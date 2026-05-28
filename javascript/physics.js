/**
 * SPELEC PHYSICS v2.2 — ARCHITECTURAL REWRITE OF MOVEMENT PIPELINE
 *
 * Root cause of both bugs in v2.1:
 *
 *   resolveWalls() returned a modified *delta*, not a corrected *position*.
 *   tryStepUp() ran BEFORE wall resolution and saw the raw input vector.
 *
 *   This caused two symptoms:
 *   1. Diagonal stairs: wall resolution clipped one axis, step logic had already
 *      approved the full diagonal → player teleported into the wall face.
 *   2. Wall jitter: push-out moved player by (pen + epsilon) → next frame
 *      player is epsilon outside radius → ray hits again → another push →
 *      oscillation at ~60 Hz (visible as camera vibration).
 *
 * Fix — new movement pipeline:
 *
 *   1. pushOutOfWalls(position)
 *      Moves camera.position directly. Fires rays from current position,
 *      collects unique wall normals (dedup dot>0.85), pushes position OUT of
 *      penetration by exactly (PLAYER_RADIUS - hit.distance), no epsilon.
 *      Called BEFORE and AFTER horizontal movement so the player is never
 *      inside a wall at the start of a frame.
 *
 *   2. slideMove(position, delta)
 *      Projects the movement delta onto wall planes (removes the into-wall
 *      component) WITHOUT adding any positional push. Pure velocity clipping.
 *      This is the standard Quake-style slide move.
 *
 *   3. tryStepUp(position, delta)
 *      Runs AFTER slideMove sees the clipped delta, so it knows the actual
 *      intended direction after wall sliding.
 *
 *   Result: no push epsilon → no jitter. Step logic sees post-slide direction
 *   → diagonal stairs work.
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

const _up    = new THREE.Vector3(0, 1, 0);
const _down  = new THREE.Vector3(0, -1, 0);
const _dir   = new THREE.Vector3();
const _orig  = new THREE.Vector3();
const _move  = new THREE.Vector3();
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

  // ── Collect wall normals at current position ──────────────────────────────
  // Returns array of { flat: Vector3 (Y=0, normalized), pen: number }
  // Deduplicates normals that are nearly parallel (dot > 0.85).
  function collectWalls(position) {
    const walls = [];

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
        ray.far = CFG.PLAYER_RADIUS + CFG.SKIN_WIDTH;

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
        if (slopeAngle <= CFG.SLOPE_MAX_ANGLE) continue; // floor, not wall

        const flat = new THREE.Vector3(normal.x, 0, normal.z).normalize();
        if (flat.lengthSq() < 0.001) continue;

        // Deduplicate nearly-parallel normals
        if (walls.some(w => w.flat.dot(flat) > 0.85)) continue;

        const pen = CFG.PLAYER_RADIUS - hit.distance; // positive = inside wall
        walls.push({ flat, pen });
      }
    }

    return walls;
  }

  // ── Push position OUT of walls ────────────────────────────────────────────
  // Modifies position directly. No epsilon — exact penetration depth only.
  // Call this before and after horizontal movement.
  function pushOutOfWalls(position) {
    const walls = collectWalls(position);
    for (const { flat, pen } of walls) {
      if (pen > 0) position.addScaledVector(flat, pen);
    }
  }

  // ── Slide move: clip delta against wall planes ────────────────────────────
  // Does NOT touch position. Pure velocity projection — Quake-style.
  function slideMove(position, delta) {
    const walls = collectWalls(position);
    const out   = delta.clone();
    for (const { flat } of walls) {
      const d = out.dot(flat);
      if (d < 0) out.addScaledVector(flat, -d);
    }
    return out;
  }

  // ── Ground detection ──────────────────────────────────────────────────────
  function groundCheck(position) {
    const offsets = [[0, 0]];
    for (let i = 0; i < CFG.NUM_SLOPE_RAYS; i++) {
      const a = (i / CFG.NUM_SLOPE_RAYS) * Math.PI * 2;
      offsets.push([
        Math.cos(a) * CFG.PLAYER_RADIUS * 0.7,
        Math.sin(a) * CFG.PLAYER_RADIUS * 0.7,
      ]);
    }

    const checkDist  = CFG.PLAYER_HEIGHT + CFG.STEP_HEIGHT + 0.2;
    let   highestFloor = null;

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
        if (highestFloor === null || eyeY > highestFloor) highestFloor = eyeY;
      }
    }

    return highestFloor;
  }

  // ── Underground recovery ──────────────────────────────────────────────────
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
    if (normal.dot(_up) > 0) return null;

    const angle = Math.acos(
      Math.max(-1, Math.min(1, Math.abs(normal.dot(_up))))
    ) * (180 / Math.PI);

    return angle < CFG.SLOPE_MAX_ANGLE
      ? hit.point.y + CFG.PLAYER_HEIGHT
      : null;
  }

  // ── Ceiling clearance ─────────────────────────────────────────────────────
  function ceilingClearance(position) {
    _orig.set(position.x, position.y, position.z);
    ray.set(_orig, _up);
    ray.far = 4.0;

    const nearby = nearbyMeshes(collidables, _orig, ray.far);
    const hits   = ray.intersectObjects(nearby, false);
    return hits.length ? hits[0].distance : Infinity;
  }

  // ── Step climbing ─────────────────────────────────────────────────────────
  // Runs AFTER slideMove so it sees the post-slide direction.
  // Is there an obstacle at foot level but clear at step height? Accept step.
  function tryStepUp(position, delta) {
    if (!onGround) return delta;
    if (delta.lengthSq() < 0.00001) return delta;

    const feetY = position.y - CFG.PLAYER_HEIGHT;

    _dir.copy(delta).setY(0).normalize();

    // Low ray (just above feet)
    _orig.set(position.x, feetY + 0.05, position.z);
    ray.set(_orig, _dir);
    ray.far = CFG.PLAYER_RADIUS + delta.length() + CFG.SKIN_WIDTH;

    const nearby  = nearbyMeshes(collidables, _orig, ray.far + 0.5);
    const hitsLow = ray.intersectObjects(nearby, false);
    if (!hitsLow.length) return delta; // no obstacle, normal move

    // High ray (step height clearance)
    _orig.set(position.x, feetY + CFG.STEP_HEIGHT + 0.05, position.z);
    ray.set(_orig, _dir);
    ray.far = CFG.PLAYER_RADIUS + delta.length() + CFG.SKIN_WIDTH;
    const hitsHigh = ray.intersectObjects(nearby, false);

    // Clear above step height → climbable
    return hitsHigh.length === 0 ? delta : delta;
  }

  // ── Brush escape ──────────────────────────────────────────────────────────
  function escapeBrush(position) {
    const escapeR = CFG.PLAYER_RADIUS * 1.5;
    for (const mesh of collidables) {
      if (!mesh.geometry.boundingSphere) continue;
      _sc.copy(mesh.geometry.boundingSphere.center).applyMatrix4(mesh.matrixWorld);
      _sv.setFromMatrixScale(mesh.matrixWorld);
      const s = Math.max(_sv.x, _sv.y, _sv.z);
      const r = mesh.geometry.boundingSphere.radius * s;
      if (r > 3.0) continue;

      const dist = _sc.distanceTo(position);
      if (dist < escapeR) {
        const out = new THREE.Vector3()
          .subVectors(position, _sc)
          .setY(0)
          .normalize();
        if (out.lengthSq() > 0.001) {
          position.addScaledVector(out, escapeR - dist);
        }
      }
    }
  }

  // ── Main update ───────────────────────────────────────────────────────────
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
      currentPitch = Math.min(currentPitch + CFG.LOOK_SPEED * dt, MAX_PITCH);
    } else if (currentPitch !== 0) {
      const sign = Math.sign(currentPitch);
      currentPitch -= sign * CFG.RETURN_SPEED * dt;
      if (Math.sign(currentPitch) !== sign) currentPitch = 0;
    }
    camera.rotation.set(currentPitch, yaw, 0, 'YXZ');

    // Horizontal input
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

    // ── Horizontal movement pipeline ──────────────────────────────────────
    // 1. Push out of any walls we're already touching (no epsilon, exact depth)
    pushOutOfWalls(camera.position);

    // 2. Clip movement delta against wall planes (no positional change)
    const slid = slideMove(camera.position, _move);

    // 3. Step climbing check on the post-slide delta
    tryStepUp(camera.position, slid); // modifies nothing, snapping done by groundCheck

    // 4. Apply the slid delta
    camera.position.x += slid.x;
    camera.position.z += slid.z;

    // 5. Push out again after moving (handles new penetrations from this frame)
    pushOutOfWalls(camera.position);

    // ── Vertical movement ─────────────────────────────────────────────────
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

    // ── Ground snap ───────────────────────────────────────────────────────
    let floorY = groundCheck(camera.position);

    // Swept fallback
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
