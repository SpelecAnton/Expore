/**
 * SPELEC Engine v7.6 — PORTAL MEDIA LABELS
 *
 * Change over v7.5:
 *   - trigger_portal entities can now use their "label" field as a media
 *     URL instead of plain text. If label ends in a recognized image
 *     (.jpg/.jpeg/.png/.gif/.webp/.avif), video (.mp4/.webm) or GLSL
 *     shader (.frag) extension, the portal no longer draws the small
 *     floating text caption — instead the whole portal plane (full
 *     width × height, same size as the portal's color/outline quad) is
 *     textured with that media, using the new loadTextureFromUrl() export
 *     from bsp_loader.js (the same image/video/animated/shader loaders
 *     used for BSP face textures, so it inherits their autoplay/looping/
 *     GPU-update behavior for free via the existing tickAnimatedTextures()
 *     call already running in the render loop — no new ticking code).
 *   - Plain-text labels are unaffected and still render exactly as before.
 *   - If the media fails to load, the portal just keeps its flat color
 *     fill (a warning is logged) — it does not fall back to drawing the
 *     URL itself as text.
 *
 * --- Previous changelog (v7.5 — PORTALS NO LONGER EMIT LIGHT) ------------
 *
 *   - buildPortal() previously created a THREE.PointLight next to every
 *     portal quad (intensity 3, distance 7) purely for a glow effect.
 *     This light was also force-reset to intensity 3 every frame in the
 *     render loop, so it could never be dimmed/disabled from outside.
 *   - Both the PointLight creation and the per-frame intensity reset have
 *     been removed. Portals are now purely visual (plane + outline +
 *     label/media) and no longer contribute any illumination to the scene.
 *   - The portal record no longer carries a `ptLight` field.
 */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';
import { EffectComposer } from 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/UnrealBloomPass.js';
import { loadBSP, tickAnimatedTextures, initTexLoader, unmuteVideos, loadTextureFromUrl } from 'https://spelecanton.github.io/Expore/javascript/bsp_loader.js';
import { createPhysics } from 'https://spelecanton.github.io/Expore/javascript/physics.js';

// Reserved for future use — not currently consumed anywhere below.
// Camera FOV is hardcoded to 90, player-height fallback is hardcoded to
// 1.6 (== PLAYER_HEIGHT * UNIT), and .02 is used inline as the Quake →
// Three.js unit conversion factor throughout this file and bsp_worker.js.
const PLAYER_HEIGHT = 80;
const FOV  = 90;
const UNIT = 0.02;

// ── Camera position hash (#x,y,z,yaw in the URL) ──────────────────────────────
function readHashState() {
  const raw = window.location.hash.slice(1);
  if (!raw) return null;
  const parts = raw.split(',').map(Number);
  if (parts.length < 4 || parts.some(isNaN)) return null;
  return { x: parts[0], y: parts[1], z: parts[2], yaw: parts[3] };
}

function writeHashState(x, y, z, yaw) {
  const r = v => Math.round(v * 1000) / 1000;
  history.replaceState(null, '', `#${r(x)},${r(y)},${r(z)},${r(yaw)}`);
}

// ── Portal audio (target_url pointing at an audio file plays/pauses in place) ─
const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.wav', '.flac', '.aac']);

function isAudioUrl(url) {
  try {
    const path = new URL(url, location.href).pathname;
    return AUDIO_EXTS.has(path.substring(path.lastIndexOf('.')).toLowerCase());
  } catch {
    return false;
  }
}

let _activePortalAudio = null;

function playPortalAudio(url) {
  const resolved = new URL(url, location.href).href;
  if (_activePortalAudio && _activePortalAudio.src === resolved) {
    _activePortalAudio.paused ? _activePortalAudio.play() : _activePortalAudio.pause();
    return;
  }
  if (_activePortalAudio) {
    _activePortalAudio.pause();
    _activePortalAudio = null;
  }
  const audio = new Audio(resolved);
  audio.play().catch(err => console.warn('[Engine] Portal audio play failed:', err));
  _activePortalAudio = audio;
}

// ── Background music auto-detection ───────────────────────────────────────────
const BG_CANDIDATES = ['background.mp3', 'background.ogg', 'background.wav'];

async function findBackgroundMusic(mapBase) {
  const results = await Promise.all(BG_CANDIDATES.map(async name => {
    const url = mapBase + name;
    try { return (await fetch(url, { method: 'HEAD' })).ok ? url : null; }
    catch { return null; }
  }));
  const found = results.find(Boolean);
  if (!found) {
    console.log('[Engine] No background music found.');
    return null;
  }
  console.log(`[Engine] Background music: ${found}`);
  const audio = new Audio(found);
  audio.loop   = true;
  audio.volume = 0.5;
  return audio;
}

function mapBaseFromUrl(url) {
  try {
    const full = new URL(url, location.href).href;
    return full.substring(0, full.lastIndexOf('/') + 1);
  } catch {
    return './';
  }
}

// ── Portal text label (canvas-rendered caption) ───────────────────────────────
function buildPortalLabel(text, color, portalMesh) {
  if (!text) return null;
  const canvas = document.createElement('canvas');
  canvas.width  = 512;
  canvas.height = 80;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 512, 80);
  ctx.shadowColor = `#${color.getHexString()}`;
  ctx.shadowBlur  = 18;
  ctx.font        = 'bold 30px "Share Tech Mono", monospace';
  ctx.fillStyle   = `#${color.getHexString()}`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text.toUpperCase(), 256, 40);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;

  const labelMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(2.8, 0.44),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide })
  );
  labelMesh.position.set(0, 0, 0.02); // slight z-offset to avoid z-fighting with the portal plane
  portalMesh.add(labelMesh);
  return labelMesh;
}

// ── Portal media label (image / video / animated / shader instead of text) ────
// If a trigger_portal's "label" field is a URL ending in a recognized media
// extension (rather than plain caption text), the portal renders that media
// full-size across its own plane instead of drawing the small text caption.
const PORTAL_MEDIA_RE = /\.(jpe?g|png|gif|webp|avif|mp4|webm|frag)(?:[?#].*)?$/i;

function isPortalMediaLabel(label) {
  return !!label && PORTAL_MEDIA_RE.test(label.trim());
}

// Loads the label URL with the same loaders bsp_loader.js uses for BSP face
// textures (static image / animated gif-avif-webp / video mp4-webm / GLSL
// .frag shader — picked by extension) and swaps it onto the portal's own
// material once ready. Runs async — the portal shows its flat color fill
// until the texture finishes loading (or stays that way if it fails).
function applyPortalMediaTexture(url, portalMesh) {
  loadTextureFromUrl(url).then(tex => {
    if (!tex) {
      console.warn('[Engine] Portal media texture failed to load:', url);
      return;
    }
    const mat = portalMesh.material;
    mat.map = tex;
    mat.color.set(0xffffff); // let the media show its own colors, untinted
    mat.needsUpdate = true;
  });
}

// ── Portal geometry ────────────────────────────────────────────────────────────
function buildPortal(entity, scene, portals) {
  const [qx, qy, qz] = (entity.origin || '0 0 0').split(' ').map(Number);
  const url    = entity.target_url || '#';
  const label  = entity.label ? entity.label.trim() : '';
  const color  = (new THREE.Color()).setHex(parseInt((entity.color || '0xff2200').replace('#', ''), 16));
  const angle  = parseFloat(entity.angle || '0') * Math.PI / 180;
  const size   = entity.size || '110';
  const width  = 0.02 * parseFloat(entity.width  || size);
  const height = 0.02 * parseFloat(entity.height || size);
  const opacity = Math.max(0, Math.min(1, parseFloat(entity.opacity ?? '0.78')));

  // Quake (x,y,z) → Three.js (x, z, -y), same convention as bsp_worker.js
  const x = 0.02 * qx;
  const y = 0.02 * qz;
  const z = 0.02 * -qy;

  const geo  = new THREE.PlaneGeometry(width, height);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
  }));
  mesh.position.set(x, y, z);
  mesh.rotation.y = angle;
  scene.add(mesh);

  mesh.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color, opacity, transparent: true })
  ));

  const isMedia = isPortalMediaLabel(label);
  if (isMedia) {
    applyPortalMediaTexture(label, mesh);
  } else {
    buildPortalLabel(label, color, mesh);
  }

  portals.push({ x, y, z, url, label, col: color, mesh, opacity, isMedia });
}

// ── Light sprites (glow billboard for "sprite"-flagged BSP lights) ────────────
function makeSpriteTexture(r, g, b) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  const outer = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  outer.addColorStop(0,    `rgba(${Math.round(255 * r)},${Math.round(255 * g)},${Math.round(255 * b)},0.9)`);
  outer.addColorStop(0.25, `rgba(${Math.round(255 * r)},${Math.round(255 * g)},${Math.round(255 * b)},0.5)`);
  outer.addColorStop(0.6,  `rgba(${Math.round(255 * r)},${Math.round(255 * g)},${Math.round(255 * b)},0.12)`);
  outer.addColorStop(1,    `rgba(${Math.round(255 * r)},${Math.round(255 * g)},${Math.round(255 * b)},0)`);
  ctx.fillStyle = outer;
  ctx.fillRect(0, 0, size, size);

  const core = ctx.createRadialGradient(64, 64, 0, 64, 64, 15.36);
  core.addColorStop(0,   '#ffffff');
  core.addColorStop(0.5, `rgba(${Math.round(255 * r)},${Math.round(255 * g)},${Math.round(255 * b)},0.9)`);
  core.addColorStop(1,   `rgba(${Math.round(255 * r)},${Math.round(255 * g)},${Math.round(255 * b)},0)`);
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace  = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const _spriteTexCache = new Map();

function getSpriteTex(r, g, b) {
  const key = `${(15 * r) | 0}:${(15 * g) | 0}:${(15 * b) | 0}`;
  if (!_spriteTexCache.has(key)) _spriteTexCache.set(key, makeSpriteTexture(r, g, b));
  return _spriteTexCache.get(key);
}

function addLightSprites(scene, lights) {
  if (!lights?.length) return;
  let spriteCount = 0;

  for (const light of lights) {
    const col       = new THREE.Color(light.r, light.g, light.b);
    const distance  = Math.min(20, Math.max(2, 0.05 * light.intensity));
    const intensity = Math.min(5, Math.max(0.2, 0.015 * light.intensity));
    const ptLight   = new THREE.PointLight(col, intensity, distance);
    ptLight.position.set(light.x, light.y, light.z);
    scene.add(ptLight);

    if (!light.sprite) continue;

    const mat = new THREE.SpriteMaterial({
      map: getSpriteTex(light.r, light.g, light.b),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      color: col,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(light.x, light.y, light.z);
    sprite.scale.setScalar(0.5);
    sprite.userData.noclip = true;
    scene.add(sprite);
    spriteCount++;
  }

  console.log(`[Engine] Lights: ${lights.length} total, ${spriteCount} with sprite`);
}

// ── Fallback room (shown if the BSP fails to load) ────────────────────────────
function _fallbackRoom(scene) {
  const floorMat   = new THREE.MeshLambertMaterial({ color: 0x1a1a2e });
  const ceilingMat = new THREE.MeshLambertMaterial({ color: 0x16161e });
  const wallMat    = new THREE.MeshLambertMaterial({ color: 0x0a0a1a });

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), floorMat);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), ceilingMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = 5;
  scene.add(ceiling);

  for (const [x, y, z, rotY] of [
    [-10, 2.5, 0, 0],
    [10, 2.5, 0, Math.PI],
    [0, 2.5, -10, Math.PI / 2],
    [0, 2.5, 10, -Math.PI / 2],
  ]) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(20, 5), wallMat);
    wall.position.set(x, y, z);
    wall.rotation.y = rotY;
    scene.add(wall);
  }

  scene.add(new THREE.AmbientLight(0x334466, 3));
}

// ── Main entry point ────────────────────────────────────────────────────────────
export async function initEngine({
  canvas,
  mapUrl          = 'map.bsp',
  textureBase     = 'textures/',
  mapName         = 'MAP', // reserved — not currently used by this module
  onReady         = null,
  onProgress      = null,
  physicsConfig   = {},
  bloomStrength   = 0.4,
  bloomRadius     = 0.4,
  bloomThreshold  = 0.2,
  renderDistance  = 180,
  maxPixelRatio   = 1,
  fogColor        = 0,
}) {
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 2;
  window._rendererInfo = renderer.info;
  initTexLoader(renderer);

  const scene   = new THREE.Scene();
  const fogCol  = new THREE.Color(fogColor).convertSRGBToLinear();
  const fogNear = 0.2 * renderDistance;
  const fogFar  = renderDistance;
  scene.fog        = new THREE.Fog(fogCol, fogNear, fogFar);
  scene.background = new THREE.Color(fogCol);

  const camera = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, 0.01, renderDistance);
  camera.position.set(0, 1.6, 0);

  const ambientLight = new THREE.AmbientLight(0xffffff, 1);
  scene.add(ambientLight);

  const composer   = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  let bloomPass = null;
  if (bloomStrength > 0) {
    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2)),
      bloomStrength, bloomRadius, bloomThreshold
    );
    composer.addPass(bloomPass);
  }

  let sceneReady = false;
  const portals = [];
  let yaw = 0;
  let worldMeshes = [];     // opaque, raycast-blocking meshes
  let invisibleMeshes = []; // colorWrite:false clip brushes — still block portal raycasts

  const bgMusicPromise = findBackgroundMusic(mapBaseFromUrl(mapUrl));

  try {
    const loaded = await loadBSP({
      url: mapUrl, scene, textureBase, fallbackTexBase: '/explore/textures/', onProgress,
    });

    if (loaded.ambientColor !== undefined)     ambientLight.color.set(loaded.ambientColor);
    if (loaded.ambientIntensity !== undefined) ambientLight.intensity = loaded.ambientIntensity;

    for (const portalEntity of loaded.portals) buildPortal(portalEntity, scene, portals);
    addLightSprites(scene, loaded.lights ?? []);

    const hash = readHashState();
    if (hash) {
      camera.position.set(hash.x, hash.y, hash.z);
      yaw = hash.yaw;
    } else if (loaded.playerStart) {
      const start = loaded.playerStart;
      camera.position.set(start.x, start.y + 1.6, start.z);
      yaw = start.angle * Math.PI / 180;
    }

    const portalMeshSet = new Set(portals.map(p => p.mesh));
    scene.traverse(obj => {
      if (obj.isMesh && obj.geometry && !portalMeshSet.has(obj)) {
        if (obj.userData.invisible) invisibleMeshes.push(obj);
        else if (obj.material?.depthWrite !== false) worldMeshes.push(obj);
      }
    });

    setTimeout(() => {
      sceneReady = true;
      console.log('[Engine] Scene ready — full render pipeline active');
    }, 500);
  } catch (err) {
    console.error('[Engine] BSP load failed:', err);
    _fallbackRoom(scene);
    ambientLight.intensity = 3;
    scene.traverse(obj => {
      if (obj.isMesh && obj.geometry) {
        if (obj.userData.invisible) invisibleMeshes.push(obj);
        else if (obj.material?.depthWrite !== false) worldMeshes.push(obj);
      }
    });
    sceneReady = true;
  }

  const physics = createPhysics(scene, physicsConfig);
  physics.refreshCollidables();
  window._cam     = camera;
  window._physics = physics;
  window._scene   = scene;

  const bgMusic = await bgMusicPromise;
  let musicStarted = false;
  function startBackgroundMusic() {
    if (!musicStarted && bgMusic) {
      musicStarted = true;
      bgMusic.play().catch(err => console.warn('[Engine] BG music failed:', err));
    }
  }

  // ── Portal hover / click raycasting ──────────────────────────────────────
  let hoveredPortal = null;
  let raycastFrameCounter = 0;
  const portalRaycaster    = new THREE.Raycaster();
  const occlusionRaycaster = new THREE.Raycaster();
  const mouseNDC = new THREE.Vector2(0, 0);
  const portalMeshList = portals.map(p => p.mesh);

  function getHoveredPortal() {
    if (!portalMeshList.length) return null;

    raycastFrameCounter++;
    if (raycastFrameCounter % 4 !== 0) return hoveredPortal; // throttle: every 4th frame

    portalRaycaster.setFromCamera(mouseNDC, camera);
    const hits = portalRaycaster.intersectObjects(portalMeshList, false);
    if (!hits.length) { hoveredPortal = null; return null; }

    const hitDistance = hits[0].distance;

    // Check if any opaque/clip geometry sits between the camera and the portal
    occlusionRaycaster.ray.copy(portalRaycaster.ray);
    occlusionRaycaster.near = portalRaycaster.near;
    occlusionRaycaster.far  = hitDistance - 0.05;

    const blockedByWorld = occlusionRaycaster.intersectObjects(worldMeshes, false);
    const blockedByClip  = invisibleMeshes.length ? occlusionRaycaster.intersectObjects(invisibleMeshes, false) : [];

    if (blockedByWorld.length > 0 || blockedByClip.length > 0) {
      hoveredPortal = null;
      return null;
    }

    hoveredPortal = portals.find(p => p.mesh === hits[0].object) ?? null;
    return hoveredPortal;
  }

  window.addEventListener('mousemove', e => {
    mouseNDC.x =  (e.clientX / window.innerWidth)  * 2 - 1;
    mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
  });

  // ── Debug key shortcuts ('f' = ground probe, 'p' = renderer stats) ───────
  window.addEventListener('keydown', e => {
    if (e.key.toLowerCase() === 'f') {
      const pos = camera.position;
      console.log('=== GROUND DEBUG ===');
      console.log('Camera pos:', `(${pos.x.toFixed(4)}, ${pos.y.toFixed(4)}, ${pos.z.toFixed(4)})`);

      const solidMeshes = worldMeshes.filter(m => !m.userData.noclip);
      const probe = new THREE.Raycaster();
      probe.firstHitOnly = true;

      const offsets = [[0, 0], [0.2, 0], [-0.2, 0], [0, 0.2], [0, -0.2]];
      for (const [ox, oz] of offsets) {
        const origin = new THREE.Vector3(pos.x + ox, pos.y + 0.25, pos.z + oz);
        probe.set(origin, new THREE.Vector3(0, -1, 0));
        probe.far = 5;
        const hits = probe.intersectObjects(solidMeshes, false);
        if (hits.length > 0) {
          const hit    = hits[0];
          const normal = hit.face?.normal ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
          console.log(
            `  offset[${ox.toFixed(1)},${oz.toFixed(1)}]:`,
            'dist=' + hit.distance.toFixed(3),
            'hitY=' + hit.point.y.toFixed(3),
            'normal=' + (normal ? `(${normal.x.toFixed(2)},${normal.y.toFixed(2)},${normal.z.toFixed(2)})` : 'N/A'),
            'mesh=' + (hit.object.name || hit.object.uuid.slice(0, 8))
          );
        } else {
          console.log(`  offset[${ox.toFixed(1)},${oz.toFixed(1)}]: NO HIT`);
        }
      }
      console.log('World meshes:', worldMeshes.length);
      console.log('====================');
    }

    if (e.key.toLowerCase() === 'p') {
      const info = renderer.info;
      console.log('=== RENDERER STATS ===');
      console.log(`Draw calls:  ${info.render.calls}`);
      console.log(`Triangles:   ${info.render.triangles}`);
      console.log(`Geometries:  ${info.memory.geometries}`);
      console.log(`Textures:    ${info.memory.textures}`);
      console.log(`Programs:    ${info.programs?.length ?? 'N/A'}`);
      console.log('======================');
    }
  }, { passive: true });

  // ── Movement key state + first-gesture unlocks (music, video audio) ──────
  const keys = {};
  window.addEventListener('keydown', e => {
    keys[e.key.toLowerCase()] = true;
    if (e.key === ' ') e.preventDefault();
    startBackgroundMusic();
    unmuteVideos();
    document.querySelectorAll('video[data-spelec-bsp-video]').forEach(v => v.play().catch(() => {}));
  });
  window.addEventListener('keyup', e => {
    keys[e.key.toLowerCase()] = false;
  });

  // ── Portal click → navigate / toggle audio ────────────────────────────────
  window.addEventListener('click', () => {
    startBackgroundMusic();
    unmuteVideos();
    const portal = getHoveredPortal();
    if (!portal) return;

    if (isAudioUrl(portal.url)) {
      playPortalAudio(portal.url);
    } else {
      document.getElementById('fade')?.classList.add('out');
      setTimeout(() => { window.location.href = portal.url; }, 350);
    }
  });

  // ── Resize handling (debounced) ────────────────────────────────────────────
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      composer.setSize(window.innerWidth, window.innerHeight);
      if (bloomPass) bloomPass.resolution.set(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2));
    }, 150);
  });

  onReady?.();

  // ── Render loop ─────────────────────────────────────────────────────────────
  const clock = new THREE.Clock();
  let lastHashWriteTime = 0;
  let frameCount = 0;

  (function renderLoop() {
    requestAnimationFrame(renderLoop);
    frameCount++;

    let delta = clock.getDelta();
    if (delta > 0.1) delta = 0.1;

    yaw = physics.update(camera, keys, yaw, delta);
    if (frameCount % 3 === 0) tickAnimatedTextures();

    for (const portal of portals) portal.mesh.material.opacity = portal.opacity;

    const now = performance.now();
    if (now - lastHashWriteTime >= 3000) {
      lastHashWriteTime = now;
      writeHashState(camera.position.x, camera.position.y, camera.position.z, yaw);
    }

    canvas.style.cursor = getHoveredPortal() ? 'pointer' : 'default';

    if (sceneReady) composer.render();
    else renderer.render(scene, camera);
  })();
}