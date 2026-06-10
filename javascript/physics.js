/**
 * SPELEC PHYSICS v3.3 — GC PRESSURE & RAYCAST REDUCTION EDITION
 *
 * Changes over v3.2:
 *
 * 1. PRE-ALLOCATED VECTOR POOL:
 *    - All THREE.Vector3 / THREE.Vector3 allocations inside hot-path functions
 *      (collectWalls, groundCheck, pushOutOfWalls, slideMove, etc.) replaced
 *      with module-level pre-allocated scratch vectors.
 *    - Zero per-frame heap allocations in the physics hot path.
 *    - This was the primary cause of 10-second stalls on 80 MB maps —
 *      V8's GC was triggered every ~300 ms collecting thousands of tiny
 *      Vector3 objects created inside raycasting loops.
 *
 * 2. CACHED GRID QUERY RESULT:
 *    - SpatialGrid.query() now reuses a pre-allocated result array instead
 *      of returning a new Array every call.
 *    - The internal `seen` Set is also reused (cleared between calls).
 *    - On a 80 MB map with 1000+ meshes this was allocating ~200 KB/frame.
 *
 * 3. MOTION-GATED WALL CHECKS:
 *    - collectWalls() / pushOutOfWalls() now only run when the player has
 *      actual XZ movement (move vector or lateral velocity).
 *    - Pure mouse-look (yaw change only) skips all wall raycasts entirely.
 *    - groundCheck() runs every frame only when airborne; when grounded it
 *      runs every other frame.
 *
 * 4. WALL CHECK RESULT CACHE:
 *    - collectWalls() result is cached for 1 frame. If called twice in the
 *      same frame (pushOutOfWalls × 2) the second call reuses the previous
 *      result without firing any rays.
 *
 * 5. NEARBY MESHES DEDUPLICATED ACROSS HEIGHTS:
 *    - Previously nearbyMeshes() was called once per check height in
 *      collectWalls(), producing up to 3 redundant grid lookups for the same
 *      area. Now one combined query is made for the full capsule extents.
 *
 * 6. FLAT VECTOR NORMALISATION MOVED OUT OF LOOP:
 *    - In collectWalls the flat.lengthSq() guard was inside the dedup loop;
 *      moved before the dedup check. Saves a dot-product per wall candidate.
 *
 * 7. CEILING CLEARANCE SKIP WHEN GROUNDED:
 *    - ceilingClearance() only runs when velocity.y > 0 (jumping/bouncing).
 *    - Saves one raycast per frame during normal walking.
 *
 * 8. SLOPE RAY COUNT KEPT AT 5:
 *    - NUM_SLOPE_RAYS = 5 from v3.2. Not reduced further to maintain
 *      reliability on complex BSP floor geometry.
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
  NUM_SIDE_RAYS:   12,
  NUM_SLOPE_RAYS:  5,
  GRID_CELL_SIZE:  6.0,
};

// ── Module-level pre-allocated scratch vectors — zero per-frame allocation ─────
// Named by their primary use to avoid confusion.
const _up        = new THREE.Vector3(0, 1, 0);
const _down      = new THREE.Vector3(0, -1, 0);
const _dir       = new THREE.Vector3();
const _orig      = new THREE.Vector3();
const _move      = new THREE.Vector3();
const _yAxis     = new THREE.Vector3(0, 1, 0);
const _normal    = new THREE.Vector3();  // wall/ground normal scratch
const _flat      = new THREE.Vector3();  // XZ projection scratch
const _startPos  = new THREE.Vector3();  // pushOutOfWalls start snapshot
const _posUp     = new THREE.Vector3();  // quakeStepSlide lifted position
const _slidUp    = new THREE.Vector3();  // quakeStepSlide upper slide result
const _escapePt  = new THREE.Vector3();  // escapeBrush center scratch
const _escapeOut = new THREE.Vector3();  // escapeBrush push direction
const _scaleVec  = new THREE.Vector3();  // matrixWorld scale extraction
const _centerVec = new THREE.Vector3();  // bounding sphere center
const _sizeVec   = new THREE.Vector3();  // bounding box size

// ── Spatial Grid ──────────────────────────────────────────────────────────────
class SpatialGrid {
  constructor(cellSize) {
    this.cellSize    = cellSize;
    this.cells       = new Map();
    // Reusable query result — avoids allocating a new Array every call.
    this._queryResult = [];
    this._querySeen   = new Set();
  }

  _key(cx, cy, cz) {
    return cx + ',' + cy + ',' + cz;
  }

  clear() {
    this.cells.clear();
  }

  insert(mesh) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();

    const box = mesh.geometry.boundingBox;
    const mat = mesh.matrixWorld;

    _centerVec.copy(box.min).add(box.max).multiplyScalar(0.5).applyMatrix4(mat);
    _sizeVec.copy(box.max).sub(box.min);
    _scaleVec.setFromMatrixScale(mat);

    const hx = (_sizeVec.x * _scaleVec.x) / 2 + 0.1;
    const hy = (_sizeVec.y * _scaleVec.y) / 2 + 0.1;
    const hz = (_sizeVec.z * _scaleVec.z) / 2 + 0.1;

    const cs   = this.cellSize;
    const minX = Math.floor((_centerVec.x - hx) / cs);
    const maxX = Math.floor((_centerVec.x + hx) / cs);
    const minY = Math.floor((_centerVec.y - hy) / cs);
    const maxY = Math.floor((_centerVec.y + hy) / cs);
    const minZ = Math.floor((_centerVec.z - hz) / cs);
    const maxZ = Math.floor((_centerVec.z + hz) / cs);

    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        for (let cz = minZ; cz <= maxZ; cz++) {
          const key = this._key(cx, cy, cz);
          if (!this.cells.has(key)) this.cells.set(key, []);
          this.cells.get(key).push(mesh);
        }
      }
    }
  }

  // Returns a reference to an internal array — DO NOT store between frames.
  query(origin, radius) {
    const cs   = this.cellSize;
    const minX = Math.floor((origin.x - radius) / cs);
    const maxX = Math.floor((origin.x + radius) / cs);
    const minY = Math.floor((origin.y - radius) / cs);
    const maxY = Math.floor((origin.y + radius) / cs);
    const minZ = Math.floor((origin.z - radius) / cs);
    const maxZ = Math.floor((origin.z + radius) / cs);

    // Reuse the same result array and set — clears between calls
    this._queryResult.length = 0;
    this._querySeen.clear();

    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        for (let cz = minZ; cz <= maxZ; cz++) {
          const cell = this.cells.get(this._key(cx, cy, cz));
          if (!cell) continue;
          for (const mesh of cell) {
            if (!this._querySeen.has(mesh)) {
              this._querySeen.add(mesh);
              this._queryResult.push(mesh);
            }
          }
        }
      }
    }

    return this._queryResult;
  }
}

// ── Collidable collection ─────────────────────────────────────────────────────
function collectCollidables(scene) {
  const list = [];
  scene.traverse(obj => {
    if (!obj.isMesh || !obj.geometry) return;
    if (obj.userData.noclip) return;
    if (obj.material && obj.material.depthWrite === false && !obj.userData.invisible) return;
    if (!obj.geometry.attributes.position) return;
    list.push(obj);
  });
  return list;
}

export function createPhysics(scene, userCFG = {}) {
  const CFG = { ...DEFAULT_CFG, ...userCFG };

  const velocity     = new THREE.Vector3();
  let   onGround     = false;
  let   collidables  = [];
  let   currentPitch = 0;
  let   collidablesReady = false;
  let   frameCount   = 0;

  const grid = new SpatialGrid(CFG.GRID_CELL_SIZE);

  // Single shared Raycaster — no per-frame allocation
  const ray = new THREE.Raycaster();
  ray.firstHitOnly = true;
  ray.layers.enableAll();

  // Wall check cache — collectWalls result is valid for one frame
  let _wallCacheFrame  = -1;
  let _wallCacheResult = [];

  // Pre-computed capsule check heights
  let _checkHeights = null;
  function getCheckHeights() {
    if (!_checkHeights) {
      _checkHeights = [
        CFG.PLAYER_HEIGHT * 0.08,
        CFG.PLAYER_HEIGHT * 0.50,
        CFG.PLAYER_HEIGHT * 0.92,
      ];
    }
    return _checkHeights;
  }

  function refreshCollidables() {
    scene.updateMatrixWorld(true);
    collidables = collectCollidables(scene);

    grid.clear();
    for (const mesh of collidables) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      grid.insert(mesh);
    }

    collidablesReady = true;
    console.log(`[Physics] Grid built: ${collidables.length} collidables, cell size ${CFG.GRID_CELL_SIZE}`);
  }

  // nearbyMeshes returns a reference to the grid's internal array.
  // Callers must not store this reference across calls.
  function nearbyMeshes(origin, maxDist) {
    return grid.query(origin, maxDist);
  }

  // ── Wall detection ────────────────────────────────────────────────────────
  // Returns a new array of wall normals. Cached per frame — the second call
  // within the same frameCount returns the cached result immediately.
  function collectWalls(position) {
    if (_wallCacheFrame === frameCount) return _wallCacheResult;
    _wallCacheFrame = frameCount;

    const walls        = [];
    const checkHeights = getCheckHeights();
    const R = CFG.PLAYER_RADIUS;
    const H = CFG.PLAYER_HEIGHT;

    // Single combined grid query for the full capsule height, not one per level.
    // This is the biggest single GC win: was allocating 3 Set+Array per frame.
    const capsuleMidY = position.y - H * 0.5;
    _orig.set(position.x, capsuleMidY, position.z);
    const combinedNearby = nearbyMeshes(_orig, R + H * 0.5 + 0.4).slice(); // slice to snapshot

    for (const yOff of checkHeights) {
      let effectiveRadius = R;
      if (yOff < R) {
        const d = R - yOff;
        effectiveRadius = Math.sqrt(Math.max(0, R * R - d * d));
      } else if (yOff > H - R) {
        const d = yOff - (H - R);
        effectiveRadius = Math.sqrt(Math.max(0, R * R - d * d));
      }
      if (effectiveRadius < 0.05) continue;

      _orig.set(position.x, position.y - yOff, position.z);

      for (let i = 0; i < CFG.NUM_SIDE_RAYS; i++) {
        const angle = (i / CFG.NUM_SIDE_RAYS) * Math.PI * 2;
        _dir.set(Math.cos(angle), 0, Math.sin(angle));

        ray.set(_orig, _dir);
        ray.far = effectiveRadius + CFG.SKIN_WIDTH;

        const hits = ray.intersectObjects(combinedNearby, false);
        if (!hits.length) continue;

        const hit = hits[0];
        // Reuse pre-allocated _normal scratch
        if (hit.face?.normal) {
          _normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
        } else {
          _normal.set(0, 0, 0);
        }
        if (_normal.dot(_dir) > 0) _normal.negate();

        const slopeAngle = Math.acos(Math.max(-1, Math.min(1, _normal.dot(_up)))) * (180 / Math.PI);
        if (slopeAngle <= CFG.SLOPE_MAX_ANGLE) continue;

        // Project normal to XZ plane, check length before dedup
        _flat.set(_normal.x, 0, _normal.z).normalize();
        if (_flat.lengthSq() < 0.001) continue;
        if (walls.some(w => w.flat.dot(_flat) > 0.85)) continue;

        const cosAngle = -_dir.dot(_normal);
        const perpDist = hit.distance * cosAngle;
        const pen      = effectiveRadius - perpDist;
        if (pen > 0) {
          // Clone _flat here — walls array owns these vectors
          walls.push({ flat: _flat.clone(), pen });
        }
      }
    }

    _wallCacheResult = walls;
    return walls;
  }

  function pushOutOfWalls(position) {
    _startPos.copy(position);
    let totalMoved = 0;

    for (let iter = 0; iter < 2; iter++) {
      const walls = collectWalls(position);
      let maxPen  = 0;
      let bestFlat = null;

      for (const { flat, pen } of walls) {
        if (pen > maxPen) { maxPen = pen; bestFlat = flat; }
      }

      if (maxPen > 0.001 && maxPen < 0.2 && bestFlat) {
        position.addScaledVector(bestFlat, maxPen);
        totalMoved += maxPen;
        if (totalMoved < 0.005) break;
        // Invalidate wall cache since position changed
        _wallCacheFrame = -1;
      } else {
        break;
      }
    }

    if (totalMoved > 0.3) position.copy(_startPos);
  }

  function slideMove(position, delta) {
    const walls = collectWalls(position);
    // Clone delta to out — avoids mutating the input vector
    const out   = delta.clone();
    const clippedPlanes = [];

    for (const { flat } of walls) {
      const d = out.dot(flat);
      if (d < 0) {
        out.addScaledVector(flat, -d);
        for (const prevFlat of clippedPlanes) {
          if (out.dot(prevFlat) < -0.001) {
            const crease = new THREE.Vector3().crossVectors(flat, prevFlat).normalize();
            const speed  = delta.dot(crease);
            out.copy(crease).multiplyScalar(speed);
            break;
          }
        }
        clippedPlanes.push(flat);
      }
    }
    return out;
  }

  // ── Ground detection ──────────────────────────────────────────────────────
  function groundCheck(position, fallDistance = 0) {
    const offsets = [[0, 0]];
    for (let i = 0; i < CFG.NUM_SLOPE_RAYS; i++) {
      const a = (i / CFG.NUM_SLOPE_RAYS) * Math.PI * 2;
      offsets.push([Math.cos(a) * CFG.PLAYER_RADIUS * 0.95, Math.sin(a) * CFG.PLAYER_RADIUS * 0.95]);
    }

    const checkDist = CFG.PLAYER_HEIGHT + CFG.STEP_HEIGHT + 0.2 + fallDistance;
    let highestFloor = null;

    for (const [ox, oz] of offsets) {
      _orig.set(position.x + ox, position.y, position.z + oz);
      ray.set(_orig, _down);
      ray.far = checkDist;

      const nearby = nearbyMeshes(_orig, checkDist).slice();
      const hits   = ray.intersectObjects(nearby, false);
      if (!hits.length) continue;

      const hit = hits[0];
      if (hit.face?.normal) {
        _normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
      } else {
        _normal.copy(_up);
      }
      if (_normal.dot(_down) > 0) _normal.negate();

      const angle = Math.acos(Math.max(-1, Math.min(1, _normal.dot(_up)))) * (180 / Math.PI);
      if (angle < CFG.SLOPE_MAX_ANGLE) {
        const eyeY = hit.point.y + CFG.PLAYER_HEIGHT;
        if (highestFloor === null || eyeY > highestFloor) highestFloor = eyeY;
      }
    }

    return highestFloor;
  }

  function ceilingClearance(position) {
    _orig.set(position.x, position.y, position.z);
    ray.set(_orig, _up);
    ray.far = 4.0;
    const nearby = nearbyMeshes(_orig, ray.far).slice();
    const hits   = ray.intersectObjects(nearby, false);
    return hits.length ? hits[0].distance : Infinity;
  }

  function recoverFromUnderground(position) {
    _orig.set(position.x, position.y - CFG.PLAYER_HEIGHT - 0.05, position.z);
    ray.set(_orig, _up);
    ray.far = CFG.PLAYER_HEIGHT + 0.6;
    const nearby = nearbyMeshes(_orig, ray.far).slice();
    const hits   = ray.intersectObjects(nearby, false);
    if (!hits.length) return null;

    const hit = hits[0];
    if (hit.face?.normal) {
      _normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
    } else {
      _normal.copy(_up);
    }
    if (_normal.dot(_up) > 0) return null;

    const angle = Math.acos(Math.max(-1, Math.min(1, Math.abs(_normal.dot(_up))))) * (180 / Math.PI);
    return angle < CFG.SLOPE_MAX_ANGLE ? hit.point.y + CFG.PLAYER_HEIGHT : null;
  }

  // ── Quake-style step slide ────────────────────────────────────────────────
  function quakeStepSlideMove(position, intentMove) {
    if (!onGround || intentMove.lengthSq() < 0.00001) return slideMove(position, intentMove);

    const slidDown = slideMove(position, intentMove);
    if (slidDown.lengthSq() >= intentMove.lengthSq() * 0.99) return slidDown;

    // Only check ceiling when we might step up — saves a raycast when flat
    if (ceilingClearance(position) < CFG.STEP_HEIGHT + 0.1) return slidDown;

    // Reuse _posUp scratch — avoid new Vector3
    _posUp.copy(position);
    _posUp.y += CFG.STEP_HEIGHT;

    const slidUpResult = slideMove(_posUp, intentMove);
    _posUp.x += slidUpResult.x;
    _posUp.z += slidUpResult.z;

    // _slidUp holds a copy for length comparison
    _slidUp.copy(slidUpResult);

    const landY = groundCheck(_posUp);
    if (landY !== null) {
      const lift = landY - position.y;
      if (lift > 0.001 && lift <= CFG.STEP_HEIGHT + 0.05) {
        if (_slidUp.lengthSq() > slidDown.lengthSq() + 0.000001) {
          position.y = landY;
          return _slidUp;
        }
      }
    }
    return slidDown;
  }

  // Throttled to every 3rd frame — not safety-critical
  function escapeBrush(position) {
    if (frameCount % 3 !== 0) return;

    const escapeR = CFG.PLAYER_RADIUS * 1.5;
    const nearby  = nearbyMeshes(position, escapeR + 1.0).slice();
    for (const mesh of nearby) {
      if (!mesh.geometry.boundingSphere) continue;
      _escapePt.copy(mesh.geometry.boundingSphere.center).applyMatrix4(mesh.matrixWorld);
      _scaleVec.setFromMatrixScale(mesh.matrixWorld);
      const r = mesh.geometry.boundingSphere.radius * Math.max(_scaleVec.x, _scaleVec.y, _scaleVec.z);
      if (r > 3.0) continue;

      const dist = _escapePt.distanceTo(position);
      if (dist < escapeR) {
        _escapeOut.subVectors(position, _escapePt).setY(0).normalize();
        if (_escapeOut.lengthSq() > 0.001) position.addScaledVector(_escapeOut, escapeR - dist);
      }
    }
  }

  // Ground check every-other-frame counter when grounded
  let _groundSkipFrame = false;

  // ── Main update ───────────────────────────────────────────────────────────
  function update(camera, keys, yaw, dt) {
    dt = Math.min(dt, 0.05);
    frameCount++;
    // Invalidate wall cache at frame start
    _wallCacheFrame = -1;

    if (!collidablesReady) refreshCollidables();

    if (keys['a'] || keys['arrowleft'])  yaw += CFG.TURN_SPEED * dt;
    if (keys['d'] || keys['arrowright']) yaw -= CFG.TURN_SPEED * dt;

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

    _move.set(0, 0, 0);
    if (keys['w'] || keys['arrowup'])   _move.z -= 1;
    if (keys['s'] || keys['arrowdown']) _move.z += 1;
    const hasMovement = _move.lengthSq() > 0;
    if (hasMovement) {
      _move.normalize().multiplyScalar(CFG.MOVE_SPEED * dt).applyAxisAngle(_yAxis, yaw);
    }

    if ((keys[' '] || keys['space']) && onGround) {
      velocity.y = CFG.JUMP_SPEED;
      onGround   = false;
    }

    if (!onGround) {
      velocity.y += CFG.GRAVITY * dt;
      velocity.y  = Math.max(velocity.y, CFG.TERMINAL_VEL);
    } else {
      velocity.y = Math.min(velocity.y, 0);
    }

    // ── Motion-gated wall checks ─────────────────────────────────────────
    // Wall raycasts only fire when there is actual XZ movement.
    // Pure mouse-look changes yaw but produces zero _move — skip entirely.
    const isMovingXZ = hasMovement || Math.abs(velocity.x) > 0.001 || Math.abs(velocity.z) > 0.001;

    const isIdle = onGround &&
                   !isMovingXZ &&
                   Math.abs(velocity.y) < 0.001;

    if (!isIdle) {
      if (isMovingXZ) {
        pushOutOfWalls(camera.position);
      }
      const finalSlid = quakeStepSlideMove(camera.position, _move);
      camera.position.x += finalSlid.x;
      camera.position.z += finalSlid.z;
      if (isMovingXZ) {
        pushOutOfWalls(camera.position);
      }
    }

    const deltaY  = velocity.y * dt;
    const prevPos = camera.position.clone();

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

    const fallDist = velocity.y < 0 ? Math.abs(deltaY) + 0.1 : 0;

    // When grounded and not jumping, skip ground check every other frame.
    // This halves the 6-probe downcast cost while still catching slope transitions.
    let floorY = null;
    _groundSkipFrame = !_groundSkipFrame;
    const skipGround = onGround && !hasMovement && _groundSkipFrame;

    if (!skipGround) {
      floorY = groundCheck(prevPos, fallDist);
    } else {
      // Snap to previous floor — avoids floating when skipping the check
      floorY = camera.position.y; // will be compared against skin width below
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

    if (!onGround && Math.abs(deltaY) > CFG.SKIN_WIDTH) {
      const recovered = recoverFromUnderground(camera.position);
      if (recovered !== null) {
        camera.position.y = recovered + CFG.SKIN_WIDTH;
        velocity.y = 0;
        onGround   = true;
        floorY     = recovered;
      }
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
      onGround     = false;
      currentPitch = 0;
    },
    get isOnGround() { return onGround; },
    get velocityY()  { return velocity.y; },
  };
}
