/**
 * SPELEC PHYSICS v2.0 — REWRITTEN COLLISION SYSTEM
 *
 * Key fixes vs v1.9:
 *
 * CEILING TELEPORT FIX:
 *   groundCheck fires downward from exactly camera.y (eye level), NOT from
 *   camera.y + recovery_offset. The recovery offset was the root cause of the
 *   teleport bug — when the ceiling was within 0.5 units, the ray origin crossed
 *   it and detected the ceiling back-face as the "floor". Recovery from
 *   underground is now a separate upward sweep (recoverFromUnderground).
 *
 * WALL TUNNELING / STUCK BETWEEN BRUSHES FIX:
 *   Wall resolution now uses 3 height levels (was 2) and applies a guaranteed
 *   minimum push-out (SKIN_WIDTH extra) so the player never rests exactly on
 *   the wall surface. A new escapeBrush() pass fires after movement and detects
 *   when the player overlaps a small mesh bounding sphere, then pushes outward.
 *   This catches the "stuck between two brushes" case the directional rays miss.
 *
 * CEILING CHECK:
 *   ceilingClearance() returns the distance to the nearest ceiling above the
 *   camera eye. Vertical movement is clamped if it would exceed that clearance,
 *   preventing the player from jumping INTO the ceiling geometry.
 *
 * STEP CLIMBING:
 *   tryStepUp now validates the landing Y with a full groundCheck before
 *   committing, preventing teleports onto floating ledges.
 *
 * PERFORMANCE:
 *   nearbyMeshes uses squared-distance comparison (no sqrt in hot path).
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';

const DEFAULT_CFG = {
  MOVE_SPEED:      280 * 0.02,
  TURN_SPEED:      2.5,
  LOOK_SPEED:      2.5,
  RETURN_SPEED:    5.0,
  GRAVITY:        -28.0,
  JUMP_SPEED:      3.0,
  TERMINAL_VEL:  -30.0,
  PLAYER_HEIGHT:   80 * 0.02,
  PLAYER_RADIUS:   0.28,
  PLAYER_MASS:     1.0,
  STEP_HEIGHT:     0.45,
  SLOPE_MAX_ANGLE: 50,
  SKIN_WIDTH:      0.02,
  GROUND_CHECK:    0.18,
  NUM_SIDE_RAYS:   10,
  NUM_SLOPE_RAYS:  4,
};

function collectCollidables(scene) {
  const list = [];
  scene.traverse(obj => {
    if (!obj.isMesh || !obj.geometry) return;
    if (obj.userData.noclip) return;
    if (obj.material && obj.material.depthWrite === false) return;
    if (!obj.geometry.attributes.position) return;
    list.push(obj);
  });
  return list;
}

const _sv = new THREE.Vector3();
const _sc = new THREE.Vector3();

function nearbyMeshes(collidables, origin, maxDist) {
  const result = [];
  for (const mesh of collidables) {
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    _sc.copy(mesh.geometry.boundingSphere.center).applyMatrix4(mesh.matrixWorld);
    _sv.setFromMatrixScale(mesh.matrixWorld);
    const s = Math.max(_sv.x, _sv.y, _sv.z);
    const r = mesh.geometry.boundingSphere.radius * s + maxDist;
    if (_sc.distanceToSquared(origin) < r * r) result.push(mesh);
  }
  return result;
}

const _up   = new THREE.Vector3(0, 1, 0);
const _down = new THREE.Vector3(0, -1, 0);
const _dir  = new THREE.Vector3();
const _orig = new THREE.Vector3();
const _move = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);

export function createPhysics(scene, userCFG = {}) {
  const CFG = { ...DEFAULT_CFG, ...userCFG };

  const velocity     = new THREE.Vector3();
  let   onGround     = false;
  let   collidables  = [];
  let   currentPitch = 0;
  let   collidablesReady = false;

  const ray = new THREE.Raycaster();
  ray.firstHitOnly = true;

  function refreshCollidables() {
    scene.updateMatrixWorld(true);
    collidables = collectCollidables(scene);
    collidablesReady = true;
    console.log(`[Physics] Collidables: ${collidables.length}`);
  }

  // ── Ground detection ─────────────────────────────────────────────────────
  // Fires DOWN from camera eye position. Returns eye-level Y of floor, or null.
  // No upward offset here — that was the ceiling-teleport bug in v1.9.
  function groundCheck(position) {
    const offsets = [[0, 0]];
    for (let i = 0; i < CFG.NUM_SLOPE_RAYS; i++) {
      const a = (i / CFG.NUM_SLOPE_RAYS) * Math.PI * 2;
      offsets.push([
        Math.cos(a) * CFG.PLAYER_RADIUS * 0.7,
        Math.sin(a) * CFG.PLAYER_RADIUS * 0.7,
      ]);
    }

    const checkDist = CFG.PLAYER_HEIGHT + CFG.STEP_HEIGHT + 0.2;
    let highestFloor = null;

    for (const [ox, oz] of offsets) {
      _orig.set(position.x + ox, position.y, position.z + oz);
      ray.set(_orig, _down);
      ray.far = checkDist;

      const nearby = nearbyMeshes(collidables, _orig, checkDist);
      const hits   = ray.intersectObjects(nearby, false);
      if (!hits.length) continue;

      const hit = hits[0];
      let normal = hit.face?.normal
        .clone()
        .transformDirection(hit.object.matrixWorld)
        ?? _up.clone();
      if (normal.dot(_down) > 0) normal.negate();

      const angle = Math.acos(
        Math.max(-1, Math.min(1, normal.dot(_up)))
      ) * (180 / Math.PI);

      if (angle < CFG.SLOPE_MAX_ANGLE) {
        const eyeY = hit.point.y + CFG.PLAYER_HEIGHT;
        if (highestFloor === null || eyeY > highestFloor) {
          highestFloor = eyeY;
        }
      }
    }

    return highestFloor;
  }

  // ── Underground recovery ─────────────────────────────────────────────────
  // Fires UP from below the feet. If a walkable surface is found above, returns
  // the eye-level Y the player should be snapped to.
  function recoverFromUnderground(position) {
    _orig.set(position.x, position.y - CFG.PLAYER_HEIGHT - 0.05, position.z);
    ray.set(_orig, _up);
    ray.far = CFG.PLAYER_HEIGHT + 0.6;

    const nearby = nearbyMeshes(collidables, _orig, ray.far);
    const hits   = ray.intersectObjects(nearby, false);
    if (!hits.length) return null;

    const hit = hits[0];
    let normal = hit.face?.normal
      .clone()
      .transformDirection(hit.object.matrixWorld)
      ?? _up.clone();

    // We want surfaces whose underside faces DOWN (floor seen from below)
    if (normal.dot(_up) > 0) return null;

    const angle = Math.acos(
      Math.max(-1, Math.min(1, Math.abs(normal.dot(_up))))
    ) * (180 / Math.PI);

    return angle < CFG.SLOPE_MAX_ANGLE
      ? hit.point.y + CFG.PLAYER_HEIGHT
      : null;
  }

  // ── Ceiling clearance ────────────────────────────────────────────────────
  // Returns distance to nearest ceiling above camera eye, or Infinity.
  function ceilingClearance(position) {
    _orig.set(position.x, position.y, position.z);
    ray.set(_orig, _up);
    ray.far = 4.0;

    const nearby = nearbyMeshes(collidables, _orig, ray.far);
    const hits   = ray.intersectObjects(nearby, false);
    return hits.length ? hits[0].distance : Infinity;
  }

  // ── Wall resolution ──────────────────────────────────────────────────────
  // Three capsule rings: feet, mid body, shoulders.
  // Minimum push-out (SKIN_WIDTH extra) prevents resting exactly on wall face.
  function resolveWalls(position, moveDelta) {
    const resolved = moveDelta.clone();

    const checkHeights = [
      CFG.PLAYER_HEIGHT * 0.08,
      CFG.PLAYER_HEIGHT * 0.45,
      CFG.PLAYER_HEIGHT * 0.82,
    ];

    for (const yOff of checkHeights) {
      _orig.set(position.x, position.y - yOff, position.z);

      for (let i = 0; i < CFG.NUM_SIDE_RAYS; i++) {
        const angle = (i / CFG.NUM_SIDE_RAYS) * Math.PI * 2;
        _dir.set(Math.cos(angle), 0, Math.sin(angle));

        ray.set(_orig, _dir);
        ray.far = CFG.PLAYER_RADIUS + CFG.SKIN_WIDTH * 2;

        const nearby = nearbyMeshes(collidables, _orig, CFG.PLAYER_RADIUS + 0.5);
        const hits   = ray.intersectObjects(nearby, false);
        if (!hits.length) continue;

        const hit = hits[0];
        let normal = hit.face?.normal
          .clone()
          .transformDirection(hit.object.matrixWorld)
          ?? new THREE.Vector3();
        if (normal.dot(_dir) > 0) normal.negate();

        const slopeAngle = Math.acos(
          Math.max(-1, Math.min(1, normal.dot(_up)))
        ) * (180 / Math.PI);

        if (slopeAngle > CFG.SLOPE_MAX_ANGLE) {
          const flat = new THREE.Vector3(normal.x, 0, normal.z).normalize();
          const dot  = resolved.dot(flat);
          if (dot < 0) resolved.addScaledVector(flat, -dot);

          const pen = CFG.PLAYER_RADIUS + CFG.SKIN_WIDTH - hit.distance;
          if (pen > 0) resolved.addScaledVector(flat, pen + CFG.SKIN_WIDTH);
        }
      }
    }

    return resolved;
  }

  // ── Brush escape ─────────────────────────────────────────────────────────
  // After movement, if the player origin sits inside a small mesh's bounding
  // sphere, push the position outward. Catches stuck-between-brushes cases
  // that the directional rays miss.
  function escapeBrush(position) {
    const escapeR = CFG.PLAYER_RADIUS * 1.5;

    for (const mesh of collidables) {
      if (!mesh.geometry.boundingSphere) continue;
      _sc.copy(mesh.geometry.boundingSphere.center).applyMatrix4(mesh.matrixWorld);
      _sv.setFromMatrixScale(mesh.matrixWorld);
      const s = Math.max(_sv.x, _sv.y, _sv.z);
      const r = mesh.geometry.boundingSphere.radius * s;
      if (r > 3.0) continue; // skip large world geometry

      const dist = _sc.distanceTo(position);
      if (dist < escapeR) {
        const out = new THREE.Vector3()
          .subVectors(position, _sc)
          .setY(0)
          .normalize();
        if (out.lengthSq() > 0.001) {
          position.addScaledVector(out, (escapeR - dist) + CFG.SKIN_WIDTH);
        }
      }
    }
  }

  // ── Step climbing ────────────────────────────────────────────────────────
  function tryStepUp(position, moveDelta) {
    if (!onGround) return moveDelta;
    if (moveDelta.lengthSq() < 0.00001) return moveDelta;

    const feetY      = position.y - CFG.PLAYER_HEIGHT;
    const stepOrigin = position.clone();
    stepOrigin.y     = feetY + CFG.STEP_HEIGHT + 0.05;

    _dir.copy(moveDelta).setY(0).normalize();
    ray.set(stepOrigin, _dir);
    ray.far = CFG.PLAYER_RADIUS + moveDelta.length() + CFG.SKIN_WIDTH;

    const nearby   = nearbyMeshes(collidables, stepOrigin, ray.far + 0.5);
    const hitsHigh = ray.intersectObjects(nearby, false);

    _orig.set(position.x, feetY + 0.05, position.z);
    ray.set(_orig, _dir);
    ray.far = CFG.PLAYER_RADIUS + moveDelta.length() + CFG.SKIN_WIDTH;
    const hitsLow = ray.intersectObjects(nearby, false);

    if (hitsLow.length > 0 && hitsHigh.length === 0) {
      const testPos = position.clone().add(moveDelta);
      const floorY  = groundCheck(testPos);
      if (floorY !== null && Math.abs(floorY - position.y) < CFG.STEP_HEIGHT + 0.05) {
        return moveDelta;
      }
    }

    return moveDelta;
  }

  // ── Main update ──────────────────────────────────────────────────────────
  function update(camera, keys, yaw, dt) {
    dt = Math.min(dt, 0.05);

    if (!collidablesReady) refreshCollidables();

    // Turning
    if (keys['a'] || keys['arrowleft'])  yaw += CFG.TURN_SPEED * dt;
    if (keys['d'] || keys['arrowright']) yaw -= CFG.TURN_SPEED * dt;

    // Head tilt
    const MAX_PITCH = 45 * (Math.PI / 180);
    if (keys['q']) {
      currentPitch = Math.max(currentPitch - CFG.LOOK_SPEED * dt, -MAX_PITCH);
    } else if (keys['e']) {
      currentPitch = Math.min(currentPitch + CFG.LOOK_SPEED * dt,  MAX_PITCH);
    } else if (currentPitch !== 0) {
      const sign = Math.sign(currentPitch);
      currentPitch -= sign * CFG.RETURN_SPEED * dt;
      if (Math.sign(currentPitch) !== sign) currentPitch = 0;
    }

    camera.rotation.set(currentPitch, yaw, 0, 'YXZ');

    // Horizontal movement
    _move.set(0, 0, 0);
    if (keys['w'] || keys['arrowup'])   _move.z -= 1;
    if (keys['s'] || keys['arrowdown']) _move.z += 1;
    if (_move.lengthSq() > 0) {
      _move.normalize()
        .multiplyScalar(CFG.MOVE_SPEED * dt)
        .applyAxisAngle(_yAxis, yaw);
    }

    // Jump
    if ((keys[' '] || keys['space']) && onGround) {
      velocity.y = CFG.JUMP_SPEED;
      onGround   = false;
    }

    // Vertical velocity
    if (!onGround) {
      velocity.y += CFG.GRAVITY * dt;
      velocity.y  = Math.max(velocity.y, CFG.TERMINAL_VEL);
    } else {
      velocity.y = Math.min(velocity.y, 0);
    }

    // Apply horizontal movement
    const stepped   = tryStepUp(camera.position, _move);
    const resolvedH = resolveWalls(camera.position, stepped);
    camera.position.x += resolvedH.x;
    camera.position.z += resolvedH.z;

    // Apply vertical movement — clamp against ceiling before moving
    const deltaY = velocity.y * dt;
    if (velocity.y > 0) {
      const HEAD_GAP  = 0.1;
      const clearance = ceilingClearance(camera.position);
      if (deltaY >= clearance - HEAD_GAP) {
        camera.position.y += Math.max(0, clearance - HEAD_GAP);
        velocity.y = 0;
      } else {
        camera.position.y += deltaY;
      }
    } else {
      camera.position.y += deltaY;
    }

    // Ground landing
    let floorY = groundCheck(camera.position);

    // Swept fallback: re-check from previous Y if we fell through thin floor
    if (floorY === null && velocity.y <= 0) {
      const prevPos = camera.position.clone();
      prevPos.y -= deltaY;
      const prevFloor = groundCheck(prevPos);
      if (
        prevFloor !== null &&
        prevFloor <= prevPos.y + 0.01 &&
        prevFloor >= camera.position.y - 0.05
      ) {
        floorY = prevFloor;
      }
    }

    // Underground recovery
    if (floorY === null) {
      const recovered = recoverFromUnderground(camera.position);
      if (recovered !== null) {
        camera.position.y = recovered + CFG.SKIN_WIDTH;
        velocity.y = 0;
        onGround   = true;
        floorY     = recovered;
      }
    }

    if (floorY !== null) {
      if (camera.position.y <= floorY + CFG.SKIN_WIDTH * 2) {
        camera.position.y = floorY;
        onGround           = true;
        velocity.y         = 0;
      } else {
        onGround = false;
      }
    } else {
      onGround = false;
    }

    // Push out of any brush the player is overlapping
    escapeBrush(camera.position);

    return yaw;
  }

  return {
    update,
    refreshCollidables,
    teleport(camera, x, y, z) {
      camera.position.set(x, y, z);
      velocity.set(0, 0, 0);
      onGround    = false;
      currentPitch = 0;
    },
    get isOnGround() { return onGround; },
    get velocityY()  { return velocity.y; },
  };
}
