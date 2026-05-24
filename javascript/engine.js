/**
 * SPELEC EXPLORE ENGINE v6.4 — WORKER LOADING EDITION
 *
 * Změny oproti v6.2:
 * - Předává onProgress do loadBSP → loading bar reaguje reálně na průběh
 * parsování (ne jen falešný ticker)
 * - Ticker v index.html lze zrušit — engine posílá přesná % zpět přes callback
 * - Zbytek kódu beze změny (render loop, portály, fyzika)
 *
 * Změny v6.4:
 * - Portál podporuje vlastnost "opacity" (0.0–1.0, výchozí 0.78)
 * - Portál podporuje "width" a "height" v BSP jednotkách
 * - Pokud není zadáno width/height, použije se "size" → čtverec
 * - Pokud není zadáno nic, výchozí čtverec 110×110
 * - OPRAVA: Průhlednost a světla již nejsou animovaná, drží statické hodnoty
 * - OPRAVA 2: Okraj (border) portálu nyní správně aplikuje transparentnost
 * * Úprava (Label):
 * - Pokud je label prázdný, nezobrazuje se URL ani prázdný mesh letadla.
 *
 * Změny v6.5:
 * - OPRAVA: Portály nelze klikat skrz zdi — getHoveredPortal() nyní
 *   kontroluje, zda mezi kamerou a portálem nestojí geometrie světa.
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';
import { loadBSP, tickAnimatedTextures } from 'https://cdn.jsdelivr.net/gh/SpelecAnton/Expore@main/javascript/bsp_loader.js';
import { createPhysics } from 'https://cdn.jsdelivr.net/gh/SpelecAnton/Expore@main/javascript/physics.js';

const PLAYER_HEIGHT = 80;
const FOV           = 90;
const UNIT          = 0.02;

// ── Portal label ──────────────────────────────────────────────────────────────
function buildPortalLabel(label, col, mesh) {
  // Pokud je label prázdný, nebudeme vytvářet texturu ani mesh
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

  const tex     = new THREE.CanvasTexture(canvas);
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
  
  // OPRAVA: Pokud label neexistuje nebo obsahuje jen mezery, nastavíme prázdný řetězec místo URL
  const label = props.label ? props.label.trim() : '';

  const col   = new THREE.Color().setHex(
    parseInt((props.color || '0xff2200').replace('#', ''), 16)
  );
  const angle = parseFloat(props.angle || '0') * Math.PI / 180;

  // Rozměry portálu:
  const defaultSize = props.size || '110';
  const w = parseFloat(props.width  || defaultSize) * UNIT;
  const h = parseFloat(props.height || defaultSize) * UNIT;

  // Průhlednost portálu: 0.0 = zcela průhledný, 1.0 = plně viditelný
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

  // FIX: Přidán explicitní transparent: true pro materiál linky, aby opacity fungovala
  mesh.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: col, opacity: opacity, transparent: true })
  ));

  const ptLight = new THREE.PointLight(col, 3.0, 7);
  ptLight.position.set(x, y, z);
  scene.add(ptLight);

  buildPortalLabel(label, col, mesh);
  
  portals.push({ x, y, z, url, label, col, mesh, ptLight, opacity });
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
  mapUrl      = '/explore/hub/maps/hub.bsp',
  textureBase = '/explore/hub/textures/',
  mapName     = 'MAP',
  onReady     = null,
  onProgress  = null,
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

  const portals = [];
  let   yaw     = 0;

  // Kolekce světových meshů pro kontrolu okluzí portálů (naplní se po načtení BSP)
  let worldMeshes = [];

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

    if (result.playerStart) {
      const ps = result.playerStart;
      camera.position.set(ps.x, ps.y + PLAYER_HEIGHT * UNIT, ps.z);
      yaw = ps.angle * Math.PI / 180;
    }

    // Sbírej světové meše pro okluzi (všechny meše se zápisem do hloubky,
    // ale ne samotné portálové meše)
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

    // I v fallback místnosti sbíráme meše
    scene.traverse(obj => {
      if (obj.isMesh && obj.geometry && obj.material?.depthWrite !== false) {
        worldMeshes.push(obj);
      }
    });
  }

  // ── Fyzika ────────────────────────────────────────────────────────────────
  const physics = createPhysics(scene);
  window._cam     = camera;
  window._physics = physics;

  // ── Portálový raycaster ───────────────────────────────────────────────────
  const portalRaycaster = new THREE.Raycaster();
  const wallRaycaster   = new THREE.Raycaster();
  const mouseNDC        = new THREE.Vector2(0, 0);
  const portalMeshes    = portals.map(p => p.mesh);

  window.addEventListener('mousemove', e => {
    mouseNDC.x =  (e.clientX / window.innerWidth)  * 2 - 1;
    mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
  });

  /**
   * Vrátí portál, na který hráč míří — ale jen pokud mezi kamerou a portálem
   * nestojí žádná geometrie světa (stěna, podlaha, strop…).
   */
  function getHoveredPortal() {
    if (!portalMeshes.length) return null;

    // 1. Zjisti, který portálový mesh paprsek zasáhne
    portalRaycaster.setFromCamera(mouseNDC, camera);
    const portalHits = portalRaycaster.intersectObjects(portalMeshes, false);
    if (!portalHits.length) return null;

    const portalHit = portalHits[0];
    const portalDist = portalHit.distance;

    // 2. Spusť stejný paprsek přes světovou geometrii a zkontroluj vzdálenost
    //    Pokud je zeď blíže než portál, portál je zakrytý → ignoruj klik.
    wallRaycaster.ray.copy(portalRaycaster.ray);
    wallRaycaster.near = portalRaycaster.near;
    wallRaycaster.far  = portalDist - 0.05; // malý offset, aby portálová rovina sama sebe nezakryla

    const wallHits = wallRaycaster.intersectObjects(worldMeshes, false);
    if (wallHits.length > 0) {
      // Mezi kamerou a portálem je zeď
      return null;
    }

    return portals.find(p => p.mesh === portalHit.object) ?? null;
  }

  // ── Input ─────────────────────────────────────────────────────────────────
  const keys = {};
  window.addEventListener('keydown', e => {
    keys[e.key.toLowerCase()] = true;
    if (e.key === ' ') e.preventDefault();
    document.querySelectorAll('video').forEach(v => v.play().catch(() => {}));
  });
  window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

  window.addEventListener('click', () => {
    const portal = getHoveredPortal();
    if (!portal) return;
    document.getElementById('fade')?.classList.add('out');
    setTimeout(() => { window.location.href = portal.url; }, 350);
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  if (onReady) onReady();

  // ── Render loop ────────────────────────────────────────────────────────────
  const clock = new THREE.Clock();

  (function tick() {
    requestAnimationFrame(tick);
    const dt = clock.getDelta();

    yaw = physics.update(camera, keys, yaw, dt);

    tickAnimatedTextures();

    // Portály drží statické hodnoty bez animací
    for (let i = 0; i < portals.length; i++) {
      const p = portals[i];
      p.mesh.material.opacity = p.opacity;
      p.ptLight.intensity     = 3.0; 
    }

    canvas.style.cursor = getHoveredPortal() ? 'pointer' : 'default';
    renderer.render(scene, camera);
  })();
}
