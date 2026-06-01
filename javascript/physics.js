/**
 * SPELEC PHYSICS v4.0 — Q3-FAITHFUL AABB BRUSH COLLISION
 *
 * The previous sphere-trace approach was geometrically wrong for a tall player:
 * a sphere of radius PLAYER_RADIUS (0.28) expands every brush plane by only 0.28,
 * but a player AABB (0.28 × 0.80 × 0.28) requires expansion of up to 0.80 for
 * near-horizontal planes.  The result: the player's foot corners clipped through
 * angled brush surfaces and they fell.
 *
 * This version implements the exact Q3 CM_ClipBoxToBrush algorithm:
 *   offset = |nx|·halfW + |ny|·halfH + |nz|·halfW   (per-plane, direction-aware)
 * This is the Minkowski-sum expansion of the AABB, mathematically exact for any
 * brush-plane orientation.
 *
 * Movement is re-implemented following bg_pmove.c closely:
 *   PM_SlideMove      — 4-bump loop, same-plane nudge, crease projection, triple stop
 *   PM_StepSlideMove  — save start, slide, conditionally step, compare
 *   PM_GroundTrace    — short downward trace (snap to floor endpos, kickoff check)
 *   PM_Friction       — Q3-style exponential-feeling deceleration
 *   PM_Accelerate     — Q3 addspeed clamp for instant-feeling direction changes
 *
 * physPos = AABB centre (mid-body).  camera.position = physPos + (0, halfH, 0).
 * That is the only externally visible change: the camera is no longer used as the
 * collision origin directly.
 *
 * Public API is identical to v2.9 / v3.0:
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
  SKIN_WIDTH:      0.02,         // units    — small gap kept from surfaces
  GROUND_CHECK:    0.18,         // (unused, ground detection is now fixed-dist)
  NUM_SIDE_RAYS:   10,           // (unused in BSP physics)
  NUM_SLOPE_RAYS:  4,            // (unused in BSP physics)
};

// ── Q3 content flags ───────────────────────────────────────────────────────────
const CONTENTS_SOLID      = 1;
const CONTENTS_PLAYERCLIP = 0x10000;

// ── Trace / clip constants ─────────────────────────────────────────────────────
// MOVE_EPSILON: the tiny gap left between the AABB and a surface.
// Prevents floating-point re-entry on the next frame.
const MOVE_EPSILON    = 0.01;

// OVERCLIP: Q3 uses 1.001 so velocity is reflected slightly past the plane,
// guaranteeing the player drifts away rather than skating along it.
const OVERCLIP        = 1.001;

// INTO_THRESH: only bother clipping velocity against a plane when the player
// is moving at least this fast INTO it.  Filters float noise.
// Q3 uses 0.1 Q3-units/s → 0.1 × 0.02 = 0.002 Three.js units/s.
// We use 0.001 to ensure even very slow movement into walls is clipped.
const INTO_THRESH     = 0.001;

const MAX_CLIP_PLANES = 5;    // max accumulated bounce planes per slide
const MAX_NODE_DEPTH  = 128;  // BSP recursion guard

// ── Q3-calibrated movement constants (already in Three.js-unit space) ──────────
const STOP_SPEED  = 100 * 0.02;  // 2.0  — friction ramps up below this speed
const FRICTION    = 6;           // dimensionless — Q3 pm_friction
const ACCEL_GROUND = 10;         // Q3 pm_accelerate
const ACCEL_AIR    = 1.5;        // Q3 pm_airaccelerate (much lower)

// ── Short ground-check distance ────────────────────────────────────────────────
// Q3 uses 0.25 Q3-units (= 0.005 Three.js).  We use a larger value to account
// for MOVE_EPSILON gaps left by the trace and for sub-60fps frames.
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

  // AABB half-extents.  halfH is the vertical half (camera to feet = PLAYER_HEIGHT,
  // so half = PLAYER_HEIGHT / 2).  halfW is the horizontal radius.
  const halfW = CFG.PLAYER_RADIUS;
  const halfH = CFG.PLAYER_HEIGHT / 2;

  // Conservative sphere bound for the BSP walk.  The true max AABB offset for
  // any plane is sqrt(halfW²+halfH²+halfW²); using halfH is an overestimate that
  // keeps the BSP walk safe.
  const bspBound = Math.sqrt(halfW * halfW + halfH * halfH + halfW * halfW);

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
  // Q3 CM_ClipBoxToBrush adapted for an AABB sweep.
  // The key difference from a sphere: each brush plane is expanded by a different
  // offset depending on the plane orientation:
  //   offset = |nx|·halfW + |ny|·halfH + |nz|·halfW
  // For a floor plane (ny ≈ 1) this gives halfH.  For a wall (nx ≈ 1) it gives
  // halfW.  For a 45° slope it gives a value in between.  A sphere of radius
  // halfW would give the same value for ALL orientations — far too small for
  // near-horizontal planes — which is exactly why the player fell through angled
  // surfaces with the previous implementation.
  function testBrush(brushIdx) {
    if (brushIdx < 0 || brushIdx >= brushCount) return;
    if (_stamp[brushIdx] === _stampVal) return; // already tested this trace
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

      // AABB Minkowski expansion — different per plane orientation
      const offset = Math.abs(nx) * halfW + Math.abs(ny) * halfH + Math.abs(nz) * halfW;
      const dist   = planes[pi + 3] + offset;

      const d1 = nx * _sx + ny * _sy + nz * _sz - dist; // signed dist, start
      const d2 = nx * _ex + ny * _ey + nz * _ez - dist; // signed dist, end

      if (d1 > 0) startsOut = true;
      if (d2 > 0) endsOut   = true;

      if (d1 > 0 && d2 > 0) return;    // entirely outside this plane → outside brush
      if (d1 <= 0 && d2 <= 0) continue; // entirely inside → this plane doesn't clip

      if (d1 > d2) {
        // entering: earliest entry fraction
        const f = (d1 - MOVE_EPSILON) / (d1 - d2);
        if (f > enterFrac) { enterFrac = f; hx = nx; hy = ny; hz = nz; }
      } else {
        // leaving: keep earliest leave
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
  // BSP tree descent.  Uses the AABB bounding sphere (bspBound) to prune
  // branches that the swept box cannot reach.
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
    const c0       = nodes[no + 1]; // front child
    const c1       = nodes[no + 2]; // back child
    if (pi < 0 || pi + 3 >= planes.length) return;

    const nx   = planes[pi], ny = planes[pi + 1], nz = planes[pi + 2];
    const dist = planes[pi + 3];

    const d1 = nx * _sx + ny * _sy + nz * _sz - dist;
    const d2 = nx * _ex + ny * _ey + nz * _ez - dist;

    // Use exact per-plane AABB offset for tighter pruning
    const r = Math.abs(nx) * halfW + Math.abs(ny) * halfH + Math.abs(nz) * halfW;

    if (d1 >= r && d2 >= r) {
      walkNode(c0, depth + 1); // entirely in front
    } else if (d1 < -r && d2 < -r) {
      walkNode(c1, depth + 1); // entirely behind
    } else {
      // Crosses: visit both.  Visit the side the start is on first.
      if (d1 >= 0) { walkNode(c0, depth + 1); walkNode(c1, depth + 1); }
      else         { walkNode(c1, depth + 1); walkNode(c0, depth + 1); }
    }
  }

  // ── traceBox ─────────────────────────────────────────────────────────────────
  // Sweep the AABB from (sx,sy,sz) to (ex,ey,ez).
  // Returns the hit fraction and normal, plus the endpos of the AABB centre.
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
  function PM_SlideMove(gravity, dt) {
    let bumpcount, numbumps = 4;
    let time_left = dt;
    let endX, endY, endZ;

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

    const pns = []; // flat array [nx, ny, nz, ...]
    let numplanes = 0;

    if (onGround) {
      pns.push(groundNX, groundNY, groundNZ);
      numplanes++;
    }

    const speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z);
    if (speed > 0) {
      pns.push(velocity.x / speed, velocity.y / speed, velocity.z / speed);
      numplanes++;
    }

    for (bumpcount = 0; bumpcount < numbumps; bumpcount++) {
      endX = physPos.x + time_left * velocity.x;
      endY = physPos.y + time_left * velocity.y;
      endZ = physPos.z + time_left * velocity.z;

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

      let i;
      for (i = 0; i < numplanes; i++) {
        if (trace.nx * pns[i * 3] + trace.ny * pns[i * 3 + 1] + trace.nz * pns[i * 3 + 2] > 0.99) {
          velocity.x += trace.nx * 0.02; // scaled Q3 epsilon
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
        
        if (into >= INTO_THRESH) continue;

        let cv = clipVel(velocity.x, velocity.y, velocity.z, p_i_nx, p_i_ny, p_i_nz);
        clipVX = cv.vx; clipVY = cv.vy; clipVZ = cv.vz;

        let ecv = clipVel(endVX, endVY, endVZ, p_i_nx, p_i_ny, p_i_nz);
        endClipVX = ecv.vx; endClipVY = ecv.vy; endClipVZ = ecv.vz;

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
      velocity.y = primalVY; // Don't change vertical velocity if not in gravity
    }

    return (bumpcount !== 0);
  }

  // ── PM_StepSlideMove ─────────────────────────────────────────────────────────
  // Faithful Q3 PM_StepSlideMove.
  function PM_StepSlideMove(gravity, dt) {
    const start_o = { x: physPos.x, y: physPos.y, z: physPos.z };
    const start_v = { x: velocity.x, y: velocity.y, z: velocity.z };

    if (!PM_SlideMove(gravity, dt)) {
      return; // we got exactly where we wanted to go first try
    }

    const down_o = { x: start_o.x, y: start_o.y - STEPSIZE, z: start_o.z };
    const traceDown = traceBox(start_o.x, start_o.y, start_o.z, down_o.x, down_o.y, down_o.z);

    if (velocity.y > 0 && (traceDown.fraction === 1.0 || traceDown.ny < 0.7)) {
      return;
    }

    // save slide result
    const slide_o = { x: physPos.x, y: physPos.y, z: physPos.z };
    const slide_v = { x: velocity.x, y: velocity.y, z: velocity.z };

    const up_o = { x: start_o.x, y: start_o.y + STEPSIZE, z: start_o.z };
    
    // test step up
    const traceUp = traceBox(start_o.x, start_o.y, start_o.z, up_o.x, up_o.y, up_o.z);
    if (traceUp.allSolid) {
      // restore slide result
      physPos.x = slide_o.x; physPos.y = slide_o.y; physPos.z = slide_o.z;
      velocity.x = slide_v.x; velocity.y = slide_v.y; velocity.z = slide_v.z;
      return;
    }

    const stepSize = traceUp.ey - start_o.y;
    
    // slide from elevated position
    physPos.x = traceUp.ex; physPos.y = traceUp.ey; physPos.z = traceUp.ez;
    velocity.x = start_v.x; velocity.y = start_v.y; velocity.z = start_v.z;

    PM_SlideMove(gravity, dt);

    // push down
    const pushDown_o = { x: physPos.x, y: physPos.y - stepSize, z: physPos.z };
    const tracePush = traceBox(physPos.x, physPos.y, physPos.z, pushDown_o.x, pushDown_o.y, pushDown_o.z);

    if (!tracePush.allSolid) {
      physPos.x = tracePush.ex; physPos.y = tracePush.ey; physPos.z = tracePush.ez;
    }
    if (tracePush.fraction < 1.0) {
      const cv = clipVel(velocity.x, velocity.y, velocity.z, tracePush.nx, tracePush.ny, tracePush.nz);
      velocity.x = cv.vx; velocity.y = cv.vy; velocity.z = cv.vz;
    }
  }

  // ── PM_GroundTrace ────────────────────────────────────────────────────────────
  // Trace GROUND_DIST downward from physPos.  If a walkable surface is found,
  // snap physPos to its endpos and set onGround = true.
  // "Kickoff" check: if the player has significant upward velocity into the ground
  // normal, they are leaving the ground (e.g. start of a jump).
  function PM_GroundTrace() {
    const tr = traceBox(physPos.x, physPos.y, physPos.z,
                        physPos.x, physPos.y - GROUND_DIST, physPos.z);

    if (tr.fraction >= 1) {
      onGround = false;
      return;
    }

    if (tr.ny < SLOPE_MIN_Y) {
      onGround = false; // surface too steep
      return;
    }

    // Kickoff: Q3 checks if velocity along ground normal > 10 Q3 u/s (~0.2 Three.js)
    if (velocity.y > 0) {
      const into = velocity.x * tr.nx + velocity.y * tr.ny + velocity.z * tr.nz;
      if (into > 0.2) {
        onGround = false; // jumping — leave ground
        return;
      }
    }

    // Validate snap: don't snap into a brush junction (wall meets floor)
    const snapTr = traceBox(tr.ex, tr.ey, tr.ez, tr.ex, tr.ey, tr.ez);
    if (snapTr.allSolid) { onGround = false; return; }

    // Snap to floor and record normal
    physPos.x = tr.ex; physPos.y = tr.ey; physPos.z = tr.ez;
    groundNX = tr.nx; groundNY = tr.ny; groundNZ = tr.nz;
    onGround = true;

    // Kill downward velocity
    if (velocity.y < 0) velocity.y = 0;
  }

  // ── PM_Friction ───────────────────────────────────────────────────────────────
  // Q3 pm_friction applied to horizontal velocity only (vertical is gravity).
  function PM_Friction(dt) {
    const hSpeedSq = velocity.x * velocity.x + velocity.z * velocity.z;
    if (hSpeedSq < 0.0001) { velocity.x = 0; velocity.z = 0; return; }

    const speed    = Math.sqrt(hSpeedSq);
    const control  = Math.max(speed, STOP_SPEED); // ramp up friction at low speed
    const drop     = control * FRICTION * dt;
    const newSpeed = Math.max(0, speed - drop) / speed;

    velocity.x *= newSpeed;
    velocity.z *= newSpeed;
  }

  // ── PM_Accelerate ─────────────────────────────────────────────────────────────
  // Q3 addspeed clamp: only add velocity in wishdir up to wishSpeed.
  // Gives instant-feeling directional response on the ground.
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

  // ── PM_UnstickIfSolid ────────────────────────────────────────────────────────
  // Runs EVERY frame.  A zero-distance trace detects if the AABB centre is inside
  // a brush (allSolid).  If so, nudge physPos upward until clear.
  // This handles spawn, teleport, and any edge case where PM_GroundTrace would
  // snap the player into a wall-floor junction.
  // Cost: one BSP tree walk per frame when clear (negligible); up to ~20 more
  // when actually stuck (rare, temporary).
  function PM_UnstickIfSolid() {
    const tr = traceBox(physPos.x, physPos.y, physPos.z,
                        physPos.x, physPos.y, physPos.z);
    if (!tr.allSolid) return;

    for (let i = 1; i <= 20; i++) {
      const testY = physPos.y + i * 0.05;
      const tr2   = traceBox(physPos.x, testY, physPos.z,
                              physPos.x, testY, physPos.z);
      if (!tr2.allSolid) {
        physPos.y = testY;
        onGround  = false;
        return;
      }
    }
  }

  // ── Main update ───────────────────────────────────────────────────────────────
  function update(camera, keys, yaw, dt) {
    dt = Math.min(dt, 0.05);

    // Sync physPos from camera (picks up external position changes like portals)
    physPos.set(camera.position.x, camera.position.y - halfH, camera.position.z);

    // ── Unstick if inside solid geometry (runs every frame, cheap when clear) ──
    PM_UnstickIfSolid();

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
    // Set onGround = false immediately so PM_AirMove runs this frame.
    if ((keys[' '] || keys['space']) && onGround) {
      velocity.y = CFG.JUMP_SPEED;
      onGround   = false;
    }

    // ── Wish direction ────────────────────────────────────────────────────────
    // A/D = turn only (no strafing).  W/S = forward/backward.
    // applyAxisAngle(Y, yaw) on (0, 0, mvZ):
    //   world X = mvZ * sin(yaw),  world Z = mvZ * cos(yaw)
    let mvZ = 0;
    if (keys['w'] || keys['arrowup'])   mvZ -= 1;
    if (keys['s'] || keys['arrowdown']) mvZ += 1;

    const cosY  = Math.cos(yaw), sinY = Math.sin(yaw);
    const wishDX = mvZ * sinY;
    const wishDZ = mvZ * cosY;

    // ── Ground movement ───────────────────────────────────────────────────────
    if (onGround) {
      // PM_Friction → PM_Accelerate → clip to slope → step-slide (no gravity)
      PM_Friction(dt);
      PM_Accelerate(wishDX, wishDZ, CFG.MOVE_SPEED, ACCEL_GROUND, dt);

      // Clip velocity to ground plane (makes player follow slope surface)
      const gDot = velocity.x * groundNX + velocity.y * groundNY + velocity.z * groundNZ;
      if (gDot < 0) {
        const gb = gDot * OVERCLIP;
        velocity.x -= groundNX * gb;
        velocity.y -= groundNY * gb;
        velocity.z -= groundNZ * gb;
      }
      // On flat ground, zero the tiny remaining vertical component
      if (groundNY > 0.99) velocity.y = 0;

      PM_StepSlideMove(false, dt);

    } else {
      // ── Air movement ──────────────────────────────────────────────────────
      // Limited acceleration in air (Q3 feel).
      // Gravity is applied inside PM_SlideMove via the Verlet averaging.
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
    // Kept for drop-in compatibility with engine.js which calls this after load.
    refreshCollidables() {},

    teleport(camera, x, y, z) {
      camera.position.set(x, y, z);
      physPos.set(x, y - halfH, z);
      velocity.set(0, 0, 0);
      onGround     = false;
      currentPitch = 0;
      // PM_UnstickIfSolid will handle bad spawn positions on the next update()
    },

    get isOnGround() { return onGround; },
    get velocityY()  { return velocity.y; },
  };
}
