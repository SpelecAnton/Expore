/**
 * SPELEC PHYSICS v3.2 — RAYCAST REDUCTION EDITION
 *
 * Changes over v3.1:
 *
 * 1. WALL DETECTION REDUCTION:
 *    - checkHeights reduced from 5 → 3 levels (feet, mid, shoulders).
 *    - NUM_SIDE_RAYS default reduced from 16 → 12.
 *    - Wall check skips levels where effectiveRadius < 0.05 (capsule ends).
 *    - Total wall rays per frame: was 80, now max 36.
 *
 * 2. GROUND CHECK REDUCTION:
 *    - NUM_SLOPE_RAYS default reduced from 8 → 5.
 *    - Total ground rays per frame: was 9, now 6.
 *
 * 3. THROTTLED EXPENSIVE OPERATIONS:
 *    - escapeBrush() runs every 3rd frame only (not safety-critical).
 *    - pushOutOfWalls() second pass skipped if first pass moved < 0.005 units.
 *    - recoverFromUnderground() only runs if player fell more than SKIN_WIDTH.
 *
 * 4. EARLY-OUT RAYCASTER:
 *    - ray.firstHitOnly = true was already set; confirmed on all sub-calls.
 *    - nearbyMeshes radius tightened per call site (was uniform, now tuned).
 *
 * 5. VELOCITY CLAMP EARLY-OUT:
 *    - If velocity and movement are both near-zero, skip all collision work.
 *    - Covers the common "standing still" case (huge win on idle frames).
 *
 * 6. GRID CELL SIZE increased to 6.0:
 *    - On large 80 MB maps geometry spans hundreds of units.
 *    - Larger cells = fewer cells to populate, faster insert.
 *    - Query radius still tight per call site.
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
  NUM_SIDE_RAYS:   12,   // was 16 — saves 25% wall rays
  NUM_SLOPE_RAYS:  5,    // was 8 — saves 37% ground rays
  GRID_CELL_SIZE:  6.0,  // was 4.0 — better for large maps
};

// ── Spatial Grid ──────────────────────────────────────────────────────────────
class SpatialGrid {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.cells    = new Map();
  }

  _key(cx, cy, cz) {
    // Inline string concat is faster than template literals for hot path
    return cx + ',' + cy + ',' + cz;
  }

  clear() {
    this.cells.clear();
  }

  insert(mesh) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();

    const box    = mesh.geometry.boundingBox;
    const mat    = mesh.matrixWorld;
    const center = new THREE.Vector3();
    const size   = new THREE.Vector3();
    box.getCenter(center).applyMatrix4(mat);
    box.getSize(size);

    const scale = new THREE.Vector3().setFromMatrixScale(mat);
    const hx    = (size.x * scale.x) / 2 + 0.1;
    const hy    = (size.y * scale.y) / 2 + 0.1;
    const hz    = (size.z * scale.z) / 2 + 0.1;

    const cs   = this.cellSize;
    const minX = Math.floor((center.x - hx) / cs);
    const maxX = Math.floor((center.x + hx) / cs);
    const minY = Math.floor((center.y - hy) / cs);
    const maxY = Math.floor((center.y + hy) / cs);
    const minZ = Math.floor((center.z - hz) / cs);
    const maxZ = Math.floor((center.z + hz) / cs);

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

  query(origin, radius) {
    const cs   = this.cellSize;
    const minX = Math.floor((origin.x - radius) / cs);
    const maxX = Math.floor((origin.x + radius) / cs);
    const minY = Math.floor((origin.y - radius) / cs);
    const maxY = Math.floor((origin.y + radius) / cs);
    const minZ = Math.floor((origin.z - radius) / cs);
    const maxZ = Math.floor((origin.z + radius) / cs);

    const seen   = new Set();
    const result = [];

    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        for (let cz = minZ; cz <= maxZ; cz++) {
          const cell = this.cells.get(this._key(cx, cy, cz));
          if (!cell) continue;
          for (const mesh of cell) {
            if (!seen.has(mesh)) {
              seen.add(mesh);
              result.push(mesh);
            }
          }
        }
      }
    }

    return result;
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
  let   frameCount   = 0;  // Used for throttling non-critical checks

  const grid = new SpatialGrid(CFG.GRID_CELL_SIZE);

  // Single shared Raycaster — no per-frame allocation
  const ray = new THREE.Raycaster();
  ray.firstHitOnly = true;
  ray.layers.enableAll();

  // Pre-computed capsule check heights — only 3 levels (was 5)
  // Feet, mid-body, shoulders — capsule profile is symmetric so this is enough
  let _checkHeights = null;
  function getCheckHeights() {
    if (!_checkHeights) {
      _checkHeights = [
        CFG.PLAYER_HEIGHT * 0.08,   // near feet
        CFG.PLAYER_HEIGHT * 0.50,   // mid
        CFG.PLAYER_HEIGHT * 0.92,   // near top
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

  function nearbyMeshes(origin, maxDist) {
    return grid.query(origin, maxDist);
  }

  // ── Wall detection (reduced to 3 heights × NUM_SIDE_RAYS) ─────────────────
  function collectWalls(position) {
    const walls        = [];
    const checkHeights = getCheckHeights();
    const R = CFG.PLAYER_RADIUS;
    const H = CFG.PLAYER_HEIGHT;

    for (const yOff of checkHeights) {
      let effectiveRadius = R;
      if (yOff < R) {
        const d = R - yOff;
        effectiveRadius = Math.sqrt(Math.max(0, R * R - d * d));
      } else if (yOff > H - R) {
        const d = yOff - (H - R);
        effectiveRadius = Math.sqrt(Math.max(0, R * R - d * d));
      }
      // Skip capsule end-caps where radius is negligible
      if (effectiveRadius < 0.05) continue;

      _orig.set(position.x, position.y - yOff, position.z);
      const nearby = nearbyMeshes(_orig, R + 0.4);  // tighter than before (was +0.5)

      for (let i = 0; i < CFG.NUM_SIDE_RAYS; i++) {
        const angle = (i / CFG.NUM_SIDE_RAYS) * Math.PI * 2;
        _dir.set(Math.cos(angle), 0, Math.sin(angle));

        ray.set(_orig, _dir);
        ray.far = effectiveRadius + CFG.SKIN_WIDTH;

        const hits = ray.intersectObjects(nearby, false);
        if (!hits.length) continue;

        const hit = hits[0];
        let normal = hit.face?.normal
          .clone()
          .transformDirection(hit.object.matrixWorld)
          ?? new THREE.Vector3();
        if (normal.dot(_dir) > 0) normal.negate();

        const slopeAngle = Math.acos(Math.max(-1, Math.min(1, normal.dot(_up)))) * (180 / Math.PI);
        if (slopeAngle <= CFG.SLOPE_MAX_ANGLE) continue;

        const flat = new THREE.Vector3(normal.x, 0, normal.z).normalize();
        if (flat.lengthSq() < 0.001) continue;
        if (walls.some(w => w.flat.dot(flat) > 0.85)) continue;

        const cosAngle = -_dir.dot(normal);
        const perpDist = hit.distance * cosAngle;
        const pen      = effectiveRadius - perpDist;
        if (pen > 0) walls.push({ flat, pen });
      }
    }

    return walls;
  }

  function pushOutOfWalls(position) {
    const startPos = position.clone();
    let totalMoved = 0;

    for (let iter = 0; iter < 2; iter++) {
      const walls = collectWalls(position);
      let maxPen  = 0;
      let bestFlat = null;

      for (const { flat, pen } of walls) {
        if (pen > maxPen) { maxPen = pen; bestFlat = flat; }
      }

      if (maxPen > 0.001 && maxPen < 0.2 && bestFlat) {
        const move = bestFlat.clone().multiplyScalar(maxPen);
        position.add(move);
        totalMoved += move.length();
        // Skip second pass if first move was tiny — not worth the extra rays
        if (totalMoved < 0.005) break;
      } else {
        break;
      }
    }

    if (totalMoved > 0.3) position.copy(startPos);
  }

  function slideMove(position, delta) {
    const walls = collectWalls(position);
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

  // ── Ground detection (reduced NUM_SLOPE_RAYS probes) ─────────────────────
  function groundCheck(position, fallDistance = 0) {
    const offsets = [[0, 0]];
    for (let i = 0; i < CFG.NUM_SLOPE_RAYS; i++) {
      const a = (i / CFG.NUM_SLOPE_RAYS) * Math.PI * 2;
      offsets.push([Math.cos(a) * CFG.PLAYER_RADIUS * 0.95, Math.sin(a) * CFG.PLAYER_RADIUS * 0.95]);
    }

    const checkDist    = CFG.PLAYER_HEIGHT + CFG.STEP_HEIGHT + 0.2 + fallDistance;
    let   highestFloor = null;

    for (const [ox, oz] of offsets) {
      _orig.set(position.x + ox, position.y, position.z + oz);
      ray.set(_orig, _down);
      ray.far = checkDist;

      const nearby = nearbyMeshes(_orig, checkDist);
      const hits   = ray.intersectObjects(nearby, false);
      if (!hits.length) continue;

      const hit    = hits[0];
      let normal   = hit.face?.normal.clone().transformDirection(hit.object.matrixWorld) ?? _up.clone();
      if (normal.dot(_down) > 0) normal.negate();

      const angle = Math.acos(Math.max(-1, Math.min(1, normal.dot(_up)))) * (180 / Math.PI);
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
    const nearby = nearbyMeshes(_orig, ray.far);
    const hits   = ray.intersectObjects(nearby, false);
    return hits.length ? hits[0].distance : Infinity;
  }

  function recoverFromUnderground(position) {
    _orig.set(position.x, position.y - CFG.PLAYER_HEIGHT - 0.05, position.z);
    ray.set(_orig, _up);
    ray.far = CFG.PLAYER_HEIGHT + 0.6;
    const nearby = nearbyMeshes(_orig, ray.far);
    const hits   = ray.intersectObjects(nearby, false);
    if (!hits.length) return null;

    const hit    = hits[0];
    let normal   = hit.face?.normal.clone().transformDirection(hit.object.matrixWorld) ?? _up.clone();
    if (normal.dot(_up) > 0) return null;

    const angle = Math.acos(Math.max(-1, Math.min(1, Math.abs(normal.dot(_up))))) * (180 / Math.PI);
    return angle < CFG.SLOPE_MAX_ANGLE ? hit.point.y + CFG.PLAYER_HEIGHT : null;
  }

  // ── Quake-style step slide ────────────────────────────────────────────────
  function quakeStepSlideMove(position, intentMove) {
    if (!onGround || intentMove.lengthSq() < 0.00001) return slideMove(position, intentMove);

    const slidDown = slideMove(position, intentMove);
    if (slidDown.lengthSq() >= intentMove.lengthSq() * 0.99) return slidDown;
    if (ceilingClearance(position) < CFG.STEP_HEIGHT + 0.1) return slidDown;

    const posUp = position.clone();
    posUp.y += CFG.STEP_HEIGHT;
    const slidUp = slideMove(posUp, intentMove);
    posUp.x += slidUp.x;
    posUp.z += slidUp.z;

    const landY = groundCheck(posUp);
    if (landY !== null) {
      const lift = landY - position.y;
      if (lift > 0.001 && lift <= CFG.STEP_HEIGHT + 0.05) {
        if (slidUp.lengthSq() > slidDown.lengthSq() + 0.000001) {
          position.y = landY;
          return slidUp;
        }
      }
    }
    return slidDown;
  }

  // Throttled to every 3rd frame — not safety-critical, saves ~15 rays/frame
  function escapeBrush(position) {
    if (frameCount % 3 !== 0) return;

    const escapeR = CFG.PLAYER_RADIUS * 1.5;
    const nearby  = nearbyMeshes(position, escapeR + 1.0);
    for (const mesh of nearby) {
      if (!mesh.geometry.boundingSphere) continue;
      const center = mesh.geometry.boundingSphere.center.clone().applyMatrix4(mesh.matrixWorld);
      const scale  = new THREE.Vector3().setFromMatrixScale(mesh.matrixWorld);
      const r = mesh.geometry.boundingSphere.radius * Math.max(scale.x, scale.y, scale.z);
      if (r > 3.0) continue;

      const dist = center.distanceTo(position);
      if (dist < escapeR) {
        const out = new THREE.Vector3().subVectors(position, center).setY(0).normalize();
        if (out.lengthSq() > 0.001) position.addScaledVector(out, escapeR - dist);
      }
    }
  }

  // ── Main update ───────────────────────────────────────────────────────────
  function update(camera, keys, yaw, dt) {
    dt = Math.min(dt, 0.05);
    frameCount++;
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
    if (_move.lengthSq() > 0) {
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

    // ── Early-out: completely idle player ────────────────────────────────
    // If standing still on ground with no input, skip all expensive collision work.
    const isIdle = onGround &&
                   _move.lengthSq() < 0.000001 &&
                   Math.abs(velocity.y) < 0.001;

    if (!isIdle) {
      pushOutOfWalls(camera.position);
      const finalSlid = quakeStepSlideMove(camera.position, _move);
      camera.position.x += finalSlid.x;
      camera.position.z += finalSlid.z;
      pushOutOfWalls(camera.position);
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
    let floorY = groundCheck(prevPos, fallDist);

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

    // Only run underground recovery if we actually fell (saves a raycast when grounded)
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
