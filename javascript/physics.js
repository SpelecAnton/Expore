/**
 * SPELEC PHYSICS v3.0 — CAPSULES + ANGLE FIXES
 *
 * Změny oproti v2.9:
 * 1. Používáme kapsle místo boxů — lepší kolize, méně "prokluzování"
 * 2. Fix propadání mapou při určitých úhlech — raycasting z povrchu kapsle
 * 3. Vylepšené zjišťování kolizí v šikmých rovinách
 * 4. Zvýšená robustnost při skokách přes šikmé schody
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
  NUM_SIDE_RAYS:   16,
  NUM_SLOPE_RAYS:  8,
  NUM_CAPSULE_RAYS: 12, // Paprsky z povrchu kapsle pro lepší zjišťování hran
};

// ── Capsule collision helpers ────────────────────────────────────────────────
const _cap = new THREE.Vector3();

function createCapsuleCenter(radius, height) {
  const geo = new THREE.CapsuleGeometry(radius, height, 4, 8);
  return geo;
}

function capsuleDistanceToPoint(p1, p2, radius) {
  const v = new THREE.Vector3().subVectors(p2, p1);
  const len2 = v.lengthSq();
  
  if (len2 <= 0) {
    return radius;
  }
  
  const t = Math.max(0, Math.min(1, v.dot(_cap)));
  
  const closest = p1.clone().addScaledVector(v, t);
  const dist = v.length() - t;
  
  return radius + dist;
}

function capsuleIntersection(p1, r1, p2, r2) {
  const v = new THREE.Vector3().subVectors(p2, p1);
  const len = v.length();
  const rSum = r1 + r2;
  
  if (len <= rSum) {
    return { intersect: true, depth: rSum - len, midpoint: v.normalize().multiplyScalar(len / 2) };
  }
  
  const t1 = (r1 * r1 - r2 * r2 + len * len) / (2 * len);
  const t2 = t1 - len;
  
  const hit = t1 > 0 && t1 < 1;
  return { intersect: hit, depth: rSum - len, midpoint: v.normalize().multiplyScalar(len / 2) };
}

function collectCapsidables(scene) {
  const list = [];
  scene.traverse(obj => {
    if (!obj.isMesh || !obj.geometry) return;
    if (obj.userData.noclip) return;
    
    if (!obj.geometry.attributes.position) return;
    list.push(obj);
  });
  return list;
}

const _sv = new THREE.Vector3();
const _sc = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _down = new THREE.Vector3(0, -1, 0);
const _dir = new THREE.Vector3();
const _orig = new THREE.Vector3();
const _move = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);

// ── Main physics setup ───────────────────────────────────────────────────────
export function createPhysics(scene, userCFG = {}) {
  const CFG = { ...DEFAULT_CFG, ...userCFG };

  const velocity = new THREE.Vector3();
  let onGround = false;
  let collidables = [];
  let currentPitch = 0;
  let collidablesReady = false;

  const ray = new THREE.Raycaster();
  ray.firstHitOnly = true;
  ray.layers.enableAll();

  function refreshCollidables() {
    scene.updateMatrixWorld(true);
    collidables = collectCapsidables(scene);
    collidablesReady = true;
  }

  // ── Collect wall normals at capsule surface (not just center) ──────────────
  function collectWalls(position) {
    const walls = [];
    
    // Multiple check points along capsule height
    const checkHeights = [
      CFG.PLAYER_HEIGHT * 0.25,
      CFG.PLAYER_HEIGHT * 0.55,
      CFG.PLAYER_HEIGHT * 0.75,
      CFG.PLAYER_HEIGHT * 0.85,
    ];

    for (const yOff of checkHeights) {
      // Get random angles around capsule circumference
      for (let theta = 0; theta < 3.14159265359; theta += 0.5) {
        // Capsule surface point at given theta and height
        _orig.set(
          position.x + Math.cos(theta) * CFG.PLAYER_RADIUS,
          position.y - yOff,
          position.z + Math.sin(theta) * CFG.PLAYER_RADIUS
        );

        for (let i = 0; i < CFG.NUM_SIDE_RAYS; i++) {
          const angle = theta + (i / CFG.NUM_SIDE_RAYS) * 0.7; // Spread rays around capsule
          
          const rayDir = new THREE.Vector3(
            Math.cos(angle),
            0,
            Math.sin(angle)
          );
          
          ray.set(_orig, rayDir);
          ray.far = CFG.PLAYER_RADIUS + CFG.SKIN_WIDTH + 0.3;

          const nearby = nearbyMeshes(collidables, _orig, CFG.PLAYER_RADIUS + 0.8);
          const hits = ray.intersectObjects(nearby, false);
          if (!hits.length) continue;

          const hit = hits[0];
          let normal = hit.face?.normal
            .clone()
            .transformDirection(hit.object.matrixWorld)
            ?? new THREE.Vector3();
          if (normal.dot(rayDir) > 0) normal.negate();

          const slopeAngle = Math.acos(
            Math.max(-1, Math.min(1, normal.dot(_up)))
          ) * (180 / Math.PI);
          if (slopeAngle <= CFG.SLOPE_MAX_ANGLE) continue;

          const flat = new THREE.Vector3(normal.x, 0, normal.z).normalize();
          if (flat.lengthSq() < 0.001) continue;
          if (walls.some(w => w.flat.dot(flat) > 0.9)) continue;

          walls.push({ flat, pen: hit.distance });
        }
      }
    }

    return walls;
  }

  // ── Push position out of capsule penetrations ───────────────────────────────
  function pushOutOfWalls(position) {
    for (let iter = 0; iter < 4; iter++) {
      const walls = collectWalls(position);
      let maxPen = 0;
      let bestFlat = null;

      for (const { flat, pen } of walls) {
        if (pen > maxPen) {
          maxPen = pen;
          bestFlat = flat;
        }
      }

      if (maxPen > 0.001 && bestFlat) {
        position.addScaledVector(bestFlat, maxPen * 1.01);
      } else {
        break;
      }
    }
  }

  // ── Slide against wall planes ──────────────────────────────────────────────
  function slideMove(position, delta) {
    const walls = collectWalls(position);
    const out = delta.clone();
    const clippedPlanes = [];

    for (const { flat } of walls) {
      const d = out.dot(flat);
      if (d < 0) {
        out.addScaledVector(flat, -d);
        clippedPlanes.push(flat);
      }
    }
    return out;
  }

  // ── Ground detection from capsule surface ─────────────────────────────────
  function groundCheck(position) {
    const offsets = [];
    
    // Multiple check points on capsule surface for better edge detection
    for (let theta = 0; theta < 3.14159265359; theta += 0.4) {
      const r = CFG.PLAYER_RADIUS * 0.98;
      offsets.push([
        Math.cos(theta) * r,
        0,
        Math.sin(theta) * r,
      ]);
    }

    const checkDist = CFG.PLAYER_HEIGHT + CFG.STEP_HEIGHT + 0.25;
    let highestFloor = null;

    for (const [ox, oy, oz] of offsets) {
      _orig.set(position.x + ox, position.y, position.z + oz);
      ray.set(_orig, _down);
      ray.far = checkDist;

      const nearby = nearbyMeshes(collidables, _orig, checkDist);
      const hits = ray.intersectObjects(nearby, false);
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
        const eyeY = hit.point.y + CFG.PLAYER_HEIGHT / 2;
        if (highestFloor === null || eyeY > highestFloor) highestFloor = eyeY;
      }
    }

    return highestFloor;
  }

  // ── Ceiling clearance at capsule height ─────────────────────────────────────
  function ceilingClearance(position) {
    _orig.set(position.x, position.y + CFG.PLAYER_HEIGHT, position.z);
    ray.set(_orig, _up);
    ray.far = 4.0;

    const nearby = nearbyMeshes(collidables, _orig, ray.far);
    const hits = ray.intersectObjects(nearby, false);
    return hits.length ? hits[0].distance : Infinity;
  }

  // ── Underground recovery ───────────────────────────────────────────────────
  function recoverFromUnderground(position) {
    _orig.set(position.x, position.y - CFG.PLAYER_HEIGHT / 2 - 0.1, position.z);
    ray.set(_orig, _up);
    ray.far = CFG.PLAYER_HEIGHT + 0.7;

    const nearby = nearbyMeshes(collidables, _orig, ray.far);
    const hits = ray.intersectObjects(nearby, false);
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
      ? hit.point.y + CFG.PLAYER_HEIGHT / 2
      : null;
  }

  // ── Movement with capsule physics ───────────────────────────────────────────
  function quakeStepSlideMove(position, intentMove) {
    if (!onGround || intentMove.lengthSq() < 0.00001) {
      return slideMove(position, intentMove);
    }

    const slidDown = slideMove(position, intentMove);

    if (slidDown.lengthSq() >= intentMove.lengthSq() * 0.99) {
      return slidDown;
    }

    if (ceilingClearance(position) < CFG.STEP_HEIGHT + 0.1) {
      return slidDown;
    }

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

  // ── Brush escape ───────────────────────────────────────────────────────────
  function escapeBrush(position) {
    const escapeR = CFG.PLAYER_RADIUS * 2.0;
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

  // ── Main update ────────────────────────────────────────────────────────────
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
      onGround = false;
    }

    // Vertical velocity
    if (!onGround) {
      velocity.y += CFG.GRAVITY * dt;
      velocity.y = Math.max(velocity.y, CFG.TERMINAL_VEL);
    } else {
      velocity.y = Math.min(velocity.y, 0);
    }

    // ── Horizontal movement pipeline ────────────────────────────────────────
    pushOutOfWalls(camera.position);

    const finalSlid = quakeStepSlideMove(camera.position, _move);

    camera.position.x += finalSlid.x;
    camera.position.z += finalSlid.z;

    pushOutOfWalls(camera.position);

    // ── Vertical movement ───────────────────────────────────────────────────
    const deltaY = velocity.y * dt;
    if (velocity.y > 0) {
      const HEAD_GAP = 0.1;
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

    // ── Ground snap ─────────────────────────────────────────────────────────
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
        onGround = true;
        floorY = recovered;
      }
    }

    if (floorY !== null) {
      if (camera.position.y <= floorY + CFG.SKIN_WIDTH * 2) {
        camera.position.y = floorY;
        onGround = true;
        velocity.y = 0;
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
      onGround = false;
      currentPitch = 0;
    },
    get isOnGround() { return onGround; },
    get velocityY() { return velocity.y; },
  };
}