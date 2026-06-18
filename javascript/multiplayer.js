/**
 * SPELEC Multiplayer v1.1
 *
 * Renders other players as 3D billboard sprites in the scene.
 * Broadcasts own position to spelec.cz/chat/players.php and receives others every 150 ms.
 * Silently degrades when server is unreachable — the engine keeps running.
 *
 * Changes over v1.0:
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
    // Canvas is 512×56 px — wide enough for up to 128-char nicks.
    // Background is drawn ONLY around the text (tight fit), not the full canvas.
    // Returns { tex, aspectRatio } so the caller can size the sprite correctly.
    const W = 512, H = 56;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    // Auto-scale font so the full nick fits without truncation.
    // Starts at 23 px and steps down to 8 px (minimum readable in 3D).
    const maxW   = W - 24;
    let fontSize = 23;
    ctx.font = `bold ${fontSize}px "Share Tech Mono","Courier New",monospace`;
    while (ctx.measureText(nick).width > maxW && fontSize > 8) {
        fontSize--;
        ctx.font = `bold ${fontSize}px "Share Tech Mono","Courier New",monospace`;
    }

    // Measure actual text width and build a tight background rect.
    const pad  = 14;   // horizontal padding on each side
    const textW = Math.min(ctx.measureText(nick).width, W - 2 * pad);
    const bgW  = textW + pad * 2;
    const bgX  = (W - bgW) / 2;
    const r    = 8;

    // Rounded-rect background — exactly as wide/tall as the nick label.
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.beginPath();
    ctx.roundRect(bgX, 0, bgW, H, r);
    ctx.fill();

    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = `hsl(${hue},100%,72%)`;
    ctx.fillText(nick, W / 2, H / 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;

    // aspectRatio = (bgW / W) * (W / H) — the fraction of the canvas that is
    // occupied by the background, scaled to the correct world-space ratio.
    const aspectRatio = bgW / H;   // world width = LABEL_H * aspectRatio
    return { tex, aspectRatio };
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createMultiplayer(scene, {
    playersUrl = 'https://spelec.cz/chat/players.php',
    mapName    = null,   // null → auto-detect from window.location.pathname
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

    // uid → { uid, nick, group, bodyTex, labelTex, labelSprite, target:Vector3 }
    const _players = new Map();

    let _ivId   = null;
    let _rafId  = null;
    let _lastRf = performance.now();

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
                    const { tex: newTex, aspectRatio } = _makeLabelTex(p.nick, _idToHue(p.uid));
                    cur.labelTex = newTex;
                    cur.labelSprite.material.map = cur.labelTex;
                    cur.labelSprite.material.needsUpdate = true;
                    // Re-size sprite so background stays tight around the new nick.
                    cur.labelSprite.scale.set(LABEL_H * aspectRatio, LABEL_H, 1);
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
        const hue               = _idToHue(data.uid);
        const bodyTex           = _makeBodyTex(hue);
        const { tex: labelTex, aspectRatio } = _makeLabelTex(data.nick, hue);

        const bodyMat  = new THREE.SpriteMaterial({ map: bodyTex,  transparent: true, depthWrite: false });
        const labelMat = new THREE.SpriteMaterial({ map: labelTex, transparent: true, depthWrite: false });

        const bodySprite = new THREE.Sprite(bodyMat);
        bodySprite.scale.set(SPRITE_SIZE, SPRITE_SIZE, 1);
        bodySprite.position.set(0, BODY_Y, 0);
        bodySprite.userData.noclip = true;

        const labelSprite = new THREE.Sprite(labelMat);
        // Width = LABEL_H × aspectRatio so the background tightly wraps the nick.
        labelSprite.scale.set(LABEL_H * aspectRatio, LABEL_H, 1);
        labelSprite.position.set(0, LABEL_Y, 0);
        labelSprite.userData.noclip = true;

        const group = new THREE.Group();
        group.userData.noclip   = true;
        group.userData.isPlayer = true;
        group.position.set(data.x, data.y, data.z);
        group.add(bodySprite, labelSprite);
        scene.add(group);

        return { uid: data.uid, nick: data.nick, group, bodyTex, labelTex, labelSprite,
                 target: new THREE.Vector3(data.x, data.y, data.z) };
    }

    // ── Remove a player's sprites and free GPU resources ──────────────────────
    function _killPlayer(p) {
        p.group.removeFromParent();
        p.bodyTex.dispose();
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