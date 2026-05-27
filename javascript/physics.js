/**
 * SPELEC PHYSICS v1.5 — SWEEP FIX
 *
 * Změny oproti v1.4:
 * - groundCheck: checkDist zvýšen z PLAYER_HEIGHT + GROUND_CHECK (1.78)
 *   na PLAYER_HEIGHT + 2.0 → paprsek dosáhne podlahy i při rychlém pádu.
 * - groundCheck: start paprsku posunut z +0.05 na +0.25 nad pozicí hráče
 *   → paprsek nezačíná pod geometrií při drobném průniku.
 * - update(): swept fallback — pokud groundCheck na nové pozici vrátí null
 *   a hráč padá, zkontrolujeme předchozí pozici; pokud tam byla podlaha
 *   a hráč ji přeskočil (tenký brush), přichytíme ho na ni.
 *   Eliminuje propadání rovnými brushy při vysoké rychlosti pádu.
 *
 * v1.4 — optimalizace collidables (CULL_DIST, refreshCollidables veřejná)
 * v1.3 — noclip podpora
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';

const DEFAULT_CFG = {
  MOVE_SPEED:    280 * 0.02,
  TURN_SPEED:    2.5,
  LOOK_SPEED:    2.5,
  RETURN_SPEED:  5.0,
  GRAVITY:       -28.0,
  JUMP_SPEED:     3.0,
  TERMINAL_VEL:  -30.0,
  PLAYER_HEIGHT:  80 * 0.02,
  PLAYER_RADIUS:   0.28,
  PLAYER_MASS:     1.0,
  STEP_HEIGHT:     0.45,
  SLOPE_MAX_ANGLE: 50,
  SKIN_WIDTH:      0.02,
  GROUND_CHECK:    0.18,
  NUM_SIDE_RAYS:   8,
  NUM_SLOPE_RAYS:  4,

  // OPTIMALIZACE: Maximální vzdálenost pro zahrnutí meshe do kolizních testů.
  // Meshe dál než CULL_DIST jednotek od hráče jsou přeskočeny ještě před
  // výpočtem boundingSphere → výrazně méně práce při velkých mapách.
  CULL_DIST: 30,
};

function collectCollidables(scene) {
  const list = [];
  scene.traverse(obj => {
    if (obj.isMesh && obj.geometry) {
      if (obj.userData.noclip) return;
      if (obj.material && obj.material.depthWrite === false) return;
      if (!obj.geometry.attributes.position) return;
      list.push(obj);
    }
  });
  return list;
}

// Sdílený vektor pro nearbyMeshes — vyhne se alokaci na každé volání.
const _scaleVec  = new THREE.Vector3();
const _centerVec = new THREE.Vector3();

// OPTIMALIZACE: Dvoustupňový filtr:
//   1. Rychlý CULL_DIST test (squared distance, žádná odmocnina) →
//      vyhodí vzdálené meshe ještě před výpočtem boundingSphere.
//   2. Přesný boundingSphere test pro zbývající kandidáty.
function nearbyMeshes(collidables, origin, maxDist, cullDistSq) {
  const result = [];

  for (const mesh of collidables) {
    // Stupeň 1: hrubý prostorový cull (světové pozice meshe)
    const wx = mesh.matrixWorld.elements[12];
    const wy = mesh.matrixWorld.elements[13];
    const wz = mesh.matrixWorld.elements[14];
    const dx = wx - origin.x, dy = wy - origin.y, dz = wz - origin.z;
    if (dx*dx + dy*dy + dz*dz > cullDistSq) continue;

    // Stupeň 2: přesný boundingSphere test
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    _centerVec.copy(mesh.geometry.boundingSphere.center)
              .applyMatrix4(mesh.matrixWorld);

    _scaleVec.setFromMatrixScale(mesh.matrixWorld);
    const maxScale = Math.max(_scaleVec.x, _scaleVec.y, _scaleVec.z);
    const r = mesh.geometry.boundingSphere.radius * maxScale;

    const totalDist = maxDist + r;
    if (_centerVec.distanceToSquared(origin) < totalDist * totalDist) {
      result.push(mesh);
    }
  }
  return result;
}

export function createPhysics(scene, userCFG = {}) {

  const CFG = { ...DEFAULT_CFG, ...userCFG };
  const cullDistSq = CFG.CULL_DIST * CFG.CULL_DIST;

  const velocity = new THREE.Vector3(0, 0, 0);
  let   onGround = false;
  let   collidables = [];
  let   currentPitch = 0;

  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;

  const _dir    = new THREE.Vector3();
  const _origin = new THREE.Vector3();
  const _move   = new THREE.Vector3();
  const _yAxis  = new THREE.Vector3(0, 1, 0);

  let collidablesReady = false;

  // OPTIMALIZACE: refreshCollidables je veřejná — engine.js ji zavolá
  // ihned po loadBSP(), takže první frame fyziky nemá žádný overhead.
  function refreshCollidables() {
    collidables = collectCollidables(scene);
    collidablesReady = true;
    console.log(`[Physics] Kolizní objekty: ${collidables.length}`);
  }

  function groundCheck(position) {
    const offsets = [
      [0, 0],
      ...Array.from({ length: CFG.NUM_SLOPE_RAYS }, (_, i) => {
        const a = (i / CFG.NUM_SLOPE_RAYS) * Math.PI * 2;
        return [Math.cos(a) * CFG.PLAYER_RADIUS * 0.7,
                Math.sin(a) * CFG.PLAYER_RADIUS * 0.7];
      }),
    ];

    let highestHit = null;

    // FIX v1.5: checkDist zvýšen — paprsek musí dosáhnout podlahy i při
    // rychlém pádu (terminal velocity −30 * dt 0.05 = 1.5 j/frame).
    // Původní hodnota PLAYER_HEIGHT + GROUND_CHECK = ~1.78 nestačila.
    const checkDist = CFG.PLAYER_HEIGHT + 2.0;

    for (const [ox, oz] of offsets) {
      // FIX v1.5: start paprsku posunut z +0.05 na +0.25 — při drobném
      // průniku do geometrie paprsek nezačínal uvnitř meshe a míjel ho.
      _origin.set(position.x + ox, position.y + 0.25, position.z + oz);
      raycaster.set(_origin, new THREE.Vector3(0, -1, 0));
      raycaster.far = checkDist;

      const nearby = nearbyMeshes(collidables, _origin, checkDist + 1, cullDistSq);
      const hits   = raycaster.intersectObjects(nearby, false);

      if (hits.length > 0) {
        const hit = hits[0];

        let normal = hit.face?.normal
          .clone()
          .transformDirection(hit.object.matrixWorld) ?? _yAxis.clone();

        if (normal.dot(raycaster.ray.direction) > 0) normal.negate();

        const angle = Math.acos(Math.max(-1, Math.min(1,
          normal.dot(_yAxis)))) * (180 / Math.PI);

        if (angle < CFG.SLOPE_MAX_ANGLE) {
          const groundY = hit.point.y + CFG.PLAYER_HEIGHT;
          if (highestHit === null || groundY > highestHit) {
            highestHit = groundY;
          }
        }
      }
    }

    return highestHit;
  }

  function resolveWalls(position, moveDelta) {
    const resolved = moveDelta.clone();
    const checkHeights = [
      CFG.PLAYER_HEIGHT * 0.5,
      CFG.PLAYER_HEIGHT * 0.15,
    ];

    for (const yOff of checkHeights) {
      _origin.set(position.x, position.y - yOff, position.z);

      for (let i = 0; i < CFG.NUM_SIDE_RAYS; i++) {
        const angle = (i / CFG.NUM_SIDE_RAYS) * Math.PI * 2;
        _dir.set(Math.cos(angle), 0, Math.sin(angle));

        raycaster.set(_origin, _dir);
        raycaster.far = CFG.PLAYER_RADIUS + CFG.SKIN_WIDTH;

        const nearby = nearbyMeshes(collidables, _origin, CFG.PLAYER_RADIUS + 1.0, cullDistSq);
        const hits   = raycaster.intersectObjects(nearby, false);

        if (hits.length > 0) {
          const hit = hits[0];

          let normal = hit.face?.normal
            .clone()
            .transformDirection(hit.object.matrixWorld) ?? new THREE.Vector3();

          if (normal.dot(raycaster.ray.direction) > 0) normal.negate();

          const slopeAngle = Math.acos(
            Math.max(-1, Math.min(1, normal.dot(_yAxis)))
          ) * (180 / Math.PI);

          if (slopeAngle > CFG.SLOPE_MAX_ANGLE) {
            const flatNormal = new THREE.Vector3(normal.x, 0, normal.z).normalize();
            const dot = resolved.dot(flatNormal);
            if (dot < 0) resolved.addScaledVector(flatNormal, -dot);

            const penetration = CFG.PLAYER_RADIUS + CFG.SKIN_WIDTH - hit.distance;
            if (penetration > 0) resolved.addScaledVector(flatNormal, penetration);
          }
        }
      }
    }

    return resolved;
  }

  function tryStepUp(position, moveDelta) {
    if (!onGround) return moveDelta;
    if (moveDelta.lengthSq() < 0.00001) return moveDelta;

    const feetY = position.y - CFG.PLAYER_HEIGHT;
    const stepOrigin = position.clone();
    stepOrigin.y = feetY + CFG.STEP_HEIGHT + 0.05;

    _dir.copy(moveDelta).setY(0).normalize();
    raycaster.set(stepOrigin, _dir);
    raycaster.far = CFG.PLAYER_RADIUS + moveDelta.length() + CFG.SKIN_WIDTH;

    const nearby = nearbyMeshes(collidables, stepOrigin, raycaster.far + 1.0, cullDistSq);
    const hits   = raycaster.intersectObjects(nearby, false);

    _origin.set(position.x, feetY + 0.1, position.z);
    raycaster.set(_origin, _dir);
    raycaster.far = CFG.PLAYER_RADIUS + moveDelta.length() + CFG.SKIN_WIDTH;
    const hitsLow = raycaster.intersectObjects(nearby, false);

    if (hitsLow.length > 0 && hits.length === 0) {
      const testPos = position.clone().add(moveDelta);
      testPos.y += CFG.STEP_HEIGHT;
      const groundY = groundCheck(testPos);
      if (groundY !== null && groundY - position.y < CFG.STEP_HEIGHT + 0.01) {
        return moveDelta;
      }
    }

    return moveDelta;
  }

  function update(camera, keys, yaw, dt) {
    dt = Math.min(dt, 0.05);

    // OPTIMALIZACE: Lazy init ponechán jako záchrana pro případ, že by
    // refreshCollidables() nebyl zavolán z engine.js (zpětná kompatibilita).
    if (!collidablesReady) refreshCollidables();

    if (keys['a'] || keys['arrowleft'])  yaw += CFG.TURN_SPEED * dt;
    if (keys['d'] || keys['arrowright']) yaw -= CFG.TURN_SPEED * dt;

    const MAX_PITCH = 45 * (Math.PI / 180);

    if (keys['q']) {
      currentPitch -= CFG.LOOK_SPEED * dt;
      if (currentPitch < -MAX_PITCH) currentPitch = -MAX_PITCH;
    } else if (keys['e']) {
      currentPitch += CFG.LOOK_SPEED * dt;
      if (currentPitch > MAX_PITCH) currentPitch = MAX_PITCH;
    } else {
      if (currentPitch !== 0) {
        const signBefore = Math.sign(currentPitch);
        if (currentPitch > 0) currentPitch -= CFG.RETURN_SPEED * dt;
        else currentPitch += CFG.RETURN_SPEED * dt;
        if (Math.sign(currentPitch) !== signBefore) currentPitch = 0;
      }
    }

    camera.rotation.set(currentPitch, yaw, 0, 'YXZ');

    _move.set(0, 0, 0);
    if (keys['w'] || keys['arrowup'])   _move.z -= 1;
    if (keys['s'] || keys['arrowdown']) _move.z += 1;

    if (_move.lengthSq() > 0) {
      _move.normalize()
        .multiplyScalar(CFG.MOVE_SPEED * dt)
        .applyAxisAngle(_yAxis, yaw);
    }

    if ((keys[' '] || keys['space']) && onGround) {
      velocity.y = CFG.JUMP_SPEED;
      onGround = false;
    }

    if (!onGround) {
      velocity.y += CFG.GRAVITY * dt;
      velocity.y = Math.max(velocity.y, CFG.TERMINAL_VEL);
    } else {
      velocity.y = Math.min(velocity.y, 0);
    }

    const movedXZ    = tryStepUp(camera.position, _move);
    const resolvedXZ = resolveWalls(camera.position, movedXZ);

    camera.position.x += resolvedXZ.x;
    camera.position.z += resolvedXZ.z;

    // FIX v1.5: Swept ground check — zachytí průchod skrz tenký brush.
    // Uložíme Y před pohybem, posuneme, pak zkontrolujeme obě pozice.
    const prevY = camera.position.y;
    camera.position.y += velocity.y * dt;

    let groundY = groundCheck(camera.position);

    // Swept fallback: hráč padal, groundCheck na nové pozici vrátil null,
    // ale na předchozí pozici podlaha byla → přeskočili jsme tenký brush.
    if (groundY === null && velocity.y < 0) {
      const prevPos = camera.position.clone();
      prevPos.y = prevY;
      const prevGroundY = groundCheck(prevPos);
      if (
        prevGroundY !== null &&
        prevGroundY <= prevY &&
        prevGroundY >= camera.position.y
      ) {
        groundY = prevGroundY;
      }
    }

    if (groundY !== null) {
      if (camera.position.y <= groundY + CFG.SKIN_WIDTH * 2) {
        camera.position.y = groundY;
        onGround = true;
        velocity.y = 0;
      } else {
        onGround = false;
      }
    } else {
      onGround = false;
    }

    return yaw;
  }

  return {
    update,
    refreshCollidables,
    teleport(camera, x, y, z) {
      camera.position.set(x, y, z);
      velocity.set(0, 0, 0);
      onGround = false;
      currentPitch = 0;
    },
    get isOnGround() { return onGround; },
    get velocityY()  { return velocity.y; },
  };
}
