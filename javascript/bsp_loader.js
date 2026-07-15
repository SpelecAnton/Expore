import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js";
let _bvhAvailable = !1,
    _MeshBVH = null,
    _acceleratedRaycast = null;
(async () => {
    try {
        const e = await import("https://cdn.jsdelivr.net/npm/three-mesh-bvh@0.7.3/build/index.module.js");
        (_MeshBVH = e.MeshBVH),
            (_acceleratedRaycast = e.acceleratedRaycast),
            (_bvhAvailable = !0),
            console.log("[BSP] three-mesh-bvh loaded — BVH raycasting enabled");
    } catch {
        console.warn("[BSP] three-mesh-bvh not available — using standard raycasting");
    }
})();
const _bvhQueue = [];
let _bvhScheduled = !1;
function scheduleBVHBuild(e) {
    if ((_bvhQueue.push(e), _bvhScheduled)) return;
    _bvhScheduled = !0;
    const t =
        "function" == typeof requestIdleCallback
            ? (e) => requestIdleCallback(e, { timeout: 2e3 })
            : (e) => setTimeout(e, 0);
    t(function e(a) {
        const n = () => !a || a.timeRemaining() > 2;
        for (; _bvhQueue.length && n(); ) {
            const e = _bvhQueue.shift();
            try {
                (e.boundsTree = new _MeshBVH(e)), (e.rawcastFunc = _acceleratedRaycast);
            } catch {}
        }
        _bvhQueue.length ? t(e) : (_bvhScheduled = !1);
    });
}
function buildBVH(e) {
    _bvhAvailable && _MeshBVH && _acceleratedRaycast && scheduleBVHBuild(e);
}
const VIDEO_EXTS = new Set([".mp4", ".webm"]),
    SHADER_EXTS = new Set([".frag"]),
    TEX_EXTENSIONS = [".mp4", ".webm", ".frag", ".gif", ".avif", ".webp", ".png", ".jpg"],
    ANIM_EXTS = new Set([".gif", ".avif", ".webp"]),
    TEXTURE_BATCH_SIZE = 4,
    MESH_YIELD_EVERY = 10,
    MAX_ATLAS_MIPMAP = 4096,
    TEX_PROBE_TIMEOUT_MS = 1e4;
let _shaderTexSize = 512,
    _maxAniso = 1,
    _shaderFps = 0,
    _shaderFilter = 1,
    _lastShaderTick = 0,
    _currentFrame = 0;
export function setShaderConfig(e, t) {
    (_shaderFps = 0 | e),
        (_shaderFilter = 0 | t),
        console.log(`[BSP] Shader FPS: ${_shaderFps || "unlimited"}, Filter: ${_shaderFilter}`);
}
export function setShaderTexSize(e) {
    (_shaderTexSize = Math.max(64, Math.min(4096, 0 | e))),
        console.log(`[BSP] Shader texture size: ${_shaderTexSize}px`);
}
export function initTexLoader(e) {
    (_maxAniso = Math.min(8, e.capabilities.getMaxAnisotropy())),
        console.log(`[BSP] Anisotropic filtering: ${_maxAniso}×`);
}
const _texCache = new Map(),
    _loader = new THREE.TextureLoader(),
    _animList = [],
    _videoList = [],
    _shaderList = [];
export function tickAnimatedTextures() {
    if ((_currentFrame++, _animList.length)) {
        const e = performance.now();
        for (const t of _animList) {
            if (t.tex._lastVisibleFrame < _currentFrame - 2) continue;
            if (e < t.nextFrameTime) continue;
            const a = t.frames[t.frameIdx];
            t.ctx.clearRect(0, 0, t.canvas.width, t.canvas.height),
                t.ctx.drawImage(a.bitmap, 0, 0, t.canvas.width, t.canvas.height),
                (t.tex.needsUpdate = !0),
                (t.frameIdx = (t.frameIdx + 1) % t.frames.length),
                (t.nextFrameTime = e + a.duration);
        }
    }
    if (_videoList.length) for (const e of _videoList) e.paused && !e.ended && e.play().catch(() => {});
    if (_shaderList.length) {
        const e = performance.now();
        let t = !0;
        if (_shaderFps > 0) {
            const a = 1e3 / _shaderFps;
            e - _lastShaderTick < a
                ? (t = !1)
                : ((_lastShaderTick = e - ((e - _lastShaderTick) % a)),
                  isNaN(_lastShaderTick) && (_lastShaderTick = e));
        }
        if (t)
            for (const e of _shaderList)
                e.tex._lastVisibleFrame < _currentFrame - 2 ||
                    ((e.sandbox.forceRender = !0), e.sandbox.render(), (e.tex.needsUpdate = !0));
    }
}
export function unmuteVideos() {
    for (const e of _videoList) e.muted && ((e.muted = !1), e.play().catch(() => {}));
}
export function touchTexture(e) {
    e && (e._lastVisibleFrame = _currentFrame);
}
function applyTexFilters(e, { linearMag: t = !1 } = {}) {
    (e.wrapS = e.wrapT = THREE.RepeatWrapping),
        (e.colorSpace = THREE.SRGBColorSpace),
        (e.minFilter = THREE.LinearMipmapLinearFilter),
        (e.magFilter = t ? THREE.LinearFilter : THREE.NearestFilter),
        (e.anisotropy = _maxAniso),
        (e.generateMipmaps = !0),
        (e.premultiplyAlpha = !0);
}
function fetchWithTimeout(e, t = 1e4, a = {}) {
    const n = new AbortController(),
        r = setTimeout(() => n.abort(), t);
    return fetch(e, { ...a, signal: n.signal }).finally(() => clearTimeout(r));
}
async function fetchBSP(e) {
    const t = await fetch(e);
    if (!t.ok) throw new Error(`BSP fetch failed: ${e} (${t.status})`);
    if (!e.endsWith(".expore")) return t.arrayBuffer();
    if ("undefined" == typeof DecompressionStream)
        throw new Error(
            "[BSP] DecompressionStream is not available in this browser. Use a plain .bsp file or upgrade to a recent browser."
        );
    console.log("[BSP] Decompressing gzip stream...");
    const a = performance.now(),
        n = new DecompressionStream("gzip"),
        r = t.body.pipeThrough(n).getReader(),
        o = [];
    let i = 0;
    for (;;) {
        const { done: e, value: t } = await r.read();
        if (e) break;
        o.push(t), (i += t.byteLength);
    }
    const s = new Uint8Array(i);
    let l = 0;
    for (const e of o) s.set(e, l), (l += e.byteLength);
    return (
        console.log(
            `[BSP] Decompressed ${(i / 1024 / 1024).toFixed(2)} MB in ${(performance.now() - a).toFixed(0)} ms`
        ),
        s.buffer
    );
}
function loadVideoTex(e, t = !1) {
    return new Promise((a) => {
        const n = document.createElement("video");
        (n.src = e),
            (n.loop = !0),
            (n.muted = !0),
            (n.playsInline = !0),
            (n.autoplay = !0),
            (n.preload = "auto"),
            (n.crossOrigin = "anonymous"),
            (n.dataset.spelecBspVideo = ""),
            (n.style.position = "absolute"),
            (n.style.top = "0"),
            (n.style.left = "0"),
            (n.style.width = "1px"),
            (n.style.height = "1px"),
            (n.style.opacity = "0"),
            (n.style.pointerEvents = "none"),
            document.body.appendChild(n);
        const r = new THREE.VideoTexture(n);
        (r._lastVisibleFrame = 0),
            (r.colorSpace = THREE.SRGBColorSpace),
            (r.minFilter = THREE.LinearFilter),
            (r.magFilter = THREE.LinearFilter),
            (r.generateMipmaps = !1),
            (r.wrapS = r.wrapT = THREE.RepeatWrapping);
        let o = !1;
        const i = (e) => {
                o || ((o = !0), clearTimeout(s), a(e));
            },
            s = setTimeout(() => {
                t || console.warn("[BSP] Video texture timed out:", e), n.remove(), i(null);
            }, 1e4);
        n.addEventListener(
            "loadeddata",
            () => {
                (n._tex = r),
                    _videoList.push(n),
                    n.play().catch(() => {}),
                    console.log(`[BSP] Video texture ready: ${e}`),
                    i(r);
            },
            { once: !0 }
        ),
            n.addEventListener(
                "error",
                () => {
                    t || console.warn("[BSP] Video texture failed to load:", e), n.remove(), i(null);
                },
                { once: !0 }
            ),
            n.load();
    });
}
let _glslCanvasLoadPromise = null;
function ensureGlslCanvasLoaded() {
    if (window.GlslCanvas) return Promise.resolve();
    if (_glslCanvasLoadPromise) return _glslCanvasLoadPromise;
    const e = import.meta.url,
        t = e.substring(0, e.lastIndexOf("/") + 1);
    function a(e) {
        return new Promise((t, a) => {
            const n = document.createElement("script");
            (n.src = e),
                (n.onload = () => t()),
                (n.onerror = () => a(new Error(`Failed to load ${e}`))),
                document.head.appendChild(n);
        });
    }
    return (
        (_glslCanvasLoadPromise = a(t + "GlslCanvas.js")
            .catch(() => a("https://spelecanton.github.io/Expore/javascript/GlslCanvas.js"))
            .then(() => {
                if (!window.GlslCanvas) throw new Error("GlslCanvas.js loaded but window.GlslCanvas is missing");
                console.log("[BSP] GlslCanvas.js loaded");
            })),
        _glslCanvasLoadPromise
    );
}
function loadShaderTex(e, t = !1) {
    return fetchWithTimeout(e)
        .then((a) => (a.ok ? a.text() : (t || console.warn("[BSP] Shader texture fetch failed:", e, a.status), null)))
        .then(async (t) => {
            if (!t) return null;
            await ensureGlslCanvasLoaded();
            const a = document.createElement("canvas");
            let n;
            (a.width = a.height = _shaderTexSize),
                (a.style.position = "absolute"),
                (a.style.top = "0"),
                (a.style.left = "0"),
                (a.style.width = _shaderTexSize + "px"),
                (a.style.height = _shaderTexSize + "px"),
                (a.style.opacity = "0"),
                (a.style.pointerEvents = "none"),
                (a.dataset.spelecBspShader = ""),
                a.setAttribute("data-fragment", t),
                document.body.appendChild(a);
            try {
                n = new window.GlslCanvas(a);
            } catch (t) {
                return console.warn("[BSP] GlslCanvas init failed:", e, t.message), a.remove(), null;
            }
            if (!n.isValid)
                return (
                    console.warn("[BSP] Shader failed to compile, skipping texture:", e),
                    n.destroy?.(),
                    a.remove(),
                    null
                );
            n.animationFrameRequest &&
                (cancelAnimationFrame(n.animationFrameRequest), (n.animationFrameRequest = void 0)),
                (a.width = _shaderTexSize),
                (a.height = _shaderTexSize),
                (n.width = _shaderTexSize),
                (n.height = _shaderTexSize),
                n.gl && n.gl.viewport(0, 0, _shaderTexSize, _shaderTexSize),
                (n.resize = () => !1),
                (n.paused = !0),
                (n.forceRender = !0),
                n.render();
            const r = new THREE.CanvasTexture(a);
            r._lastVisibleFrame = 0;
            const o = 0 === _shaderFilter ? THREE.NearestFilter : THREE.LinearFilter;
            return (
                (r.colorSpace = THREE.SRGBColorSpace),
                (r.minFilter = o),
                (r.magFilter = o),
                (r.generateMipmaps = !1),
                (r.wrapS = r.wrapT = THREE.RepeatWrapping),
                _shaderList.push({ canvas: a, sandbox: n, tex: r }),
                console.log(`[BSP] Shader texture ready: ${e} @ ${_shaderTexSize}px`),
                r
            );
        })
        .catch((a) => (t || console.warn("[BSP] Shader texture load failed:", e, a.message), null));
}
async function loadAnimatedTex(e, t = !1) {
    if ("undefined" == typeof ImageDecoder)
        return t || console.warn("[BSP] ImageDecoder not available, static fallback:", e), loadStaticTex(e);
    try {
        const t = await fetchWithTimeout(e);
        if (!t.ok) return null;
        const a = await t.arrayBuffer(),
            n =
                { ".gif": "image/gif", ".avif": "image/avif", ".webp": "image/webp" }[
                    e.substring(e.lastIndexOf(".")).toLowerCase()
                ] ?? "image/gif",
            r = new ImageDecoder({ data: new Blob([a], { type: n }).stream(), type: n, preferAnimation: !0 });
        await r.tracks.ready;
        const o = r.tracks.selectedTrack?.frameCount ?? 1;
        if ((r.close(), o <= 1)) return loadStaticTex(e);
        console.log(`[BSP] Animated texture ${e}: ${o} frames`);
        const i = new ImageDecoder({ data: new Blob([a], { type: n }).stream(), type: n, preferAnimation: !0 });
        await i.tracks.ready;
        const s = [];
        let l = 0,
            c = 0;
        for (let e = 0; e < o; e++) {
            const t = (await i.decode({ frameIndex: e })).image,
                a = null != t.duration ? t.duration / 1e3 : 100;
            0 === e && ((l = t.displayWidth || t.codedWidth || 128), (c = t.displayHeight || t.codedHeight || 128));
            const n = await createImageBitmap(t, { resizeWidth: l, resizeHeight: c });
            t.close(), s.push({ bitmap: n, duration: a });
        }
        if ((i.close(), !s.length)) return loadStaticTex(e);
        const d = document.createElement("canvas");
        (d.width = l), (d.height = c);
        const u = d.getContext("2d");
        u.drawImage(s[0].bitmap, 0, 0, l, c);
        const h = new THREE.CanvasTexture(d);
        return (
            (h._lastVisibleFrame = 0),
            applyTexFilters(h),
            (h.needsUpdate = !0),
            _animList.push({
                frames: s,
                canvas: d,
                ctx: u,
                tex: h,
                frameIdx: 0,
                nextFrameTime: performance.now() + s[0].duration,
            }),
            h
        );
    } catch (a) {
        return t || console.warn("[BSP] Animation load failed, fallback static:", e, a.message), loadStaticTex(e);
    }
}
function loadStaticTex(e) {
    return new Promise((t) => {
        let a = !1;
        const n = setTimeout(() => {
            a || ((a = !0), t(null));
        }, 1e4);
        _loader.load(
            e,
            (e) => {
                a || ((a = !0), clearTimeout(n), applyTexFilters(e), t(e));
            },
            void 0,
            () => {
                a || ((a = !0), clearTimeout(n), t(null));
            }
        );
    });
}
function loadTexByExt(e, t, a = !1) {
    return VIDEO_EXTS.has(t)
        ? loadVideoTex(e, a)
        : SHADER_EXTS.has(t)
          ? loadShaderTex(e, a)
          : ANIM_EXTS.has(t)
            ? loadAnimatedTex(e, a)
            : loadStaticTex(e);
}
async function tryLoadTex(e) {
    if (_texCache.has(e)) return _texCache.get(e);
    const t = e.substring(e.lastIndexOf(".")).toLowerCase(),
        a = await loadTexByExt(e, t);
    return _texCache.set(e, a), a;
}
export async function loadTextureFromUrl(e) {
    if (_texCache.has(e)) return _texCache.get(e);
    const t = e.substring(e.lastIndexOf(".")).toLowerCase(),
        a = await loadTexByExt(e, t);
    return _texCache.set(e, a), a;
}
async function findTex(e, t) {
    for (const a of e) {
        if (!a) continue;
        const e = (
            await Promise.all(
                TEX_EXTENSIONS.map(async (e) => {
                    const n = a + t + e;
                    if (_texCache.has(n)) {
                        const e = _texCache.get(n);
                        return e ? { url: n, tex: e } : null;
                    }
                    const r = await loadTexByExt(n, e, !0);
                    return _texCache.set(n, r), r ? { url: n, tex: r } : null;
                })
            )
        ).find((e) => null !== e);
        if (e) return e.tex;
    }
    return null;
}
const _whiteTex = (() => {
        const e = document.createElement("canvas");
        (e.width = e.height = 1), (e.getContext("2d").fillStyle = "#fff"), e.getContext("2d").fillRect(0, 0, 1, 1);
        const t = new THREE.CanvasTexture(e);
        return (t.colorSpace = THREE.SRGBColorSpace), (t.minFilter = t.magFilter = THREE.LinearFilter), t;
    })(),
    _invisibleMat = new THREE.MeshBasicMaterial({
        colorWrite: !1,
        depthWrite: !1,
        transparent: !0,
        opacity: 0,
        side: THREE.DoubleSide,
    });
async function fetchWorkerCode() {
    const e = import.meta.url,
        t = e.substring(0, e.lastIndexOf("/") + 1) + "bsp_worker.js";
    for (const e of [t, "https://spelecanton.github.io/Expore/javascript/bsp_worker.js"])
        try {
            const t = await fetch(e);
            if (t.ok) return console.log("[BSP] Worker loaded from:", e), await t.text();
        } catch {}
    throw new Error("bsp_worker.js not found");
}
function runBSPWorker(e, t, a, n) {
    return new Promise(async (r, o) => {
        try {
            const i = await fetchWorkerCode(),
                s = new Blob([i], { type: "application/javascript" }),
                l = URL.createObjectURL(s),
                c = new Worker(l);
            (c.onmessage = ({ data: e }) => {
                "progress" === e.type
                    ? n?.(e.pct)
                    : "done" === e.type
                      ? (c.terminate(), URL.revokeObjectURL(l), r(e))
                      : "error" === e.type &&
                        (c.terminate(), URL.revokeObjectURL(l), o(new Error(`[BSP Worker] ${e.message}`)));
            }),
                (c.onerror = (e) => {
                    c.terminate(), URL.revokeObjectURL(l), o(e);
                }),
                c.postMessage({ buffer: e, textureBase: t, fallbackTexBase: a }, [e]);
        } catch (e) {
            o(e);
        }
    });
}
const MAX_VERTS_PER_DRAW = 6e4;
function buildGeometry(e) {
    const t = [];
    let a = [],
        n = 0;
    function r() {
        if (!a.length) return;
        let e = 0,
            r = 0;
        for (const t of a) (e += new Float32Array(t.pos).length / 3), (r += new Uint32Array(t.idx).length);
        const o = new Float32Array(3 * e),
            i = new Float32Array(3 * e),
            s = new Float32Array(2 * e),
            l = new Float32Array(2 * e),
            c = new Uint32Array(r);
        let d = 0,
            u = 0;
        for (const e of a) {
            const t = new Float32Array(e.pos),
                a = new Float32Array(e.nrm),
                n = new Float32Array(e.uv1),
                r = new Float32Array(e.uv2),
                h = new Uint32Array(e.idx),
                p = t.length / 3;
            o.set(t, 3 * d), i.set(a, 3 * d), s.set(n, 2 * d), l.set(r, 2 * d);
            for (let e = 0; e < h.length; e++) c[u + e] = h[e] + d;
            (d += p), (u += h.length);
        }
        const h = new THREE.BufferGeometry();
        h.setAttribute("position", new THREE.BufferAttribute(o, 3)),
            h.setAttribute("normal", new THREE.BufferAttribute(i, 3)),
            h.setAttribute("uv", new THREE.BufferAttribute(s, 2)),
            h.setAttribute("uv1", new THREE.BufferAttribute(l, 2)),
            h.setIndex(new THREE.BufferAttribute(c, 1)),
            h.computeBoundingSphere(),
            h.computeBoundingBox(),
            buildBVH(h),
            t.push(h),
            (a = []),
            (n = 0);
    }
    for (const t of e) {
        const e = new Float32Array(t.pos).length / 3;
        n + e > 6e4 && n > 0 && r(), a.push(t), (n += e);
    }
    return r(), t;
}
// Groups now include the PVS cluster id in the merge key, so a single merged
// draw call never spans the whole map anymore — each mesh stays spatially
// local, which is what makes both frustum culling AND the PVS visibility
// toggle in engine.js actually effective (previously one mesh could cover
// the entire level, defeating any per-object culling).
function mergeBatchGeometries(e) {
    const t = new Map();
    for (const a of e) {
        const key = `${a.texIdx}|${a.lmIdx}|${a.noclip ? 1 : 0}|${a.invisible ? 1 : 0}`;
        if (!t.has(key)) {
            t.set(key, {
                texIdx: a.texIdx,
                lmIdx: a.lmIdx,
                noclip: a.noclip,
                invisible: a.invisible,
                hasLM: a.hasLM,
                clusterSet: new Set(),
                parts: [],
            });
        }
        const group = t.get(key);
        if (a.clusters) {
            for (const c of a.clusters) group.clusterSet.add(c);
        } else if (a.cluster !== undefined) {
            group.clusterSet.add(a.cluster);
        }
        group.parts.push(a);
    }
    const a = [];
    for (const [, e] of t) {
        const t = buildGeometry(e.parts);
        for (const n of t)
            a.push({
                geo: n,
                texIdx: e.texIdx,
                lmIdx: e.lmIdx,
                noclip: e.noclip,
                invisible: e.invisible,
                hasLM: e.hasLM,
                clusters: Array.from(e.clusterSet),
            });
    }
    return a;
}
function yieldToEventLoop() {
    return new Promise((e) => setTimeout(e, 0));
}
async function buildMeshesProgressively(e, t, a, n, r, o) {
    let i = 0,
        s = 0,
        l = 0,
        c = 0,
        g = 0;
    const d = new Map();
    const sharedMaterials = new Map();
    for (let u = 0; u < e.length; u++) {
        u > 0 && u % 10 == 0 && (o?.(90 + (u / e.length) * 10), await yieldToEventLoop());
        const h = e[u],
            p = t[h.texIdx] || "default";
        let m;
        if (h.invisible) m = _invisibleMat;
        else {
            const matKey = p + (h.hasLM && a && !h.invisible ? "_lm" : "");
            if (sharedMaterials.has(matKey)) {
                m = sharedMaterials.get(matKey);
            } else {
                const tex = n.get(p) ?? null;
                m = new THREE.MeshLambertMaterial({ map: tex ?? _whiteTex, side: THREE.DoubleSide, alphaTest: 0.5 });
                if (h.hasLM && a && !h.invisible) {
                    m.lightMap = a;
                    m.lightMapIntensity = 1;
                }
                sharedMaterials.set(matKey, m);
                tex || (d.has(p) || d.set(p, []), d.get(p).push(m));
            }
        }
        const f = new THREE.Mesh(h.geo, m);
        f.onBeforeRender = function () {
            m.map && (m.map._lastVisibleFrame = _currentFrame);
        };
        f.matrixAutoUpdate = !1;
        f.updateMatrix();
        f.frustumCulled = !0;
        h.invisible && ((f.userData.invisible = !0), c++);
        h.noclip && ((f.userData.noclip = !0), l++);
        h.hasLM && a && !h.invisible && s++;
        if (h.clusters && h.clusters.length > 0) {
            f.userData.clusterSet = new Set(h.clusters);
            g++;
        }
        r.add(f);
        // Diagnostics: detect broken bounding spheres which cause wrong frustum culling
        const bs = f.geometry.boundingSphere;
        const bb = f.geometry.boundingBox;
        if (!bs || isNaN(bs.radius) || !isFinite(bs.radius) || bs.radius <= 0) {
            console.warn(`[BSP] BROKEN bounding sphere on mesh #${i}: radius=${bs?.radius}, tex=${p}`);
        }
        if (bb) {
            console.log(`[BSP] mesh #${i} tex="${p}" Y: ${bb.min.y.toFixed(2)}..${bb.max.y.toFixed(2)}, X: ${bb.min.x.toFixed(2)}..${bb.max.x.toFixed(2)}, Z: ${bb.min.z.toFixed(2)}..${bb.max.z.toFixed(2)}, clusters=${JSON.stringify(h.clusters?.slice(0,4))}`);
        }
        i++;
    }
    return (
        console.log(`[BSP] Meshes: ${i} total, noclip: ${l}, invisible clip: ${c}, PVS-tagged: ${g}`),
        { totalMeshes: i, pendingSwap: d }
    );
}
const INITIAL_BATCHES = 1;
async function loadTexturesInBatches(e, t, a, n) {
    const r = new Map(),
        o = e.length;
    for (let i = 0; i < o; i += 4) {
        const s = e.slice(i, i + 4);
        await Promise.all(
            s.map(async (e) => {
                const a = await findTex(t, e);
                if ((r.set(e, a || _whiteTex), n && a)) {
                    const t = n.get(e);
                    if (t) {
                        for (const e of t) (e.map = a), (e.needsUpdate = !0);
                        n.delete(e);
                    }
                }
            })
        ),
            a?.(82 + ((i + s.length) / o) * 8);
    }
    return r;
}
export async function loadBSP({
    url: e,
    scene: t,
    textureBase: a = "",
    fallbackTexBase: n = "",
    onProgress: r = null,
}) {
    r?.(0);
    const o = await fetchBSP(e);
    r?.(5);
    const i = await runBSPWorker(o, a, n, (e) => r?.(5 + 0.75 * e)),
        {
            portals: s,
            playerStart: l,
            ambientIntensity: c,
            ambientColorArr: d,
            texNames: u,
            lmAtlas: h,
            batches: p,
        } = i;
    let m = null;
    if (h) {
        0 === h.nonZero
            ? console.warn("[BSP] No lightmap — baked light missing.")
            : console.log(`[BSP] Lightmap atlas ${h.W}×${h.H}, non-zero: ${h.nonZero}`);
        const e = new Uint8Array(h.data);
        (m = new THREE.DataTexture(e, h.W, h.H, THREE.RGBAFormat)),
            (m.colorSpace = THREE.SRGBColorSpace),
            (m.channel = 1),
            h.W > 4096 || h.H > 4096
                ? (console.warn(
                      `[BSP] Atlas ${h.W}×${h.H} exceeds 4096px — mipmaps disabled. Consider -lightmapsize 128 in q3map2.`
                  ),
                  (m.generateMipmaps = !1),
                  (m.minFilter = THREE.LinearFilter))
                : ((m.generateMipmaps = !0), (m.minFilter = THREE.LinearMipmapLinearFilter)),
            (m.magFilter = THREE.LinearFilter),
            (m.anisotropy = _maxAniso),
            (m.wrapS = m.wrapT = THREE.ClampToEdgeWrapping),
            setTimeout(() => {
                m.needsUpdate = !0;
            }, 0);
    }
    console.log(`[BSP] Merging ${p.length} batches (vertex budget: 60000)...`);
    const f = mergeBatchGeometries(p);
    console.log(`[BSP] After merge: ${f.length} draw calls`);
    const x = [a, n],
        g = [...new Set(p.filter((e) => !e.invisible).map((e) => u[e.texIdx] || "default"))];
    console.log(`[BSP] Loading ${g.length} unique textures (4/batch)...`);
    const w = g.slice(0, 4),
        T = new Map();
    await Promise.all(
        w.map(async (e) => {
            const t = await findTex(x, e);
            T.set(e, t || _whiteTex);
        })
    ),
        r?.(82);
    const { pendingSwap: E } = await buildMeshesProgressively(f, u, m, T, t, r);
    r?.(100);
    const S = g.slice(w.length);
    S.length > 0 &&
        (console.log(`[BSP] Background-loading ${S.length} remaining textures...`),
        loadTexturesInBatches(S, x, null, E).catch((e) => {
            console.warn("[BSP] Background texture load error:", e);
        }));
    const _ = { portals: s, playerStart: l };
    void 0 !== c && (_.ambientIntensity = c);
    d && (_.ambientColor = new THREE.Color(...d));
    _.lights = i.lights ?? [];

    // Rebuild the BSP tree / PVS typed arrays from the worker's transferred
    // ArrayBuffers. Left as null when the map has no tree/visdata (older
    // compile, or -vis skipped) — engine.js treats null as "PVS disabled,
    // render everything", so nothing changes on those maps.
    if (i.bspTree) {
        _.bspTree = {
            hasVis: i.bspTree.hasVis,
            planes: new Float32Array(i.bspTree.planes),
            nodePlane: new Int32Array(i.bspTree.nodePlane),
            nodeChildren: new Int32Array(i.bspTree.nodeChildren),
            leafCluster: new Int32Array(i.bspTree.leafCluster),
            numClusters: i.bspTree.numClusters,
            bytesPerCluster: i.bspTree.bytesPerCluster,
            visBits: i.bspTree.visBits ? new Uint8Array(i.bspTree.visBits) : null,
        };
    } else {
        _.bspTree = null;
    }

    return _;
}
