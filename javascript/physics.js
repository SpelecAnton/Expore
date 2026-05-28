/**
 * SPELEC PHYSICS v2.8 — MULTI-PLANE FIX & CORNER TUNNELING PROTECTION
 *
 * Plně implementovaná detekce schodů a stěn ve stylu id Tech 3 (Quake 3).
 * Verze 2.8 řeší třesení a propadávání skrze spoje více brushů (vnitřní rohy):
 * 1. pushOutOfWalls nyní používá iterativní greedy přístup (řeší nejprve nejhlubší zásek).
 * 2. slideMove detekuje skřípnutí mezi dvěma rovinami a uzamyká pohyb do jejich průsečíku.
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

  // ── Collect unique wall normals at a given position ───────────────────────
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
        if (slopeAngle <= CFG.SLOPE_MAX_ANGLE) continue;

        const flat = new THREE.Vector3(normal.x, 0, normal.z).normalize();
        if (flat.lengthSq() < 0.001) continue;
        if (walls.some(w => w.flat.dot(flat) > 0.85)) continue;

        const cosAngle = -_dir.dot(normal);
        const perpDist = hit.distance * cosAngle;
        const pen = CFG.PLAYER_RADIUS - perpDist;

        walls.push({ flat, pen });
      }
    }

    return walls;
  }

  // ── Push position directly out of wall penetrations ───────────────────────
  function pushOutOfWalls(position) {
    // FIX v2.8: Iterativní Greedy vytlačování (max 3 průchody).
    // Místo vytlačení ze všech stěn naráz vyřešíme v každém kroku pouze tu NEJHLUBŠÍ kolizi.
    // Tím zabráníme tomu, aby nás vytlačení z jedné zdi hodilo nekontrolovaně hluboko do druhé.
    for (let iter = 0; iter < 3; iter++) {
      const walls = collectWalls(position);
      let maxPen = 0;
      let bestFlat = null;

      for (const { flat, pen } of walls) {
        if (pen > maxPen) {
          maxPen = pen;
          bestFlat = flat;
        }
      }

      // Pokud najdeme průnik, vytlačíme hráče ven s nepatrným bonusem (odlepení od stěny)
      if (maxPen > 0.001 && bestFlat) {
        position.addScaledVector(bestFlat, maxPen * 1.005);
      } else {
        break; // Žádné další kolize, jsme bezpečně venku
      }
    }
  }

  // ── Clip movement delta against wall planes ───────────────────────────────
  function slideMove(position, delta) {
    const walls = collectWalls(position);
    const out   = delta.clone();
    const clippedPlanes = [];

    for (const { flat } of walls) {
      const d = out.dot(flat);
      if (d < 0) {
        // Standardní oříznutí pohybu podél stěny
        out.addScaledVector(flat, -d);

        // FIX v2.8: Quake 3 Multi-plane crease clipping
        // Pokud nově oříznutý směr začne směřovat PROTI některé z rovin, 
        // kterými jsme už v tomto framu prošli, jsme skřípnutí v koutě.
        for (const prevFlat of clippedPlanes) {
          if (out.dot(prevFlat) < -0.001) {
            // Vypočítáme osu průsečíku obou stěn (křížový součin normál)
            const crease = new THREE.Vector3().crossVectors(flat, prevFlat).normalize();
            
            // Projektujeme původní zamýšlený pohyb do této linie průsečíku.
            // U čistě vertikálních stěn bude výsledek (0,0,0), což pohyb bezpečně zastaví
            // a zabrání proklouznutí skrze šev geometrie.
            const speed = delta.dot(crease);
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

  // ── Ceiling clearance at a given position ─────────────────────────────────
  function ceilingClearance(position) {
    _orig.set(position.x, position.y, position.z);
    ray.set(_orig, _up);
    ray.far = 4.0;

    const nearby = nearbyMeshes(collidables, _orig, ray.far);
    const hits   = ray.intersectObjects(nearby, false);
    return hits.length ? hits[0].distance : Infinity;
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

  // ── Quake-style PM_StepSlideMove ──────────────────────────────────────────
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
        if (slidUp.lengthSq() > slidDown.lengthSq() + 0.0001) {
          position.y = landY; 
          return slidUp;      
        }
      }
    }

    return slidDown;
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
    pushOutOfWalls(camera.position);

    const finalSlid = quakeStepSlideMove(camera.position, _move);

    camera.position.x += finalSlid.x;
    camera.position.z += finalSlid.z;

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