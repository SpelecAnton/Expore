/**
 * SPELEC EXPLORE ENGINE v7.1 — LARGE MAP EDITION
 *
 * Changes over v7.0:
 *
 * 1. WORLD MESH COLLECTION FIXED:
 *    - v7.0 used scene.traverse() inside the debug F-key handler on every press.
 *    - worldMeshes list is now always built from the pre-collected list, not
 *      via a fresh traverse inside the keydown handler.
 *    - The portal wall-occlusion raycaster also uses the pre-built worldMeshes
 *      (was already correct in v7.0, kept).
 *
 * 2. PORTAL HOVER THROTTLED:
 *    - getHoveredPortal() ran every frame even when there are no portals.
 *    - Now skips entirely if portals array is empty.
 *    - When portals exist, only runs every OTHER frame (cursor update still
 *      runs every frame but uses the cached result).
 *
 * 3. HASH WRITE INTERVAL increased 1000 ms → 2000 ms:
 *    - history.replaceState() is surprisingly expensive on some browsers.
 *    - 2 second granularity is still fine for URL state persistence.
 *
 * 4. CLOCK.getDelta() GUARD:
 *    - If the tab was hidden and then restored, getDelta() returns a huge
 *      value (5–30 seconds). This causes physics to teleport the player.
 *    - Clamped to 0.1 s max at the engine level (physics also clamps to 0.05).
 *
 * 5. ANIMATED TEXTURE TICK — ALREADY FAST:
 *    - tickAnimatedTextures() in bsp_loader v5.1 has a zero-cost early-out
 *      when _animList is empty. No change needed here.
 *
 * 6. RENDERER PIXEL RATIO — DEFAULT LOWERED:
 *    - maxPixelRatio default 1.5 → 1.0 for large maps.
 *    - On an 80 MB map the geometry complexity is the bottleneck, not texel
 *      density. Authors can raise it in index.html if needed.
 *
 * 7. BLOOM PASS — RESOLUTION HALVED:
 *    - UnrealBloomPass now uses half the renderer resolution.
 *    - Bloom quality is perceptually unchanged at half res but ~4× cheaper
 *      (two passes on a quarter the pixels).
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';
import { EffectComposer }  from 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass }      from 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/UnrealBloomPass.js';
import { loadBSP, tickAnimatedTextures, initTexLoader } from 'https://spelecanton.github.io/Expore/javascript/bsp_loader.js';
import { createPhysics } from 'https://spelecanton.github.io/Expore/javascript/physics.js';

const PLAYER_HEIGHT = 80;
const FOV           = 90;
const UNIT          = 0.02;

// ── URL hash helpers ──────────────────────────────────────────────────────────

function readHashState() {
  const hash = window.location.hash.slice(1);
  if (!hash) return null;
  const parts = hash.split(',').map(Number);
  if (parts.length < 4 || parts.some(isNaN)) return null;
  return { x: parts[0], y: parts[1], z: parts[2], yaw: parts[3] };
}

function writeHashState(x, y, z, yaw) {
  const r = v => Math.round(v * 1000) / 1000;
  history.replaceState(null, '', '#' + `${r(x)},${r(y)},${r(z)},${r(yaw)}`);
}

// ── Audio helpers ─────────────────────────────────────────────────────────────

const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.wav', '.flac', '.aac']);

function isAudioUrl(url) {
  try {
    const path = new URL(url, location.href).pathname;
    return AUDIO_EXTS.has(path.substring(path.lastIndexOf('.')).toLowerCase());
  } catch { return false; }
}

let _activePortalAudio = null;

function playPortalAudio(url) {
  const resolved = new URL(url, location.href).href;
  if (_activePortalAudio && _activePortalAudio.src === resolved) {
    _activePortalAudio.paused ? _activePortalAudio.play() : _activePortalAudio.pause();
    return;
  }
  if (_activePortalAudio) { _activePortalAudio.pause(); _activePortalAudio = null; }
  const audio = new Audio(resolved);
  audio.play().catch(err => console.warn('[Engine] Portal audio play failed:', err));
  _activePortalAudio = audio;
}

// ── Background music ──────────────────────────────────────────────────────────

const BG_CANDIDATES = ['background.mp3', 'background.ogg', 'background.wav'];

async function findBackgroundMusic(mapBase) {
  const results = await Promise.all(
    BG_CANDIDATES.map(async file => {
      const url = mapBase + file;
      try { const res = await fetch(url, { method: 'HEAD' }); return res.ok ? url : null; }
      catch { return null; }
    })
  );
  const url = results.find(Boolean);
  if (!url) { console.log('[Engine] No background music found.'); return null; }
  console.log(`[Engine] Background music: ${url}`);
  const audio  = new Audio(url);
  audio.loop   = true;
  audio.volume = 0.5;
  return audio;
}

function mapBaseFromUrl(mapUrl) {
  try {
    const abs = new URL(mapUrl, location.href).href;
    return abs.substring(0, abs.lastIndexOf('/') + 1);
  } catch { return './'; }
}

// ── Portal label ──────────────────────────────────────────────────────────────

function buildPortalLabel(label, col, mesh) {
  if (!label) return null;
  const canvas  = document.createElement('canvas');
  canvas.width  = 512;
  canvas.height = 80;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 512, 80);
  ctx.shadowColor  = `#${col.getHexString()}`;
  ctx.shadowBlur   = 18;
  ctx.font         = 'bold 30px "Share Tech Mono", monospace';
  ctx.fillStyle    = `#${col.getHexString()}`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label.toUpperCase(), 256, 40);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(2.8, 0.44),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide })
  );
  plane.position.set(0, 0, 0.02);
  mesh.add(plane);
  return plane;
}

// ── Portal builder ────────────────────────────────────────────────────────────

function buildPortal(props, scene, portals) {
  const [ox, oy, oz] = (props.origin || '0 0 0').split(' ').map(Number);
  const url   = props.target_url || '#';
  const label = props.label ? props.label.trim() : '';
  const col   = new THREE.Color().setHex(parseInt((props.color || '0xff2200').replace('#', ''), 16));
  const angle = parseFloat(props.angle || '0') * Math.PI / 180;

  const defaultSize = props.size || '110';
  const w       = parseFloat(props.width  || defaultSize) * UNIT;
  const h       = parseFloat(props.height || defaultSize) * UNIT;
  const opacity = Math.max(0, Math.min(1, parseFloat(props.opacity ?? '0.78')));
  const x = ox * UNIT, y = oz * UNIT, z = -oy * UNIT;

  const geo  = new THREE.PlaneGeometry(w, h);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: col, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
  }));
  mesh.position.set(x, y, z);
  mesh.rotation.y = angle;
  scene.add(mesh);

  mesh.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: col, opacity, transparent: true })
  ));

  const ptLight = new THREE.PointLight(col, 3.0, 7);
  ptLight.position.set(x, y, z);
  scene.add(ptLight);

  buildPortalLabel(label, col, mesh);
  portals.push({ x, y, z, url, label, col, mesh, ptLight, opacity });
}

// ── Light sprite ──────────────────────────────────────────────────────────────

function makeSpriteTexture(r, g, b) {
  const size   = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2, cy = size / 2;

  const outerGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
  outerGrad.addColorStop(0,    `rgba(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)},0.9)`);
  outerGrad.addColorStop(0.25, `rgba(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)},0.5)`);
  outerGrad.addColorStop(0.6,  `rgba(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)},0.12)`);
  outerGrad.addColorStop(1,    `rgba(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)},0)`);
  ctx.fillStyle = outerGrad;
  ctx.fillRect(0, 0, size, size);

  const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.12);
  coreGrad.addColorStop(0,   '#ffffff');
  coreGrad.addColorStop(0.5, `rgba(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)},0.9)`);
  coreGrad.addColorStop(1,   `rgba(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)},0)`);
  ctx.fillStyle = coreGrad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace  = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const _spriteTexCache = new Map();

function getSpriteTex(r, g, b) {
  const key = `${(r * 15) | 0}:${(g * 15) | 0}:${(b * 15) | 0}`;
  if (!_spriteTexCache.has(key)) _spriteTexCache.set(key, makeSpriteTexture(r, g, b));
  return _spriteTexCache.get(key);
}

function addLightSprites(scene, lights) {
  if (!lights?.length) return;
  let spriteCount = 0;

  for (const light of lights) {
    const col      = new THREE.Color(light.r, light.g, light.b);
    const range    = Math.min(20, Math.max(2, light.intensity * 0.05));
    const ptIntens = Math.min(5, Math.max(0.2, light.intensity * 0.015));
    const ptLight  = new THREE.PointLight(col, ptIntens, range);
    ptLight.position.set(light.x, light.y, light.z);
    scene.add(ptLight);

    if (!light.sprite) continue;

    const spriteMat = new THREE.SpriteMaterial({
      map: getSpriteTex(light.r, light.g, light.b),
      transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
      color: col,
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.position.set(light.x, light.y, light.z);
    sprite.scale.setScalar(0.5);
    sprite.userData.noclip = true;
    scene.add(sprite);
    spriteCount++;
  }

  console.log(`[Engine] Lights: ${lights.length} total, ${spriteCount} with sprite`);
}

// ── Fallback room ─────────────────────────────────────────────────────────────

function _fallbackRoom(scene) {
  const floorMat   = new THREE.MeshLambertMaterial({ color: 0x1a1a2e });
  const wallMat    = new THREE.MeshLambertMaterial({ color: 0x16213e });
  const ceilingMat = new THREE.MeshLambertMaterial({ color: 0x0a0a1a });

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), floorMat);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), ceilingMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = 5;
  scene.add(ceil);

  for (const [wx, wy, wz, ry] of [
    [-10, 2.5, 0, 0], [10, 2.5, 0, Math.PI],
    [0, 2.5, -10, Math.PI / 2], [0, 2.5, 10, -Math.PI / 2],
  ]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(20, 5), wallMat);
    m.position.set(wx, wy, wz);
    m.rotation.y = ry;
    scene.add(m);
  }
  scene.add(new THREE.AmbientLight(0x334466, 3));
}

// ── initEngine ────────────────────────────────────────────────────────────────

export async function initEngine({
  canvas,
  mapUrl          = 'map.bsp',
  textureBase     = 'textures/',
  mapName         = 'MAP',
  onReady         = null,
  onProgress      = null,
  physicsConfig   = {},
  bloomStrength   = 0.4,
  bloomRadius     = 0.4,
  bloomThreshold  = 0.2,
  renderDistance  = 180,
  maxPixelRatio   = 1.0,   // Lowered default: 1.0 for large maps (was 1.5)
  fogColor        = 0x000000,
}) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias:              true,
    powerPreference:        'high-performance',
    logarithmicDepthBuffer: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping         = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 2.0;

  window._rendererInfo = renderer.info;

  initTexLoader(renderer);

  const scene  = new THREE.Scene();

  const fogDensity = 2.8 / renderDistance;
  scene.fog        = new THREE.FogExp2(fogColor, fogDensity);
  scene.background = new THREE.Color(fogColor);

  const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.01, renderDistance);
  camera.position.set(0, PLAYER_HEIGHT * UNIT, 0);

  const ambient = new THREE.AmbientLight(0xffffff, 1.0);
  scene.add(ambient);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  // Bloom at half resolution — perceptually equivalent, ~4× cheaper
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(
      Math.floor(window.innerWidth  / 2),
      Math.floor(window.innerHeight / 2),
    ),
    bloomStrength,
    bloomRadius,
    bloomThreshold,
  );
  composer.addPass(bloomPass);

  const portals     = [];
  let   yaw         = 0;
  let   worldMeshes = [];

  const mapBase        = mapBaseFromUrl(mapUrl);
  const bgMusicPromise = findBackgroundMusic(mapBase);

  try {
    const result = await loadBSP({
      url:             mapUrl,
      scene,
      textureBase,
      fallbackTexBase: '/explore/textures/',
      onProgress,
    });

    if (result.ambientColor     !== undefined) ambient.color.set(result.ambientColor);
    if (result.ambientIntensity !== undefined) ambient.intensity = result.ambientIntensity;

    for (const props of result.portals) buildPortal(props, scene, portals);
    addLightSprites(scene, result.lights ?? []);

    const hashState = readHashState();
    if (hashState) {
      camera.position.set(hashState.x, hashState.y, hashState.z);
      yaw = hashState.yaw;
    } else if (result.playerStart) {
      const ps = result.playerStart;
      camera.position.set(ps.x, ps.y + PLAYER_HEIGHT * UNIT, ps.z);
      yaw = ps.angle * Math.PI / 180;
    }

    // Build worldMeshes once — never traverse again at runtime
    const portalMeshSet = new Set(portals.map(p => p.mesh));
    scene.traverse(obj => {
      if (
        obj.isMesh && obj.geometry &&
        (obj.material?.depthWrite !== false || obj.userData.invisible) &&
        !portalMeshSet.has(obj)
      ) {
        worldMeshes.push(obj);
      }
    });

  } catch (err) {
    console.error('[Engine] BSP load failed:', err);
    _fallbackRoom(scene);
    ambient.intensity = 3;
    scene.traverse(obj => {
      if (obj.isMesh && obj.geometry && (obj.material?.depthWrite !== false || obj.userData.invisible)) {
        worldMeshes.push(obj);
      }
    });
  }

  const physics = createPhysics(scene, physicsConfig);
  physics.refreshCollidables();

  window._cam     = camera;
  window._physics = physics;
  window._scene   = scene;

  const bgMusic = await bgMusicPromise;
  let bgMusicStarted = false;

  function startBgMusic() {
    if (bgMusicStarted || !bgMusic) return;
    bgMusicStarted = true;
    bgMusic.play().catch(err => console.warn('[Engine] BG music failed:', err));
  }

  // Hash write every 2 s (was 1 s) — history.replaceState is expensive
  let _lastHashWrite       = 0;
  const HASH_WRITE_INTERVAL = 2000;

  // Portal hover check: cached result reused on odd frames
  let _lastPortalHoverResult = null;
  let _portalFrameCount      = 0;

  const portalRaycaster = new THREE.Raycaster();
  const wallRaycaster   = new THREE.Raycaster();
  const mouseNDC        = new THREE.Vector2(0, 0);
  const portalMeshes    = portals.map(p => p.mesh);

  window.addEventListener('mousemove', e => {
    mouseNDC.x =  (e.clientX / window.innerWidth)  * 2 - 1;
    mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
  });

  function getHoveredPortal() {
    // Fast exit if no portals in scene
    if (!portalMeshes.length) return null;

    // Run expensive check only every other frame; reuse cached on odd frames
    _portalFrameCount++;
    if (_portalFrameCount % 2 !== 0) return _lastPortalHoverResult;

    portalRaycaster.setFromCamera(mouseNDC, camera);
    const portalHits = portalRaycaster.intersectObjects(portalMeshes, false);
    if (!portalHits.length) { _lastPortalHoverResult = null; return null; }

    const portalDist = portalHits[0].distance;
    wallRaycaster.ray.copy(portalRaycaster.ray);
    wallRaycaster.near = portalRaycaster.near;
    wallRaycaster.far  = portalDist - 0.05;
    const wallHits = wallRaycaster.intersectObjects(worldMeshes, false);
    if (wallHits.length > 0) { _lastPortalHoverResult = null; return null; }

    _lastPortalHoverResult = portals.find(p => p.mesh === portalHits[0].object) ?? null;
    return _lastPortalHoverResult;
  }

  // ── DEBUG: Press F → ground debug, Press P → renderer stats ──────────────
  window.addEventListener('keydown', e => {
    if (e.key.toLowerCase() === 'f') {
      const pos = camera.position;
      console.log('=== GROUND DEBUG ===');
      console.log('Camera pos:', `(${pos.x.toFixed(4)}, ${pos.y.toFixed(4)}, ${pos.z.toFixed(4)})`);

      // Use pre-built worldMeshes — no traverse needed
      const debugMeshes = worldMeshes.filter(obj => !obj.userData.noclip);

      const ray     = new THREE.Raycaster();
      ray.firstHitOnly = true;
      const offsets = [[0,0],[0.2,0],[-0.2,0],[0,0.2],[0,-0.2]];

      for (const [ox, oz] of offsets) {
        const origin = new THREE.Vector3(pos.x + ox, pos.y + 0.25, pos.z + oz);
        ray.set(origin, new THREE.Vector3(0, -1, 0));
        ray.far = 5.0;

        const hits = ray.intersectObjects(debugMeshes, false);
        if (hits.length > 0) {
          const h = hits[0];
          const n = h.face?.normal ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : null;
          console.log(
            `  offset[${ox.toFixed(1)},${oz.toFixed(1)}]:`,
            'dist=' + h.distance.toFixed(3),
            'hitY=' + h.point.y.toFixed(3),
            'normal=' + (n ? `(${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)})` : 'N/A'),
            'mesh=' + (h.object.name || h.object.uuid.slice(0, 8)),
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

  const keys = {};

  window.addEventListener('keydown', e => {
    keys[e.key.toLowerCase()] = true;
    if (e.key === ' ') e.preventDefault();
    startBgMusic();
    document.querySelectorAll('video').forEach(v => v.play().catch(() => {}));
  });

  window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

  window.addEventListener('click', () => {
    startBgMusic();
    const portal = getHoveredPortal();
    if (!portal) return;
    if (isAudioUrl(portal.url)) { playPortalAudio(portal.url); return; }
    document.getElementById('fade')?.classList.add('out');
    setTimeout(() => { window.location.href = portal.url; }, 350);
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    // Also update bloom pass resolution on resize
    bloomPass.resolution.set(
      Math.floor(window.innerWidth  / 2),
      Math.floor(window.innerHeight / 2),
    );
  });

  if (onReady) onReady();

  const clock = new THREE.Clock();

  (function tick() {
    requestAnimationFrame(tick);

    // Guard against huge dt after tab switch / focus loss
    let dt = clock.getDelta();
    if (dt > 0.1) dt = 0.1;

    yaw = physics.update(camera, keys, yaw, dt);
    tickAnimatedTextures();

    for (const p of portals) {
      p.mesh.material.opacity = p.opacity;
      p.ptLight.intensity     = 3.0;
    }

    const now = performance.now();
    if (now - _lastHashWrite >= HASH_WRITE_INTERVAL) {
      _lastHashWrite = now;
      writeHashState(camera.position.x, camera.position.y, camera.position.z, yaw);
    }

    canvas.style.cursor = getHoveredPortal() ? 'pointer' : 'default';
    composer.render();
  })();
}
