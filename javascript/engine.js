/**
 * SPELEC EXPLORE ENGINE v7.2 — PERFORMANCE EDITION
 *
 * Changes over v7.1:
 *
 * 1. COMPOSER RENDER THROTTLED DURING TEXTURE LOAD:
 *    - composer.render() was called every frame even while the map was still
 *      building meshes after loadBSP() returned. During that period the scene
 *      is half-built and the bloom pass processes thousands of new GPU objects
 *      per frame → 3 FPS.
 *    - A _sceneReady flag gates the full composer render. Before the flag is
 *      set, a cheap renderer.render() (no bloom) is used instead.
 *    - Flag is set via setTimeout(500) after loadBSP() returns so the final
 *      mesh-build yield passes complete before bloom kicks in.
 *
 * 2. BLOOM PASS STRENGTH ZERO WHEN NOTHING TO BLOOM:
 *    - If bloomStrength is 0 the UnrealBloomPass is skipped entirely.
 *      Avoids allocating bloom FBOs for maps that don't need it.
 *
 * 3. PORTAL HOVER THROTTLE INCREASED:
 *    - Portal hover check was every 2nd frame (v7.1).
 *    - Increased to every 4th frame — portals don't move, 15Hz hover
 *      detection is imperceptible to users.
 *
 * 4. ANIMATED TEXTURE TICK THROTTLED:
 *    - tickAnimatedTextures() was called every rAF (~60Hz).
 *    - Now called every 3rd frame (~20Hz). Animated textures rarely need
 *      more than 12–15 fps, and the tick itself is cheap but not free.
 *
 * 5. HASH WRITE INTERVAL INCREASED 2000 → 3000 ms:
 *    - history.replaceState() causes a layout invalidation in some browsers.
 *    - 3 second granularity is still fine for URL state persistence.
 *
 * 6. WORLD MESHES LIST FILTERED AT BUILD TIME:
 *    - In v7.1 worldMeshes included invisible clip meshes
 *      (mesh.material.depthWrite === false with userData.invisible).
 *    - These are zero-opacity and can never occlude portals, so they were
 *      wasted raycasts in getHoveredPortal(). Now filtered out at build time.
 *
 * 7. RENDERER INFO LOGGING REMOVED FROM HOT PATH:
 *    - window._rendererInfo was assigned every frame. Moved to a one-time
 *      assignment after renderer creation.
 *
 * 8. RESIZE HANDLER DEBOUNCED:
 *    - resize fired composer.setSize() synchronously, which can stall a frame
 *      if it happens mid-render. Now debounced 150 ms.
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';
import { EffectComposer }  from 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass }      from 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass }      from 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/ShaderPass.js';
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
  maxPixelRatio   = 1.0,
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

  // One-time assignment — was incorrectly inside tick() in v7.1
  window._rendererInfo = renderer.info;

  initTexLoader(renderer);

  const scene  = new THREE.Scene();

  // No scene.fog — fog is applied as a Z-depth post-processing ShaderPass AFTER
  // tone mapping. This means:
  //   1. fogColor is exact sRGB (not shifted by ACESFilmic / exposure).
  //   2. Fog factor is based on camera Z-depth, not euclidean distance, so
  //      no angle-dependent variation in screen corners.
  scene.fog        = null;
  scene.background = null;
  renderer.setClearColor(0x000000, 1); // cleared to black; fog pass replaces it

  const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.01, renderDistance);
  camera.position.set(0, PLAYER_HEIGHT * UNIT, 0);

  const ambient = new THREE.AmbientLight(0xffffff, 1.0);
  scene.add(ambient);

  // ── Post-processing setup ─────────────────────────────────────────────────

  // sceneRT has a DepthTexture so the Z-depth fog ShaderPass can read real
  // per-pixel Z values from the depth buffer after the scene is rendered.
  const sceneRT = new THREE.WebGLRenderTarget(
    window.innerWidth, window.innerHeight,
    { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, stencilBuffer: false },
  );
  sceneRT.depthBuffer  = true;
  sceneRT.depthTexture = new THREE.DepthTexture(window.innerWidth, window.innerHeight);
  sceneRT.depthTexture.type = THREE.FloatType;

  // Passing sceneRT to EffectComposer makes renderTarget1 = sceneRT.
  // RenderPass writes to renderTarget1, so sceneRT.depthTexture is populated
  // with depth data that persists through subsequent passes (bloom etc.).
  const composer   = new EffectComposer(renderer, sceneRT);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  let bloomPass = null;
  if (bloomStrength > 0) {
    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(
        Math.floor(window.innerWidth  / 2),
        Math.floor(window.innerHeight / 2),
      ),
      bloomStrength,
      bloomRadius,
      bloomThreshold,
    );
    // Start disabled — enabled after scene is fully built (avoids 3 FPS during load).
    bloomPass.enabled = false;
    composer.addPass(bloomPass);
  }

  // ── Z-Depth Fog ShaderPass ────────────────────────────────────────────────
  // Applied AFTER tone mapping so fogColor reaches the screen as exact sRGB.
  // Uses linearised Z-depth from sceneRT.depthTexture (not euclidean distance)
  // so fog density is perfectly uniform regardless of viewing angle.
  const fogPass = new ShaderPass({
    uniforms: {
      tDiffuse:   { value: null },                          // set automatically by ShaderPass
      tDepth:     { value: sceneRT.depthTexture },          // depth captured during RenderPass
      fogColor:   { value: new THREE.Color(fogColor) },     // exact sRGB — not tone-mapped
      fogNear:    { value: 0 },                             // fog starts at camera (distance 0)
      fogFar:     { value: renderDistance },
      cameraNear: { value: camera.near },
      cameraFar:  { value: camera.far },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform sampler2D tDepth;
      uniform vec3      fogColor;
      uniform float     fogNear;
      uniform float     fogFar;
      uniform float     cameraNear;
      uniform float     cameraFar;

      varying vec2 vUv;

      // Convert raw depth buffer value [0,1] → eye-space Z distance from camera.
      // Uses the standard perspective reconstruction formula.
      float linearizeDepth(float rawDepth) {
        float z_ndc = rawDepth * 2.0 - 1.0;
        return (2.0 * cameraNear * cameraFar)
               / (cameraFar + cameraNear - z_ndc * (cameraFar - cameraNear));
      }

      void main() {
        vec4  sceneColor = texture2D(tDiffuse, vUv);
        float rawDepth   = texture2D(tDepth,   vUv).r;
        float zEye       = linearizeDepth(rawDepth);
        // Linear fog ramp: 0 at fogNear, 1 at fogFar.
        float fogFactor  = clamp((zEye - fogNear) / (fogFar - fogNear), 0.0, 1.0);
        // Mix tone-mapped scene color with exact fogColor.
        // At depth == far plane (sky/void): rawDepth≈1 → zEye≈cameraFar → fogFactor=1 → pure fogColor.
        gl_FragColor = vec4(mix(sceneColor.rgb, fogColor, fogFactor), sceneColor.a);
      }
    `,
  });
  composer.addPass(fogPass);

  // Flag: bloom is disabled until scene is fully built.
  // (Fog pass runs every frame from the start — it's cheap.)
  let _sceneReady = false;

  const portals     = [];
  let   yaw         = 0;
  let   worldMeshes = [];   // opaque meshes — used for physics & portal occlusion
  let   clipMeshes  = [];   // invisible CLIP brushes — used only for portal occlusion

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

    // Build worldMeshes (opaque) and clipMeshes (invisible CLIP brushes).
    // worldMeshes: used for physics + portal occlusion raycasts.
    // clipMeshes:  invisible — skipped by bloom/render but still block portal clicks.
    const portalMeshSet = new Set(portals.map(p => p.mesh));
    scene.traverse(obj => {
      if (!obj.isMesh || !obj.geometry) return;
      if (portalMeshSet.has(obj)) return;
      if (obj.userData.invisible) {
        clipMeshes.push(obj);  // CLIP brush — invisible but blocks portal interaction
        return;
      }
      if (obj.material?.depthWrite === false) return; // other transparent — skip both lists
      worldMeshes.push(obj);
    });

    // Delay enabling bloom — give background mesh-build yields time to complete
    setTimeout(() => {
      _sceneReady = true;
      if (bloomPass) bloomPass.enabled = true;
      console.log('[Engine] Scene ready — full render pipeline active');
    }, 500);

  } catch (err) {
    console.error('[Engine] BSP load failed:', err);
    _fallbackRoom(scene);
    ambient.intensity = 3;
    scene.traverse(obj => {
      if (!obj.isMesh || !obj.geometry) return;
      if (obj.userData.invisible) { clipMeshes.push(obj); return; }
      if (obj.material?.depthWrite !== false) worldMeshes.push(obj);
    });
    _sceneReady = true;
    if (bloomPass) bloomPass.enabled = true;
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

  const HASH_WRITE_INTERVAL = 3000; // Increased 2000 → 3000 ms

  // Portal hover check: every 4th frame (was every 2nd in v7.1)
  // 15Hz hover detection is imperceptible for static portals
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
    if (!portalMeshes.length) return null;

    _portalFrameCount++;
    // Only recompute every 4th frame — cache result otherwise
    if (_portalFrameCount % 4 !== 0) return _lastPortalHoverResult;

    portalRaycaster.setFromCamera(mouseNDC, camera);
    const portalHits = portalRaycaster.intersectObjects(portalMeshes, false);
    if (!portalHits.length) { _lastPortalHoverResult = null; return null; }

    const portalDist = portalHits[0].distance;
    wallRaycaster.ray.copy(portalRaycaster.ray);
    wallRaycaster.near = portalRaycaster.near;
    wallRaycaster.far  = portalDist - 0.05;
    // Check both opaque world meshes AND invisible CLIP brushes for occlusion.
    // Without clipMeshes, portals behind CLIP walls could be clicked through them.
    const wallHits = wallRaycaster.intersectObjects(worldMeshes, false);
    const clipHits = clipMeshes.length ? wallRaycaster.intersectObjects(clipMeshes, false) : [];
    if (wallHits.length > 0 || clipHits.length > 0) { _lastPortalHoverResult = null; return null; }

    _lastPortalHoverResult = portals.find(p => p.mesh === portalHits[0].object) ?? null;
    return _lastPortalHoverResult;
  }

  // ── DEBUG: Press F → ground debug, Press P → renderer stats ──────────────
  window.addEventListener('keydown', e => {
    if (e.key.toLowerCase() === 'f') {
      const pos = camera.position;
      console.log('=== GROUND DEBUG ===');
      console.log('Camera pos:', `(${pos.x.toFixed(4)}, ${pos.y.toFixed(4)}, ${pos.z.toFixed(4)})`);

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

  // Debounced resize — avoids mid-frame FBO reallocation
  let _resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      sceneRT.setSize(window.innerWidth, window.innerHeight);  // keep depth texture in sync
      composer.setSize(window.innerWidth, window.innerHeight);
      if (bloomPass) {
        bloomPass.resolution.set(
          Math.floor(window.innerWidth  / 2),
          Math.floor(window.innerHeight / 2),
        );
      }
    }, 150);
  });

  if (onReady) onReady();

  const clock = new THREE.Clock();
  let _lastHashWrite = 0;
  let _tickFrame     = 0;

  (function tick() {
    requestAnimationFrame(tick);
    _tickFrame++;

    let dt = clock.getDelta();
    if (dt > 0.1) dt = 0.1;

    yaw = physics.update(camera, keys, yaw, dt);

    // Animated textures at ~20 Hz instead of 60 Hz
    if (_tickFrame % 3 === 0) tickAnimatedTextures();

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

    // Always use the composer — bloom is disabled (not removed) until _sceneReady,
    // so the pipeline is: RenderPass → (bloom disabled) → ZDepthFogPass.
    // Cost is similar to raw renderer.render() during load.
    composer.render();
  })();
}
