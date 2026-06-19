/**
 * SPELEC Multiplayer v1.4
 *
 * Renders other players as 3D billboard sprites in the scene.
 * Broadcasts own position to spelec.cz/chat/players.php and receives others every 150 ms.
 * Silently degrades when server is unreachable — the engine keeps running.
 *
 * Changes over v1.3:
 *
 * 1. ANIMATED / VIDEO CUSTOM SKINS:
 *    player_skins.txt entries can now point at a .gif/.avif/.webp (animated
 *    image) or .mp4/.webm (video) file, not just a static image — detected
 *    purely by URL extension.
 *      - Video skins: a hidden looping <video> element wrapped in a
 *        THREE.VideoTexture, same off-screen-but-not-display:none trick used
 *        by bsp_loader.js for map textures. ALWAYS muted — unlike BSP map
 *        textures, several player avatars playing audio simultaneously would
 *        be unpleasant, so there is intentionally no unmute path for these.
 *      - Animated image skins: decoded via the ImageDecoder API into a frame
 *        list, drawn onto a canvas backing a THREE.CanvasTexture, and ticked
 *        forward once per frame from _lerpLoop(). Falls back to a plain
 *        static texture if ImageDecoder is unavailable or the file turns out
 *        to only have one frame.
 *    _applyBodyAppearance() now tracks a per-player `skinCleanup` callback
 *    (removes the <video> element / closes decoded bitmaps) so swapping or
 *    removing a skin never leaks GPU/DOM resources.
 *
 * --- Previous changelog (v1.3) ----------------------------------------------
 *
 * 1. RESERVED ADMIN SKIN GATE:
 *    The custom-skin feature (added in v1.2) matches any nickname against
 *    player_skins.txt — but the reserved admin name ("Anton Špelec", same
 *    constant used by chat.js / chat_overlay.js / api.php) is a special
 *    case: ANYONE could otherwise just rename themselves "Anton Špelec" and
 *    impersonate the admin's appearance.
 *    The reserved name's skin now only renders when the server
 *    (chat/players.php) confirms `is_admin: true` on that player's record,
 *    which it only sets when the broadcast included the correct admin
 *    password. All other nicknames in the skin list are unaffected — no
 *    password needed for those.
 *    Own admin password is supplied via the new setAdminPass() method on
 *    the object returned by createMultiplayer(); see Map Maker/index.html
 *    for how it's wired to the chat overlay's admin password field.
 *
 * --- Previous changelog (v1.2 — CUSTOM SKINS EDITION) -----------------------
 *
 * 1. CUSTOM SKINS BY NICKNAME:
 *    A player can swap the default glowing-ball sprite for a custom image
 *    just by picking a matching nickname. The mapping lives in a plain text
 *    file hosted on GitHub Pages (see SKINS_URL / skinsUrl option), one
 *    entry per line:
 *
 *        Nickname = https://example.com/image.png
 *
 *    Lines starting with "#" or blank lines are ignored. Matching is
 *    case-insensitive and trims whitespace on both sides of "=".
 *    The list is fetched once at startup; if it's unreachable or a specific
 *    image fails to load (e.g. missing CORS headers), the player silently
 *    falls back to the default ball — never blocks rendering.
 *
 * --- Previous changelog (v1.1) ----------------------------------------------
 *
 * 1. AUTO MAP NAME:
 *    mapName parameter now defaults to null which triggers auto-detection from
 *    window.location.pathname. The URL hash (coordinates written by engine.js,
 *    e.g. #6.326,1.62,-1.974,-14.613) is intentionally ignored — only the
 *    page path is used as the group key so all players on the same page share
 *    a session regardless of their individual positions.
 *    Example: https://spelec.cz/expore/#1,2,3,4  →  _mapName = "expore"
 *             https://spelec.cz/games/dungeon/    →  _mapName = "games/dungeon"
 *
 * 2. NICK LABEL: 16-CHAR LIMIT RAISED TO 128
 *    Label canvas widened from 256 px to 512 px. Font auto-scales from 23 px
 *    down to 8 px so any nick up to 128 characters is displayed without
 *    truncation. LABEL_W updated to 1.83 to preserve the correct aspect ratio
 *    (512 / 56 × LABEL_H 0.20).
 *
 * Usage:
 *   const mp = createMultiplayer(window._scene, {
 *     playersUrl: 'https://spelec.cz/chat/players.php',
 *     // mapName omitted → auto-detected from window.location.pathname
 *     // skinsUrl omitted → defaults to SKINS_URL below
 *   });
 *   // mp.getPlayers() → [{ uid, nick, x, y, z }]
 *   // mp.setAdminPass(pass) → include with own broadcast for the admin gate
 *   // mp.destroy()
 *
 * Requires window._cam (THREE.PerspectiveCamera) set by engine.js after load.
 */

'use strict';

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';

const BROADCAST_MS  = 150;
const REQ_TIMEOUT   = 2500;
const SPRITE_SIZE   = 0.44;
const LABEL_W       = 1.83;   // 512 / 56 × LABEL_H(0.20) — widened from 1.08
const LABEL_H       = 0.20;
const LABEL_Y       = 0.60;
const BODY_Y        = -0.28;
const LERP_SPEED    = 10.0;

// Default location of the nickname → skin-image mapping file.
// Hosted alongside the engine on GitHub Pages so it can be edited without
// touching any code. Override via the `skinsUrl` option if needed.
const SKINS_URL = 'https://spelecanton.github.io/Expore/player_skins.txt';

// Custom skins render a bit larger than the default dot so the image reads
// clearly as a character — this is the length of the sprite's longer side,
// relative to SPRITE_SIZE.
const SKIN_SCALE = 2.2;

// Same reserved name used by chat.js / chat_overlay.js / chat/api.php.
// A skin-list entry for this exact name only applies once the server has
// confirmed the broadcasting player supplied the correct admin password —
// see _resolveSkinUrl() and chat/players.php's `is_admin` field.
const RESERVED_NAME = 'Anton Špelec';

// ── Auto map name ─────────────────────────────────────────────────────────────
// Derives a stable group key from the current page path.
// engine.js writes player coordinates into window.location.hash every few seconds
// (e.g. #x,y,z,yaw) — we must NOT include the hash in the map key or every
// player movement would produce a different group key.
function _autoMapName() {
    // "/expore/"         → "expore"
    // "/"               → "root"
    // "/games/dungeon/" → "games/dungeon"
    const path = window.location.pathname.toLowerCase();
    return path.replace(/^\/|\/$/g, '') || 'root';
}

// ── Colour helpers ────────────────────────────────────────────────────────────

function _idToHue(uid) {
    let h = 0;
    for (let i = 0; i < uid.length; i++) h = uid.charCodeAt(i) + ((h << 5) - h);
    return ((h % 360) + 360) % 360;
}

// ── Sprite textures ───────────────────────────────────────────────────────────

function _makeBodyTex(hue) {
    const S      = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = S;
    const ctx = canvas.getContext('2d');
    const cx = S / 2, cy = S / 2;

    // Glow halo
    const grad = ctx.createRadialGradient(cx, cy, S * 0.08, cx, cy, S / 2);
    grad.addColorStop(0,    `hsla(${hue},100%,78%,0.90)`);
    grad.addColorStop(0.45, `hsla(${hue},100%,55%,0.60)`);
    grad.addColorStop(1,    `hsla(${hue},100%,40%,0.00)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, S, S);

    // Solid core
    ctx.beginPath();
    ctx.arc(cx, cy, S * 0.20, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${hue},100%,82%)`;
    ctx.fill();

    // White centre dot
    ctx.beginPath();
    ctx.arc(cx, cy, S * 0.07, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fill();

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
}

function _makeLabelTex(nick, hue) {
    // Canvas 512×56 px. Background fills the full canvas so the sprite
    // always has a solid backdrop regardless of nick length.
    const W = 512, H = 56;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    // Rounded-rect background — full canvas width.
    const r = 10;
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.arcTo(W, 0, W, H, r); ctx.arcTo(W, H, 0, H, r);
    ctx.arcTo(0, H, 0, 0, r); ctx.arcTo(0, 0, W, 0, r);
    ctx.closePath();
    ctx.fill();

    // Auto-scale font so the full nick fits without truncation.
    // Starts at 23 px and steps down to 8 px (minimum readable in 3D).
    const maxW   = W - 24;
    let fontSize = 23;
    ctx.font = `bold ${fontSize}px "Share Tech Mono","Courier New",monospace`;
    while (ctx.measureText(nick).width > maxW && fontSize > 8) {
        fontSize--;
        ctx.font = `bold ${fontSize}px "Share Tech Mono","Courier New",monospace`;
    }

    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = `hsl(${hue},100%,72%)`;
    ctx.fillText(nick, W / 2, H / 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
}

// ── Custom skin loading ────────────────────────────────────────────────────────
// Shared loader instance — crossOrigin must be set before any load() call so
// WebGL is allowed to read pixels from cross-origin images (most static
// hosts, e.g. GitHub raw / imgur, already send the required CORS headers).
const _skinLoader = new THREE.TextureLoader();
_skinLoader.setCrossOrigin('anonymous');

// Parses the "Nickname = URL" list into a Map keyed by lower-cased,
// trimmed nickname. Never throws — an unreachable or malformed file just
// results in an empty map, and every player keeps the default ball sprite.
async function _loadSkinMap(url) {
    const map = new Map();
    if (!url) return map;

    try {
        const ctrl = new AbortController();
        const tid  = setTimeout(() => ctrl.abort(), REQ_TIMEOUT);
        const res  = await fetch(url, { signal: ctrl.signal });
        clearTimeout(tid);
        if (!res.ok) return map;

        const text = await res.text();
        for (const rawLine of text.split('\n')) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;

            const eq = line.indexOf('=');
            if (eq === -1) continue;

            const nick    = line.slice(0, eq).trim();
            const skinUrl = line.slice(eq + 1).trim();
            if (!nick || !/^https?:\/\//i.test(skinUrl)) continue;

            map.set(nick.toLowerCase(), skinUrl);
        }
        console.log(`[Multiplayer] Skin list loaded: ${map.size} entr${map.size === 1 ? 'y' : 'ies'}`);
    } catch {
        console.warn('[Multiplayer] Skin list unreachable — using default sprites');
    }
    return map;
}

// ── Animated / video skin support ───────────────────────────────────────────
// Custom skins can be a static image, an animated image (.gif/.avif/.webp),
// or a short looping video (.mp4/.webm). Detected purely by URL extension —
// server content-type is not consulted (matches the rest of the skin-list
// parsing, which is intentionally simple/static).
//
// Every loader below resolves to either `null` (failed) or:
//   { tex, width, height, cleanup }
// `cleanup()` releases any DOM/decoder resources the asset created (detached
// <video> elements, decoded ImageBitmaps) — always call it when a skin is
// replaced or its player leaves.

const SKIN_VIDEO_EXTS = new Set(['.mp4', '.webm']);
const SKIN_ANIM_EXTS  = new Set(['.gif', '.avif', '.webp']);

function _extOf(url) {
    try {
        const path = new URL(url, window.location.origin).pathname;
        return path.substring(path.lastIndexOf('.')).toLowerCase();
    } catch { return ''; }
}

// Active animated-canvas skins — advanced once per frame from _lerpLoop().
const _activeAnimSkins  = new Set();
// Active <video> skin elements — resumed if the browser pauses them (tab
// switch, power-saving), same pattern as bsp_loader.js's tickAnimatedTextures().
const _activeVideoSkins = new Set();

// Looping muted <video> element as a skin texture. ALWAYS muted: multiple
// player avatars playing audio simultaneously would be unpleasant, and
// muted autoplay also sidesteps the browser autoplay-gesture requirement
// entirely, so the avatar starts animating immediately for everyone.
function _loadVideoSkin(url) {
    return new Promise(resolve => {
        const video = document.createElement('video');
        video.src         = url;
        video.loop        = true;
        video.muted       = true;
        video.playsInline = true;
        video.autoplay    = true;
        video.preload     = 'auto';
        video.crossOrigin = 'anonymous';

        // Kept off-screen but NOT display:none — some browsers stop decoding
        // frames for display:none elements, which would freeze the texture
        // on its first frame.
        video.style.position      = 'absolute';
        video.style.top           = '0';
        video.style.left          = '0';
        video.style.width         = '1px';
        video.style.height        = '1px';
        video.style.opacity       = '0';
        video.style.pointerEvents = 'none';
        document.body.appendChild(video);

        let settled = false;

        const onReady = () => {
            if (settled) return;
            settled = true;

            const tex = new THREE.VideoTexture(video);
            tex.colorSpace      = THREE.SRGBColorSpace;
            tex.minFilter       = THREE.LinearFilter;
            tex.magFilter       = THREE.LinearFilter;
            tex.generateMipmaps = false;
            tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;

            video.play().catch(() => { /* retried by _tickAnimatedSkins() */ });
            _activeVideoSkins.add(video);

            resolve({
                tex,
                width:  video.videoWidth  || 1,
                height: video.videoHeight || 1,
                cleanup: () => {
                    _activeVideoSkins.delete(video);
                    video.pause();
                    video.removeAttribute('src');
                    video.load();
                    video.remove();
                },
            });
        };

        const onError = () => {
            if (settled) return;
            settled = true;
            console.warn('[Multiplayer] Video skin failed to load:', url);
            video.remove();
            resolve(null);
        };

        video.addEventListener('loadeddata', onReady, { once: true });
        video.addEventListener('error', onError, { once: true });
        video.load();
    });
}

// Animated GIF/AVIF/WEBP skin via ImageDecoder, drawn frame-by-frame onto a
// canvas backing a THREE.CanvasTexture. Mirrors bsp_loader.js's
// loadAnimatedTex() but keeps its own independent state since multiplayer.js
// has no dependency on bsp_loader.js. Falls back to a plain static texture
// when ImageDecoder is unavailable or the file turns out to have only one
// frame (i.e. it isn't actually animated).
async function _loadAnimatedSkin(url) {
    if (typeof ImageDecoder === 'undefined') {
        console.warn('[Multiplayer] ImageDecoder not available, static fallback:', url);
        return _loadStaticSkin(url);
    }
    try {
        const res = await fetch(url, { mode: 'cors' });
        if (!res.ok) return null;
        const buffer = await res.arrayBuffer();

        const ext     = _extOf(url);
        const typeMap = { '.gif': 'image/gif', '.avif': 'image/avif', '.webp': 'image/webp' };
        const type    = typeMap[ext] ?? 'image/gif';

        const probeDecoder = new ImageDecoder({
            data: new Blob([buffer], { type }).stream(), type, preferAnimation: true,
        });
        await probeDecoder.tracks.ready;
        const frameCount = probeDecoder.tracks.selectedTrack?.frameCount ?? 1;
        probeDecoder.close();
        if (frameCount <= 1) return _loadStaticSkin(url);

        const decoder = new ImageDecoder({
            data: new Blob([buffer], { type }).stream(), type, preferAnimation: true,
        });
        await decoder.tracks.ready;

        const frames = [];
        let w = 0, h = 0;
        for (let i = 0; i < frameCount; i++) {
            const result   = await decoder.decode({ frameIndex: i });
            const img      = result.image;
            const duration = img.duration != null ? img.duration / 1000 : 100;
            if (i === 0) {
                w = img.displayWidth  || img.codedWidth  || 128;
                h = img.displayHeight || img.codedHeight || 128;
            }
            const bitmap = await createImageBitmap(img, { resizeWidth: w, resizeHeight: h });
            img.close();
            frames.push({ bitmap, duration });
        }
        decoder.close();
        if (!frames.length) return _loadStaticSkin(url);

        const canvas = document.createElement('canvas');
        canvas.width  = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(frames[0].bitmap, 0, 0, w, h);

        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace  = THREE.SRGBColorSpace;
        tex.needsUpdate = true;

        const animEntry = {
            frames, canvas, ctx, tex, frameIdx: 0,
            nextFrameTime: performance.now() + frames[0].duration,
        };
        _activeAnimSkins.add(animEntry);

        return {
            tex, width: w, height: h,
            cleanup: () => {
                _activeAnimSkins.delete(animEntry);
                for (const f of frames) f.bitmap.close();
            },
        };
    } catch (err) {
        console.warn('[Multiplayer] Animated skin load failed, static fallback:', url, err.message);
        return _loadStaticSkin(url);
    }
}

// Plain static-image skin loader — the original v1.2/v1.3 behaviour, also
// used as the fallback path for animated formats when ImageDecoder is
// unavailable or the file isn't actually animated. Resolves to `null`
// instead of rejecting on failure so callers never need a try/catch.
function _loadStaticSkin(url) {
    return new Promise(resolve => {
        _skinLoader.load(
            url,
            tex => {
                tex.colorSpace  = THREE.SRGBColorSpace;
                tex.needsUpdate = true;
                const img = tex.image;
                resolve({
                    tex,
                    width:  img?.width  || 1,
                    height: img?.height || 1,
                    cleanup: () => {},
                });
            },
            undefined,
            () => {
                console.warn('[Multiplayer] Skin image failed to load:', url);
                resolve(null);
            },
        );
    });
}

// Dispatches to the right loader based on the skin URL's file extension.
function _loadSkinAsset(url) {
    const ext = _extOf(url);
    if (SKIN_VIDEO_EXTS.has(ext)) return _loadVideoSkin(url);
    if (SKIN_ANIM_EXTS.has(ext))  return _loadAnimatedSkin(url);
    return _loadStaticSkin(url);
}

// Ticks all active animated-canvas skin textures forward and resumes any
// <video> skins the browser may have paused. Called once per frame from
// _lerpLoop() — no separate interval needed.
function _tickAnimatedSkins() {
    if (_activeAnimSkins.size) {
        const now = performance.now();
        for (const anim of _activeAnimSkins) {
            if (now < anim.nextFrameTime) continue;
            const frame = anim.frames[anim.frameIdx];
            anim.ctx.clearRect(0, 0, anim.canvas.width, anim.canvas.height);
            anim.ctx.drawImage(frame.bitmap, 0, 0, anim.canvas.width, anim.canvas.height);
            anim.tex.needsUpdate = true;
            anim.frameIdx      = (anim.frameIdx + 1) % anim.frames.length;
            anim.nextFrameTime = now + frame.duration;
        }
    }
    if (_activeVideoSkins.size) {
        for (const video of _activeVideoSkins) {
            if (video.paused && !video.ended) {
                video.play().catch(() => { /* still blocked — retried next tick */ });
            }
        }
    }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createMultiplayer(scene, {
    playersUrl = 'https://spelec.cz/chat/players.php',
    mapName    = null,        // null → auto-detect from window.location.pathname
    skinsUrl   = SKINS_URL,   // null/'' to disable custom skins entirely
} = {}) {

    // Resolve map key once at startup — the URL path never changes during gameplay.
    const _mapName = mapName ?? _autoMapName();
    console.log(`[Multiplayer] Map key: "${_mapName}"`);

    // Own identity — shared with chat page via localStorage
    let _uid  = localStorage.getItem('chat_user_id') || '';
    let _nick = localStorage.getItem('chat_nick')    || 'Anon';

    if (!_uid) {
        _uid = Array.from(crypto.getRandomValues(new Uint8Array(8)))
            .map(b => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem('chat_user_id', _uid);
    }

    // Own admin password, supplied at runtime via setAdminPass() — never
    // persisted to localStorage. Sent with every broadcast so the server
    // (chat/players.php) can set `is_admin` on our own player record when
    // it matches. Empty by default, which simply means "not the admin".
    let _adminPass = '';

    // nickname (lower-cased, trimmed) → image URL. Populated asynchronously;
    // starts empty so everyone renders as the default ball until (if) it loads.
    let _skinMap = new Map();

    // Resolves the skin URL for a player, given their nick and whether the
    // server confirmed admin status for that record. The reserved admin
    // name requires `isAdmin === true`; every other name in the skin list
    // just needs a matching nickname.
    function _resolveSkinUrl(nick, isAdmin) {
        const trimmed = (nick || '').trim();
        const skinUrl = _skinMap.get(trimmed.toLowerCase());
        if (!skinUrl) return null;
        if (trimmed === RESERVED_NAME && !isAdmin) return null;
        return skinUrl;
    }

    // uid → { uid, nick, isAdmin, group, bodySprite, bodyTex, skinUrl,
    //         skinCleanup, hue, labelTex, labelSprite, target:Vector3, destroyed }
    const _players = new Map();

    let _ivId   = null;
    let _rafId  = null;
    let _lastRf = performance.now();

    // ── Apply (or re-apply) a player's body appearance ────────────────────────
    // Handles the default procedural ball plus async-loaded custom skins
    // (static image, animated image, or video). Safe to call again later
    // (e.g. after a nick/admin-status change) — disposes the old texture and
    // runs its cleanup() first so GPU/DOM resources never leak.
    function _applyBodyAppearance(entry) {
        if (entry.bodyTex)     { entry.bodyTex.dispose(); entry.bodyTex = null; }
        if (entry.skinCleanup) { entry.skinCleanup(); entry.skinCleanup = null; }

        const skinUrl = entry.skinUrl;

        if (!skinUrl) {
            entry.bodyTex = _makeBodyTex(entry.hue);
            entry.bodySprite.scale.set(SPRITE_SIZE, SPRITE_SIZE, 1);
            entry.bodySprite.material.map = entry.bodyTex;
            entry.bodySprite.material.needsUpdate = true;
            return;
        }

        // Custom skin requested — clear the map while it loads so the player
        // doesn't briefly flash the old appearance, then swap in once ready.
        entry.bodySprite.material.map = null;
        entry.bodySprite.material.needsUpdate = true;

        _loadSkinAsset(skinUrl).then(asset => {
            // The player may have left, or their nick/admin status (and thus
            // skin) may have changed again while this request was in flight —
            // bail out if so, releasing whatever was just loaded.
            if (entry.destroyed || entry.skinUrl !== skinUrl) {
                if (asset) { asset.tex.dispose(); asset.cleanup(); }
                return;
            }

            if (!asset) {
                // Load failed (404, CORS, unsupported codec, etc.) — fall
                // back to the default ball.
                entry.skinUrl = null;
                _applyBodyAppearance(entry);
                return;
            }

            entry.bodyTex     = asset.tex;
            entry.skinCleanup = asset.cleanup;
            entry.bodySprite.material.map = asset.tex;
            entry.bodySprite.material.needsUpdate = true;

            // Preserve the source asset's aspect ratio instead of forcing a
            // square, scaled so the longer side matches SPRITE_SIZE * SKIN_SCALE.
            const w = asset.width, h = asset.height;
            const longSide = SPRITE_SIZE * SKIN_SCALE;
            if (w >= h) {
                entry.bodySprite.scale.set(longSide, longSide * (h / w), 1);
            } else {
                entry.bodySprite.scale.set(longSide * (w / h), longSide, 1);
            }
        });
    }

    // Re-checks every currently-spawned player against the skin map. Needed
    // because players can (and usually do) spawn before the skin list fetch
    // resolves — without this, anyone who joined early would be stuck with
    // the default ball even though their nick matches an entry.
    function _refreshAllSkins() {
        for (const entry of _players.values()) {
            const want = _resolveSkinUrl(entry.nick, entry.isAdmin);
            if (want !== entry.skinUrl) {
                entry.skinUrl = want;
                _applyBodyAppearance(entry);
            }
        }
    }

    _loadSkinMap(skinsUrl).then(map => {
        _skinMap = map;
        _refreshAllSkins();
    });

    // ── Combined broadcast + poll ─────────────────────────────────────────────
    async function _tick() {
        try {
            const cam = window._cam;
            if (!cam || !_uid) return;

            _nick = localStorage.getItem('chat_nick') || 'Anon';

            const ctrl = new AbortController();
            const tid  = setTimeout(() => ctrl.abort(), REQ_TIMEOUT);

            const res = await fetch(playersUrl, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    uid:        _uid,
                    nick:       _nick,
                    x:          cam.position.x,
                    y:          cam.position.y,
                    z:          cam.position.z,
                    map:        _mapName,
                    admin_pass: _adminPass,
                }),
                signal: ctrl.signal,
            });

            clearTimeout(tid);
            if (!res.ok) return;

            const data = await res.json();
            _syncPlayers(data.players ?? []);

        } catch {
            // Server unreachable — sprites hold last positions, engine unaffected
        }
    }

    // ── Update 3D sprites from server player list ─────────────────────────────
    function _syncPlayers(list) {
        const seen = new Set();

        for (const p of list) {
            if (p.uid === _uid) continue;
            seen.add(p.uid);

            const cur = _players.get(p.uid);
            if (cur) {
                cur.target.set(p.x, p.y, p.z);

                const nickChanged = cur.nick !== p.nick;
                if (nickChanged) {
                    cur.nick = p.nick;
                    cur.labelTex.dispose();
                    cur.labelTex = _makeLabelTex(p.nick, cur.hue);
                    cur.labelSprite.material.map = cur.labelTex;
                    cur.labelSprite.material.needsUpdate = true;
                }

                // Re-resolve the skin whenever the nick changes OR the
                // server's admin confirmation flips (e.g. the reserved name
                // typed the correct password without changing their nick).
                const newIsAdmin = !!p.is_admin;
                if (nickChanged || cur.isAdmin !== newIsAdmin) {
                    cur.isAdmin = newIsAdmin;
                    const newSkinUrl = _resolveSkinUrl(p.nick, newIsAdmin);
                    if (newSkinUrl !== cur.skinUrl) {
                        cur.skinUrl = newSkinUrl;
                        _applyBodyAppearance(cur);
                    }
                }
            } else {
                _players.set(p.uid, _spawnPlayer(p));
            }
        }

        // Remove players that left
        for (const [uid, p] of _players) {
            if (!seen.has(uid)) { _killPlayer(p); _players.delete(uid); }
        }
    }

    // ── Spawn a new player sprite group ──────────────────────────────────────
    function _spawnPlayer(data) {
        const hue = _idToHue(data.uid);

        const bodyMat    = new THREE.SpriteMaterial({ map: null, transparent: true, depthWrite: false });
        const bodySprite = new THREE.Sprite(bodyMat);
        bodySprite.scale.set(SPRITE_SIZE, SPRITE_SIZE, 1);
        bodySprite.position.set(0, BODY_Y, 0);
        bodySprite.userData.noclip = true;

        const labelTex  = _makeLabelTex(data.nick, hue);
        const labelMat  = new THREE.SpriteMaterial({ map: labelTex, transparent: true, depthWrite: false });
        const labelSprite = new THREE.Sprite(labelMat);
        labelSprite.scale.set(LABEL_W, LABEL_H, 1);
        labelSprite.position.set(0, LABEL_Y, 0);
        labelSprite.userData.noclip = true;

        const group = new THREE.Group();
        group.userData.noclip   = true;
        group.userData.isPlayer = true;
        group.position.set(data.x, data.y, data.z);
        group.add(bodySprite, labelSprite);
        scene.add(group);

        const entry = {
            uid: data.uid, nick: data.nick, isAdmin: !!data.is_admin, hue, group,
            bodySprite, bodyTex: null, skinUrl: null, skinCleanup: null,
            labelTex, labelSprite,
            target: new THREE.Vector3(data.x, data.y, data.z),
            destroyed: false,
        };

        entry.skinUrl = _resolveSkinUrl(data.nick, entry.isAdmin);
        _applyBodyAppearance(entry);

        return entry;
    }

    // ── Remove a player's sprites and free GPU/DOM resources ──────────────────
    function _killPlayer(p) {
        p.destroyed = true;
        p.group.removeFromParent();
        if (p.bodyTex)     p.bodyTex.dispose();
        if (p.skinCleanup) p.skinCleanup();
        p.labelTex.dispose();
        for (const child of p.group.children) {
            if (child.material) child.material.dispose();
        }
    }

    // ── RAF loop: smoothly lerp sprite positions + tick animated skins ────────
    function _lerpLoop() {
        const now   = performance.now();
        const dt    = Math.min((now - _lastRf) / 1000, 0.1);
        _lastRf     = now;
        const alpha = Math.min(1, LERP_SPEED * dt);

        for (const p of _players.values()) {
            p.group.position.lerp(p.target, alpha);
        }

        _tickAnimatedSkins();

        _rafId = requestAnimationFrame(_lerpLoop);
    }

    // ── Start ─────────────────────────────────────────────────────────────────
    _tick();
    _ivId  = setInterval(_tick, BROADCAST_MS);
    _rafId = requestAnimationFrame(_lerpLoop);

    // ── Public API ────────────────────────────────────────────────────────────
    return {
        /**
         * Returns the current player list (excluding self).
         * Used by chat_overlay.js to populate the teleport strip.
         */
        getPlayers() {
            return [..._players.values()].map(p => ({
                uid:  p.uid,
                nick: p.nick,
                x:    p.target.x,
                y:    p.target.y,
                z:    p.target.z,
            }));
        },

        /**
         * Supplies the admin password to include with our own position
         * broadcasts. Call this whenever the chat overlay's admin password
         * field changes (see Map Maker/index.html). Pass '' to clear it.
         */
        setAdminPass(pass) {
            _adminPass = pass || '';
        },

        destroy() {
            clearInterval(_ivId);
            cancelAnimationFrame(_rafId);
            for (const p of _players.values()) _killPlayer(p);
            _players.clear();
        },
    };
}