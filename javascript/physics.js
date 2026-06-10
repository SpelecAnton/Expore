/**
 * SPELEC PHYSICS v4.0 — RAPIER 3D EDITION
 *
 * Nahrazuje vlastní raycast fyziku (v3.x) za Rapier 3D (WASM).
 *
 * Klíčové změny oproti v3.x:
 *
 * 1. WASM FYZIKA:
 *    Rapier běží mimo JS heap → žádný GC pressure, žádné stally.
 *    Žádná SpatialGrid, žádné per-frame intersectObjects smyčky.
 *
 * 2. NATIVNÍ KinematicCharacterController:
 *    Rapier KCC řeší stoupání po schodech, klouzání na svazích,
 *    snap-to-ground, kapsula vs. TriMesh — vše nativně v WASM.
 *
 * 3. TRIMESH COLLIDERY:
 *    Celá BSP geometrie je nahrána jako TriMesh collidery do Rapier světa
 *    jednou při startu. Fyzika pak dotazuje Rapier, ne Three.js meshe.
 *
 * 4. STEJNÉ PUBLIC API:
 *    engine.js ani index.html se nemění. Exportuje createPhysics(scene, cfg).
 *
 * Async inicializace:
 *    RAPIER.init() (WASM load) startuje okamžitě při importu modulu.
 *    refreshCollidables() volaná dříve než WASM doběhne je zařazena do fronty
 *    a spustí se automaticky, jakmile WASM je připraven.
 */

import RAPIER from 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/rapier.es.js';
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';

// ── Spusť načítání WASM ihned při evaluaci modulu ─────────────────────────────
// (probíhá souběžně s načítáním BSP mapy → žádné čekání navíc)
const _rapierReady = RAPIER.init();

// ── Výchozí config (zachovány stejné hodnoty jako v3.x) ──────────────────────
const DEFAULT_CFG = {
  MOVE_SPEED:      280 * 0.02,   // jednotky/s (BSP scale: 1 unit = 0.02 m)
  TURN_SPEED:      2.5,
  LOOK_SPEED:      2.5,
  RETURN_SPEED:    5.0,
  GRAVITY:        -28.0,         // m/s² (kladné nahoru, záporné dolů)
  JUMP_SPEED:      3.0,          // počáteční rychlost skoku m/s
  TERMINAL_VEL:  -30.0,          // max. rychlost pádu m/s
  PLAYER_HEIGHT:   80 * 0.02,   // 1.6 m (výška oka od podlahy)
  PLAYER_RADIUS:   0.28,         // poloměr kapsule
  STEP_HEIGHT:     0.45,         // max výška schodu, na který hráč vyleze
  SLOPE_MAX_ANGLE: 50,           // max úhel svahu (°) pro chůzi
  SKIN_WIDTH:      0.02,         // skin offset pro KCC (1–2 cm)
};

// Pre-alokovaný scratch Vector3 pro _buildCollidables loop (nulová GC zátěž)
const _vtmp = new THREE.Vector3();

// ── Filtr kolizních meshů — stejná pravidla jako v3.x ────────────────────────
function collectCollidables(scene) {
  const list = [];
  scene.traverse(obj => {
    if (!obj.isMesh || !obj.geometry) return;
    if (obj.userData.noclip) return;
    // průhledné materiály bez depthWrite (portály, sklo) = noclip, ale invisible
    // clip brushe (userData.invisible) mají depthWrite === false záměrně → kolize zachovat
    if (obj.material && obj.material.depthWrite === false && !obj.userData.invisible) return;
    if (!obj.geometry.attributes.position) return;
    list.push(obj);
  });
  return list;
}

// ── Hlavní factory ────────────────────────────────────────────────────────────
export function createPhysics(scene, userCFG = {}) {
  const CFG = { ...DEFAULT_CFG, ...userCFG };

  // ── Rapier objekty (vyplněny po _initRapier) ──
  let world      = null;
  let charBody   = null;   // kinematické tuhé těleso hráče
  let charCol    = null;   // kapsula collider hráče
  let controller = null;   // KinematicCharacterController

  let _ready          = false;  // true po dokončení WASM + inicializace světa
  let _collidersBuilt = false;  // true po nahrání statických TriMesh colliderů
  let _pendingRefresh = false;  // refreshCollidables() volaná před _ready
  let _firstSync      = true;   // při prvním update() synchonizuj tělo s kamerou

  // Handlery statických colliderů pro možnost přestavby
  let _staticHandles = [];

  // ── Stav hráče ──
  const velocity     = new THREE.Vector3();
  let   onGround     = false;
  let   currentPitch = 0;

  const _move  = new THREE.Vector3();
  const _yAxis = new THREE.Vector3(0, 1, 0);

  // Geometrie kapsuly odvozená z CFG:
  //   Rapier capsule: celková výška = 2 * (halfHeight + radius)
  //   → halfHeight = (PLAYER_HEIGHT - 2 * radius) / 2
  const _capsuleHalfH = Math.max(0.01, (CFG.PLAYER_HEIGHT - 2 * CFG.PLAYER_RADIUS) / 2);

  // Offset oka od středu kapsuly = PLAYER_HEIGHT / 2
  //   střed kapsuly Y = eye Y - _eyeOffset
  const _eyeOffset = CFG.PLAYER_HEIGHT / 2;

  // ── Async inicializace Rapier ──────────────────────────────────────────────
  async function _initRapier() {
    await _rapierReady;

    // Svět — gravitace nastavena pro případ dynamických těles v budoucnu.
    // Na kinematiské tělo hráče gravitace nemá vliv (aplikujeme ručně).
    world = new RAPIER.World({ x: 0.0, y: CFG.GRAVITY, z: 0.0 });

    // Kinematické tuhé těleso hráče
    charBody = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());

    // Kapsula collider — friktce 0 (KCC si sám řídí klouzání)
    const colDesc = RAPIER.ColliderDesc
      .capsule(_capsuleHalfH, CFG.PLAYER_RADIUS)
      .setFriction(0.0)
      .setRestitution(0.0);
    charCol = world.createCollider(colDesc, charBody);

    // KinematicCharacterController (skin offset = CFG.SKIN_WIDTH)
    controller = world.createCharacterController(CFG.SKIN_WIDTH);

    // Maximální úhel svahu pro stoupání (v radiánech)
    controller.setMaxSlopeClimbAngle(CFG.SLOPE_MAX_ANGLE * Math.PI / 180);
    // Minimální úhel pro kluuz ze svahu (stejný → bez šedé zóny)
    controller.setMinSlopeSlideAngle(CFG.SLOPE_MAX_ANGLE * Math.PI / 180);
    // Automatické stoupání po schodech: max výška, min šířka schodu, includeeDynamic
    controller.enableAutostep(CFG.STEP_HEIGHT, CFG.PLAYER_RADIUS * 0.5, true);
    // Přichytávání k zemi (zabraňuje "floating" na hranách)
    controller.enableSnapToGround(0.5);
    // Neaplikovat impulsy na dynamická tělesa (hra je walksim, ne fyzikální)
    controller.setApplyImpulsesToDynamicBodies(false);

    _ready = true;
    console.log('[Physics] Rapier 3D KCC připraven ✓');

    // Pokud refreshCollidables() bylo voláno ještě před tímto okamžikem,
    // spustíme stavbu colliderů teď
    if (_pendingRefresh) _buildCollidables();
  }

  _initRapier().catch(err => console.error('[Physics] Init selhal:', err));

  // ── Veřejná funkce: refresh colliderů ────────────────────────────────────
  function refreshCollidables() {
    if (!_ready) {
      // WASM ještě není hotový — zařadíme do fronty
      _pendingRefresh = true;
      return;
    }
    _buildCollidables();
  }

  // ── Interní: stavba TriMesh colliderů ze scény ────────────────────────────
  function _buildCollidables() {
    _pendingRefresh = false;
    scene.updateMatrixWorld(true);

    // Odstraň staré statické collidery (např. při reloadu mapy)
    for (const handle of _staticHandles) {
      const col = world.getCollider(handle);
      if (col) world.removeCollider(col, false /* wakeUp = false */);
    }
    _staticHandles = [];

    const meshes = collectCollidables(scene);
    let built = 0;
    let skipped = 0;

    for (const mesh of meshes) {
      const geo = mesh.geometry;
      if (!geo.attributes.position) continue;

      const posAttr = geo.attributes.position;
      const n       = posAttr.count;

      // Extrahuj vrcholy transformované do world-space
      // Používáme _vtmp scratch Vector3 — žádné per-vertex alokace
      const verts = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        _vtmp.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
        verts[i * 3]     = _vtmp.x;
        verts[i * 3 + 1] = _vtmp.y;
        verts[i * 3 + 2] = _vtmp.z;
      }

      // Extrahuj indexy trojúhelníků
      let indices;
      const idxAttr = geo.index;
      if (idxAttr) {
        indices = new Uint32Array(idxAttr.count);
        for (let i = 0; i < idxAttr.count; i++) indices[i] = idxAttr.getX(i);
      } else {
        // Neindexovaná geometrie — sequential indexy
        indices = new Uint32Array(n);
        for (let i = 0; i < n; i++) indices[i] = i;
      }

      if (indices.length < 3) continue;

      try {
        const colDesc = RAPIER.ColliderDesc
          .trimesh(verts, indices)
          .setFriction(0.7)
          .setRestitution(0.0);

        const col = world.createCollider(colDesc);
        _staticHandles.push(col.handle);
        built++;
      } catch (e) {
        // Degenerovaná nebo non-manifold geometrie může hodit — přeskočíme
        console.warn(
          `[Physics] TriMesh přeskočen: ${mesh.name || mesh.uuid.slice(0, 8)} — ${e.message}`,
        );
        skipped++;
      }
    }

    _collidersBuilt = true;
    console.log(
      `[Physics] Collidery: ${built} postaveny, ${skipped} přeskočeno (z ${meshes.length} meshů)`,
    );
  }

  // ── Hlavní update — volán každý frame z engine.js ─────────────────────────
  function update(camera, keys, yaw, dt) {
    // Dokud Rapier a collidery nejsou připraveny, přeskočíme fyziku
    // (kamera stojí na místě — to je OK, loadovací obrazovka zakrývá začátek)
    if (!_ready || !_collidersBuilt) return yaw;

    dt = Math.min(dt, 0.05);

    // ── Otočení / look ────────────────────────────────────────────────────────
    if (keys['a'] || keys['arrowleft'])  yaw += CFG.TURN_SPEED * dt;
    if (keys['d'] || keys['arrowright']) yaw -= CFG.TURN_SPEED * dt;

    const MAX_PITCH = 45 * Math.PI / 180;
    if (keys['q']) {
      currentPitch = Math.max(currentPitch - CFG.LOOK_SPEED * dt, -MAX_PITCH);
    } else if (keys['e']) {
      currentPitch = Math.min(currentPitch + CFG.LOOK_SPEED * dt, MAX_PITCH);
    } else if (currentPitch !== 0) {
      const sign = Math.sign(currentPitch);
      currentPitch -= sign * CFG.RETURN_SPEED * dt;
      if (Math.sign(currentPitch) !== sign) currentPitch = 0;
    }
    camera.rotation.set(currentPitch, yaw, 0, 'YXZ');

    // ── Horizontální pohyb ────────────────────────────────────────────────────
    _move.set(0, 0, 0);
    if (keys['w'] || keys['arrowup'])   _move.z -= 1;
    if (keys['s'] || keys['arrowdown']) _move.z += 1;
    if (_move.lengthSq() > 0) {
      _move.normalize().multiplyScalar(CFG.MOVE_SPEED * dt).applyAxisAngle(_yAxis, yaw);
    }

    // ── Skok ─────────────────────────────────────────────────────────────────
    if ((keys[' '] || keys['space']) && onGround) {
      velocity.y = CFG.JUMP_SPEED;
      onGround   = false;
    }

    // ── Gravitace (ruční — kinematická tělesa Rapier gravitaci ignorují) ──────
    if (!onGround) {
      velocity.y += CFG.GRAVITY * dt;
      velocity.y  = Math.max(velocity.y, CFG.TERMINAL_VEL);
    } else {
      velocity.y = Math.min(velocity.y, 0);
    }

    // ── První frame: synchronizuj Rapier tělo na pozici kamery ───────────────
    // Bez toho by na prvním frame bylo tělo na (0,0,0) a KCC by počítal
    // pohyb ze špatné startovní pozice.
    if (_firstSync) {
      _firstSync = false;
      charBody.setNextKinematicTranslation({
        x: camera.position.x,
        y: camera.position.y - _eyeOffset,
        z: camera.position.z,
      });
      world.step(); // okamžitě aplikiuj — broad-phase zná správnou pozici
    }

    // ── Rapier KinematicCharacterController ──────────────────────────────────
    // Požadovaný pohyb = horizontální input + vertikální (gravitace/skok)
    const desired = {
      x: _move.x,
      y: velocity.y * dt,
      z: _move.z,
    };

    // computeColliderMovement provede shape cast z aktuální pozice kapsule
    // a vrátí korigovaný pohyb (bez průchodů stěnami, se stoupáním po schodech)
    controller.computeColliderMovement(charCol, desired);

    const corrected = controller.computedMovement();
    onGround = controller.computedGrounded();

    // Resetuj vertikální rychlost při přistání (zabraňuje akumulaci záporné vy)
    if (onGround && velocity.y < 0) velocity.y = 0;

    // Aplikuj korigovaný pohyb na kameru
    camera.position.x += corrected.x;
    camera.position.y += corrected.y;
    camera.position.z += corrected.z;

    // Naplánuj novou kinematickou pozici těla (aplikuje se v world.step())
    // Střed kapsuly = eye Y − _eyeOffset (= eye Y − PLAYER_HEIGHT/2)
    charBody.setNextKinematicTranslation({
      x: camera.position.x,
      y: camera.position.y - _eyeOffset,
      z: camera.position.z,
    });

    // Advance physics world — aplikuje kinematické posuny do broad-phase,
    // aby příští frame měl správné pozice pro shape casts
    world.step();

    return yaw;
  }

  // ── Veřejné API (identické s v3.x) ───────────────────────────────────────
  return {
    update,
    refreshCollidables,

    teleport(camera, x, y, z) {
      camera.position.set(x, y, z);
      velocity.set(0, 0, 0);
      onGround     = false;
      currentPitch = 0;
      // Vynuť re-sync Rapier těla na novou pozici při příštím update()
      _firstSync = true;
    },

    get isOnGround() { return onGround; },
    get velocityY()  { return velocity.y; },
  };
}
