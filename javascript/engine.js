/**
 * SPELEC EXPLORE ENGINE v8.0 — OCTREE CAPSULE PHYSICS
 *
 * Changes from v7.0:
 *   Physics now uses Three.js Octree + Capsule instead of BSP brush traces.
 *
 *   buildWorldOctree(scene) collects all solid and clip meshes from the scene
 *   (excluding portals, noclip objects and sprites) and feeds them into an
 *   Octree.  The Octree is passed to createPhysics() instead of bspCollision.
 *
 *   Portal meshes and their children (edge lines, label planes) are marked
 *   userData.noCollide = true in buildPortal() so they are never added to the
 *   Octree — the player walks straight through them.
 *
 *   worldMeshes is still built for portal-click occlusion raycasting (unchanged).
 *
 *   Fallback room: if BSP load fails, _fallbackRoom() creates plain geometry
 *   that IS included in the Octree, so the player has real collision even in
 *   the error state (improvement over v7.0 where fallback had no collision).
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';
import { EffectComposer }  from 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass }      from 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/UnrealBloomPass.js';
import { Octree }          from 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/math/Octree.js';
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
  const r    = v => Math.round(v * 1000) / 1000;
  const hash = `${r(x)},${r(y)},${r(z)},${r(yaw)}`;
  history.replaceState(null, '', '#' + hash);
}

// ── Audio helpers ─────────────────────────────────────────────────────────────
const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.wav', '.flac', '.aac']);

function isAudioUrl(url) {
  try {
    const path = new URL(url, location.href).pathname;
    const ext  = path.substring(path.lastIndexOf('.')).toLowerCase();
    return AUDIO_EXTS.has(ext);
  } catch { return false; }
}

let _activePortalAudio = null;

function playPortalAudio(url) {
  const resolved = new URL(url, location.href).href;

  if (_activePortalAudio && _activePortalAudio.src === resolved) {
    if (_activePortalAudio.paused) _activePortalAudio.play();
    else                           _activePortalAudio.pause();
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
  const audio = new Audio(url);
  audio.loop = true; audio.volume = 0.5;
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
  canvas.width  = 512; canvas.height = 80;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 512, 80);
  ctx.shadowColor = `#${col.getHexString()}`; ctx.shadowBlur = 18;
  ctx.font = 'bold 30px "Share Tech Mono", monospace';
  ctx.fillStyle = `#${col.getHexString()}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
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
  const col   = new THREE.Color().setHex(
    parseInt((props.color || '0xff2200').replace('#', ''), 16)
  );
  const angle = parseFloat(props.angle || '0') * Math.PI / 180;

  const defaultSize = props.size || '110';
  const w = parseFloat(props.width  || defaultSize) * UNIT;
  const h = parseFloat(props.height || defaultSize) * UNIT;
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

  // Mark portal mesh and ALL its children (edge lines, label plane) as
  // non-collidable so buildWorldOctree() skips them.
  // The player should walk straight through portals.
  mesh.traverse(obj => { obj.userData.noCollide = true; });
}

// ── Light sprite ──────────────────────────────────────────────────────────────
function makeSpriteTexture(r, g, b) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2, cy = size / 2;

  const outerGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
  outerGrad.addColorStop(0,    `rgba(${(r*255)|0},${(g*255)|0},${(b*255)|0},0.9)`);
  outerGrad.addColorStop(0.25, `rgba(${(r*255)|0},${(g*255)|0},${(b*255)|0},0.5)`);
  outerGrad.addColorStop(0.6,  `rgba(${(r*255)|0},${(g*255)|0},${(b*255)|0},0.12)`);
  outerGrad.addColorStop(1,    `rgba(${(r*255)|0},${(g*255)|0},${(b*255)|0},0)`);
  ctx.fillStyle = outerGrad; ctx.fillRect(0, 0, size, size);

  const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.12);
  coreGrad.addColorStop(0,   '#ffffff');
  coreGrad.addColorStop(0.5, `rgba(${(r*255)|0},${(g*255)|0},${(b*255)|0},0.9)`);
  coreGrad.addColorStop(1,   `rgba(${(r*255)|0},${(g*255)|0},${(b*255)|0},0)`);
  ctx.fillStyle = coreGrad; ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const _spriteTexCache = new Map();
function getSpriteTex(r, g, b) {
  const key = `${(r*15)|0}:${(g*15)|0}:${(b*15)|0}`;
  if (!_spriteTexCache.has(key)) _spriteTexCache.set(key, makeSpriteTexture(r, g, b));
  return _spriteTexCache.get(key);
}

function addLightSprites(scene, lights) {
  if (!lights?.length) return;
  let spriteCount = 0;
  for (const light of lights) {
    const col    = new THREE.Color(light.r, light.g, light.b);
    const range  = Math.min(20, Math.max(2, light.intensity * 0.05));
    const intens = Math.min(5, Math.max(0.2, light.intensity * 0.015));
    const pt     = new THREE.PointLight(col, intens, range);
    pt.position.set(light.x, light.y, light.z);
    scene.add(pt);

    if (!light.sprite) continue;
    const spriteMat = new THREE.SpriteMaterial({
      map: getSpriteTex(light.r, light.g, light.b),
      transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, color: col,
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.position.set(light.x, light.y, light.z);
    sprite.scale.setScalar(0.5);
    sprite.userData.noclip = true; // excluded from Octree by buildWorldOctree()
    scene.add(sprite);
    spriteCount++;
  }
  console.log(`[Engine] Lights: ${lights.length} total, ${spriteCount} with sprite`);
}

// ── Fallback room (shown when BSP fails to load) ──────────────────────────────
function _fallbackRoom(scene) {
  const floorMat   = new THREE.MeshLambertMaterial({ color: 0x1a1a2e });
  const wallMat    = new THREE.MeshLambertMaterial({ color: 0x16213e });
  const ceilingMat = new THREE.MeshLambertMaterial({ color: 0x0a0a1a });

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), floorMat);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), ceilingMat);
  ceil.rotation.x = Math.PI / 2; ceil.position.y = 5;
  scene.add(ceil);

  for (const [wx, wy, wz, ry] of [
    [-10, 2.5, 0, 0], [10, 2.5, 0, Math.PI],
    [0, 2.5, -10, Math.PI / 2], [0, 2.5, 10, -Math.PI / 2],
  ]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(20, 5), wallMat);
    m.position.set(wx, wy, wz); m.rotation.y = ry;
    scene.add(m);
  }
  scene.add(new THREE.AmbientLight(0x334466, 3));
}

// ── buildWorldOctree ──────────────────────────────────────────────────────────
// Iterates all meshes in the scene and adds collision-relevant ones to an Octree.
//
// Included:  visible solid meshes, invisible clip-brush meshes (userData.invisible)
// Excluded:  portal meshes + children  (userData.noCollide — set by buildPortal)
//            noclip objects            (userData.noclip — func_wall, sprites, etc.)
//
// Called AFTER both the BSP load try/catch and (if it failed) _fallbackRoom(),
// so the fallback room geometry is also properly included.
function buildWorldOctree(scene) {
  console.log('[Engine] Building collision Octree...');
  const t0     = performance.now();
  const octree = new Octree();
  let   triCount = 0;

  scene.updateMatrixWorld(true);

  scene.traverse(obj => {
    if (!obj.isMesh || !obj.geometry) return;
    if (obj.userData.noCollide) return; // portals and their label/edge children
    if (obj.userData.noclip)    return; // func_wall, light sprites, etc.

    // Estimate triangle count for the debug log.
    const idx = obj.geometry.index;
    triCount += idx ? idx.count / 3 : obj.geometry.attributes.position.count / 3;

    // fromGraphNode on a single Mesh adds only that mesh's triangles to the Octree.
    // BSP meshes have identity world transforms (vertices already in world space).
    octree.fromGraphNode(obj);
  });

  console.log(
    `[Engine] Octree ready: ~${triCount | 0} triangles` +
    ` in ${(performance.now() - t0).toFixed(0)} ms`
  );
  return octree;
}

// ── initEngine ────────────────────────────────────────────────────────────────
export async function initEngine({
  canvas,
  mapUrl          = '/explore/hub/maps/hub.bsp',
  textureBase     = '/explore/hub/textures/',
  mapName         = 'MAP',
  onReady         = null,
  onProgress      = null,
  physicsConfig   = {},
  bloomStrength   = 0.9,
  bloomRadius     = 0.4,
  bloomThreshold  = 0.2,
}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping         = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 2.0;

  initTexLoader(renderer);

  const scene  = new THREE.Scene();
  scene.fog        = new THREE.FogExp2(0x000000, 0.016);
  scene.background = new THREE.Color(0x000000);

  const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.01, 120);
  camera.position.set(0, PLAYER_HEIGHT * UNIT, 0);

  const ambient = new THREE.AmbientLight(0xffffff, 1.0);
  scene.add(ambient);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    bloomStrength, bloomRadius, bloomThreshold,
  ));

  const portals   = [];
  let   yaw       = 0;

  // worldMeshes: used only for portal-click occlusion raycasting (not physics).
  const worldMeshes   = [];
  const portalMeshSet = new Set();

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
    portals.forEach(p => portalMeshSet.add(p.mesh));

    addLightSprites(scene, result.lights ?? []);

    // Note: result.bspCollision is intentionally ignored here.
    // Physics now uses the Octree built from scene meshes (below).

    const hashState = readHashState();
    if (hashState) {
      camera.position.set(hashState.x, hashState.y, hashState.z);
      yaw = hashState.yaw;
    } else if (result.playerStart) {
      const ps = result.playerStart;
      camera.position.set(ps.x, ps.y + PLAYER_HEIGHT * UNIT, ps.z);
      yaw = ps.angle * Math.PI / 180;
    }

    // Collect visible + clip meshes for portal occlusion raycasting (unchanged from v7).
    scene.traverse(obj => {
      if (obj.isMesh && obj.geometry && !portalMeshSet.has(obj)) {
        if (obj.userData.noclip) return;
        if (obj.userData.invisible || obj.material?.depthWrite !== false) {
          worldMeshes.push(obj);
        }
      }
    });

  } catch (err) {
    console.error('[Engine] BSP load failed:', err);
    _fallbackRoom(scene);
    ambient.intensity = 3;
    // Fallback room meshes are plain geometry with no special userData,
    // so buildWorldOctree() will include them → player has real collision.
  }

  // ── Build world Octree for capsule collision ───────────────────────────────
  // Runs after both the try block and catch block so it always picks up
  // whatever geometry is currently in the scene (BSP map or fallback room).
  // Blocks the main thread briefly — the loading screen stays visible during this.
  const worldOctree = buildWorldOctree(scene);

  // ── Physics — Octree + Capsule (physics.js v5.0) ──────────────────────────
  const physics = createPhysics(worldOctree, physicsConfig);
  physics.refreshCollidables(); // no-op in v5.0, kept for API compatibility

  window._cam     = camera;
  window._physics = physics;
  window._scene   = scene;

  const bgMusic        = await bgMusicPromise;
  let   bgMusicStarted = false;

  function startBgMusic() {
    if (bgMusicStarted || !bgMusic) return;
    bgMusicStarted = true;
    bgMusic.play().catch(err => console.warn('[Engine] BG music play failed:', err));
  }

  let _lastHashWrite = 0;
  const HASH_WRITE_INTERVAL = 1000;

  const portalRaycaster = new THREE.Raycaster();
  const wallRaycaster   = new THREE.Raycaster();
  const mouseNDC        = new THREE.Vector2(0, 0);
  const portalMeshes    = portals.map(p => p.mesh);

  window.addEventListener('mousemove', e => {
    mouseNDC.x =  (e.clientX / window.innerWidth)  * 2 - 1;
    mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
  });

  function getHoveredPortal() {
    if (!portalMeshes.length) return null;
    portalRaycaster.setFromCamera(mouseNDC, camera);
    const portalHits = portalRaycaster.intersectObjects(portalMeshes, false);
    if (!portalHits.length) return null;

    const portalDist = portalHits[0].distance;
    wallRaycaster.ray.copy(portalRaycaster.ray);
    wallRaycaster.near = portalRaycaster.near;
    wallRaycaster.far  = portalDist - 0.05;

    const wallHits = wallRaycaster.intersectObjects(worldMeshes, false);
    if (wallHits.length > 0) return null;

    return portals.find(p => p.mesh === portalHits[0].object) ?? null;
  }

  // ── Debug: F key ─────────────────────────────────────────────────────────
  window.addEventListener('keydown', e => {
    if (e.key.toLowerCase() !== 'f') return;
    const pos = camera.position;
    console.log('=== CAMERA DEBUG ===');
    console.log(`Position:  (${pos.x.toFixed(4)}, ${pos.y.toFixed(4)}, ${pos.z.toFixed(4)})`);
    console.log(`Hash:      ${pos.x.toFixed(3)},${pos.y.toFixed(3)},${pos.z.toFixed(3)},${yaw.toFixed(3)}`);
    console.log(`onGround:  ${physics.isOnGround}   velocityY: ${physics.velocityY.toFixed(3)}`);
    console.log(`Octree collision: ${worldOctree ? 'ready' : 'NONE'}`);
    console.log('====================');
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

    if (isAudioUrl(portal.url)) {
      playPortalAudio(portal.url);
      return;
    }

    document.getElementById('fade')?.classList.add('out');
    setTimeout(() => { window.location.href = portal.url; }, 350);
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
  });

  if (onReady) onReady();

  const clock = new THREE.Clock();

  (function tick() {
    requestAnimationFrame(tick);
    const dt = clock.getDelta();

    yaw = physics.update(camera, keys, yaw, dt);

    tickAnimatedTextures();

    // Animate portals
    for (let i = 0; i < portals.length; i++) {
      const p = portals[i];
      p.mesh.material.opacity = p.opacity;
      p.ptLight.intensity     = 3.0;
    }

    // Periodically write camera position to URL hash
    const now = performance.now();
    if (now - _lastHashWrite >= HASH_WRITE_INTERVAL) {
      _lastHashWrite = now;
      writeHashState(camera.position.x, camera.position.y, camera.position.z, yaw);
    }

    canvas.style.cursor = getHoveredPortal() ? 'pointer' : 'default';

    composer.render();
  })();
}
