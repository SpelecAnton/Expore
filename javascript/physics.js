/**
 * SPELEC PHYSICS v4.1 — WALL STICKING FIX
 *
 * Changes from v4.0:
 *
 *   FIX 1 — MOVE_EPSILON reduced from 0.01 → 0.001.
 *     The old value was 16× larger than Q3's actual DIST_EPSILON (1/32 Q3-unit ≈ 0.000625
 *     Three.js units).  The brush trace computes the entering fraction as:
 *       f = (d1 - MOVE_EPSILON) / (d1 - d2)
 *     After the first wall collision the player is placed so that d1 == MOVE_EPSILON exactly.
 *     On every subsequent frame, ANY velocity component toward the wall makes d2 < d1, and
 *     therefore f = 0 → the player cannot advance even a single step → wall sticking.
 *     Reducing MOVE_EPSILON makes the zero-fraction threshold unreachable in normal play.
 *
 *   FIX 2 — Removed velocity-direction clip plane from PM_SlideMove initialisation.
 *     Q3's bg_pmove.c PM_SlideMove only pre-loads the ground normal when on ground.
 *     The extra plane (initial velocity direction) is not part of the Q3 algorithm; in
 *     multi-plane crease situations it can cause the k-plane triple-stop to fire when
 *     only two real surfaces are involved, zeroing velocity against flat walls.
 *
 * Everything else is identical to v4.0.
 *
 * Public API (unchanged):
 *   createPhysics(bspCollision, userCFG) → { update, refreshCollidables, teleport,
 *                                            isOnGround, velocityY }
 *   update(camera, keys, yaw, dt) → yaw
 */

'use strict';

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';

// ── Default config (same keys as before for drop-in compatibility) ─────────────
const DEFAULT_CFG = {
  MOVE_SPEED:      280 * 0.02,   // units/s  — horizontal speed
  TURN_SPEED:      2.5,          // rad/s    — A/D turn
  LOOK_SPEED:      2.5,          // rad/s    — Q/E tilt
  RETURN_SPEED:    5.0,          // rad/s    — auto-level after Q/E
  GRAVITY:        -28.0,         // units/s² — negative = downward
  JUMP_SPEED:      3.0,          // units/s  — initial jump velocity
  TERMINAL_VEL:  -30.0,         // units/s  — max fall speed
  PLAYER_HEIGHT:   80 * 0.02,   // units    — eye height above floor (1.6)
  PLAYER_RADIUS:   0.28,         // units    — AABB x/z half-extent
  PLAYER_MASS:     1.0,          // (unused)
  STEP_HEIGHT:     0.45,         // units    — max climbable step
  SLOPE_MAX_ANGLE: 50,           // degrees  — steeper = wall, not floor
  SKIN_WIDTH:      0.02,         // units    — (unused in BSP physics)
  GROUND_CHECK:    0.18,         // (unused, ground detection is fixed-dist)
  NUM_SIDE_RAYS:   10,           // (unused in BSP physics)
  NUM_SLOPE_RAYS:  4,            // (unused in BSP physics)
};

// ── Q3 content flags ───────────────────────────────────────────────────────────
const CONTENTS_SOLID      = 1;
const CONTENTS_PLAYERCLIP = 0x10000;

// ── Trace / clip constants ─────────────────────────────────────────────────────
// MOVE_EPSILON: gap kept between the AABB surface and brush planes after a trace.
// Q3 uses DIST_EPSILON = 1/32 Q3-unit ≈ 0.000625 Three.js units.
// We use 0.001 (≈1.6× Q3) for a small numerical safety margin.
// IMPORTANT: a value that is too large causes fraction=0 traces ("wall sticking").
const MOVE_EPSILON    = 0.001;   // ← was 0.01 in v4.0 (FIX 1)

// OVERCLIP: Q3 uses 1.001 so velocity is reflected slightly past the plane,
// guaranteeing the player drifts away rather than skating along it.
const OVERCLIP        = 1.001;

// INTO_THRESH: only clip velocity against a plane if the player moves at least
// this fast INTO it.  Filters float noise (~Q3's PM_MOVEEPSILON in Three.js scale).
const INTO_THRESH     = 0.001;

const MAX_CLIP_PLANES = 5;    // max accumulated bounce planes per slide
const MAX_NODE_DEPTH  = 128;  // BSP recursion guard

// ── Q3-calibrated movement constants (already in Three.js-unit space) ──────────
const STOP_SPEED   = 100 * 0.02;  // 2.0  — friction ramps up below this speed
const FRICTION     = 6;           // dimensionless — Q3 pm_friction
const ACCEL_GROUND = 10;          // Q3 pm_accelerate
const ACCEL_AIR    = 1.5;         // Q3 pm_airaccelerate (much lower)

// ── Short ground-check distance ────────────────────────────────────────────────
const GROUND_DIST = 0.12;

// ── Helpers ────────────────────────────────────────────────────────────────────
function emptyBSP() {
  return {
    planes:      new Float32Array(0),
    nodes:       new Int32Array(0),
    leafs:       new Int32Array(0),
    leafBrushes: new Int32Array(0),
    brushes:     new Int32Array(0),
    brushSides:  new Int32Array(0),
  };
}

// ── createPhysics ──────────────────────────────────────────────────────────────
export function createPhysics(bspCollision, userCFG = {}) {
  const CFG = { ...DEFAULT_CFG, ...userCFG };
  const col  = bspCollision ?? emptyBSP();
  const { planes, nodes, leafs, leafBrushes, brushes, brushSides } = col;

  const brushCount  = (brushes.length    / 3) | 0;
  const nodeCount   = (nodes.length      / 3) | 0;
  const leafCount   = (leafs.length      / 2) | 0;

  // AABB half-extents.
  // halfH: vertical half (camera to feet = PLAYER_HEIGHT, so half = PLAYER_HEIGHT / 2).
  // halfW: horizontal radius.
  const halfW = CFG.PLAYER_RADIUS;
  const halfH = CFG.PLAYER_HEIGHT / 2;

  const SLOPE_MIN_Y = Math.cos(CFG.SLOPE_MAX_ANGLE * Math.PI / 180);
  const STEPSIZE    = CFG.STEP_HEIGHT;

  // ── Player state ────────────────────────────────────────────────────────────
  const velocity = new THREE.Vector3();
  const physPos  = new THREE.Vector3(); // AABB centre = camera − (0, halfH, 0)
  let   onGround      = false;
  let   groundNX = 0, groundNY = 1, groundNZ = 0; // normal of floor we stand on
  let   currentPitch  = 0;

  // ── Trace state (reused per call — single-threaded JS) ──────────────────────
  let _sx, _sy, _sz;   // trace start (AABB centre)
  let _ex, _ey, _ez;   // trace end   (AABB centre)
  let _tFrac;           // result: earliest hit fraction
  let _tNX, _tNY, _tNZ; // result: hit plane normal
  let _tSolid, _tAllSolid;

  // Brush-deduplication stamp — avoids testing the same brush twice when it
  // appears in multiple BSP leafs along the trace path.
  const _stamp    = new Int32Array(Math.max(1, brushCount));
  let   _stampVal = 0;

  // ── testBrush ────────────────────────────────────────────────────────────────
  // Q3 CM_ClipBoxToBrush adapted for AABB sweep.
  // Each brush plane is expanded by an orientation-aware Minkowski offset:
  //   offset = |nx|·halfW + |ny|·halfH + |nz|·halfW
  // This is mathematically exact for axis-aligned AABBs — a sphere of radius halfW
  // would use the same offset for every plane orientation, which is far too small
  // for near-horizontal (floor/ceiling) planes.
  function testBrush(brushIdx) {
    if (brushIdx < 0 || brushIdx >= brushCount) return;
    if (_stamp[brushIdx] === _stampVal) return;
    _stamp[brushIdx] = _stampVal;

    const bi        = brushIdx * 3;
    const firstSide = brushes[bi];
    const numSides  = brushes[bi + 1];
    const contents  = brushes[bi + 2];

    if (!(contents & (CONTENTS_SOLID | CONTENTS_PLAYERCLIP))) return;
    if (numSides <= 0) return;

    let enterFrac = -1, leaveFrac = 1;
    let hx = 0, hy = 1, hz = 0;
    let startsOut = false, endsOut = false;

    for (let s = 0; s < numSides; s++) {
      const si = firstSide + s;
      if (si < 0 || si >= brushSides.length) continue;
      const pi = brushSides[si] * 4;
      if (pi < 0 || pi + 3 >= planes.length) continue;

      const nx = planes[pi];
      const ny = planes[pi + 1];
      const nz = planes[pi + 2];

      // Per-plane AABB Minkowski expansion (different for every plane orientation)
      const offset = Math.abs(nx) * halfW + Math.abs(ny) * halfH + Math.abs(nz) * halfW;
      const dist   = planes[pi + 3] + offset;

      const d1 = nx * _sx + ny * _sy + nz * _sz - dist; // signed dist, start
      const d2 = nx * _ex + ny * _ey + nz * _ez - dist; // signed dist, end

      if (d1 > 0) startsOut = true;
      if (d2 > 0) endsOut   = true;

      if (d1 > 0 && d2 > 0) return;    // entirely outside this plane → outside brush
      if (d1 <= 0 && d2 <= 0) continue; // entirely inside → plane doesn't clip

      if (d1 > d2) {
        // Entering: compute fraction with small pull-back (MOVE_EPSILON gap)
        const f = (d1 - MOVE_EPSILON) / (d1 - d2);
        if (f > enterFrac) { enterFrac = f; hx = nx; hy = ny; hz = nz; }
      } else {
        // Leaving: keep earliest exit
        const f = (d1 + MOVE_EPSILON) / (d1 - d2);
        if (f < leaveFrac) leaveFrac = f;
      }
    }

    if (!startsOut) {
      _tSolid = true;
      if (!endsOut) _tAllSolid = true;
      return;
    }

    if (enterFrac < leaveFrac && enterFrac > -1 && enterFrac < _tFrac) {
      _tFrac = Math.max(0, enterFrac);
      _tNX = hx; _tNY = hy; _tNZ = hz;
    }
  }

  // ── walkNode ─────────────────────────────────────────────────────────────────
  // BSP tree descent with exact per-plane AABB pruning.
  function walkNode(ni, depth) {
    if (depth > MAX_NODE_DEPTH) return;

    if (ni < 0) {
      // Leaf: index = -(ni + 1)
      const leafIdx = -(ni + 1);
      if (leafIdx >= leafCount) return;
      const lo = leafIdx * 2;
      const firstLB = leafs[lo], numLB = leafs[lo + 1];
      for (let i = 0; i < numLB; i++) {
        const idx = firstLB + i;
        if (idx < leafBrushes.length) testBrush(leafBrushes[idx]);
      }
      return;
    }

    if (ni >= nodeCount) return;
    const no       = ni * 3;
    const pi       = nodes[no] * 4;
    const c0       = nodes[no + 1];
    const c1       = nodes[no + 2];
    if (pi < 0 || pi + 3 >= planes.length) return;

    const nx   = planes[pi], ny = planes[pi + 1], nz = planes[pi + 2];
    const dist = planes[pi + 3];

    const d1 = nx * _sx + ny * _sy + nz * _sz - dist;
    const d2 = nx * _ex + ny * _ey + nz * _ez - dist;

    // Per-plane AABB offset for tight BSP pruning
    const r = Math.abs(nx) * halfW + Math.abs(ny) * halfH + Math.abs(nz) * halfW;

    if (d1 >= r && d2 >= r) {
      walkNode(c0, depth + 1);
    } else if (d1 < -r && d2 < -r) {
      walkNode(c1, depth + 1);
    } else {
      // Crosses both sides: visit the side the start is on first
      if (d1 >= 0) { walkNode(c0, depth + 1); walkNode(c1, depth + 1); }
      else         { walkNode(c1, depth + 1); walkNode(c0, depth + 1); }
    }
  }

  // ── traceBox ─────────────────────────────────────────────────────────────────
  // Sweep the AABB from (sx,sy,sz) to (ex,ey,ez).
  function traceBox(sx, sy, sz, ex, ey, ez) {
    if (nodeCount === 0 || brushCount === 0) {
      return { fraction: 1, nx: 0, ny: 1, nz: 0,
               startSolid: false, allSolid: false,
               ex, ey, ez };
    }

    if (++_stampVal >= 0x7FFFFFFF) { _stamp.fill(0); _stampVal = 1; }

    _sx = sx; _sy = sy; _sz = sz;
    _ex = ex; _ey = ey; _ez = ez;
    _tFrac     = 1;
    _tNX       = 0; _tNY = 1; _tNZ = 0;
    _tSolid    = false;
    _tAllSolid = false;

    walkNode(0, 0);

    const f = _tFrac;
    return {
      fraction:   f,
      nx: _tNX, ny: _tNY, nz: _tNZ,
      startSolid: _tSolid,
      allSolid:   _tAllSolid,
      ex: sx + (ex - sx) * f,
      ey: sy + (ey - sy) * f,
      ez: sz + (ez - sz) * f,
    };
  }

  // ── PM_ClipVelocity ───────────────────────────────────────────────────────────
  function clipVel(vx, vy, vz, nx, ny, nz) {
    let backoff = vx * nx + vy * ny + vz * nz;
    if (backoff < 0) backoff *= OVERCLIP;
    else             backoff /= OVERCLIP;
    return { vx: vx - nx * backoff, vy: vy - ny * backoff, vz: vz - nz * backoff };
  }

  // ── PM_SlideMove ─────────────────────────────────────────────────────────────
  // Faithful Q3 bg_pmove.c PM_SlideMove.
  //
  // FIX 2: The initial clip-plane list now only contains the ground normal (if on
  // ground), matching Q3's behaviour.  The old code additionally added the current
  // velocity direction as a plane, which is not in the Q3 source and could cause
  // the k-plane triple-stop to fire prematurely against flat walls.
  function PM_SlideMove(gravity, dt) {
    let bumpcount, numbumps = 4;
    let time_left = dt;

    let primalVX = velocity.x, primalVY = velocity.y, primalVZ = velocity.z;
    let endVX = velocity.x, endVY = velocity.y, endVZ = velocity.z;

    if (gravity) {
      endVY = velocity.y + CFG.GRAVITY * dt;
      velocity.y = (velocity.y + endVY) * 0.5;
      primalVY = endVY;
      if (onGround) {
        const cv = clipVel(velocity.x, velocity.y, velocity.z, groundNX, groundNY, groundNZ);
        velocity.x = cv.vx; velocity.y = cv.vy; velocity.z = cv.vz;
      }
    }

    // Initial clip-plane list: ground normal only (if on ground).
    // Q3 does NOT add the velocity direction here — doing so caused spurious
    // triple-stop kills against single flat walls (FIX 2).
    const pns = [];       // flat array [nx, ny, nz, ...]
    let numplanes = 0;

    if (onGround) {
      pns.push(groundNX, groundNY, groundNZ);
      numplanes++;
    }

    for (bumpcount = 0; bumpcount < numbumps; bumpcount++) {
      const endX = physPos.x + time_left * velocity.x;
      const endY = physPos.y + time_left * velocity.y;
      const endZ = physPos.z + time_left * velocity.z;

      const trace = traceBox(physPos.x, physPos.y, physPos.z, endX, endY, endZ);

      if (trace.allSolid) {
        velocity.y = 0;
        return true;
      }

      if (trace.fraction > 0) {
        physPos.x = trace.ex;
        physPos.y = trace.ey;
        physPos.z = trace.ez;
      }

      if (trace.fraction === 1) {
        break;
      }

      time_left -= time_left * trace.fraction;

      if (numplanes >= MAX_CLIP_PLANES) {
        velocity.x = 0; velocity.y = 0; velocity.z = 0;
        return true;
      }

      // Check if we hit the same plane again → nudge away to prevent oscillation
      let i;
      for (i = 0; i < numplanes; i++) {
        if (trace.nx * pns[i * 3] + trace.ny * pns[i * 3 + 1] + trace.nz * pns[i * 3 + 2] > 0.99) {
          // Same plane: add a tiny push away from the surface (1 Q3-unit/s equivalent)
          velocity.x += trace.nx * 0.02;
          velocity.y += trace.ny * 0.02;
          velocity.z += trace.nz * 0.02;
          break;
        }
      }
      if (i < numplanes) continue;

      pns.push(trace.nx, trace.ny, trace.nz);
      numplanes++;

      let clipVX = 0, clipVY = 0, clipVZ = 0;
      let endClipVX = 0, endClipVY = 0, endClipVZ = 0;

      for (i = 0; i < numplanes; i++) {
        const p_i_nx = pns[i * 3], p_i_ny = pns[i * 3 + 1], p_i_nz = pns[i * 3 + 2];
        const into = velocity.x * p_i_nx + velocity.y * p_i_ny + velocity.z * p_i_nz;

        // Skip planes we are moving away from (or barely touching)
        if (into >= INTO_THRESH) continue;

        let cv = clipVel(velocity.x, velocity.y, velocity.z, p_i_nx, p_i_ny, p_i_nz);
        clipVX = cv.vx; clipVY = cv.vy; clipVZ = cv.vz;

        let ecv = clipVel(endVX, endVY, endVZ, p_i_nx, p_i_ny, p_i_nz);
        endClipVX = ecv.vx; endClipVY = ecv.vy; endClipVZ = ecv.vz;

        // Crease case: check every other accumulated plane
        let j;
        for (j = 0; j < numplanes; j++) {
          if (j === i) continue;
          const p_j_nx = pns[j * 3], p_j_ny = pns[j * 3 + 1], p_j_nz = pns[j * 3 + 2];

          if (clipVX * p_j_nx + clipVY * p_j_ny + clipVZ * p_j_nz >= INTO_THRESH) continue;

          cv = clipVel(clipVX, clipVY, clipVZ, p_j_nx, p_j_ny, p_j_nz);
          clipVX = cv.vx; clipVY = cv.vy; clipVZ = cv.vz;

          ecv = clipVel(endClipVX, endClipVY, endClipVZ, p_j_nx, p_j_ny, p_j_nz);
          endClipVX = ecv.vx; endClipVY = ecv.vy; endClipVZ = ecv.vz;

          if (clipVX * p_i_nx + clipVY * p_i_ny + clipVZ * p_i_nz >= 0) continue;

          // Crease direction: cross product of the two plane normals
          let dirX = p_i_ny * p_j_nz - p_i_nz * p_j_ny;
          let dirY = p_i_nz * p_j_nx - p_i_nx * p_j_nz;
          let dirZ = p_i_nx * p_j_ny - p_i_ny * p_j_nx;
          let dirlen = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
          if (dirlen > 0) {
            dirX /= dirlen; dirY /= dirlen; dirZ /= dirlen;
          }

          let d = dirX * velocity.x + dirY * velocity.y + dirZ * velocity.z;
          clipVX = dirX * d; clipVY = dirY * d; clipVZ = dirZ * d;

          d = dirX * endVX + dirY * endVY + dirZ * endVZ;
          endClipVX = dirX * d; endClipVY = dirY * d; endClipVZ = dirZ * d;

          // Triple-stop: if the crease velocity is into a third plane, stop entirely
          let k;
          for (k = 0; k < numplanes; k++) {
            if (k === i || k === j) continue;
            const p_k_nx = pns[k * 3], p_k_ny = pns[k * 3 + 1], p_k_nz = pns[k * 3 + 2];

            if (clipVX * p_k_nx + clipVY * p_k_ny + clipVZ * p_k_nz >= INTO_THRESH) continue;

            velocity.x = 0; velocity.y = 0; velocity.z = 0;
            return true;
          }
        }

        velocity.x = clipVX; velocity.y = clipVY; velocity.z = clipVZ;
        endVX = endClipVX; endVY = endClipVY; endVZ = endClipVZ;
        break;
      }
    }

    if (gravity) {
      velocity.x = endVX; velocity.y = endVY; velocity.z = endVZ;
    } else {
      velocity.y = primalVY; // ground mode: don't alter vertical velocity
    }

    return (bumpcount !== 0);
  }

  // ── PM_StepSlideMove ─────────────────────────────────────────────────────────
  // Faithful Q3 PM_StepSlideMove.
  function PM_StepSlideMove(gravity, dt) {
    const start_o = { x: physPos.x, y: physPos.y, z: physPos.z };
    const start_v = { x: velocity.x, y: velocity.y, z: velocity.z };

    if (!PM_SlideMove(gravity, dt)) {
      return; // reached destination on first try
    }

    const down_o  = { x: start_o.x, y: start_o.y - STEPSIZE, z: start_o.z };
    const traceDown = traceBox(start_o.x, start_o.y, start_o.z, down_o.x, down_o.y, down_o.z);

    if (velocity.y > 0 && (traceDown.fraction === 1.0 || traceDown.ny < 0.7)) {
      return;
    }

    // Save slide result
    const slide_o = { x: physPos.x, y: physPos.y, z: physPos.z };
    const slide_v = { x: velocity.x, y: velocity.y, z: velocity.z };

    const up_o    = { x: start_o.x, y: start_o.y + STEPSIZE, z: start_o.z };
    const traceUp = traceBox(start_o.x, start_o.y, start_o.z, up_o.x, up_o.y, up_o.z);

    if (traceUp.allSolid) {
      physPos.x = slide_o.x; physPos.y = slide_o.y; physPos.z = slide_o.z;
      velocity.x = slide_v.x; velocity.y = slide_v.y; velocity.z = slide_v.z;
      return;
    }

    const stepSize = traceUp.ey - start_o.y;

    // Slide from elevated position
    physPos.x = traceUp.ex; physPos.y = traceUp.ey; physPos.z = traceUp.ez;
    velocity.x = start_v.x; velocity.y = start_v.y; velocity.z = start_v.z;

    PM_SlideMove(gravity, dt);

    // Push back down to step height
    const pushDown_o = { x: physPos.x, y: physPos.y - stepSize, z: physPos.z };
    const tracePush  = traceBox(physPos.x, physPos.y, physPos.z,
                                pushDown_o.x, pushDown_o.y, pushDown_o.z);

    // Reject step if we landed on a steep surface (wall-climbing guard)
    if (tracePush.fraction < 1.0 && tracePush.ny < SLOPE_MIN_Y) {
      physPos.x = slide_o.x; physPos.y = slide_o.y; physPos.z = slide_o.z;
      velocity.x = slide_v.x; velocity.y = slide_v.y; velocity.z = slide_v.z;
      return;
    }

    if (!tracePush.allSolid) {
      physPos.x = tracePush.ex; physPos.y = tracePush.ey; physPos.z = tracePush.ez;
    }
    if (tracePush.fraction < 1.0) {
      const cv = clipVel(velocity.x, velocity.y, velocity.z,
                         tracePush.nx, tracePush.ny, tracePush.nz);
      velocity.x = cv.vx; velocity.y = cv.vy; velocity.z = cv.vz;
    }
  }

  // ── PM_GroundTrace ────────────────────────────────────────────────────────────
  // Short downward trace to detect and snap to the floor.
  function PM_GroundTrace() {
    const tr = traceBox(physPos.x, physPos.y, physPos.z,
                        physPos.x, physPos.y - GROUND_DIST, physPos.z);

    if (tr.fraction >= 1) {
      onGround = false;
      return;
    }

    if (tr.ny < SLOPE_MIN_Y) {
      onGround = false; // surface too steep to stand on
      return;
    }

    // Kickoff check: if moving upward into the ground normal, we are jumping
    if (velocity.y > 0) {
      const into = velocity.x * tr.nx + velocity.y * tr.ny + velocity.z * tr.nz;
      if (into > 0.2) {
        onGround = false;
        return;
      }
    }

    // Validate snap position: reject points inside solid (brush junction)
    const snapTr = traceBox(tr.ex, tr.ey, tr.ez, tr.ex, tr.ey, tr.ez);
    if (snapTr.allSolid) { onGround = false; return; }

    // Snap and record floor normal
    physPos.x = tr.ex; physPos.y = tr.ey; physPos.z = tr.ez;
    groundNX = tr.nx; groundNY = tr.ny; groundNZ = tr.nz;
    onGround = true;

    if (velocity.y < 0) velocity.y = 0;
  }

  // ── PM_Friction ───────────────────────────────────────────────────────────────
  // Q3 pm_friction applied to horizontal velocity only.
  function PM_Friction(dt) {
    const hSpeedSq = velocity.x * velocity.x + velocity.z * velocity.z;
    if (hSpeedSq < 0.0001) { velocity.x = 0; velocity.z = 0; return; }

    const speed    = Math.sqrt(hSpeedSq);
    const control  = Math.max(speed, STOP_SPEED);
    const drop     = control * FRICTION * dt;
    const newSpeed = Math.max(0, speed - drop) / speed;

    velocity.x *= newSpeed;
    velocity.z *= newSpeed;
  }

  // ── PM_Accelerate ─────────────────────────────────────────────────────────────
  // Q3 addspeed clamp: only add velocity toward wishdir up to wishSpeed.
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

  // ── Main update ───────────────────────────────────────────────────────────────
  function update(camera, keys, yaw, dt) {
    dt = Math.min(dt, 0.05);

    // Sync physPos from camera (picks up external position changes like portals)
    physPos.set(camera.position.x, camera.position.y - halfH, camera.position.z);

    // ── Turning ──────────────────────────────────────────────────────────────
    if (keys['a'] || keys['arrowleft'])  yaw += CFG.TURN_SPEED * dt;
    if (keys['d'] || keys['arrowright']) yaw -= CFG.TURN_SPEED * dt;

    // ── Head tilt (Q / E) ────────────────────────────────────────────────────
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

    // ── Jump ─────────────────────────────────────────────────────────────────
    if ((keys[' '] || keys['space']) && onGround) {
      velocity.y = CFG.JUMP_SPEED;
      onGround   = false;
    }

    // ── Wish direction ────────────────────────────────────────────────────────
    // A/D = turn only (no strafing).  W/S = forward/backward.
    let mvZ = 0;
    if (keys['w'] || keys['arrowup'])   mvZ -= 1;
    if (keys['s'] || keys['arrowdown']) mvZ += 1;

    const cosY  = Math.cos(yaw), sinY = Math.sin(yaw);
    const wishDX = mvZ * sinY;
    const wishDZ = mvZ * cosY;

    // ── Ground movement ───────────────────────────────────────────────────────
    if (onGround) {
      PM_Friction(dt);
      PM_Accelerate(wishDX, wishDZ, CFG.MOVE_SPEED, ACCEL_GROUND, dt);

      // Clip velocity to ground plane (player follows slope surface)
      const gDot = velocity.x * groundNX + velocity.y * groundNY + velocity.z * groundNZ;
      if (gDot < 0) {
        const gb = gDot * OVERCLIP;
        velocity.x -= groundNX * gb;
        velocity.y -= groundNY * gb;
        velocity.z -= groundNZ * gb;
      }
      // Zero residual vertical component on flat ground
      if (groundNY > 0.99) velocity.y = 0;

      PM_StepSlideMove(false, dt);

    } else {
      // ── Air movement ──────────────────────────────────────────────────────
      velocity.y = Math.max(velocity.y, CFG.TERMINAL_VEL);
      PM_Accelerate(wishDX, wishDZ, CFG.MOVE_SPEED, ACCEL_AIR, dt);
      PM_StepSlideMove(true, dt);
    }

    // ── Ground trace ─────────────────────────────────────────────────────────
    PM_GroundTrace();

    // ── Push result back into camera ─────────────────────────────────────────
    camera.position.set(physPos.x, physPos.y + halfH, physPos.z);

    return yaw;
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  return {
    update,

    // No-op: BSP data is static, no scene traversal needed.
    // Kept for drop-in compatibility with engine.js.
    refreshCollidables() {},

    teleport(camera, x, y, z) {
      camera.position.set(x, y, z);
      physPos.set(x, y - halfH, z);
      velocity.set(0, 0, 0);
      onGround     = false;
      currentPitch = 0;
    },

    get isOnGround() { return onGround; },
    get velocityY()  { return velocity.y; },
  };
}