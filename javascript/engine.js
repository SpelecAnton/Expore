/**
 * SPELEC EXPLORE ENGINE v6.9 — BLOOM + LIGHT SPRITES
 *
 * Změny oproti v6.8:
 * - UnrealBloomPass přidán přes EffectComposer → globální bloom efekt
 * - addLightSprites(): pro light entity s _sprite 1 se vytvoří procedurálně
 *   generovaný sprite (canvas textura, glow halo) viditelný ve scéně
 * - Světla bez _sprite 1 fungují jako dřív — pouze PointLight, žádný sprite
 * - bloomPass parametry jsou doladěny pro tmavé mapy (strength 0.9, radius 0.4)
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';
import { EffectComposer }  from 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass }      from 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/UnrealBloomPass.js';
import { loadBSP, tickAnimatedTextures } from 'https://spelecanton.github.io/Expore/javascript/bsp_loader.js';
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

  if (_activePortalAudio) {
    _activePortalAudio.pause();
    _activePortalAudio = null;
  }

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
      try {
        const res = await fetch(url, { method: 'HEAD' });
        return res.ok ? url : null;
      } catch { return null; }
    })
  );

  const url = results.find(Boolean);
  if (!url) {
    console.log('[Engine] No background music found (background.mp3/ogg/wav).');
    return null;
  }

  console.log(`[Engine] Background music found: ${url}`);
  const audio  = new Audio(url);
  audio.loop   = true;
  audio.volume = 0.5;
  return audio;
}

function mapBaseFromUrl(mapUrl) {
  try {
    const abs = new URL(mapUrl, location.href).href;
    return abs.substring(0, abs.lastIndexOf('/') + 1);
  } catch {
    return './';
  }
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
    new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    })
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
    color: col, transparent: true, opacity,
    side: THREE.DoubleSide, depthWrite: false,
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

// ── Light sprite — procedurálně generovaný bloom sprite ──────────────────────
// Vytvoří canvas texturu s radial gradient (glow efekt) bez nutnosti
// externího souboru. Sprite je vždy natočen ke kameře (Billboard).
//
// Volá se jen pro světla s _sprite 1 — ostatní světla dostanou jen PointLight.

function makeSpriteTexture(r, g, b) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width  = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  const cx = size / 2;
  const cy = size / 2;

  // Vnější měkký glow
  const outerGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
  outerGrad.addColorStop(0,    `rgba(${Math.round(r*255)}, ${Math.round(g*255)}, ${Math.round(b*255)}, 0.9)`);
  outerGrad.addColorStop(0.25, `rgba(${Math.round(r*255)}, ${Math.round(g*255)}, ${Math.round(b*255)}, 0.5)`);
  outerGrad.addColorStop(0.6,  `rgba(${Math.round(r*255)}, ${Math.round(g*255)}, ${Math.round(b*255)}, 0.12)`);
  outerGrad.addColorStop(1,    `rgba(${Math.round(r*255)}, ${Math.round(g*255)}, ${Math.round(b*255)}, 0)`);

  ctx.fillStyle = outerGrad;
  ctx.fillRect(0, 0, size, size);

  // Jasné jádro uprostřed
  const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.12);
  coreGrad.addColorStop(0, '#ffffff');
  coreGrad.addColorStop(0.5, `rgba(${Math.round(r*255)}, ${Math.round(g*255)}, ${Math.round(b*255)}, 0.9)`);
  coreGrad.addColorStop(1,   `rgba(${Math.round(r*255)}, ${Math.round(g*255)}, ${Math.round(b*255)}, 0)`);

  ctx.fillStyle = coreGrad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace  = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Cache textur podle barvy — světla stejné barvy sdílejí texturu.
const _spriteTexCache = new Map();

function getSpriteTex(r, g, b) {
  // Klíč s rozlišením ~4 bity — podobné barvy sdílejí texturu
  const key = `${(r * 15) | 0}:${(g * 15) | 0}:${(b * 15) | 0}`;
  if (!_spriteTexCache.has(key)) {
    _spriteTexCache.set(key, makeSpriteTexture(r, g, b));
  }
  return _spriteTexCache.get(key);
}

/**
 * addLightSprites — přidá do scény viditelné bloom sprite pro každé světlo
 * které má sprite = true (tj. _sprite "1" v BSP entitě).
 *
 * Světla bez sprite = true dostanou pouze PointLight (jako dřív).
 *
 * @param {THREE.Scene} scene
 * @param {Array}       lights  — pole z result.lights (parsováno workerem)
 */
function addLightSprites(scene, lights) {
  if (!lights || !lights.length) return;

  let spriteCount = 0;

  for (const light of lights) {
    const col = new THREE.Color(light.r, light.g, light.b);

    // PointLight vždy — svítí na okolní geometrii
    const range     = Math.min(20, Math.max(2, light.intensity * 0.05));
    const ptIntens  = Math.min(5, Math.max(0.2, light.intensity * 0.015));
    const ptLight   = new THREE.PointLight(col, ptIntens, range);
    ptLight.position.set(light.x, light.y, light.z);
    scene.add(ptLight);

    // Sprite — jen pokud má _sprite 1
    if (!light.sprite) continue;

    const tex = getSpriteTex(light.r, light.g, light.b);

    // THREE.Sprite je vždy otočen ke kameře (billboard) automaticky
    const spriteMat = new THREE.SpriteMaterial({
      map:         tex,
      transparent: true,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,  // additivní → přirozenější glow
      color:       col,
    });

    const sprite = new THREE.Sprite(spriteMat);
    sprite.position.set(light.x, light.y, light.z);
    sprite.scale.setScalar(0.5);   // velikost v world units; doladit dle mapy
    sprite.userData.noclip = true;
    scene.add(sprite);

    spriteCount++;
  }

  console.log(`[Engine] Světla: ${lights.length} celkem, ${spriteCount} se spritem`);
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
  mapUrl          = '/explore/hub/maps/hub.bsp',
  textureBase     = '/explore/hub/textures/',
  mapName         = 'MAP',
  onReady         = null,
  onProgress      = null,
  physicsConfig   = {},
  // Bloom nastavení — lze přepsat z index.html
  bloomStrength   = 0.9,   // intenzita bloom efektu
  bloomRadius     = 0.4,   // rozmazání bloom halo
  bloomThreshold  = 0.2,   // práh — jak světlá musí být barva aby bloomovala
}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping         = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 2.0;

  const scene  = new THREE.Scene();
  scene.fog        = new THREE.FogExp2(0x000000, 0.016);
  scene.background = new THREE.Color(0x000000);

  const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.01, 120);
  camera.position.set(0, PLAYER_HEIGHT * UNIT, 0);

  const ambient = new THREE.AmbientLight(0xffffff, 1.0);
  scene.add(ambient);

  // ── EffectComposer + UnrealBloomPass ──────────────────────────────────────
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    bloomStrength,
    bloomRadius,
    bloomThreshold,
  );
  composer.addPass(bloomPass);

  const portals    = [];
  let   yaw        = 0;
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

    // ── Přidej světla + bloom sprite ────────────────────────────────────────
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

    const portalMeshSet = new Set(portals.map(p => p.mesh));
    scene.traverse(obj => {
      if (
        obj.isMesh &&
        obj.geometry &&
        obj.material?.depthWrite !== false &&
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
      if (obj.isMesh && obj.geometry && obj.material?.depthWrite !== false) {
        worldMeshes.push(obj);
      }
    });
  }

  // ── Fyzika ────────────────────────────────────────────────────────────────
  const physics = createPhysics(scene, physicsConfig);
  physics.refreshCollidables();

  window._cam     = camera;
  window._physics = physics;

  // ── Background music ──────────────────────────────────────────────────────
  const bgMusic = await bgMusicPromise;
  let   bgMusicStarted = false;

  function startBgMusic() {
    if (bgMusicStarted || !bgMusic) return;
    bgMusicStarted = true;
    bgMusic.play().catch(err => console.warn('[Engine] BG music play failed:', err));
  }

  // ── URL hash sync ─────────────────────────────────────────────────────────
  let _lastHashWrite = 0;
  const HASH_WRITE_INTERVAL = 1000;

  // ── Portálový raycaster ───────────────────────────────────────────────────
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

    const portalHit  = portalHits[0];
    const portalDist = portalHit.distance;

    wallRaycaster.ray.copy(portalRaycaster.ray);
    wallRaycaster.near = portalRaycaster.near;
    wallRaycaster.far  = portalDist - 0.05;

    const wallHits = wallRaycaster.intersectObjects(worldMeshes, false);
    if (wallHits.length > 0) return null;

    return portals.find(p => p.mesh === portalHit.object) ?? null;
  }

  // ── Input ─────────────────────────────────────────────────────────────────
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

  // ── Render loop ────────────────────────────────────────────────────────────
  const clock = new THREE.Clock();

  (function tick() {
    requestAnimationFrame(tick);
    const dt = clock.getDelta();

    yaw = physics.update(camera, keys, yaw, dt);

    tickAnimatedTextures();

    for (let i = 0; i < portals.length; i++) {
      const p = portals[i];
      p.mesh.material.opacity = p.opacity;
      p.ptLight.intensity     = 3.0;
    }

    const now = performance.now();
    if (now - _lastHashWrite >= HASH_WRITE_INTERVAL) {
      _lastHashWrite = now;
      writeHashState(
        camera.position.x,
        camera.position.y,
        camera.position.z,
        yaw
      );
    }

    canvas.style.cursor = getHoveredPortal() ? 'pointer' : 'default';

    // Bloom composer místo přímého renderer.render()
    composer.render();
  })();
}
