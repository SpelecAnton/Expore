import RAPIER from "https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/rapier.es.js";
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js";
const _rapierReady = RAPIER.init(),
    DEFAULT_CFG = {
        MOVE_SPEED: 280 * 0.02,
        TURN_SPEED: 2.5,
        LOOK_SPEED: 2.5,
        RETURN_SPEED: 5,
        GRAVITY: -28,
        JUMP_SPEED: 3,
        TERMINAL_VEL: -30,
        PLAYER_HEIGHT: 1.6,
        PLAYER_RADIUS: 0.28,
        STEP_HEIGHT: 0.45,
        SLOPE_MAX_ANGLE: 50,
        SKIN_WIDTH: 0.02,
    },
    _vtmp = new THREE.Vector3();
function collectCollidables(e) {
    const t = [];
    return (
        e.traverse((e) => {
            e.isMesh &&
                e.geometry &&
                (e.userData.noclip ||
                    (e.material && !1 === e.material.depthWrite && !e.userData.invisible) ||
                    (e.geometry.attributes.position && t.push(e)));
        }),
        t
    );
}
export function createPhysics(e, t = {}) {
    const o = { ...DEFAULT_CFG, ...t };
    let i = null,
        n = null,
        s = null,
        r = null,
        l = !1,
        a = !1,
        c = !1,
        E = !0,
        p = [];
    const u = new THREE.Vector3();
    let R = !1,
        d = 0;
    const m = new THREE.Vector3(),
        y = new THREE.Vector3(0, 1, 0),
        P = Math.max(0.01, (o.PLAYER_HEIGHT - 2 * o.PLAYER_RADIUS) / 2),
        _ = o.PLAYER_HEIGHT / 2;
    function A() {
        (c = !1), e.updateMatrixWorld(!0);
        for (const e of p) {
            const t = i.getCollider(e);
            t && i.removeCollider(t, !1);
        }
        p = [];
        const t = collectCollidables(e);
        let o = 0,
            n = 0;
        for (const e of t) {
            const s = e.geometry;
            if (!s.attributes.position) continue;
            const r = s.attributes.position,
                l = r.count,
                a = new Float32Array(3 * l);
            for (let t = 0; t < l; t++)
                _vtmp.fromBufferAttribute(r, t).applyMatrix4(e.matrixWorld),
                    (a[3 * t] = _vtmp.x),
                    (a[3 * t + 1] = _vtmp.y),
                    (a[3 * t + 2] = _vtmp.z);
            let c;
            const E = s.index;
            if (E) {
                c = new Uint32Array(E.count);
                for (let e = 0; e < E.count; e++) c[e] = E.getX(e);
            } else {
                c = new Uint32Array(l);
                for (let e = 0; e < l; e++) c[e] = e;
            }
            if (!(c.length < 3))
                try {
                    const e = RAPIER.ColliderDesc.trimesh(a, c).setFriction(0.7).setRestitution(0),
                        t = i.createCollider(e);
                    p.push(t.handle), o++;
                } catch (t) {
                    console.warn(`[Physics] TriMesh přeskočen: ${e.name || e.uuid.slice(0, 8)} — ${t.message}`), n++;
                }
        }
        (a = !0), console.log(`[Physics] Collidery: ${o} postaveny, ${n} přeskočeno (z ${t.length} meshů)`);
    }
    return (
        (async function () {
            await _rapierReady,
                (i = new RAPIER.World({ x: 0, y: o.GRAVITY, z: 0 })),
                (n = i.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()));
            const e = RAPIER.ColliderDesc.capsule(P, o.PLAYER_RADIUS).setFriction(0).setRestitution(0);
            (s = i.createCollider(e, n)),
                (r = i.createCharacterController(o.SKIN_WIDTH)),
                r.setMaxSlopeClimbAngle((o.SLOPE_MAX_ANGLE * Math.PI) / 180),
                r.setMinSlopeSlideAngle((o.SLOPE_MAX_ANGLE * Math.PI) / 180),
                r.enableAutostep(o.STEP_HEIGHT, 0.5 * o.PLAYER_RADIUS, !0),
                r.enableSnapToGround(0.5),
                r.setApplyImpulsesToDynamicBodies(!1),
                (l = !0),
                console.log("[Physics] Rapier 3D KCC připraven ✓"),
                c && A();
        })().catch((e) => console.error("[Physics] Init selhal:", e)),
        {
            update: function (e, t, c, p) {
                if (!l || !a) return c;
                (p = Math.min(p, 0.05)),
                    (t.a || t.arrowleft) && (c += o.TURN_SPEED * p),
                    (t.d || t.arrowright) && (c -= o.TURN_SPEED * p);
                const P = (45 * Math.PI) / 180;
                if (t.q) d = Math.max(d - o.LOOK_SPEED * p, -P);
                else if (t.e) d = Math.min(d + o.LOOK_SPEED * p, P);
                else if (0 !== d) {
                    const e = Math.sign(d);
                    (d -= e * o.RETURN_SPEED * p), Math.sign(d) !== e && (d = 0);
                }
                e.rotation.set(d, c, 0, "YXZ"),
                    m.set(0, 0, 0),
                    (t.w || t.arrowup) && (m.z -= 1),
                    (t.s || t.arrowdown) && (m.z += 1),
                    m.lengthSq() > 0 &&
                        m
                            .normalize()
                            .multiplyScalar(o.MOVE_SPEED * p)
                            .applyAxisAngle(y, c),
                    o.JUMP_SPEED > 0 && (t[" "] || t.space) && R && ((u.y = o.JUMP_SPEED), (R = !1)),
                    R ? (u.y = Math.min(u.y, 0)) : ((u.y += o.GRAVITY * p), (u.y = Math.max(u.y, o.TERMINAL_VEL))),
                    E &&
                        ((E = !1),
                        n.setNextKinematicTranslation({ x: e.position.x, y: e.position.y - _, z: e.position.z }),
                        i.step());
                const A = { x: m.x, y: u.y * p - o.SKIN_WIDTH, z: m.z };
                r.computeColliderMovement(s, A);
                const h = r.computedMovement();
                return (
                    (R = r.computedGrounded()),
                    R && u.y < 0 && (u.y = 0),
                    (e.position.x += h.x),
                    (e.position.y += h.y),
                    (e.position.z += h.z),
                    n.setNextKinematicTranslation({ x: e.position.x, y: e.position.y - _, z: e.position.z }),
                    i.step(),
                    c
                );
            },
            refreshCollidables: function () {
                l ? A() : (c = !0);
            },
            teleport(e, t, o, i) {
                e.position.set(t, o, i), u.set(0, 0, 0), (R = !1), (d = 0), (E = !0);
            },
            get isOnGround() {
                return R;
            },
            get velocityY() {
                return u.y;
            },
        }
    );
}
