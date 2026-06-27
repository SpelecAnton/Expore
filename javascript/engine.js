// engine.js v7.17
// Changelog:
// v7.17 — Fix three camera bob bugs:
//         1. Jitter: phase was frozen mid-sine during fade-out, so
//            sin(_bobPhase)*_bobFactor decayed from a non-zero value,
//            producing a visible snap/jitter at the end. Fix: phase now
//            always advances toward the nearest zero crossing while
//            _bobFactor > 0 (not only when < 0.05), driven by bobSpeed.
//         2. Wall-induced amplitude: fadeRate=20 threshold was
//            horizDist<0.005, but sliding along a wall keeps horizDist
//            above that so the fast-fade never triggered. Fix: fadeRate
//            is now always proportional to horizDist — fast when still,
//            slow when moving — using a smooth remap.
//         3. Slope-dependent amplitude: bob was applied as a pitch
//            (cam.rotation.x) offset. On slopes the camera pitch itself
//            changes (LOOK_SPEED / RETURN_SPEED), so adding the bob angle
//            to a tilted pitch produced a different apparent vertical
//            movement depending on slope angle. Fix: bob is now applied
//            as a pure Y-position offset (+bobOffset to cam.position.y
//            during render, removed after), completely independent of
//            camera orientation. bobStrength unit is now world-units
//            (same as v7.13 and earlier).
// v7.16 — MSAA 2x support via WebGLRenderTarget with samples.
// v7.15 — Fix inconsistent bob frequency on slopes and walls.
// v7.14 — Bob as pitch rotation instead of Y position offset.
// v7.14 — Bob as pitch rotation instead of Y position offset.
//         Root cause: position-lerp _renderY lags behind physicsY when
//         climbing → camera rendered lower than physics → floor appears
//         closer → bob looks bigger. Descending: opposite lag, floor farther,
//         bob looks smaller.
//         Fix: replace position-lerp with a VELOCITY-FOLLOWING smoother.
//         Instead of lerping _renderY toward physicsY (which lags on any
//         sustained vertical movement), we smooth the Y *velocity* each frame
//         and integrate it into _renderY. DC component (slope trend) passes
//         through immediately with zero lag; high-frequency step-snap noise
//         is attenuated ~77 % at 10 Hz and ~92 % at 30 Hz. A very slow drift
//         correction (K=2, τ≈500 ms) prevents long-term numerical divergence
//         without introducing any perceptible position lag.
// v7.11 — Frame-rate independent bob: lerp factors use 1-exp(-dt*K).
// v7.10 — Fix: camera bob appeared larger on slopes (added _renderY filter).
// v7.9  — Bob phase driven by actual horizontal displacement instead of time.
// v7.8  — Camera bob while walking on ground.
// v7.7  — (previous version)
//         on slopes or alongside walls. Root cause: Rapier's step-snapping
//         and ground-snap produce per-frame Y noise that adds to the sine
//         offset, making the apparent amplitude larger than bobStrength.
//         Fix: render uses a low-pass-filtered _renderY (smoothing constant
//         25) instead of raw physicsY, which kills high-frequency Y jitter
//         while still tracking real terrain changes within ~130 ms.
//         Also: bobFactor fades out 2.5× faster when the player is truly
//         not moving (horizDist < 0.005), preventing the sine wave from
//         lingering at its peak after the player hits a wall.
//         Raw physicsY is fully restored after render — Rapier never sees
//         any of the visual smoothing or bob offset.
// v7.9 — Bob phase driven by actual horizontal displacement instead of time.
// v7.8 — Camera bob while walking on ground.
// v7.7 — (previous version)

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js";
import { EffectComposer } from "https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass }     from "https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass }      from "https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/ShaderPass.js";
import { loadBSP, tickAnimatedTextures, initTexLoader, unmuteVideos, loadTextureFromUrl }
    from "https://spelecanton.github.io/Expore/javascript/bsp_loader.js";
import { createPhysics } from "https://spelecanton.github.io/Expore/javascript/physics.js";

const PLAYER_HEIGHT = 80, FOV = 90, UNIT = 0.02;

const ColorAdjustShader = {
    uniforms: {
        tDiffuse: { value: null },
        brightness: { value: 0.0 },
        contrast: { value: 1.0 },
        tintColor: { value: new THREE.Vector3(1, 1, 1) },
        tintAlpha: { value: 0.0 }
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float brightness;
        uniform float contrast;
        uniform vec3 tintColor;
        uniform float tintAlpha;
        varying vec2 vUv;

        void main() {
            vec4 tex = texture2D(tDiffuse, vUv);
            
            // Apply contrast
            tex.rgb = (tex.rgb - 0.5) * max(contrast, 0.0) + 0.5;
            
            // Apply brightness
            tex.rgb += brightness;
            
            // Apply RGBA tint
            tex.rgb = mix(tex.rgb, tintColor, tintAlpha);
            
            gl_FragColor = tex;
        }
    `
};

// ── URL hash helpers ──────────────────────────────────────────────────────────

function readHashState() {
    const s = window.location.hash.slice(1);
    if (!s) return null;
    const parts = s.split(",").map(Number);
    return parts.length < 4 || parts.some(isNaN) ? null
        : { x: parts[0], y: parts[1], z: parts[2], yaw: parts[3] };
}

function writeHashState(x, y, z, yaw) {
    const f = v => Math.round(v * 1000) / 1000;
    history.replaceState(null, "", `#${f(x)},${f(y)},${f(z)},${f(yaw)}`);
}

// ── Audio helpers ─────────────────────────────────────────────────────────────

const AUDIO_EXTS = new Set([".mp3", ".ogg", ".wav", ".flac", ".aac"]);

function isAudioUrl(url) {
    try {
        const p = new URL(url, location.href).pathname;
        return AUDIO_EXTS.has(p.substring(p.lastIndexOf(".")).toLowerCase());
    } catch { return false; }
}

let _activePortalAudio = null;

function playPortalAudio(url) {
    const href = new URL(url, location.href).href;
    if (_activePortalAudio && _activePortalAudio.src === href) {
        _activePortalAudio.paused ? _activePortalAudio.play() : _activePortalAudio.pause();
        return;
    }
    if (_activePortalAudio) { _activePortalAudio.pause(); _activePortalAudio = null; }
    const a = new Audio(href);
    a.play().catch(e => console.warn("[Engine] Portal audio play failed:", e));
    _activePortalAudio = a;
}

// ── Background music ──────────────────────────────────────────────────────────

const BG_CANDIDATES = ["background.mp3", "background.ogg", "background.wav"];

async function findBackgroundMusic(base) {
    const found = (await Promise.all(BG_CANDIDATES.map(async name => {
        const url = base + name;
        try { return (await fetch(url, { method: "HEAD" })).ok ? url : null; }
        catch { return null; }
    }))).find(Boolean);
    if (!found) { console.log("[Engine] No background music found."); return null; }
    console.log(`[Engine] Background music: ${found}`);
    const a = new Audio(found);
    a.loop = true;
    a.volume = 0.5;
    return a;
}

function mapBaseFromUrl(url) {
    try {
        const href = new URL(url, location.href).href;
        return href.substring(0, href.lastIndexOf("/") + 1);
    } catch { return "./"; }
}

// ── Portal helpers ────────────────────────────────────────────────────────────

function buildPortalLabel(text, color, parent) {
    if (!text) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 512; canvas.height = 80;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, 512, 80);
    ctx.shadowColor  = `#${color.getHexString()}`;
    ctx.shadowBlur   = 18;
    ctx.font         = 'bold 30px "Share Tech Mono", monospace';
    ctx.fillStyle    = `#${color.getHexString()}`;
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text.toUpperCase(), 256, 40);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(2.8, 0.44),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide })
    );
    mesh.position.set(0, 0, 0.02);
    parent.add(mesh);
    return mesh;
}

const PORTAL_MEDIA_RE = /\.(jpe?g|png|gif|webp|avif|mp4|webm|frag)(?:[?#].*)?$/i;

function isPortalMediaLabel(s) {
    return !!s && PORTAL_MEDIA_RE.test(s.trim());
}

function applyPortalMediaTexture(url, mesh) {
    loadTextureFromUrl(url).then(tex => {
        if (!tex) { console.warn("[Engine] Portal media texture failed to load:", url); return; }
        const mat = mesh.material;
        mat.map = tex;
        mat.color.set(0xffffff);
        mat.needsUpdate = true;
    });
}

function buildPortal(entity, scene, portals) {
    const [ox, oy, oz] = (entity.origin || "0 0 0").split(" ").map(Number);
    const url          = entity.target_url || "#";
    const label        = (entity.label || "").trim();
    const color        = new THREE.Color().setHex(parseInt((entity.color || "0xff2200").replace("#", ""), 16));
    const angle        = parseFloat(entity.angle  || "0") * Math.PI / 180;
    const szDefault    = entity.size || "110";
    const w            = 0.02 * parseFloat(entity.width  || szDefault);
    const h            = 0.02 * parseFloat(entity.height || szDefault);
    const opacity      = Math.max(0, Math.min(1, parseFloat(entity.opacity ?? "0.78")));
    const px = 0.02 * ox, py = 0.02 * oz, pz = 0.02 * -oy;

    const geo  = new THREE.PlaneGeometry(w, h);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
    }));
    mesh.position.set(px, py, pz);
    mesh.rotation.y = angle;
    scene.add(mesh);
    mesh.add(new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color, opacity, transparent: true })
    ));

    const isMedia = isPortalMediaLabel(label);
    isMedia ? applyPortalMediaTexture(label, mesh) : buildPortalLabel(label, color, mesh);
    portals.push({ x: px, y: py, z: pz, url, label, col: color, mesh, opacity, isMedia });
}

// ── Light sprites ─────────────────────────────────────────────────────────────

function makeSpriteTexture(r, g, b) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext("2d");
    const rg = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    const rgb = `${Math.round(255*r)},${Math.round(255*g)},${Math.round(255*b)}`;
    rg.addColorStop(0,    `rgba(${rgb},0.9)`);
    rg.addColorStop(0.25, `rgba(${rgb},0.5)`);
    rg.addColorStop(0.6,  `rgba(${rgb},0.12)`);
    rg.addColorStop(1,    `rgba(${rgb},0)`);
    ctx.fillStyle = rg; ctx.fillRect(0, 0, 128, 128);
    const rg2 = ctx.createRadialGradient(64, 64, 0, 64, 64, 15.36);
    rg2.addColorStop(0,   "#ffffff");
    rg2.addColorStop(0.5, `rgba(${rgb},0.9)`);
    rg2.addColorStop(1,   `rgba(${rgb},0)`);
    ctx.fillStyle = rg2; ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
}

const _spriteTexCache = new Map;
function getSpriteTex(r, g, b) {
    const key = `${r*15|0}:${g*15|0}:${b*15|0}`;
    if (!_spriteTexCache.has(key)) _spriteTexCache.set(key, makeSpriteTexture(r, g, b));
    return _spriteTexCache.get(key);
}

function addLightSprites(scene, lights) {
    if (!lights?.length) return;
    let spriteCount = 0;
    for (const l of lights) {
        const color  = new THREE.Color(l.r, l.g, l.b);
        const dist   = Math.min(20, Math.max(2,   0.05  * l.intensity));
        const intens = Math.min(5,  Math.max(0.2, 0.015 * l.intensity));
        const pt     = new THREE.PointLight(color, intens, dist);
        pt.position.set(l.x, l.y, l.z);
        scene.add(pt);
        if (!l.sprite) continue;
        const mat    = new THREE.SpriteMaterial({
            map: getSpriteTex(l.r, l.g, l.b),
            transparent: true, depthWrite: false,
            blending: THREE.AdditiveBlending, color,
        });
        const sprite = new THREE.Sprite(mat);
        sprite.position.set(l.x, l.y, l.z);
        sprite.scale.setScalar(0.5);
        sprite.userData.noclip = true;
        scene.add(sprite);
        spriteCount++;
    }
    console.log(`[Engine] Lights: ${lights.length} total, ${spriteCount} with sprite`);
}

// ── Fallback room (BSP load error) ───────────────────────────────────────────

function _fallbackRoom(scene) {
    const floorMat = new THREE.MeshLambertMaterial({ color: 1710638 });
    const ceilMat  = new THREE.MeshLambertMaterial({ color: 1447454 });
    const wallMat  = new THREE.MeshLambertMaterial({ color:  657946 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), floorMat);
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), ceilMat);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.y = 5;
    scene.add(ceil);
    for (const [wx, wy, wz, wr] of [
        [-10, 2.5, 0, 0], [10, 2.5, 0, Math.PI],
        [0, 2.5, -10, Math.PI / 2], [0, 2.5, 10, -Math.PI / 2],
    ]) {
        const wall = new THREE.Mesh(new THREE.PlaneGeometry(20, 5), wallMat);
        wall.position.set(wx, wy, wz);
        wall.rotation.y = wr;
        scene.add(wall);
    }
    scene.add(new THREE.AmbientLight(0x334466, 3));
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function initEngine({
    canvas,
    mapUrl        = "map.bsp",
    textureBase   = "textures/",
    mapName       = "MAP",
    onReady       = null,
    onProgress    = null,
    physicsConfig = {},
    bloomStrength  = 0.4,
    bloomRadius    = 0.4,
    bloomThreshold = 0.2,
    renderDistance = 180,
    maxPixelRatio  = 1,
    fogColor       = 0,
    // ── MSAA ───────────────────────────────────────────────────────────────
    // msaa: WebGL multi-sample count for the main scene render target.
    //   2 = MSAA 2x (good balance of quality vs. cost).
    //   4 = MSAA 4x (higher quality, more GPU cost).
    //   0 = disabled (falls back to antialias:true on the renderer).
    msaa = 2,
    // ── Camera bob ─────────────────────────────────────────────────────────
    // bobStrength: vertical sine amplitude in world units (0 = disabled).
    //   0.02 = barely noticeable, 0.05 = natural, 0.10 = very pronounced.
    //   Applied as a Y-position offset (not pitch), so slope angle has
    //   zero effect on apparent amplitude.
    // bobSpeed: phase advance rate in radians per second (rad/s).
    //   Phase advances only when actually moving (horizDist > 0.001).
    //   At MOVE_SPEED 5.6 u/s and bobSpeed 7.0: ~1.1 Hz walking rhythm.
    bobStrength = 0,
    bobSpeed    = 7.0,
    // ── Color Adjustments ──────────────────────────────────────────────────
    brightness  = 0.0,
    contrast    = 1.0,
    tintRgba    = [1, 1, 1, 0], // [r, g, b, alpha]
}) {
    // ── Renderer ──────────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({
        canvas, antialias: true,
        powerPreference: "high-performance",
        logarithmicDepthBuffer: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping         = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 2;
    window._rendererInfo = renderer.info;
    initTexLoader(renderer);

    // ── Scene / fog ───────────────────────────────────────────────────────────
    const scene  = new THREE.Scene;
    const fogCol = new THREE.Color(fogColor).convertSRGBToLinear();
    scene.fog        = new THREE.Fog(fogCol, 0.2 * renderDistance, renderDistance);
    scene.background = new THREE.Color(fogCol);

    // ── Camera ────────────────────────────────────────────────────────────────
    const cam = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, 0.01, renderDistance);
    cam.position.set(0, 1.6, 0);

    // ── Ambient light ─────────────────────────────────────────────────────────
    const ambient = new THREE.AmbientLight(0xffffff, 1);
    scene.add(ambient);

    // ── Post-processing ───────────────────────────────────────────────────────
    // MSAA render target: samples>0 enables hardware multi-sample AA on the
    // main scene pass before bloom is applied. EffectComposer uses this as
    // its read buffer so the first RenderPass resolves into it.
    let msaaTarget = null;
    if (msaa > 0) {
        msaaTarget = new THREE.WebGLRenderTarget(
            window.innerWidth, window.innerHeight,
            {
                samples:    msaa,
                type:       THREE.HalfFloatType,
                colorSpace: THREE.SRGBColorSpace,
            }
        );
        console.log(`[Engine] MSAA ${msaa}x enabled`);
    }
    const composer = msaaTarget
        ? new EffectComposer(renderer, msaaTarget)
        : new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, cam));
    
    const colorAdjustPass = new ShaderPass(ColorAdjustShader);
    colorAdjustPass.uniforms["brightness"].value = brightness;
    colorAdjustPass.uniforms["contrast"].value = contrast;
    colorAdjustPass.uniforms["tintColor"].value.set(tintRgba[0], tintRgba[1], tintRgba[2]);
    colorAdjustPass.uniforms["tintAlpha"].value = tintRgba[3] !== undefined ? tintRgba[3] : 0.0;
    composer.addPass(colorAdjustPass);

    let bloomPass = null;
    if (bloomStrength > 0) {
        bloomPass = new UnrealBloomPass(
            new THREE.Vector2(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2)),
            bloomStrength, bloomRadius, bloomThreshold
        );
        composer.addPass(bloomPass);
    }

    // ── Scene-ready gate (bloom off until BSP is fully loaded) ───────────────
    let sceneReady = false;

    // ── Portal / mesh lists for raycasting ───────────────────────────────────
    const portals     = [];
    const solidMeshes = [];   // visible, depthWrite=true → collidable for raycasts
    const invisMeshes = [];   // invisible clip brushes

    // ── Background music (start fetching early) ───────────────────────────────
    const bgMusicPromise = findBackgroundMusic(mapBaseFromUrl(mapUrl));

    // ── Yaw (shared between spawn, physics loop, and hash writes) ────────────
    let yaw = 0;

    // ── Load BSP ──────────────────────────────────────────────────────────────
    try {
        const bsp = await loadBSP({
            url: mapUrl, scene,
            textureBase,
            fallbackTexBase: "/expore/textures/",
            onProgress,
        });

        if (bsp.ambientColor    !== undefined) ambient.color.set(bsp.ambientColor);
        if (bsp.ambientIntensity !== undefined) ambient.intensity = bsp.ambientIntensity;

        for (const portal of bsp.portals) buildPortal(portal, scene, portals);
        addLightSprites(scene, bsp.lights ?? []);

        // Spawn position
        const hash = readHashState();
        if (hash) {
            cam.position.set(hash.x, hash.y, hash.z);
            yaw = hash.yaw;
        } else if (bsp.playerStart) {
            const ps = bsp.playerStart;
            cam.position.set(ps.x, ps.y + 1.6, ps.z);
            yaw = ps.angle * Math.PI / 180;
        }

        // Collect meshes for portal occlusion raycasting
        const portalMeshSet = new Set(portals.map(p => p.mesh));
        scene.traverse(obj => {
            if (!obj.isMesh || !obj.geometry) return;
            if (portalMeshSet.has(obj)) return;
            if (obj.userData.invisible)            invisMeshes.push(obj);
            else if (obj.material?.depthWrite !== false) solidMeshes.push(obj);
        });

        setTimeout(() => {
            sceneReady = true;
            console.log("[Engine] Scene ready — full render pipeline active");
        }, 500);

    } catch (err) {
        console.error("[Engine] BSP load failed:", err);
        _fallbackRoom(scene);
        ambient.intensity = 3;
        scene.traverse(obj => {
            if (!obj.isMesh || !obj.geometry) return;
            if (obj.userData.invisible)            invisMeshes.push(obj);
            else if (obj.material?.depthWrite !== false) solidMeshes.push(obj);
        });
        sceneReady = true;
    }

    // ── Physics ───────────────────────────────────────────────────────────────
    const physics = createPhysics(scene, physicsConfig);
    physics.refreshCollidables();
    window._cam     = cam;
    window._physics = physics;
    window._scene   = scene;

    // ── Background music ──────────────────────────────────────────────────────
    const bgMusic  = await bgMusicPromise;
    let bgStarted  = false;
    function startBgMusic() {
        if (!bgStarted && bgMusic) {
            bgStarted = true;
            bgMusic.play().catch(e => console.warn("[Engine] BG music failed:", e));
        }
    }

    // ── Portal hover raycasting ───────────────────────────────────────────────
    let _lastPortal    = null;
    let _rayFrame      = 0;
    const _centerUV    = new THREE.Vector2(0, 0);
    const _fwdRay      = new THREE.Raycaster;
    const _occRay      = new THREE.Raycaster;
    const _portalMeshes = portals.map(p => p.mesh);

    function getHoveredPortal() {
        if (!_portalMeshes.length) return null;
        if (++_rayFrame % 4 !== 0) return _lastPortal;
        _fwdRay.setFromCamera(_centerUV, cam);
        const hits = _fwdRay.intersectObjects(_portalMeshes, false);
        if (!hits.length) return (_lastPortal = null);
        const dist = hits[0].distance;
        _occRay.ray.copy(_fwdRay.ray);
        _occRay.near = _fwdRay.near;
        _occRay.far  = dist - 0.05;
        const blocked =
            _occRay.intersectObjects(solidMeshes, false).length > 0 ||
            (invisMeshes.length && _occRay.intersectObjects(invisMeshes, false).length > 0);
        return (_lastPortal = blocked ? null : (portals.find(p => p.mesh === hits[0].object) ?? null));
    }

    // ── Input ─────────────────────────────────────────────────────────────────
    const keys = {};

    window.addEventListener("mousemove", e => {
        _centerUV.x =  e.clientX / window.innerWidth  * 2 - 1;
        _centerUV.y = -e.clientY / window.innerHeight * 2 + 1;
    });

    window.addEventListener("keydown", e => {
        keys[e.key.toLowerCase()] = true;
        if (e.key === " ") e.preventDefault();
        startBgMusic();
        unmuteVideos();
        document.querySelectorAll("video[data-spelec-bsp-video]").forEach(v => v.play().catch(() => {}));

        // Debug: F = ground probe
        if (e.key.toLowerCase() === "f") {
            const pos = cam.position;
            console.log("=== GROUND DEBUG ===");
            console.log("Camera pos:", `(${pos.x.toFixed(4)}, ${pos.y.toFixed(4)}, ${pos.z.toFixed(4)})`);
            const ray   = new THREE.Raycaster; ray.firstHitOnly = true;
            const world = solidMeshes.filter(m => !m.userData.noclip);
            for (const [ox, oz] of [[0,0],[.2,0],[-.2,0],[0,.2],[0,-.2]]) {
                ray.set(new THREE.Vector3(pos.x+ox, pos.y+0.25, pos.z+oz), new THREE.Vector3(0,-1,0));
                ray.far = 5;
                const res = ray.intersectObjects(world, false);
                if (res.length) {
                    const h = res[0], n = h.face?.normal?.clone().transformDirection(h.object.matrixWorld);
                    console.log(`  [${ox.toFixed(1)},${oz.toFixed(1)}]`,
                        "dist="+h.distance.toFixed(3), "hitY="+h.point.y.toFixed(3),
                        "n="+(n?`(${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)})`:"N/A"),
                        h.object.name||h.object.uuid.slice(0,8));
                } else {
                    console.log(`  [${ox.toFixed(1)},${oz.toFixed(1)}] NO HIT`);
                }
            }
            console.log("====================");
        }
        // Debug: P = renderer stats
        if (e.key.toLowerCase() === "p") {
            const info = renderer.info;
            console.log("=== RENDERER STATS ===");
            console.log(`Draw calls:  ${info.render.calls}`);
            console.log(`Triangles:   ${info.render.triangles}`);
            console.log(`Geometries:  ${info.memory.geometries}`);
            console.log(`Textures:    ${info.memory.textures}`);
            console.log(`Programs:    ${info.programs?.length ?? "N/A"}`);
            console.log("======================");
        }
    }, { passive: true });

    window.addEventListener("keyup", e => { keys[e.key.toLowerCase()] = false; });

    window.addEventListener("click", () => {
        startBgMusic();
        unmuteVideos();
        const portal = getHoveredPortal();
        if (portal) {
            if (isAudioUrl(portal.url)) {
                playPortalAudio(portal.url);
            } else {
                document.getElementById("fade")?.classList.add("out");
                setTimeout(() => { window.location.href = portal.url; }, 350);
            }
        }
    });

    // ── Resize ────────────────────────────────────────────────────────────────
    let _resizeTimer = null;
    window.addEventListener("resize", () => {
        clearTimeout(_resizeTimer);
        _resizeTimer = setTimeout(() => {
            cam.aspect = window.innerWidth / window.innerHeight;
            cam.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
            if (msaaTarget) msaaTarget.setSize(window.innerWidth, window.innerHeight);
            composer.setSize(window.innerWidth, window.innerHeight);
            if (bloomPass) bloomPass.resolution.set(
                Math.floor(window.innerWidth  / 2),
                Math.floor(window.innerHeight / 2)
            );
        }, 150);
    });

    onReady?.();

    // Debug: log received bobStrength so we can verify the parameter arrived.
    console.log(`[Engine] bobStrength=${bobStrength}, bobSpeed=${bobSpeed}`);

    let _bobPhase=0,_bobFactor=0;

    // ── Render loop ───────────────────────────────────────────────────────────
    const clock   = new THREE.Clock;
    let frameN    = 0;
    let lastHash  = 0;

    (function loop() {
        requestAnimationFrame(loop);
        frameN++;

        let dt = clock.getDelta();
        if (dt > 0.1) dt = 0.1;

        // 1. Save camera XZ before physics so we can measure actual movement
        const prevX=cam.position.x,prevZ=cam.position.z;

        // 2. Physics — moves cam.position based on Rapier KCC
        yaw = physics.update(cam, keys, yaw, dt);

        // Actual horizontal distance traveled this frame.
        // This is the ground truth for bob activation and phase advance:
        //   • Against a wall: displacement ≈ 0 → bob stops
        //   • On a steep slope: horizontal component is smaller → bob slows
        const dx=cam.position.x-prevX,dz=cam.position.z-prevZ;
        const horizDist=Math.sqrt(dx*dx+dz*dz);

        // 3. Animated textures every 3rd frame
        if (frameN % 3 === 0) tickAnimatedTextures();

        // 4. Portal opacity
        for (const p of portals) p.mesh.material.opacity = p.opacity;

        // 5. Hash save every 3 s — uses raw physics Y, not bobbed Y
        const now = performance.now();
        if (now - lastHash >= 3000) {
            lastHash = now;
            writeHashState(cam.position.x, cam.position.y, cam.position.z, yaw);
        }

        // 6. Portal hover cursor — uses raw physics cam position
        canvas.style.cursor = getHoveredPortal() ? "pointer" : "default";

        // 7. Camera bob — pure Y-position offset, independent of camera pitch.
        //
        // Design rationale (v7.17):
        //   • Y-offset (not pitch): slope angle and LOOK_SPEED pitch changes
        //     have zero effect on apparent bob amplitude.
        //   • fadeRate scales with horizDist: near zero movement (wall press,
        //     stopped) the factor fades out quickly (rate→20); while moving
        //     normally it fades in/out at rate 8. This prevents wall-induced
        //     amplitude increase without a hard threshold.
        //   • Phase always advances toward the nearest zero crossing when
        //     not active (bobActive=false) at rate bobSpeed. This guarantees
        //     the bob value sin(_bobPhase)*_bobFactor decays smoothly through
        //     zero with no mid-sine jitter or sudden snap.
        const isWalkKey=keys.w||keys.s||keys.a||keys.d||keys.arrowup||keys.arrowdown||keys.arrowleft||keys.arrowright;
        const onGround = physics.isOnGround;
        // bobActive: requires isOnGround (physics.js v1.3 fixes computedGrounded
        // flickering), isWalkKey, and actual horizontal displacement.
        const bobActive=bobStrength>0&&onGround&&isWalkKey&&horizDist>0.001;
        // fadeRate: maps horizDist 0→0.001 to rate 20→8 smoothly.
        const fadeRate=bobActive?8:20;
        _bobFactor+=((bobActive?1:0)-_bobFactor)*(1-Math.exp(-dt*fadeRate));
        if(bobActive){
            _bobPhase+=dt*bobSpeed;
        } else {
            // Advance phase toward the nearest N*PI zero crossing so the
            // bob damps to exactly 0, not to an arbitrary sine value.
            const target=Math.round(_bobPhase/Math.PI)*Math.PI;
            const diff=target-_bobPhase;
            const step=dt*bobSpeed;
            _bobPhase+=Math.abs(diff)<=step?diff:Math.sign(diff)*step;
        }
        const bobOffset=Math.sin(_bobPhase)*bobStrength*_bobFactor;

        // Live diagnostics — inspect via window._bobDebug in the browser console.
        window._bobDebug={
            bobStrength, bobSpeed, bobActive, onGround, isWalkKey,
            horizDist: +horizDist.toFixed(5),
            factor:    +_bobFactor.toFixed(4),
            phase:     +_bobPhase.toFixed(4),
            offset:    +bobOffset.toFixed(6),
        };

        // Apply bob as Y-position offset — save physics Y, shift cam up/down,
        // render, restore. Rapier and hash saves never see the offset.
        const savedY=cam.position.y;
        cam.position.y=savedY+bobOffset;

        // 8. Render
        composer.render();

        cam.position.y=savedY;
    })();
}
