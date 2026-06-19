/**
 * SPELEC Multiplayer v1.2
 *
 * Renders other players as 3D billboard sprites in the scene.
 * Broadcasts own position to spelec.cz/chat/players.php and receives others every 150 ms.
 * Silently degrades when server is unreachable — the engine keeps running.
 *
 * Changes over v1.1:
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

// Loads a single skin image as a THREE.Texture. Resolves to `null` instead
// of rejecting on failure so callers can fall back to the default ball
// without needing a try/catch around every call site.
function _loadSkinTexture(url) {
    return new Promise(resolve => {
        _skinLoader.load(
            url,
            tex => {
                tex.colorSpace = THREE.SRGBColorSpace;
                tex.needsUpdate = true;
                resolve(tex);
            },
            undefined,
            () => {
                console.warn('[Multiplayer] Skin image failed to load:', url);
                resolve(null);
            },
        );
    });
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

    // nickname (lower-cased, trimmed) → image URL. Populated asynchronously;
    // starts empty so everyone renders as the default ball until (if) it loads.
    let _skinMap = new Map();

    function _resolveSkinUrl(nick) {
        return _skinMap.get((nick || '').trim().toLowerCase()) || null;
    }

    // uid → { uid, nick, group, bodySprite, bodyTex, skinUrl, hue,
    //         labelTex, labelSprite, target:Vector3, destroyed }
    const _players = new Map();

    let _ivId   = null;
    let _rafId  = null;
    let _lastRf = performance.now();

    // ── Apply (or re-apply) a player's body appearance ────────────────────────
    // Handles both the default procedural ball and async-loaded custom skins.
    // Safe to call again later (e.g. after a nick change) — disposes the old
    // body texture first so GPU memory doesn't leak.
    function _applyBodyAppearance(entry) {
        if (entry.bodyTex) { entry.bodyTex.dispose(); entry.bodyTex = null; }

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

        _loadSkinTexture(skinUrl).then(tex => {
            // The player may have left, or their nick (and thus skin) may have
            // changed again while this request was in flight — bail out if so.
            if (entry.destroyed || entry.skinUrl !== skinUrl) {
                if (tex) tex.dispose();
                return;
            }

            if (!tex) {
                // Load failed (404, CORS, etc.) — fall back to the default ball.
                entry.skinUrl = null;
                _applyBodyAppearance(entry);
                return;
            }

            entry.bodyTex = tex;
            entry.bodySprite.material.map = tex;
            entry.bodySprite.material.needsUpdate = true;

            // Preserve the source image's aspect ratio instead of forcing a
            // square, scaled so the longer side matches SPRITE_SIZE * SKIN_SCALE.
            const img      = tex.image;
            const w        = img?.width  || 1;
            const h        = img?.height || 1;
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
            const want = _resolveSkinUrl(entry.nick);
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
                    uid:  _uid,
                    nick: _nick,
                    x:    cam.position.x,
                    y:    cam.position.y,
                    z:    cam.position.z,
                    map:  _mapName,
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
                if (cur.nick !== p.nick) {
                    cur.nick = p.nick;
                    cur.labelTex.dispose();
                    cur.labelTex = _makeLabelTex(p.nick, cur.hue);
                    cur.labelSprite.material.map = cur.labelTex;
                    cur.labelSprite.material.needsUpdate = true;

                    // Nick changed — re-resolve the skin too, since the whole
                    // point of this feature is "rename to swap appearance".
                    const newSkinUrl = _resolveSkinUrl(p.nick);
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
            uid: data.uid, nick: data.nick, hue, group,
            bodySprite, bodyTex: null, skinUrl: null,
            labelTex, labelSprite,
            target: new THREE.Vector3(data.x, data.y, data.z),
            destroyed: false,
        };

        entry.skinUrl = _resolveSkinUrl(data.nick);
        _applyBodyAppearance(entry);

        return entry;
    }

    // ── Remove a player's sprites and free GPU resources ──────────────────────
    function _killPlayer(p) {
        p.destroyed = true;
        p.group.removeFromParent();
        if (p.bodyTex) p.bodyTex.dispose();
        p.labelTex.dispose();
        for (const child of p.group.children) {
            if (child.material) child.material.dispose();
        }
    }

    // ── RAF loop: smoothly lerp sprite positions ──────────────────────────────
    function _lerpLoop() {
        const now   = performance.now();
        const dt    = Math.min((now - _lastRf) / 1000, 0.1);
        _lastRf     = now;
        const alpha = Math.min(1, LERP_SPEED * dt);

        for (const p of _players.values()) {
            p.group.position.lerp(p.target, alpha);
        }

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

        destroy() {
            clearInterval(_ivId);
            cancelAnimationFrame(_rafId);
            for (const p of _players.values()) _killPlayer(p);
            _players.clear();
        },
    };
}
