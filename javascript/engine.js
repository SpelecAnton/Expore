
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js";
import { EffectComposer } from "https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass }     from "https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass }      from "https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/ShaderPass.js";
import { loadBSP, tickAnimatedTextures, initTexLoader, unmuteVideos, loadTextureFromUrl, setShaderTexSize, setShaderConfig, touchTexture }
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
            tex.rgb = (tex.rgb - 0.5) * max(contrast, 0.0) + 0.5;
            tex.rgb += brightness;
            tex.rgb = mix(tex.rgb, tintColor, tintAlpha);
            gl_FragColor = tex;
        }
    `
};

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

// ── Footstep audio ──────────────────────────────────────────────────────────
// Uses the Web Audio API instead of a plain <audio> element so pitch can be
// varied without changing playback speed/duration (plain playbackRate ties
// pitch and tempo together, which is not what we want here).
//
// Technique: granular resynthesis. The buffer is chopped into small
// overlapping "grains". Each grain plays a short slice of the source at the
// target pitchRatio (which changes its pitch), but grains are scheduled back
// onto the timeline at the *original* real-time spacing — so overall
// duration stays put while the pitch inside each grain shifts. This is a
// simplified version of the technique used by proper time-stretch/pitch-shift
// libraries (e.g. WSOLA), good enough for short percussive sounds like
// footsteps.

const STEPS_CANDIDATES = ["steps.mp3", "steps.ogg", "steps.wav"];

async function findStepsUrl(base) {
    const found = (await Promise.all(STEPS_CANDIDATES.map(async name => {
        const url = base + name;
        try { return (await fetch(url, { method: "HEAD" })).ok ? url : null; }
        catch { return null; }
    }))).find(Boolean);
    if (!found) console.log("[Engine] No footstep sound found.");
    return found ?? null;
}

async function loadAudioBuffer(ctx, url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Steps fetch failed: ${url} (${res.status})`);
    const arr = await res.arrayBuffer();
    return await ctx.decodeAudioData(arr);
}

class GranularStepsPlayer {
    constructor(ctx, buffer, gainNode, { pitchVariation = 0, stopMode = "pause", grainSize = 0.09, overlap = 0.5 } = {}) {
        this.ctx            = ctx;
        this.buffer          = buffer;
        this.gainNode        = gainNode;
        this.pitchVariation  = pitchVariation;
        this.stopMode        = stopMode; // "pause" | "finish"
        this.grainSize       = grainSize;
        this.overlap         = overlap;
        this.hop             = grainSize * (1 - overlap);

        this._position        = 0;     // seconds into buffer, persists across pause/resume
        this._pitchRatio       = 1;
        this._playing          = false; // scheduler active
        this._finishing         = false; // "finish" mode: let current cycle end, then stop
        this._walking           = false;
        this._scheduledUntil    = 0;    // ctx.currentTime up to which grains are scheduled
        this._activeSources     = [];
        this._schedulerTimer    = null;
    }

    _randomPitchRatio() {
        if (this.pitchVariation <= 0) return 1;
        const r = 1 + (Math.random() * 2 - 1) * this.pitchVariation;
        return Math.max(0.5, Math.min(2, r));
    }

    _scheduleGrain(outputTime, sourceTime) {
        const available = this.buffer.duration - sourceTime;
        if (available <= 0) return;
        const sourceDur = Math.min(this.grainSize * this._pitchRatio, available);
        if (sourceDur <= 0) return;

        const src  = this.ctx.createBufferSource();
        src.buffer = this.buffer;
        src.playbackRate.value = this._pitchRatio;

        const g = this.ctx.createGain();
        const half = this.grainSize * this.overlap * 0.5;
        g.gain.setValueAtTime(0, outputTime);
        g.gain.linearRampToValueAtTime(1, outputTime + half);
        g.gain.setValueAtTime(1, Math.max(outputTime + half, outputTime + this.grainSize - half));
        g.gain.linearRampToValueAtTime(0, outputTime + this.grainSize);

        src.connect(g).connect(this.gainNode);
        try {
            src.start(outputTime, sourceTime, sourceDur);
            src.stop(outputTime + this.grainSize + 0.02);
        } catch { return; }

        this._activeSources.push(src);
        src.onended = () => {
            const i = this._activeSources.indexOf(src);
            if (i !== -1) this._activeSources.splice(i, 1);
        };
    }

    _scheduleAhead() {
        const lookahead = 0.25;
        const now = this.ctx.currentTime;
        while (this._scheduledUntil < now + lookahead) {
            if (this._position >= this.buffer.duration) {
                if (this._finishing) {
                    this._playing   = false;
                    this._finishing = false;
                    this._position  = 0;
                    clearTimeout(this._schedulerTimer);
                    return;
                }
                this._position   = 0;
                this._pitchRatio = this._randomPitchRatio();
            }
            this._scheduleGrain(this._scheduledUntil, this._position);
            this._scheduledUntil += this.hop;
            this._position        += this.hop;
        }
    }

    _startScheduler() {
        const tick = () => {
            if (!this._playing) return;
            this._scheduleAhead();
            this._schedulerTimer = setTimeout(tick, 50);
        };
        tick();
    }

    _stopNow() {
        this._playing = false;
        clearTimeout(this._schedulerTimer);
        const now = this.ctx.currentTime;
        for (const src of this._activeSources) {
            try { src.stop(now + 0.03); } catch {}
        }
        this._activeSources = [];
        const unplayed = Math.max(0, this._scheduledUntil - now);
        this._position = Math.max(0, Math.min(this.buffer.duration, this._position - unplayed));
    }

    // Called every frame with the current walking state.
    update(isWalking) {
        this._walking = isWalking;
        if (isWalking) {
            this._finishing = false;
            if (!this._playing) {
                this._playing = true;
                if (this._position === 0) this._pitchRatio = this._randomPitchRatio();
                this._scheduledUntil = this.ctx.currentTime;
                this._startScheduler();
            }
        } else if (this._playing) {
            if (this.stopMode === "pause") {
                this._stopNow();
            } else {
                this._finishing = true; // let _scheduleAhead stop it once the current cycle ends
            }
        }
    }
}

function mapBaseFromUrl(url) {
    try {
        const href = new URL(url, location.href).href;
        return href.substring(0, href.lastIndexOf("/") + 1);
    } catch { return "./"; }
}

function parseEntityColor(str, fallbackHex = 0xff2200) {
    const s = (str || "").trim();
    if (!s) return new THREE.Color(fallbackHex);

    if (s.startsWith("0x") || s.startsWith("#") || /^[0-9a-f]{6}$/i.test(s)) {
        const hex = parseInt(s.replace(/^0x|^#/i, ""), 16);
        return isNaN(hex) ? new THREE.Color(fallbackHex) : new THREE.Color(hex);
    }

    const parts = s.split(/\s+/).map(Number);
    if (parts.length >= 3 && parts.every(n => !isNaN(n))) {
        const [r, g, b] = parts;
        return new THREE.Color(
            Math.max(0, Math.min(1, r / 255)),
            Math.max(0, Math.min(1, g / 255)),
            Math.max(0, Math.min(1, b / 255)),
        );
    }

    return new THREE.Color(fallbackHex);
}

function buildPortalLabel(text, color, parent) {
    if (!text) return null;
    const W = 2048, H = 320;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, W, H);

    let fontSize = 120;
    ctx.font = `bold ${fontSize}px "Share Tech Mono", monospace`;
    while (ctx.measureText(text.toUpperCase()).width > W - 120 && fontSize > 48) {
        fontSize -= 4;
        ctx.font = `bold ${fontSize}px "Share Tech Mono", monospace`;
    }

    ctx.shadowColor  = `#${color.getHexString()}`;
    ctx.shadowBlur   = 72;
    ctx.fillStyle    = `#${color.getHexString()}`;
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text.toUpperCase(), W / 2, H / 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate     = true;
    tex.generateMipmaps = true;
    tex.minFilter       = THREE.LinearMipmapLinearFilter;
    tex.magFilter       = THREE.LinearFilter;

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

function parseEntityBool(str) {
    const s = (str ?? "").trim().toLowerCase();
    return s === "1" || s === "true";
}

function buildPortal(entity, scene, portals) {
    const [ox, oy, oz] = (entity.origin || "0 0 0").split(" ").map(Number);
    const url          = (entity.target_url || "").trim();
    const hasUrl        = url.length > 0;
    const label        = (entity.label || "").trim();
    const hasColor      = !!(entity.color && entity.color.trim());
    const color        = parseEntityColor(entity.color, 0xff2200);
    const angle        = parseFloat(entity.angle  || "0") * Math.PI / 180;
    const billboard     = parseEntityBool(entity.billboard);
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

    mesh.onBeforeRender = function () {
        if (mesh.material.map) touchTexture(mesh.material.map);
    };

    scene.add(mesh);
    if (hasColor) {
        mesh.add(new THREE.LineSegments(
            new THREE.EdgesGeometry(geo),
            new THREE.LineBasicMaterial({ color, opacity, transparent: true })
        ));
    }

    const isMedia = isPortalMediaLabel(label);
    isMedia ? applyPortalMediaTexture(label, mesh) : buildPortalLabel(label, color, mesh);
    portals.push({ x: px, y: py, z: pz, url, label, col: color, mesh, opacity, isMedia, billboard, clickable: hasUrl });
}

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
        const mat = new THREE.SpriteMaterial({
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
    msaa = 2,
    bobStrength = 0,
    bobSpeed    = 7.0,
    brightness  = 0.0,
    contrast    = 1.0,
    tintRgba    = [1, 1, 1, 0],
    shaderTexSize = 512,
    shaderFps = 0,
    shaderFilter = 1,
    targetFps = 0,
    stepsVolume = 0.6,
    stepsPitchVariation = 0.15,
    stepsStopMode = "pause",
}) {
    setShaderConfig(shaderFps, shaderFilter);
    setShaderTexSize(shaderTexSize);

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

    const scene  = new THREE.Scene;
    const fogCol = new THREE.Color(fogColor).convertSRGBToLinear();
    scene.fog        = new THREE.Fog(fogCol, 0.2 * renderDistance, renderDistance);
    scene.background = new THREE.Color(fogCol);

    const cam = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, 0.01, renderDistance);
    cam.position.set(0, 1.6, 0);

    const ambient = new THREE.AmbientLight(0xffffff, 1);
    scene.add(ambient);

    let msaaTarget = null;
    if (msaa > 0) {
        msaaTarget = new THREE.WebGLRenderTarget(
            window.innerWidth, window.innerHeight,
            { samples: msaa, type: THREE.HalfFloatType, colorSpace: THREE.SRGBColorSpace }
        );
        console.log(`[Engine] MSAA ${msaa}x enabled`);
    }
    const composer = msaaTarget
        ? new EffectComposer(renderer, msaaTarget)
        : new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, cam));

    const colorAdjustPass = new ShaderPass(ColorAdjustShader);
    colorAdjustPass.uniforms["brightness"].value = brightness;
    colorAdjustPass.uniforms["contrast"].value   = contrast;
    colorAdjustPass.uniforms["tintColor"].value.set(tintRgba[0], tintRgba[1], tintRgba[2]);
    colorAdjustPass.uniforms["tintAlpha"].value  = tintRgba[3] ?? 0.0;
    composer.addPass(colorAdjustPass);

    let bloomPass = null;
    if (bloomStrength > 0) {
        bloomPass = new UnrealBloomPass(
            new THREE.Vector2(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2)),
            bloomStrength, bloomRadius, bloomThreshold
        );
        composer.addPass(bloomPass);
    }

    const portals     = [];
    const solidMeshes = [];
    const invisMeshes = [];

    const bgMusicPromise = findBackgroundMusic(mapBaseFromUrl(mapUrl));

    // Steps: create the AudioContext eagerly (it starts suspended until a
    // user gesture in most browsers, resumed on first keydown below), then
    // fetch + decode the sound file in parallel with everything else.
    let stepsCtx = null;
    let stepsPlayer = null;
    try {
        stepsCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
        console.warn("[Engine] Web Audio API unavailable — footsteps disabled:", e.message);
    }
    const stepsReadyPromise = (async () => {
        if (!stepsCtx) return;
        const url = await findStepsUrl(mapBaseFromUrl(mapUrl));
        if (!url) return;
        try {
            const buffer = await loadAudioBuffer(stepsCtx, url);
            const gainNode = stepsCtx.createGain();
            gainNode.gain.value = stepsVolume;
            gainNode.connect(stepsCtx.destination);
            stepsPlayer = new GranularStepsPlayer(stepsCtx, buffer, gainNode, {
                pitchVariation: stepsPitchVariation,
                stopMode: stepsStopMode,
            });
            console.log(`[Engine] Footstep sound ready: ${url} (pitchVariation=${stepsPitchVariation}, stopMode=${stepsStopMode})`);
        } catch (e) {
            console.warn("[Engine] Footstep sound failed to load:", e.message);
        }
    })();

    let yaw = 0;

    try {
        const bsp = await loadBSP({
            url: mapUrl, scene,
            textureBase,
            fallbackTexBase: "/expore/textures/",
            onProgress,
        });

        if (bsp.ambientColor     !== undefined) ambient.color.set(bsp.ambientColor);
        if (bsp.ambientIntensity !== undefined) ambient.intensity = bsp.ambientIntensity;

        for (const portal of bsp.portals) buildPortal(portal, scene, portals);
        addLightSprites(scene, bsp.lights ?? []);

        const hash = readHashState();
        if (hash) {
            cam.position.set(hash.x, hash.y, hash.z);
            yaw = hash.yaw;
        } else if (bsp.playerStart) {
            const ps = bsp.playerStart;
            cam.position.set(ps.x, ps.y + 1.6, ps.z);
            yaw = ps.angle * Math.PI / 180;
        }

        const portalMeshSet = new Set(portals.map(p => p.mesh));
        scene.traverse(obj => {
            if (!obj.isMesh || !obj.geometry) return;
            if (portalMeshSet.has(obj)) return;
            if (obj.userData.invisible)                    invisMeshes.push(obj);
            else if (obj.material?.depthWrite !== false)   solidMeshes.push(obj);
        });

        setTimeout(() => {
            console.log("[Engine] Scene ready — full render pipeline active");
        }, 500);

    } catch (err) {
        console.error("[Engine] BSP load failed:", err);
        _fallbackRoom(scene);
        ambient.intensity = 3;
        scene.traverse(obj => {
            if (!obj.isMesh || !obj.geometry) return;
            if (obj.userData.invisible)                    invisMeshes.push(obj);
            else if (obj.material?.depthWrite !== false)   solidMeshes.push(obj);
        });
    }

    const physics = createPhysics(scene, physicsConfig);
    physics.refreshCollidables();
    window._cam     = cam;
    window._physics = physics;
    window._scene   = scene;

    const bgMusic = await bgMusicPromise;
    await stepsReadyPromise;
    let bgStarted = false;
    function startBgMusic() {
        if (!bgStarted && bgMusic) {
            bgStarted = true;
            bgMusic.play().catch(e => console.warn("[Engine] BG music failed:", e));
        }
    }

    let _lastPortal     = null;
    let _rayFrame       = 0;
    const _centerUV     = new THREE.Vector2(0, 0);
    const _fwdRay       = new THREE.Raycaster;
    const _occRay       = new THREE.Raycaster;
    const _portalMeshes = portals.filter(p => p.clickable).map(p => p.mesh);

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
        if (stepsCtx && stepsCtx.state === "suspended") stepsCtx.resume().catch(() => {});
        document.querySelectorAll("video[data-spelec-bsp-video]").forEach(v => v.play().catch(() => {}));

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
    console.log(`[Engine] bobStrength=${bobStrength}, bobSpeed=${bobSpeed}, shaderTexSize=${shaderTexSize}, shaderFps=${shaderFps||"unlimited"}, shaderFilter=${shaderFilter}, targetFps=${targetFps||"unlimited"}, stepsVolume=${stepsVolume}, stepsPitchVariation=${stepsPitchVariation}, stepsStopMode=${stepsStopMode}`);

    let _bobPhase = 0, _bobFactor = 0;

    const _frameInterval = targetFps > 0 ? 1000 / targetFps : 0;
    let _lastFrameTime   = 0;

    const clock  = new THREE.Clock;
    let frameN   = 0;
    let lastHash = 0;

    (function loop() {
        requestAnimationFrame(loop);
        frameN++;

        if (_frameInterval > 0) {
            const _now = performance.now();
            if (_now - _lastFrameTime < _frameInterval) return;
            _lastFrameTime = _now - ((_now - _lastFrameTime) % _frameInterval);
        }

        let dt = clock.getDelta();
        if (dt > 0.1) dt = 0.1;

        const prevX = cam.position.x, prevZ = cam.position.z;
        yaw = physics.update(cam, keys, yaw, dt);

        const dx = cam.position.x - prevX, dz = cam.position.z - prevZ;
        const horizDist = Math.sqrt(dx*dx + dz*dz);

        if (frameN % 3 === 0) tickAnimatedTextures();

        for (const p of portals) {
            p.mesh.material.opacity = p.opacity;
            if (p.billboard) {
                const bdx = cam.position.x - p.mesh.position.x;
                const bdz = cam.position.z - p.mesh.position.z;
                p.mesh.rotation.y = Math.atan2(bdx, bdz);
            }
        }

        const now = performance.now();
        if (now - lastHash >= 3000) {
            lastHash = now;
            writeHashState(cam.position.x, cam.position.y, cam.position.z, yaw);
        }

        canvas.style.cursor = getHoveredPortal() ? "pointer" : "default";

        const isWalkKey = keys.w||keys.s||keys.a||keys.d||keys.arrowup||keys.arrowdown||keys.arrowleft||keys.arrowright;
        const onGround  = physics.isOnGround;
        const bobActive = bobStrength > 0 && onGround && isWalkKey && horizDist > 0.001;

        if (stepsPlayer) {
            const isWalking = onGround && isWalkKey && horizDist > 0.001;
            stepsPlayer.update(isWalking);
        }

        _bobFactor += ((bobActive ? 1 : 0) - _bobFactor) * (1 - Math.exp(-dt * (bobActive ? 8 : 20)));
        if (bobActive) {
            _bobPhase += dt * bobSpeed;
        } else {
            const target = Math.round(_bobPhase / Math.PI) * Math.PI;
            const diff   = target - _bobPhase;
            const step   = dt * bobSpeed;
            _bobPhase   += Math.abs(diff) <= step ? diff : Math.sign(diff) * step;
        }
        const bobOffset = Math.sin(_bobPhase) * bobStrength * _bobFactor;

        window._bobDebug = {
            bobStrength, bobSpeed, bobActive, onGround, isWalkKey,
            horizDist: +horizDist.toFixed(5),
            factor:    +_bobFactor.toFixed(4),
            phase:     +_bobPhase.toFixed(4),
            offset:    +bobOffset.toFixed(6),
        };

        const savedY = cam.position.y;
        cam.position.y = savedY + bobOffset;
        composer.render();
        cam.position.y = savedY;
    })();
}