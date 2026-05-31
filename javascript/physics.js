/**
 * SPELEC PHYSICS v3.0 — Q3 BSP BRUSH COLLISION
 *
 * Replaces all mesh raycasting with BSP brush sphere traces.
 * This fixes the "fall through angled brushes" bug completely:
 * the old system used discrete rays that could slip through the gap
 * between two angled surfaces; a sphere sweep test against brush planes
 * is geometrically exact and cannot miss a surface.
 *
 * Key algorithms:
 *   traceSphere(sx,sy,sz, ex,ey,ez, r)
 *     Walks the BSP tree from the root (node 0), visits all leafs that the
 *     swept sphere (radius r) might intersect, and for each leaf tests every
 *     solid brush (CONTENTS_SOLID | CONTENTS_PLAYERCLIP) with the Q3
 *     ClipMoveToEntities algorithm.  Returns {fraction, nx,ny,nz, startSolid}.
 *
 *   slideMove(px,py,pz, vx,vy,vz, dt)
 *     Q3-style PM_SlideMove with up to 4 bump iterations and multi-plane
 *     velocity clipping.  When velocity is clipped against two planes that
 *     both oppose motion the resulting velocity is projected onto the crease
 *     (cross product of the two normals) — this is what prevents fall-through
 *     in concave corners.
 *
 *   stepSlideMove(px,py,pz, vx,vy,vz, dt)
 *     Tries a normal slideMove first.  If horizontally blocked (< 98 % of
 *     desired distance covered) AND the player is on the ground, it lifts the
 *     sphere by STEP_HEIGHT, slides again, traces back down to find the new
 *     floor, and accepts the result if the step is within STEP_HEIGHT.
 *
 *   groundCheck(px,py,pz)
 *     Traces the player sphere straight down from the camera (eye) position.
 *     Returns the new camera Y if a walkable floor is within reach, or null.
 *     Only called after movement; physics.js then snaps camera.y if the floor
 *     is within SKIN_WIDTH*2 of the current position.
 *
 * Coordinate convention (same as the rest of SPELEC):
 *   camera.position = eye / top of player
 *   feet at  camera.y − PLAYER_HEIGHT
 *   Sphere for collision centred at camera position, radius = PLAYER_RADIUS
 *
 * Public API (unchanged from v2.9):
 *   createPhysics(bspCollision, userCFG) → { update, refreshCollidables, teleport,
 *                                            isOnGround, velocityY }
 *   update(camera, keys, yaw, dt) → yaw
 *   refreshCollidables()           no-op — BSP data is static
 *   teleport(camera, x, y, z)
 */

'use strict';

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';

// ── Default physics config (same keys as before for drop-in compatibility) ────
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
  PLAYER_MASS:     1.0,           // reserved
  STEP_HEIGHT:     0.45,
  SLOPE_MAX_ANGLE: 50,
  SKIN_WIDTH:      0.02,
  GROUND_CHECK:    0.18,
  NUM_SIDE_RAYS:   10,            // kept for config compat, not used
  NUM_SLOPE_RAYS:  4,             // kept for config compat, not used
};

// ── Q3 content flags ──────────────────────────────────────────────────────────
const CONTENTS_SOLID      = 1;
const CONTENTS_PLAYERCLIP = 0x10000;

// ── Trace constants ───────────────────────────────────────────────────────────
// MOVE_EPSILON: small gap so the sphere stops just before the surface,
// preventing floating-point sticking.  ~0.5 mm in Three.js units (UNIT=0.02).
const MOVE_EPSILON    = 0.01;
const OVERCLIP        = 1.001;   // velocity slightly overcorrected on bounce
const MAX_CLIP_PLANES = 5;       // max accumulated bounce planes per frame
const MAX_NODE_DEPTH  = 128;     // BSP tree recursion guard

// ── Helper: empty BSP for fallback room or missing data ──────────────────────
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

// ── createPhysics ─────────────────────────────────────────────────────────────
export function createPhysics(bspCollision, userCFG = {}) {
  const CFG = { ...DEFAULT_CFG, ...userCFG };
  const col = bspCollision ?? emptyBSP();
  const { planes, nodes, leafs, leafBrushes, brushes, brushSides } = col;

  const brushCount  = (brushes.length    / 3) | 0;
  const nodeCount   = (nodes.length      / 3) | 0;
  const leafCount   = (leafs.length      / 2) | 0;
  const planeCount  = (planes.length     / 4) | 0;
  const bsCount     = brushSides.length;

  // Slope threshold: normal.y must be >= this value to count as walkable floor
  const SLOPE_MIN_Y = Math.cos(CFG.SLOPE_MAX_ANGLE * Math.PI / 180);

  // ── Player state ──────────────────────────────────────────────────────────
  const velocity     = new THREE.Vector3();
  let   onGround     = false;
  let   currentPitch = 0;

  // ── Trace shared state (reused each call, single-threaded JS) ─────────────
  let _sx, _sy, _sz;           // trace start
  let _ex, _ey, _ez;           // trace end
  let _sr;                     // trace sphere radius
  let _tFrac;                  // result: hit fraction (0–1)
  let _tNX, _tNY, _tNZ;        // result: hit plane normal (Three.js space)
  let _tSolid, _tAllSolid;     // result: start-in-solid flags

  // Brush deduplication: stamp array avoids testing the same brush twice per
  // trace when it appears in multiple leafs along the path.
  const _stamp    = new Int32Array(Math.max(1, brushCount));
  let   _stampVal = 0;

  // ── testBrush ─────────────────────────────────────────────────────────────
  // Q3 CM_ClipBoxToBrush adapted for sphere sweep.
  // Expands each brush plane outward by _sr (the sphere radius).
  // Returns early (no hit) if the sweep is outside any plane.
  // Updates _tFrac / _tNX,NY,NZ if a closer hit is found.
  function testBrush(brushIdx) {
    if (brushIdx < 0 || brushIdx >= brushCount) return;
    // Stamp check — skip if already tested this trace
    if (_stamp[brushIdx] === _stampVal) return;
    _stamp[brushIdx] = _stampVal;

    const bi        = brushIdx * 3;
    const firstSide = brushes[bi];
    const numSides  = brushes[bi + 1];
    const contents  = brushes[bi + 2];

    // Only solid and playerclip brushes block the player
    if (!(contents & (CONTENTS_SOLID | CONTENTS_PLAYERCLIP))) return;
    if (numSides <= 0) return;

    let enterFrac = -1, leaveFrac = 1;
    let hx = 0, hy = 1, hz = 0; // normal of the entering plane
    let startsOut = false, endsOut = false;

    for (let s = 0; s < numSides; s++) {
      const si = firstSide + s;
      if (si < 0 || si >= bsCount) continue;

      const planeIdx = brushSides[si];
      const pi       = planeIdx * 4;
      if (pi < 0 || pi + 3 >= planes.length) continue;

      const nx   = planes[pi];
      const ny   = planes[pi + 1];
      const nz   = planes[pi + 2];
      // Expand plane outward by sphere radius
      const dist = planes[pi + 3] + _sr;

      const d1 = nx * _sx + ny * _sy + nz * _sz - dist; // signed dist: start
      const d2 = nx * _ex + ny * _ey + nz * _ez - dist; // signed dist: end

      if (d1 > 0) startsOut = true;
      if (d2 > 0) endsOut   = true;

      // Both start and end are outside this plane → the sphere never enters the brush
      if (d1 > 0 && d2 > 0) return;
      // Both inside this plane → this plane doesn't clip
      if (d1 <= 0 && d2 <= 0) continue;

      if (d1 > d2) {
        // Moving from outside to inside: entering fraction
        const f = (d1 - MOVE_EPSILON) / (d1 - d2);
        if (f > enterFrac) { enterFrac = f; hx = nx; hy = ny; hz = nz; }
      } else {
        // Moving from inside to outside: leaving fraction
        const f = (d1 + MOVE_EPSILON) / (d1 - d2);
        if (f < leaveFrac) leaveFrac = f;
      }
    }

    if (!startsOut) {
      // Sphere starts inside the brush
      _tSolid = true;
      if (!endsOut) _tAllSolid = true;
      return;
    }

    // Hit if we enter before we leave, and closer than any previous hit
    if (enterFrac < leaveFrac && enterFrac > -1 && enterFrac < _tFrac) {
      _tFrac = Math.max(0, enterFrac);
      _tNX = hx; _tNY = hy; _tNZ = hz;
    }
  }

  // ── walkNode ──────────────────────────────────────────────────────────────
  // Recursive BSP tree descent.  Children >= 0 are node indices;
  // children < 0 encode leaf index as -(child + 1).
  // We visit both children whenever the swept sphere spans a node plane,
  // ensuring no brush is missed even at plane boundaries.
  function walkNode(ni, depth) {
    if (depth > MAX_NODE_DEPTH) return;

    if (ni < 0) {
      // Leaf node
      const leafIdx = -(ni + 1);
      if (leafIdx >= leafCount) return;

      const lo      = leafIdx * 2;
      const firstLB = leafs[lo];
      const numLB   = leafs[lo + 1];

      for (let i = 0; i < numLB; i++) {
        const idx = firstLB + i;
        if (idx < leafBrushes.length) testBrush(leafBrushes[idx]);
      }
      return;
    }

    if (ni >= nodeCount) return;

    const no  = ni * 3;
    const pi  = nodes[no] * 4;
    const c0  = nodes[no + 1]; // front child
    const c1  = nodes[no + 2]; // back child

    if (pi < 0 || pi + 3 >= planes.length) return;

    const nx   = planes[pi];
    const ny   = planes[pi + 1];
    const nz   = planes[pi + 2];
    const dist = planes[pi + 3];

    const d1 = nx * _sx + ny * _sy + nz * _sz - dist; // start signed distance
    const d2 = nx * _ex + ny * _ey + nz * _ez - dist; // end signed distance
    const r  = _sr;

    if (d1 >= r && d2 >= r) {
      // Entire sweep is strictly in front of this plane → front child only
      walkNode(c0, depth + 1);
    } else if (d1 < -r && d2 < -r) {
      // Entire sweep is strictly behind this plane → back child only
      walkNode(c1, depth + 1);
    } else {
      // Sweep spans (or touches) the plane → must visit both children.
      // Visit the side the start point is on first (slightly more cache-friendly).
      if (d1 >= 0) {
        walkNode(c0, depth + 1);
        walkNode(c1, depth + 1);
      } else {
        walkNode(c1, depth + 1);
        walkNode(c0, depth + 1);
      }
    }
  }

  // ── traceSphere ───────────────────────────────────────────────────────────
  // Entry point for all collision queries.
  // Returns an object with:
  //   fraction   — how far along (sx→ex) before first hit (1 = no hit)
  //   nx,ny,nz   — surface normal at the hit point (Three.js space)
  //   startSolid — true if the start position is already inside a brush
  //   allSolid   — true if both start and end are inside a brush
  function traceSphere(sx, sy, sz, ex, ey, ez, radius) {
    if (nodeCount === 0 || brushCount === 0) {
      // No BSP data (e.g. fallback room)
      return { fraction: 1, nx: 0, ny: 1, nz: 0, startSolid: false, allSolid: false };
    }

    // Advance stamp to invalidate previous brush tests without clearing the array
    if (++_stampVal >= 0x7FFFFFFF) { _stamp.fill(0); _stampVal = 1; }

    _sx = sx; _sy = sy; _sz = sz;
    _ex = ex; _ey = ey; _ez = ez;
    _sr = radius;

    _tFrac    = 1;
    _tNX      = 0; _tNY = 1; _tNZ = 0;
    _tSolid   = false;
    _tAllSolid = false;

    walkNode(0, 0); // BSP root is always node index 0

    return {
      fraction:   _tFrac,
      nx:         _tNX,
      ny:         _tNY,
      nz:         _tNZ,
      startSolid: _tSolid,
      allSolid:   _tAllSolid,
    };
  }

  // ── slideMove ─────────────────────────────────────────────────────────────
  // Q3-style PM_SlideMove with multi-plane clipping.
  // Up to 4 bump iterations.  On each bump:
  //   1. Trace from current position toward desired end.
  //   2. Move up to the hit (or full distance if no hit).
  //   3. Clip velocity against hit plane.
  //   4. Check if clipped velocity re-enters any previously-hit plane;
  //      if so, project onto the crease (cross product of the two normals).
  // This crease projection is the key fix for concave brush corners —
  // without it the player accelerates into the corner and falls through.
  function slideMove(px, py, pz, vx, vy, vz, dt) {
    let timeLeft = dt;
    let cpx = px, cpy = py, cpz = pz;
    let cvx = vx, cvy = vy, cvz = vz;

    // Accumulated plane normals from each bounce (flattened: [nx,ny,nz, ...])
    const pns    = [];
    let numClip  = 0;

    for (let bump = 0; bump < 4 && timeLeft > 0.0001; bump++) {
      const dx = cvx * timeLeft;
      const dy = cvy * timeLeft;
      const dz = cvz * timeLeft;

      const tr = traceSphere(cpx, cpy, cpz,
                              cpx + dx, cpy + dy, cpz + dz,
                              CFG.PLAYER_RADIUS);

      if (tr.allSolid) {
        // Deep inside solid — stop all movement
        cvy = 0;
        break;
      }

      if (tr.fraction > 0) {
        // Move as far as allowed
        cpx += dx * tr.fraction;
        cpy += dy * tr.fraction;
        cpz += dz * tr.fraction;
      }

      if (tr.fraction >= 1) break; // Moved the full distance — done

      timeLeft -= timeLeft * tr.fraction;

      // Record this plane for future crease tests
      if (numClip < MAX_CLIP_PLANES) {
        pns.push(tr.nx, tr.ny, tr.nz);
        numClip++;
      }

      // Clip velocity against the hit surface
      const dot = (cvx * tr.nx + cvy * tr.ny + cvz * tr.nz) * OVERCLIP;
      cvx -= tr.nx * dot;
      cvy -= tr.ny * dot;
      cvz -= tr.nz * dot;

      // Check for crease: if the new velocity re-enters any previously accumulated plane
      for (let i = 0; i < (numClip - 1) * 3; i += 3) {
        const pnx = pns[i], pny = pns[i + 1], pnz = pns[i + 2];

        if (cvx * pnx + cvy * pny + cvz * pnz < 0) {
          // Velocity opposes an old plane → project onto the crease line
          // Crease = cross(current plane normal, old plane normal)
          const crnx = tr.ny * pnz - tr.nz * pny;
          const crny = tr.nz * pnx - tr.nx * pnz;
          const crnz = tr.nx * pny - tr.ny * pnx;
          const crLen = Math.sqrt(crnx * crnx + crny * crny + crnz * crnz);

          if (crLen > 0.001) {
            // Speed along crease
            const spd = (cvx * crnx + cvy * crny + cvz * crnz) / (crLen * crLen);
            cvx = crnx * spd;
            cvy = crny * spd;
            cvz = crnz * spd;
          } else {
            // Two nearly-parallel planes facing opposite directions → dead stop
            cvx = cvy = cvz = 0;
          }
          break;
        }
      }
    }

    return { px: cpx, py: cpy, pz: cpz, vx: cvx, vy: cvy, vz: cvz };
  }

  // ── groundCheck ───────────────────────────────────────────────────────────
  // Traces the player sphere straight down from the camera (eye) position.
  // totalDist covers PLAYER_HEIGHT + STEP_HEIGHT so the check works both
  // when standing (fraction ≈ PLAYER_HEIGHT/totalDist) and when one step above
  // a stair (fraction slightly larger).
  //
  // Returns the new camera.y the player should snap to, or null if no floor
  // was found within range.  The caller decides whether to actually snap based
  // on how close the floor is to the current position.
  function groundCheck(px, py, pz) {
    const totalDist = CFG.PLAYER_HEIGHT + CFG.STEP_HEIGHT + 0.3;
    const tr = traceSphere(px, py, pz, px, py - totalDist, pz, CFG.PLAYER_RADIUS);

    if (tr.fraction >= 1) return null;     // nothing below
    if (tr.ny < SLOPE_MIN_Y) return null;  // surface too steep to stand on

    // At fraction f, the sphere CENTER is at: py - totalDist * f
    // The sphere surface is PLAYER_RADIUS below the center, so the actual floor
    // surface = (py - totalDist * f) - PLAYER_RADIUS.
    // Camera should sit at floorSurface + PLAYER_HEIGHT.
    const hitCenterY = py - totalDist * tr.fraction;
    return hitCenterY - CFG.PLAYER_RADIUS + CFG.PLAYER_HEIGHT;
  }

  // ── ceilingCheck ─────────────────────────────────────────────────────────
  // Returns clearance above the camera in Three.js units.
  function ceilingCheck(px, py, pz) {
    const tr = traceSphere(px, py, pz, px, py + 4.0, pz, CFG.PLAYER_RADIUS);
    return tr.fraction < 1 ? tr.fraction * 4.0 : Infinity;
  }

  // ── stepSlideMove ─────────────────────────────────────────────────────────
  // Extends slideMove with Q3-style stair stepping.
  // Algo:
  //   1. Normal slide → if 98 %+ of horizontal distance covered, accept.
  //   2. Trace UP by STEP_HEIGHT (ceiling check).
  //   3. Slide from lifted position (zero vertical velocity = step is instant).
  //   4. Ground trace from result → new floor Y.
  //   5. If the step is within (0, STEP_HEIGHT] and moved further than flat,
  //      accept the stepped result.
  function stepSlideMove(px, py, pz, vx, vy, vz, dt) {
    // Normal slide first
    const flat = slideMove(px, py, pz, vx, vy, vz, dt);

    // Stepping only makes sense when on the ground and horizontal movement is blocked
    if (!onGround) return flat;

    const fdx = flat.px - px, fdz = flat.pz - pz;
    const desiredH = Math.sqrt(vx * vx + vz * vz) * dt;
    const flatH    = Math.sqrt(fdx * fdx + fdz * fdz);

    if (desiredH < 0.0001 || flatH >= desiredH * 0.98) return flat;

    // Check that there is ceiling room above
    const upTr = traceSphere(px, py, pz, px, py + CFG.STEP_HEIGHT, pz, CFG.PLAYER_RADIUS);
    if (upTr.fraction <= 0.001) return flat; // Ceiling blocks step

    const liftY = py + CFG.STEP_HEIGHT * upTr.fraction;

    // Slide horizontally from the lifted position (vy = 0: step is instantaneous)
    const lifted = slideMove(px, liftY, pz, vx, 0, vz, dt);

    // Find the floor below the lifted+moved position
    const newCamY = groundCheck(lifted.px, lifted.py, lifted.pz);
    if (newCamY === null) return flat;

    // Reject if the new floor is lower than our start (walking off a ledge)
    // or higher than STEP_HEIGHT (unreachable with a single step)
    const lift = newCamY - py;
    if (lift <= 0.001 || lift > CFG.STEP_HEIGHT + 0.05) return flat;

    // Accept if we moved further horizontally than the flat slide
    const sdx = lifted.px - px, sdz = lifted.pz - pz;
    const stepH = Math.sqrt(sdx * sdx + sdz * sdz);
    if (stepH <= flatH + 0.001) return flat;

    return {
      px: lifted.px, py: newCamY, pz: lifted.pz,
      vx: lifted.vx, vy: flat.vy, vz: lifted.vz,
    };
  }

  // ── escapeIfSolid ─────────────────────────────────────────────────────────
  // If the player somehow ends up inside solid geometry, push them upward until
  // the sphere is clear.  Prevents getting permanently stuck on load / teleport.
  function escapeIfSolid(px, py, pz) {
    const tr = traceSphere(px, py, pz, px, py, pz, CFG.PLAYER_RADIUS);
    if (!tr.startSolid) return py;

    for (let i = 1; i <= 10; i++) {
      const testY = py + i * 0.08;
      const tr2   = traceSphere(px, testY, pz, px, testY, pz, CFG.PLAYER_RADIUS);
      if (!tr2.startSolid) {
        console.warn(`[Physics] Escaped solid at Y+${(i * 0.08).toFixed(2)}`);
        return testY;
      }
    }
    return py; // Could not escape — leave camera where it is
  }

  // ── Main update ───────────────────────────────────────────────────────────
  const _yAxis = new THREE.Vector3(0, 1, 0); // reused; never modified

  function update(camera, keys, yaw, dt) {
    dt = Math.min(dt, 0.05);

    // ── Turning ──────────────────────────────────────────────────────────
    if (keys['a'] || keys['arrowleft'])  yaw += CFG.TURN_SPEED * dt;
    if (keys['d'] || keys['arrowright']) yaw -= CFG.TURN_SPEED * dt;

    // ── Head tilt (Q / E) ────────────────────────────────────────────────
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

    // ── Jump ─────────────────────────────────────────────────────────────
    if ((keys[' '] || keys['space']) && onGround) {
      velocity.y = CFG.JUMP_SPEED;
      onGround   = false;
    }

    // ── Gravity ──────────────────────────────────────────────────────────
    if (!onGround) {
      velocity.y += CFG.GRAVITY * dt;
      velocity.y  = Math.max(velocity.y, CFG.TERMINAL_VEL);
    } else {
      velocity.y = Math.min(velocity.y, 0);
    }

    // ── Horizontal movement intent ────────────────────────────────────────
    // A/D = turn (above), W/S = move forward/backward.
    // Rotate local (0, 0, mvZ) by yaw to get world-space velocity.
    let mvZ = 0;
    if (keys['w'] || keys['arrowup'])   mvZ -= 1;
    if (keys['s'] || keys['arrowdown']) mvZ += 1;

    let wx = 0, wz = 0;
    if (mvZ !== 0) {
      // applyAxisAngle(Y, yaw) on (0, 0, mvZ):
      //   x' =  mvZ * sin(yaw)
      //   z' =  mvZ * cos(yaw)
      const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
      wx = mvZ * sinY * CFG.MOVE_SPEED;
      wz = mvZ * cosY * CFG.MOVE_SPEED;
    }

    // ── Escape solid (safety, runs once after teleport or bad spawn) ──────
    camera.position.y = escapeIfSolid(
      camera.position.x, camera.position.y, camera.position.z
    );

    // ── Horizontal movement (step + slide) ───────────────────────────────
    // Vertical velocity intentionally excluded here; it is applied below so
    // that gravity and jumping are handled independently of wall sliding.
    if (wx !== 0 || wz !== 0) {
      const stepped = stepSlideMove(
        camera.position.x, camera.position.y, camera.position.z,
        wx, 0, wz, dt
      );
      camera.position.x = stepped.px;
      camera.position.z = stepped.pz;

      // Accept Y from step only if within step-up range (prevents large jumps)
      const dy = stepped.py - camera.position.y;
      if (dy > 0.001 && dy <= CFG.STEP_HEIGHT + 0.05) {
        camera.position.y = stepped.py;
      }
    }

    // ── Vertical movement (gravity / jump) ───────────────────────────────
    const deltaY = velocity.y * dt;

    if (deltaY > 0) {
      // Going up — check ceiling clearance
      const clearance = ceilingCheck(
        camera.position.x, camera.position.y, camera.position.z
      );
      const maxUp = Math.max(0, clearance - 0.05);
      const actualUp = Math.min(deltaY, maxUp);
      camera.position.y += actualUp;
      if (actualUp < deltaY) velocity.y = 0; // hit ceiling
    } else {
      camera.position.y += deltaY;
    }

    // ── Ground snap ───────────────────────────────────────────────────────
    // groundCheck traces downward from camera; returns what camera.y SHOULD be
    // if a floor is found.  We only snap if we're close (within SKIN_WIDTH*2),
    // so mid-air falling is handled by gravity above.
    const floorCamY = groundCheck(
      camera.position.x, camera.position.y, camera.position.z
    );

    if (floorCamY !== null) {
      if (camera.position.y <= floorCamY + CFG.SKIN_WIDTH * 2) {
        camera.position.y = floorCamY;
        onGround           = true;
        velocity.y         = 0;
      } else {
        onGround = false;
      }
    } else {
      onGround = false;
    }

    return yaw;
  }

  // ── Public interface ──────────────────────────────────────────────────────
  return {
    update,

    // No-op: BSP data is static, no rebuild needed.
    // Kept for API compatibility with old code that calls physics.refreshCollidables().
    refreshCollidables() {},

    teleport(camera, x, y, z) {
      camera.position.set(x, y, z);
      velocity.set(0, 0, 0);
      onGround     = false;
      currentPitch = 0;
    },

    get isOnGround() { return onGround; },
    get velocityY()  { return velocity.y; },
  };
}
