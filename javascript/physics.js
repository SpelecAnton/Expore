/**
 * SPELEC PHYSICS v1.2 — EXTERNAL CONFIG
 * Gravitace, kolize se světem, step-up pro schody, svahy a plynulý pohled Q/E.
 *
 * CFG defaulty jsou zde — přepsat lze z index.html přes physicsConfig v initEngine().
 *
 * v1.3 — noclip podpora:
 *   Meshe s userData.noclip = true jsou ignorovány při buildování collidables.
 *   (Dříve se používalo material.depthWrite === false, ale to způsobovalo
 *    renderovací artefakty — průhlednost, z-fighting.)
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
};

function collectCollidables(scene) {
  const list = [];
  scene.traverse(obj => {
    if (obj.isMesh && obj.geometry) {
      // Přeskoč noclip meshe (func_wall apod.) — průchozí zdi
      if (obj.userData.noclip) return;
      // Přeskoč průhledné meshe (portály apod.)
      if (obj.material && obj.material.depthWrite === false) return;
      if (!obj.geometry.attributes.position) return;
      list.push(obj);
    }
  });
  return list;
}

function nearbyMeshes(collidables, origin, maxDist) {
  const result = [];
  const scaleVec = new THREE.Vector3();

  for (const mesh of collidables) {
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    const center = mesh.geometry.boundingSphere.center
      .clone()
      .applyMatrix4(mesh.matrixWorld);

    scaleVec.setFromMatrixScale(mesh.matrixWorld);
    const maxScale = Math.max(scaleVec.x, scaleVec.y, scaleVec.z);
    const r = mesh.geometry.boundingSphere.radius * maxScale;

    const totalDist = maxDist + r;
    if (center.distanceToSquared(origin) < totalDist * totalDist) {
      result.push(mesh);
    }
  }
  return result;
}

export function createPhysics(scene, userCFG = {}) {

  const CFG = { ...DEFAULT_CFG, ...userCFG };

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
    const checkDist = CFG.PLAYER_HEIGHT + CFG.GROUND_CHECK;

    for (const [ox, oz] of offsets) {
      _origin.set(position.x + ox, position.y + 0.05, position.z + oz);
      raycaster.set(_origin, new THREE.Vector3(0, -1, 0));
      raycaster.far = checkDist;

      const nearby = nearbyMeshes(collidables, _origin, checkDist + 1);
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

        const nearby = nearbyMeshes(collidables, _origin, CFG.PLAYER_RADIUS + 1.0);
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

    const nearby = nearbyMeshes(collidables, stepOrigin, raycaster.far + 1.0);
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
    camera.position.y += velocity.y * dt;

    const groundY = groundCheck(camera.position);

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
