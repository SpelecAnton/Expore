/**
 * SPELEC Chat Overlay v1.1
 *
 * Embeds the spelec.cz/chat/ global chatroom as a corner widget over the 3D engine.
 *
 * Changes over v1.0:
 *
 * 1. TICKER ALWAYS SHOWS LAST 5 MESSAGES (no age cutoff):
 *    v1.0 filtered ticker messages to those from the last 60 seconds — if there
 *    were no recent messages, the ticker appeared empty and the user saw no sign
 *    of chat activity until they opened the panel. The cutoff is now removed;
 *    the ticker always shows the 5 most recent messages regardless of how old
 *    they are.
 *
 * 2. UNREAD BADGE: FIRST LOAD EXCLUDED:
 *    v1.0 counted messages from the initial page-load poll as unread, so the
 *    badge immediately showed "9+" on every page visit. Now only messages that
 *    arrive AFTER the first poll are counted as unread.
 *
 * 3. TICKER REFRESHED AFTER EVERY POLL:
 *    v1.0 only called _refreshTicker() when new messages arrived; the periodic
 *    setInterval (8 s) was the only guarantee otherwise. _refreshTicker() is now
 *    called unconditionally at the end of every poll cycle so the ticker is
 *    always in sync.
 *
 * 4. NICK INPUT MAXLENGTH: 32 → 128:
 *    Matches the 128-char server-side limit in players.php and api.php.
 *
 * DEFAULT STATE — Ticker:
 *   Small non-interactive strip above the [CHAT] button.
 *   Always shows the 5 most recent messages.
 *
 * FULL PANEL — opened by [Tab] or clicking [CHAT]:
 *   Full history with "load older" + player teleport strip (if multiplayer active).
 *   WASD / Space / arrows are captured so the engine ignores typing.
 *
 * Usage:
 *   import { createChatOverlay } from './chat_overlay.js';
 *   createChatOverlay({
 *     apiUrl:     'https://spelec.cz/chat/api.php',
 *     onlineUrl:  'https://spelec.cz/chat/online.php',
 *     getPlayers: () => multiplayer.getPlayers(),    // optional
 *     onTeleport: (x, y, z) => physics.teleport(...) // optional
 *   });
 */

'use strict';

const RESERVED   = 'Anton Špelec';
const POLL_BASE  = 3000;
const POLL_MAX   = 15000;
const PING_IV    = 5000;
const TICKER_IV  = 5000;   // fallback ticker refresh interval (ms); primary is per-poll
const MSG_CAP    = 300;    // max messages kept in memory

// ── Pure helpers ──────────────────────────────────────────────────────────────

function _idToHue(shortId) {
    let h = 0;
    for (let i = 0; i < shortId.length; i++) h = shortId.charCodeAt(i) + ((h << 5) - h);
    return ((h % 360) + 360) % 360;
}

function _linkify(text) {
    return text.replace(/(https?:\/\/[^\s<>"']+)/g, url =>
        `<a href="${url.replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer">${url}</a>`
    );
}

function _fmtTime(ts) {
    const d  = new Date(ts * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    return `${hh}:${mm} ${dd}.${mo}`;
}

function _sanitizeUrl(url) {
    if (!url) return '';
    try {
        if ((url.startsWith('chat_uploads/') || url.startsWith('/chat/chat_uploads/'))
            && !url.includes('..')) return url;
        const p = new URL(url, window.location.origin);
        return (p.protocol === 'https:' || p.protocol === 'http:') ? p.href : '';
    } catch { return ''; }
}

function _el(tag, attrs = {}) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') e.className = v; else e.setAttribute(k, v);
    }
    return e;
}

function _abortFor(ms) {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createChatOverlay({
    apiUrl      = 'https://spelec.cz/chat/api.php',
    onlineUrl   = 'https://spelec.cz/chat/online.php',
    getPlayers  = null,   // () => [{uid,nick,x,y,z}]
    onTeleport  = null,   // (x,y,z) => void
} = {}) {

    // ── Identity ──────────────────────────────────────────────────────────────
    let _uid = localStorage.getItem('chat_user_id') || '';
    if (!_uid) {
        _uid = Array.from(crypto.getRandomValues(new Uint8Array(8)))
            .map(b => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem('chat_user_id', _uid);
    }

    // ── State ─────────────────────────────────────────────────────────────────
    let _isOpen       = true;    // panel is open by default on page load
    let _allMsgs      = [];       // chronological, newest last
    const _seen       = new Set();
    let _lastTs       = 0;
    let _hasMoreOlder = false;
    let _oldestTs     = 0;
    let _firstLoad    = true;
    let _firstLoadDone = false;
    let _unread       = 0;
    let _pollTo       = null;
    let _polling      = false;
    let _pingIv       = null;
    let _tickerIv     = null;
    let _plyrIv       = null;
    let _loadingOlder = false;
    let _pollMs       = POLL_BASE;
    let _atBottom     = true;

    // ── Inject styles ─────────────────────────────────────────────────────────
    _injectStyles();

    // ── Build DOM ─────────────────────────────────────────────────────────────
    const _wrap = _el('div', { id: 'co-wrap' });

    // Ticker
    const _ticker = _el('div', { id: 'co-ticker' });

    // Toggle button
    const _toggleBtn = _el('button', { id: 'co-toggle', type: 'button', title: 'Chat [Tab]' });
    _toggleBtn.textContent = 'CHAT';
    const _badge = _el('span', { id: 'co-badge' });
    _badge.hidden = true;
    _toggleBtn.appendChild(_badge);

    // Panel
    const _panel = _el('div', { id: 'co-panel' });
    // Panel starts visible — matches Consul chat behaviour where chat is always shown.

    //   Header
    const _header   = _el('div', { id: 'co-header' });
    const _titleEl  = _el('span', { id: 'co-title'  }); _titleEl.textContent  = 'GLOBAL CHAT';
    const _onlineEl = _el('span', { id: 'co-online' }); _onlineEl.textContent = '● 0';
    const _closeBtn = _el('button', { id: 'co-close', type: 'button', title: 'Zavřít' });
    _closeBtn.textContent = '×';
    _header.append(_titleEl, _onlineEl, _closeBtn);

    //   Player strip — only built when getPlayers callback is provided
    let _plyrStrip = null;
    let _plyrSect  = null;
    if (typeof getPlayers === 'function') {
        _plyrSect        = _el('div', { id: 'co-players' });
        const _plyrHdr   = _el('div', { class: 'co-plyr-hdr' });
        _plyrHdr.textContent = 'HRÁČI NA MAPĚ';
        _plyrStrip       = _el('div', { id: 'co-plyr-strip' });
        _plyrSect.append(_plyrHdr, _plyrStrip);
    }

    //   Load-older banner
    const _lmBanner = _el('div', { id: 'co-lm-banner' });
    _lmBanner.textContent = '▲ načíst starší zprávy';
    _lmBanner.hidden = true;

    //   Messages
    const _msgDiv = _el('div', { id: 'co-messages' });

    //   Footer
    const _footer      = _el('div', { id: 'co-footer' });
    const _nickRow     = _el('div', { id: 'co-nick-row' });
    const _nickInput   = _el('input', { id: 'co-nick',      class: 'co-input',
                                maxlength: '128', placeholder: 'Nick',       autocomplete: 'off', spellcheck: 'false' });
    const _adminInput  = _el('input', { id: 'co-adminpass', class: 'co-input',
                                type: 'password', maxlength: '64', placeholder: 'Admin pass' });
    _adminInput.hidden = true;
    _nickRow.append(_nickInput, _adminInput);

    const _inputRow = _el('div', { id: 'co-input-row' });
    const _msgInput = _el('input', { id: 'co-msg-input', class: 'co-input',
                            maxlength: '2000', placeholder: 'Zpráva…', autocomplete: 'off' });
    const _sendBtn  = _el('button', { id: 'co-send', type: 'button' });
    _sendBtn.textContent = '→';
    _inputRow.append(_msgInput, _sendBtn);

    const _statusEl = _el('div', { id: 'co-status' });
    _footer.append(_nickRow, _inputRow, _statusEl);

    // Assemble panel
    _panel.append(_header);
    if (_plyrSect) _panel.appendChild(_plyrSect);
    _panel.append(_lmBanner, _msgDiv, _footer);

    // Assemble root
    _wrap.append(_ticker, _toggleBtn, _panel);
    document.body.appendChild(_wrap);

    // ── Restore saved nick ────────────────────────────────────────────────────
    _nickInput.value = localStorage.getItem('chat_nick') || '';
    if (_nickInput.value.trim() === RESERVED) _adminInput.hidden = false;

    // ── Events ────────────────────────────────────────────────────────────────

    _nickInput.addEventListener('input', () => {
        const v = _nickInput.value.trim();
        localStorage.setItem('chat_nick', v);
        _adminInput.hidden = (v !== RESERVED);
    });

    _toggleBtn.addEventListener('click', () => _setOpen(!_isOpen));
    _closeBtn.addEventListener('click',  () => _setOpen(false));
    _sendBtn.addEventListener('click', _send);
    _lmBanner.addEventListener('click', _loadOlder);

    // Prevent engine from receiving WASD / Space while user types in any input
    const _stopKey = e => e.stopPropagation();
    for (const inp of [_nickInput, _adminInput, _msgInput]) {
        inp.addEventListener('keydown', _stopKey);
        inp.addEventListener('keyup',   _stopKey);
    }
    _msgInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _send(); }
    });

    // Tab key toggles panel — capture phase fires before engine's bubble-phase listeners
    const _tabH = e => {
        if (e.key === 'Tab') {
            e.preventDefault();
            e.stopImmediatePropagation();
            _setOpen(!_isOpen);
        }
    };
    window.addEventListener('keydown', _tabH, { capture: true });

    // Scroll: track bottom + trigger load-older at top
    _msgDiv.addEventListener('scroll', () => {
        _atBottom = _msgDiv.scrollHeight - _msgDiv.scrollTop - _msgDiv.clientHeight < 40;
        if (_msgDiv.scrollTop === 0 && _hasMoreOlder && !_loadingOlder) _loadOlder();
    });

    // ── Start polling and pinging ─────────────────────────────────────────────
    _poll();
    _pingIv   = setInterval(_pingOnline, PING_IV);
    _tickerIv = setInterval(_refreshTicker, TICKER_IV);
    _pingOnline();

    // ── Core functions ────────────────────────────────────────────────────────

    function _setOpen(open) {
        _isOpen = open;
        _panel.hidden  = !open;
        _ticker.hidden = open;

        if (open) {
            _unread       = 0;
            _badge.hidden = true;

            // Populate panel from in-memory cache (messages already loaded)
            _msgDiv.innerHTML = '';
            for (const msg of _allMsgs) _msgDiv.appendChild(_renderMsg(msg));
            _lmBanner.hidden = !_hasMoreOlder;
            _atBottom = true;

            requestAnimationFrame(() => { _msgDiv.scrollTop = _msgDiv.scrollHeight; });

            _updatePlayerStrip();
            if (_plyrStrip) _plyrIv = setInterval(_updatePlayerStrip, 1000);

            _msgInput.focus();
        } else {
            clearInterval(_plyrIv);
            _plyrIv = null;
        }
    }

    // Called once at startup to set up the open panel's player strip interval
    function _initOpenPanel() {
        _updatePlayerStrip();
        if (_plyrStrip) _plyrIv = setInterval(_updatePlayerStrip, 1000);
    }

    // ── Polling ───────────────────────────────────────────────────────────────

    async function _poll() {
        if (_polling) return;   // never run two polls concurrently
        _polling = true;
        try {
            const res = await fetch(`${apiUrl}?action=get&since=${_lastTs}`, {
                signal: _abortFor(5000),
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();

            if (data.messages?.length) {
                if (_firstLoad) {
                    _firstLoad    = false;
                    _hasMoreOlder = data.has_more ?? false;
                    _oldestTs     = data.messages[0].timestamp;
                }

                const newMsgs = [];
                for (const msg of data.messages) {
                    if (_seen.has(msg.id)) continue;
                    _seen.add(msg.id);
                    _allMsgs.push(msg);
                    if (msg.timestamp > _lastTs) _lastTs = msg.timestamp;
                    newMsgs.push(msg);

                    // Only count as unread if the first load is already done;
                    // messages present on page load are not "new" to the user.
                    if (!_isOpen && _firstLoadDone) {
                        _unread++;
                        _badge.textContent = _unread > 9 ? '9+' : String(_unread);
                        _badge.hidden      = false;
                    }
                }

                // Cap in-memory store
                if (_allMsgs.length > MSG_CAP) _allMsgs = _allMsgs.slice(-MSG_CAP);

                if (_isOpen && newMsgs.length) {
                    // Rebuild the full message list so the panel is always
                    // correct — works for both auto-open and subsequent polls.
                    const wasAtBottom = _atBottom;
                    _msgDiv.innerHTML = '';
                    for (const msg of _allMsgs) _msgDiv.appendChild(_renderMsg(msg));
                    _lmBanner.hidden = !_hasMoreOlder;
                    if (wasAtBottom) {
                        requestAnimationFrame(() => { _msgDiv.scrollTop = _msgDiv.scrollHeight; });
                    }
                }

            } else if (_firstLoad) {
                _firstLoad = false;
            }

            // Mark first load complete AFTER processing (so subsequent polls count as unread)
            _firstLoadDone = true;

            _pollMs = POLL_BASE;
        } catch {
            _pollMs = Math.min(_pollMs * 1.5, POLL_MAX);
        } finally {
            _polling = false;
            // Always refresh ticker after each poll — keeps it in sync even when
            // no new messages arrived and the periodic setInterval hasn't fired yet.
            _refreshTicker();
            _pollTo = setTimeout(_poll, _pollMs);
        }
    }

    // ── Send message ──────────────────────────────────────────────────────────

    async function _send() {
        const text = _msgInput.value.trim();
        if (!text) return;

        const nick      = _nickInput.value.trim() || 'Anon';
        const adminPass = _adminInput.value;

        _sendBtn.disabled    = true;
        _statusEl.textContent = '';

        try {
            const res = await fetch(`${apiUrl}?action=send`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ user_id: _uid, nickname: nick, text, admin_pass: adminPass }),
                signal:  _abortFor(6000),
            });
            const data = await res.json();
            if (!res.ok) { _statusEl.textContent = data.error || 'Chyba odesílání'; return; }

            _msgInput.value = '';
            _atBottom = true;

            if (data.message && !_seen.has(data.message.id)) {
                _seen.add(data.message.id);
                _allMsgs.push(data.message);
                if (data.message.timestamp > _lastTs) _lastTs = data.message.timestamp;

                if (_isOpen) {
                    _msgDiv.appendChild(_renderMsg(data.message));
                    _msgDiv.scrollTop = _msgDiv.scrollHeight;
                }
            }
        } catch {
            _statusEl.textContent = 'Chyba sítě';
        } finally {
            _sendBtn.disabled = false;
            _msgInput.focus();
        }
    }

    // ── Online ping ───────────────────────────────────────────────────────────

    async function _pingOnline() {
        try {
            const res  = await fetch(onlineUrl, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ uid: _uid }),
                signal:  _abortFor(3000),
            });
            const data = await res.json();
            if (data.online !== undefined) _onlineEl.textContent = `● ${data.online}`;
        } catch {}
    }

    // ── Load older messages ───────────────────────────────────────────────────

    async function _loadOlder() {
        if (!_hasMoreOlder || !_oldestTs || _loadingOlder) return;
        _loadingOlder = true;
        _lmBanner.textContent = '⏳ načítám...';

        try {
            const res  = await fetch(`${apiUrl}?action=get&before=${_oldestTs}`, {
                signal: _abortFor(7000),
            });
            if (!res.ok) throw new Error();
            const data = await res.json();

            if (data.messages?.length) {
                const prevH   = _msgDiv.scrollHeight;
                const newMsgs = data.messages.filter(m => !_seen.has(m.id));
                for (const m of newMsgs) _seen.add(m.id);

                _allMsgs  = [...newMsgs, ..._allMsgs];
                if (newMsgs.length) _oldestTs = data.messages[0].timestamp;

                // Prepend to panel and hold scroll position
                if (newMsgs.length) {
                    const frag = document.createDocumentFragment();
                    for (const msg of newMsgs) frag.appendChild(_renderMsg(msg));
                    _msgDiv.insertBefore(frag, _msgDiv.firstChild);
                    _msgDiv.scrollTop += _msgDiv.scrollHeight - prevH;
                }
            }

            _hasMoreOlder       = data.has_more ?? false;
            _lmBanner.hidden    = !_hasMoreOlder;
            if (_hasMoreOlder) _lmBanner.textContent = '▲ načíst starší zprávy';

        } catch {
            _lmBanner.textContent = '▲ načíst starší zprávy (chyba, zkus znovu)';
        } finally {
            _loadingOlder = false;
        }
    }

    // ── Ticker ────────────────────────────────────────────────────────────────
    // Always shows the 5 most recent messages — no age cutoff.
    // Called after every poll and every TICKER_IV ms as fallback.

    function _refreshTicker() {
        if (_isOpen) return;   // ticker is hidden while panel is open

        // Show last 5 messages regardless of age — empty ticker was confusing
        // because it appeared as if no messages existed before the panel opened.
        const recent = _allMsgs.slice(-5);

        _ticker.innerHTML = '';
        for (const msg of recent) {
            const div   = _el('div', { class: 'co-tick' });
            const hue   = _idToHue(msg.short_id);
            const color = msg.is_admin ? '#ff9900' : `hsl(${hue},100%,65%)`;

            const nick = _el('span', { class: 'co-tick-nick' });
            nick.style.color  = color;
            nick.textContent  = msg.nickname + ':';

            const body = _el('span', { class: 'co-tick-text' });
            if (msg.text) {
                const tmp = document.createElement('span');
                tmp.innerHTML    = msg.text;
                body.textContent = tmp.textContent.slice(0, 90);
            } else if (msg.image_url) {
                body.textContent  = '[příloha]';
                body.style.opacity = '0.5';
            }

            div.append(nick, ' ', body);
            _ticker.appendChild(div);
        }
    }

    // ── Player teleport strip ─────────────────────────────────────────────────

    function _updatePlayerStrip() {
        if (!_plyrStrip || typeof getPlayers !== 'function') return;
        const players = getPlayers();
        _plyrStrip.innerHTML = '';

        if (!players.length) {
            const e = _el('span', { class: 'co-plyr-empty' });
            e.textContent = 'Jsi tu sám.';
            _plyrStrip.appendChild(e);
            return;
        }

        for (const p of players) {
            const hue  = _idToHue(p.uid);
            const col  = `hsl(${hue},100%,65%)`;
            const btn  = _el('button', { class: 'co-plyr-btn' });
            btn.style.color = col;
            btn.title       = `Teleportovat k ${p.nick}`;

            const dot  = document.createElement('span');  dot.textContent = '● ';
            const name = document.createElement('span');  name.textContent = p.nick;
            const tele = document.createElement('span');  tele.textContent = ' ↗';
            tele.style.opacity = '0.55';

            btn.append(dot, name, tele);
            btn.addEventListener('click', () => {
                if (typeof onTeleport === 'function') onTeleport(p.x, p.y, p.z);
                _setOpen(false);
            });
            _plyrStrip.appendChild(btn);
        }
    }

    // ── Render a single message element ──────────────────────────────────────

    function _renderMsg(msg) {
        const div = _el('div', { class: 'co-msg' + (msg.is_admin ? ' co-admin' : '') });
        div.dataset.id = msg.id;

        const hue   = _idToHue(msg.short_id);
        const color = msg.is_admin ? '#ff9900' : `hsl(${hue},100%,65%)`;

        const hdr     = _el('div', { class: 'co-msg-header' });
        const nickEl  = _el('span', { class: 'co-nick' });
        nickEl.style.color = color;
        nickEl.textContent = msg.nickname;

        const sidEl   = _el('span', { class: 'co-sid' });
        sidEl.textContent = '#' + msg.short_id;

        const timeEl  = _el('span', { class: 'co-time' });
        timeEl.textContent = _fmtTime(msg.timestamp);

        hdr.append(nickEl, sidEl, timeEl);
        div.appendChild(hdr);

        if (msg.text) {
            const textEl = _el('div', { class: 'co-text' });
            textEl.innerHTML = _linkify(msg.text);
            div.appendChild(textEl);
        }

        if (msg.image_url) {
            const safe  = _sanitizeUrl(msg.image_url);
            const lower = safe.toLowerCase();
            if (safe) {
                let med;
                if (/\.(mp4|webm|ogv)$/i.test(lower)) {
                    med = _el('video'); med.controls = true; med.preload = 'metadata';
                } else if (/\.(mp3|wav|ogg|aac)$/i.test(lower)) {
                    med = _el('audio'); med.controls = true;
                } else {
                    med = _el('img'); med.alt = ''; med.loading = 'lazy';
                    med.style.cursor = 'pointer';
                    med.addEventListener('click', () => window.open(safe, '_blank'));
                }
                med.src       = safe;
                med.className = 'co-media';
                div.appendChild(med);
            }
        }

        return div;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    function destroy() {
        clearTimeout(_pollTo);
        clearInterval(_pingIv);
        clearInterval(_tickerIv);
        clearInterval(_plyrIv);
        window.removeEventListener('keydown', _tabH, { capture: true });
        _wrap.remove();
    }

    return { destroy, open: () => _setOpen(true), close: () => _setOpen(false) };
}

// ── Style injection ───────────────────────────────────────────────────────────

function _injectStyles() {
    if (document.getElementById('co-styles')) return;

    if (!document.querySelector('link[href*="Share+Tech+Mono"]')) {
        const lnk = document.createElement('link');
        lnk.rel   = 'stylesheet';
        lnk.href  = 'https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap';
        document.head.appendChild(lnk);
    }

    const s = document.createElement('style');
    s.id    = 'co-styles';
    s.textContent = _CSS;
    document.head.appendChild(s);
}

const _CSS = `
#co-wrap {
  position: fixed;
  bottom: 20px;
  right: 20px;
  width: 48px;
  height: 48px;
  z-index: 9999;
  font-family: 'Share Tech Mono', 'Courier New', monospace;
  user-select: text;
  -webkit-user-select: text;
}

/* ── Ticker ──────────────────────────────────────── */
#co-ticker {
  position: absolute;
  bottom: 60px;
  right: 0;
  width: 272px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  pointer-events: none;
}
.co-tick {
  padding: 4px 8px;
  background: rgba(0,0,0,0.62);
  backdrop-filter: blur(5px);
  -webkit-backdrop-filter: blur(5px);
  border-radius: 4px;
  border-left: 2px solid rgba(255,34,0,0.28);
  font-size: 11px;
  line-height: 1.45;
  word-break: break-word;
  color: rgba(255,255,255,0.82);
}
.co-tick-nick { font-weight: bold; margin-right: 3px; }

/* ── Toggle button ───────────────────────────────── */
#co-toggle {
  position: relative;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: rgba(0,0,0,0.82);
  border: 1px solid rgba(255,34,0,0.45);
  color: rgba(255,34,0,0.85);
  cursor: pointer;
  font-family: inherit;
  font-size: 9px;
  letter-spacing: 0.10em;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.18s, background 0.18s;
}
#co-toggle:hover {
  border-color: rgba(255,34,0,0.80);
  background: rgba(16,0,0,0.92);
}
#co-badge {
  position: absolute;
  top: -5px; right: -5px;
  min-width: 18px; height: 18px;
  border-radius: 9px;
  background: #ff2200;
  color: #fff;
  font-size: 10px;
  padding: 0 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  box-shadow: 0 0 6px rgba(255,34,0,0.65);
  animation: co-badge-pop 0.25s ease;
}
@keyframes co-badge-pop {
  0%   { transform: scale(0.5); opacity: 0; }
  70%  { transform: scale(1.2); }
  100% { transform: scale(1);   opacity: 1; }
}

/* ── Panel ───────────────────────────────────────── */
#co-panel {
  position: absolute;
  bottom: 60px;
  right: 0;
  width: 300px;
  height: 420px;
  background: rgba(3,0,0,0.93);
  border: 1px solid rgba(255,34,0,0.18);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 8px 32px rgba(0,0,0,0.72);
}

/* ── Header ──────────────────────────────────────── */
#co-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid rgba(255,34,0,0.10);
  flex-shrink: 0;
}
#co-title  { flex:1; color:rgba(255,34,0,0.85); font-size:9px; letter-spacing:0.20em; }
#co-online { color:rgba(255,255,255,0.28); font-size:9px; white-space:nowrap; }
#co-close  {
  background:none; border:none;
  color:rgba(255,255,255,0.28);
  cursor:pointer; font-size:16px; line-height:1; padding:0;
  transition:color 0.15s; font-family:inherit;
}
#co-close:hover { color:rgba(255,255,255,0.70); }

/* ── Player strip ────────────────────────────────── */
#co-players {
  flex-shrink: 0;
  padding: 5px 8px;
  border-bottom: 1px solid rgba(255,34,0,0.08);
}
.co-plyr-hdr  { font-size:8px; letter-spacing:0.15em; color:rgba(255,255,255,0.22); margin-bottom:4px; }
#co-plyr-strip { display:flex; flex-wrap:wrap; gap:4px; }
.co-plyr-btn  {
  background:rgba(255,255,255,0.04);
  border:1px solid rgba(255,255,255,0.10);
  border-radius:12px;
  cursor:pointer;
  font-family:inherit;
  font-size:10px;
  padding:3px 8px;
  display:flex; align-items:center; gap:3px;
  transition:background 0.15s, border-color 0.15s;
}
.co-plyr-btn:hover { background:rgba(255,255,255,0.09); border-color:rgba(255,255,255,0.25); }
.co-plyr-empty { color:rgba(255,255,255,0.20); font-size:10px; }

/* ── Load-older banner ───────────────────────────── */
#co-lm-banner {
  flex-shrink: 0;
  text-align: center;
  padding: 5px 0;
  font-size: 10px;
  color: rgba(255,255,255,0.32);
  cursor: pointer;
  border-bottom: 1px solid rgba(255,34,0,0.07);
  transition: color 0.18s;
}
#co-lm-banner:hover { color:rgba(255,100,100,0.85); }

/* ── Messages ────────────────────────────────────── */
#co-messages {
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px;
}
#co-messages::-webkit-scrollbar { width:3px; }
#co-messages::-webkit-scrollbar-track { background:transparent; }
#co-messages::-webkit-scrollbar-thumb { background:rgba(255,34,0,0.20); border-radius:2px; }

.co-msg {
  margin-bottom: 6px;
  padding: 5px 7px;
  background: rgba(255,255,255,0.025);
  border-left: 2px solid rgba(255,255,255,0.07);
  border-radius: 3px;
  word-break: break-word;
}
.co-msg.co-admin { border-left-color:rgba(255,153,0,0.40); background:rgba(255,120,0,0.04); }

.co-msg-header {
  display: flex;
  align-items: baseline;
  gap: 4px;
  margin-bottom: 2px;
  overflow: hidden;
}
.co-nick { font-size:11px; font-weight:bold; flex-shrink:0; }
.co-sid  { color:rgba(255,255,255,0.18); font-size:9px; flex-shrink:0; }
.co-time { color:rgba(255,255,255,0.15); font-size:9px; margin-left:auto; white-space:nowrap; flex-shrink:0; }

.co-text { color:rgba(255,255,255,0.78); font-size:11px; line-height:1.55; }
.co-text a { color:rgba(255,90,40,0.85); text-decoration:none; }
.co-text a:hover { text-decoration:underline; }

.co-media { display:block; max-width:100%; max-height:90px; margin-top:4px; border-radius:3px; object-fit:contain; }
.co-empty { color:rgba(255,255,255,0.22); text-align:center; padding:20px 8px; font-size:11px; }

/* ── Footer ──────────────────────────────────────── */
#co-footer {
  flex-shrink: 0;
  padding: 7px 8px;
  border-top: 1px solid rgba(255,34,0,0.08);
  display: flex;
  flex-direction: column;
  gap: 5px;
}
#co-nick-row  { display:flex; gap:5px; }
#co-input-row { display:flex; gap:5px; }
#co-nick      { flex:1; }
#co-adminpass { flex:1; }
#co-msg-input { flex:1; }

.co-input {
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 4px;
  color: rgba(255,255,255,0.82);
  font-family: inherit;
  font-size: 11px;
  padding: 5px 7px;
  outline: none;
  transition: border-color 0.18s;
  box-sizing: border-box;
  width: 100%;
}
.co-input:focus       { border-color:rgba(255,34,0,0.35); }
.co-input::placeholder { color:rgba(255,255,255,0.18); }

#co-send {
  flex-shrink: 0;
  background: rgba(255,34,0,0.10);
  border: 1px solid rgba(255,34,0,0.22);
  border-radius: 4px;
  color: rgba(255,34,0,0.80);
  cursor: pointer;
  font-family: inherit;
  font-size: 14px;
  padding: 4px 10px;
  transition: background 0.18s;
}
#co-send:hover    { background:rgba(255,34,0,0.26); }
#co-send:disabled { opacity:0.40; cursor:default; }

#co-status { color:rgba(255,100,0,0.75); font-size:10px; min-height:12px; }
`;