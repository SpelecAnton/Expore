/**
 * SPELEC PHYSICS v5.1 — THREE.JS OCTREE + CAPSULE COLLIDER
 *
 * Replaces BSP brush trace collision (v4.x) with Three.js Octree + Capsule.
 *
 * WHY THIS FIXES WALL-STICKING:
 * The old AABB/brush-trace system detected collision even when the player moved
 * *parallel* to a surface due to floating-point drift (d1 ≈ d2 → fraction ≈ 0).
 * A Capsule has two spherical ends that naturally slide along edges and corners.
 * capsuleIntersect() only fires when there is actual geometric penetration, so
 * parallel movement never triggers a false collision.
 *
 * API (backwards-compatible):
 * createPhysics(worldOctree, userCFG)
 * worldOctree — THREE.Octree built from world collision meshes (engine.js)
 * Pass null for no collision (player floats — fallback room).
 * userCFG     — optional overrides (same keys as before)
 *
 * Movement model:
 * Q3-style friction + acceleration on the ground.
 * Reduced air acceleration (ACCEL_AIR < ACCEL_GROUND).
 * Sub-stepped integration (SUBSTEPS = 5) for stable collision resolution.
 *
 * Step climbing:
 * The capsule bottom hemisphere (radius R = 0.28 u) naturally rolls over
 * obstacles up to ~R high.  Typical Q3 steps are 8 q-units = 0.16 u, which
 * is within this range.  Taller steps require a jump.
 */

'use strict';

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';
import { Capsule } from 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/math/Capsule.js';

// ── Default config (same keys as v4 for backwards-compat) ─────────────────────
const DEFAULT_CFG = {
  MOVE_SPEED:      280 * 0.02,   // walk speed  (units/s)
  TURN_SPEED:      2.5,          // A/D turning (rad/s)
  LOOK_SPEED:      2.5,          // Q/E tilt    (rad/s)
  RETURN_SPEED:    5.0,          // auto-level after Q/E (rad/s)
  GRAVITY:        -28.0,         // downward accel (units/s²)
  JUMP_SPEED:      3.0,          // initial jump velocity (units/s)
  TERMINAL_VEL:  -30.0,          // max fall speed (units/s)
  PLAYER_HEIGHT:   80 * 0.02,   // eye height above floor (1.6 u)
  PLAYER_RADIUS:   0.28,         // capsule radius
  STEP_HEIGHT:     0.45,         // kept for config compatibility (not used explicitly —
                                 // handled naturally by capsule hemisphere)
  SLOPE_MAX_ANGLE: 50,           // surfaces steeper than this are walls, not floors (°)
  SKIN_WIDTH:      0.02,         // kept for config compatibility
};

// ── Q3-calibrated movement constants ──────────────────────────────────────────
const STOP_SPEED   = 100 * 0.02;  // 2.0  — friction scales up below this speed
const FRICTION     = 6;           // ground friction  (Q3: pm_friction)
const ACCEL_GROUND = 10;          // ground accel     (Q3: pm_accelerate)
const ACCEL_AIR    = 1.5;         // air accel        (Q3: pm_airaccelerate)

// ── Physics sub-steps ─────────────────────────────────────────────────────────
// Each frame is split into SUBSTEPS smaller ticks.
// More steps → less tunnelling and smoother corner resolution.
// 5 steps at 60 fps → each step ≈ 3.3 ms → max displacement per step ≈ 0.019 u
// (well below capsule radius 0.28 u, so tunnelling through normal BSP walls is impossible).
const SUBSTEPS = 5;

// ── createPhysics ──────────────────────────────────────────────────────────────
export function createPhysics(worldOctree, userCFG = {}) {
  const CFG = { ...DEFAULT_CFG, ...userCFG };

  const R = CFG.PLAYER_RADIUS;
  const H = CFG.PLAYER_HEIGHT;

  // Minimum Y-component of a surface normal to be considered walkable floor.
  // cos(50°) ≈ 0.643 — surfaces with a shallower normal are cliffs/walls.
  const SLOPE_MIN_Y = Math.cos(CFG.SLOPE_MAX_ANGLE * Math.PI / 180);

  // ── Capsule collider ──────────────────────────────────────────────────────────
  // start = bottom sphere centre  (R above floor when standing → touches floor)
  // end   = top sphere centre     = camera / eye level (= floor + H)
  // The total capsule height (bottom of bottom sphere to top of top sphere) = H + R.
  const playerCollider = new Capsule(
    new THREE.Vector3(0, R, 0),
    new THREE.Vector3(0, H, 0),
    R
  );

  const velocity     = new THREE.Vector3();
  const _tmpVec      = new THREE.Vector3(); // reused scratch vector — never aliased
  let   onGround     = false;
  let   currentPitch = 0;

  function resolveCollision() {
    if (!worldOctree) return;

    const result = worldOctree.capsuleIntersect(playerCollider);
    if (!result) return;

    let normal = result.normal;

    // 1. Reakce na zem
    if (normal.y > SLOPE_MIN_Y) {
      onGround = true;
      if (velocity.y < 0) velocity.y = 0;
    }

    // 2. Projekce rychlosti (klouzání)
    const dot = velocity.dot(normal);
    if (dot < 0) {
      velocity.addScaledVector(normal, -dot);
    }

    // 3. Vytlačení (Three.js Octree vrací normálu směřující ven z geometrie směrem k hráči)
    _tmpVec.copy(normal).multiplyScalar(result.depth);
    playerCollider.translate(_tmpVec);
  }

  // ── PM_Friction ───────────────────────────────────────────────────────────────
  // Q3-style horizontal friction: ramps up below STOP_SPEED for crisp stops.
  function PM_Friction(dt) {
    const speed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
    if (speed < 0.0001) { velocity.x = 0; velocity.z = 0; return; }
    const control  = Math.max(speed, STOP_SPEED);
    const newSpeed = Math.max(0, speed - control * FRICTION * dt) / speed;
    velocity.x *= newSpeed;
    velocity.z *= newSpeed;
  }

  // ── PM_Accelerate ─────────────────────────────────────────────────────────────
  // Q3-style velocity cap: only accelerate up to wishSpeed in the wish direction.
  function PM_Accelerate(wishDX, wishDZ, wishSpeed, accel, dt) {
    const wlen = Math.sqrt(wishDX * wishDX + wishDZ * wishDZ);
    if (wlen < 0.001) return;
    const wdx = wishDX / wlen, wdz = wishDZ / wlen;
    const curSpeed = velocity.x * wdx + velocity.z * wdz;
    const addSpeed = wishSpeed - curSpeed;
    if (addSpeed <= 0) return;
    const accelSpeed = Math.min(accel * dt * wishSpeed, addSpeed);
    velocity.x += accelSpeed * wdx;
    velocity.z += accelSpeed * wdz;
  }

  // ── update ────────────────────────────────────────────────────────────────────
  // Called every frame by engine.js.  Mutates camera.position and camera.rotation.
  // Returns the current yaw so engine.js can persist it.
  function update(camera, keys, yaw, dt) {
    dt = Math.min(dt, 0.05); // cap at 50 ms to prevent spiral-of-death

    // Re-sync the capsule from camera each frame.
    // camera.y is always the eye level = playerCollider.end.y.
    playerCollider.end.set(camera.position.x, camera.position.y, camera.position.z);
    playerCollider.start.set(camera.position.x, camera.position.y - H + R, camera.position.z);

    // ── Turning (A / D or arrow keys) ────────────────────────────────────────
    if (keys['a'] || keys['arrowleft'])  yaw += CFG.TURN_SPEED * dt;
    if (keys['d'] || keys['arrowright']) yaw -= CFG.TURN_SPEED * dt;

    // ── Head tilt (Q / E) — auto-levels when key released ────────────────────
    const MAX_PITCH = Math.PI / 4;
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

    // ── Jump (Space) — only when on ground ───────────────────────────────────
    if ((keys[' '] || keys['space']) && onGround) {
      velocity.y = CFG.JUMP_SPEED;
      onGround   = false; // force air-movement controls this frame
    }

    // ── Horizontal wish direction (W / S or arrow keys) ───────────────────────
    let mvZ = 0;
    if (keys['w'] || keys['arrowup'])   mvZ -= 1;
    if (keys['s'] || keys['arrowdown']) mvZ += 1;
    const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
    const wishDX = mvZ * sinY, wishDZ = mvZ * cosY;

    // ── Ground / air movement controls (run once per frame, not per sub-step) ─
    // Using this frame's onGround value (set by collision in the previous frame).
    if (onGround) {
      PM_Friction(dt);
      PM_Accelerate(wishDX, wishDZ, CFG.MOVE_SPEED, ACCEL_GROUND, dt);
    } else {
      PM_Accelerate(wishDX, wishDZ, CFG.MOVE_SPEED, ACCEL_AIR, dt);
    }

    // ── Sub-stepped integration ───────────────────────────────────────────────
    // Reset ground state; collision in each sub-step will re-establish it.
    // The reset ensures we correctly detect leaving the ground (stepping off edge).
    onGround = false;
    const subDt = dt / SUBSTEPS;

    for (let i = 0; i < SUBSTEPS; i++) {
      // Apply gravity only while airborne (set in this sub-step loop).
      // On the first sub-step, onGround is always false (reset above), so
      // a tiny gravity impulse is applied.  If the player is on the floor,
      // resolveCollision() will set onGround=true and cancel velocity.y,
      // preventing accumulation.  This is intentional and mirrors id's approach.
      if (!onGround) {
        velocity.y = Math.max(velocity.y + CFG.GRAVITY * subDt, CFG.TERMINAL_VEL);
      }

      // Translate capsule by velocity × sub-step time.
      _tmpVec.copy(velocity).multiplyScalar(subDt);
      playerCollider.translate(_tmpVec);

      // Resolve any penetration and slide velocity along surfaces.
      resolveCollision();
    }

    // ── Write capsule result back to camera ───────────────────────────────────
    // playerCollider.end is the top-sphere centre = eye level = camera position.
    camera.position.copy(playerCollider.end);

    return yaw;
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  return {
    update,

    // No-op: Octree is immutable after creation; kept for API compatibility.
    refreshCollidables() {},

    teleport(camera, x, y, z) {
      camera.position.set(x, y, z);
      playerCollider.end.set(x, y, z);
      playerCollider.start.set(x, y - H + R, z);
      velocity.set(0, 0, 0);
      onGround     = false;
      currentPitch = 0;
    },

    get isOnGround() { return onGround; },
    get velocityY()  { return velocity.y; },
  };
}