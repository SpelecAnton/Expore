"use strict";
const RESERVED = "Anton Špelec",
    POLL_BASE = 1e3,
    POLL_MAX = 1e4,
    PING_IV = 5e3,
    TICKER_IV = 5e3,
    MSG_CAP = 300;
function _idToHue(n) {
    let e = 0;
    for (let t = 0; t < n.length; t++) e = n.charCodeAt(t) + ((e << 5) - e);
    return ((e % 360) + 360) % 360;
}
function _linkify(n) {
    return n.replace(
        /(https?:\/\/[^\s<>"']+)/g,
        (n) => `<a href="${n.replace(/"/g, "&quot;")}" target="_blank" rel="noopener noreferrer">${n}</a>`
    );
}
function _fmtTime(n) {
    const e = new Date(1e3 * n);
    return `${String(e.getHours()).padStart(2, "0")}:${String(e.getMinutes()).padStart(2, "0")} ${String(e.getDate()).padStart(2, "0")}.${String(e.getMonth() + 1).padStart(2, "0")}`;
}
function _sanitizeUrl(n) {
    if (!n) return "";
    try {
        if (
            (n.startsWith("chat_uploads/") && (n = "/chat/" + n),
            n.startsWith("/chat/chat_uploads/") && !n.includes(".."))
        )
            return new URL(n, "https://spelec.cz").href;
        const e = new URL(n, window.location.origin);
        return "https:" === e.protocol || "http:" === e.protocol ? e.href : "";
    } catch {
        return "";
    }
}
function _el(n, e = {}) {
    const t = document.createElement(n);
    for (const [n, o] of Object.entries(e)) "class" === n ? (t.className = o) : t.setAttribute(n, o);
    return t;
}
function _abortFor(n) {
    const e = new AbortController();
    return setTimeout(() => e.abort(), n), e.signal;
}
export function createChatOverlay({
    apiUrl: n = "https://spelec.cz/chat/api.php",
    onlineUrl: e = "https://spelec.cz/chat/online.php",
    getPlayers: t = null,
    onTeleport: o = null,
    onAdminPassChange: i = null,
} = {}) {
    let r = localStorage.getItem("chat_user_id") || "";
    r ||
        ((r = Array.from(crypto.getRandomValues(new Uint8Array(8)))
            .map((n) => n.toString(16).padStart(2, "0"))
            .join("")),
        localStorage.setItem("chat_user_id", r));
    let a = !1,
        s = [];
    const l = new Set();
    let c = 0,
        d = !1,
        p = 0,
        g = !0,
        h = !1,
        u = 0,
        x = null,
        b = !1,
        f = null,
        m = null,
        y = null,
        k = !1,
        v = 1e3,
        w = !0;
    _injectStyles();
    const _ = _el("div", { id: "co-wrap" }),
        C = _el("div", { id: "co-ticker" }),
        E = _el("button", { id: "co-toggle", type: "button", title: "Chat [Tab]" });
    E.textContent = "CHAT";
    const S = _el("span", { id: "co-badge" });
    (S.hidden = !0), E.appendChild(S);
    const T = _el("div", { id: "co-panel" });
    T.hidden = !0;
    const L = _el("div", { id: "co-header" }),
        z = _el("span", { id: "co-title" });
    z.textContent = "GLOBAL CHAT";
    const H = _el("span", { id: "co-online" });
    H.textContent = "● 0";
    const I = _el("button", { id: "co-close", type: "button", title: "Zavřít" });
    (I.textContent = "×"), L.append(z, H, I);
    let A = null,
        M = null;
    if ("function" == typeof t) {
        M = _el("div", { id: "co-players" });
        const n = _el("div", { class: "co-plyr-hdr" });
        (n.textContent = "PLAYERS ON THIS MAP"), (A = _el("div", { id: "co-plyr-strip" })), M.append(n, A);
    }
    const P = _el("div", { id: "co-lm-banner" });
    (P.textContent = "▲ load older messages"), (P.hidden = !0);
    const $ = _el("div", { id: "co-messages" }),
        j = _el("div", { id: "co-footer" }),
        D = _el("div", { id: "co-nick-row" }),
        N = _el("input", {
            id: "co-nick",
            class: "co-input",
            maxlength: "128",
            placeholder: "Nick",
            autocomplete: "off",
            spellcheck: "false",
        }),
        R = _el("input", {
            id: "co-adminpass",
            class: "co-input",
            type: "password",
            maxlength: "64",
            placeholder: "Admin pass",
        });
    (R.hidden = !0), D.append(N, R);
    const F = _el("div", { id: "co-input-row" }),
        O = _el("input", {
            id: "co-msg-input",
            class: "co-input",
            maxlength: "2000",
            placeholder: "Message…",
            autocomplete: "off",
        }),
        U = _el("button", { id: "co-send", type: "button" });
    (U.textContent = "→"), F.append(O, U);
    const V = _el("div", { id: "co-status" });
    j.append(D, F, V),
        T.append(L),
        M && T.appendChild(M),
        T.append(P, $, j),
        _.append(C, E, T),
        document.body.appendChild(_);
    const q = _el("div", { id: "co-lightbox" });
    q.hidden = !0;
    const B = _el("div", { id: "co-lightbox-inner" }),
        G = _el("button", { id: "co-lightbox-close", type: "button", title: "Zavřít" });
    (G.textContent = "×"),
        q.append(B, G),
        document.body.appendChild(q),
        (N.value = localStorage.getItem("chat_nick") || ""),
        N.value.trim() === RESERVED && (R.hidden = !1),
        N.addEventListener("input", () => {
            const n = N.value.trim();
            localStorage.setItem("chat_nick", n);
            const e = n === RESERVED;
            (R.hidden = !e), !e && R.value && (R.value = ""), i?.(R.hidden ? "" : R.value);
        }),
        R.addEventListener("input", () => {
            i?.(R.value);
        }),
        E.addEventListener("click", () => W(!a)),
        I.addEventListener("click", () => W(!1)),
        U.addEventListener("click", Q),
        P.addEventListener("click", en);
    const J = (n) => n.stopPropagation();
    for (const n of [N, R, O]) n.addEventListener("keydown", J), n.addEventListener("keyup", J);
    O.addEventListener("keydown", (n) => {
        "Enter" !== n.key || n.shiftKey || (n.preventDefault(), Q());
    });
    const Z = (n) => {
        "Tab" === n.key && (n.preventDefault(), n.stopImmediatePropagation(), W(!a));
    };
    window.addEventListener("keydown", Z, { capture: !0 });
    const K = (n) => {
        "Escape" !== n.key || q.hidden || (n.stopPropagation(), X());
    };
    function W(n) {
        (a = n),
            (T.hidden = !n),
            (C.hidden = n),
            n
                ? ((u = 0),
                  (S.hidden = !0),
                  (w = !0),
                  (P.hidden = !d),
                  requestAnimationFrame(() => {
                      $.scrollTop = $.scrollHeight;
                  }),
                  on(),
                  A && (y = setInterval(on, 1e3)),
                  O.focus())
                : (clearInterval(y), (y = null));
    }
    function Y(n, e) {
        let t;
        (B.innerHTML = ""),
            "video" === n
                ? ((t = _el("video")), (t.controls = !0), (t.autoplay = !0), (t.playsInline = !0))
                : ((t = _el("img")), (t.alt = "")),
            (t.src = e),
            B.appendChild(t),
            (q.hidden = !1);
    }
    function X() {
        const n = B.querySelector("video");
        n && n.pause(), (q.hidden = !0), (B.innerHTML = "");
    }
    async function Q() {
        const e = O.value.trim();
        if (!e) return;
        const t = N.value.trim() || "Anon",
            o = R.value;
        (U.disabled = !0), (V.textContent = "");
        try {
            const i = await fetch(`${n}?action=send`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ user_id: r, nickname: t, text: e, admin_pass: o }),
                    signal: _abortFor(6e3),
                }),
                d = await i.json();
            if (!i.ok) return void (V.textContent = d.error || "Sending Error");
            (O.value = ""),
                (w = !0),
                d.message &&
                    !l.has(d.message.id) &&
                    (l.add(d.message.id),
                    s.push(d.message),
                    d.message.timestamp > c && (c = d.message.timestamp),
                    $.appendChild(rn(d.message)),
                    a && ($.scrollTop = $.scrollHeight));
        } catch {
            V.textContent = "Network Error";
        } finally {
            (U.disabled = !1), O.focus();
        }
    }
    async function nn() {
        try {
            const n = await fetch(e, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ uid: r }),
                    signal: _abortFor(3e3),
                }),
                t = await n.json();
            void 0 !== t.online && (H.textContent = `● ${t.online}`);
        } catch {}
    }
    async function en() {
        if (d && p && !k) {
            (k = !0), (P.textContent = "⏳ loading...");
            try {
                const e = await fetch(`${n}?action=get&before=${p}`, { signal: _abortFor(7e3) });
                if (!e.ok) throw new Error();
                const t = await e.json();
                if (t.messages?.length) {
                    const n = $.scrollHeight,
                        e = t.messages.filter((n) => !l.has(n.id));
                    for (const n of e) l.add(n.id);
                    if (((s = [...e, ...s]), e.length && (p = t.messages[0].timestamp), e.length)) {
                        const t = document.createDocumentFragment();
                        for (const n of e) t.appendChild(rn(n));
                        $.insertBefore(t, $.firstChild), ($.scrollTop += $.scrollHeight - n);
                    }
                }
                (d = t.has_more ?? !1), (P.hidden = !d), d && (P.textContent = "▲ load older messages");
            } catch {
                P.textContent = "▲ load older messages (error, try again)";
            } finally {
                k = !1;
            }
        }
    }
    function tn() {
        if (a) return;
        const n = s.slice(-5);
        C.innerHTML = "";
        for (const e of n) {
            const n = _el("div", { class: "co-tick" }),
                t = _idToHue(e.short_id),
                o = e.is_admin ? "#ff9900" : `hsl(${t},100%,65%)`,
                i = _el("span", { class: "co-tick-nick" });
            (i.style.color = o), (i.textContent = e.nickname + ":");
            const r = _el("span", { class: "co-tick-text" });
            if (e.text) {
                const n = document.createElement("span");
                (n.innerHTML = e.text), (r.textContent = n.textContent.slice(0, 90));
            } else e.image_url && ((r.textContent = "[file]"), (r.style.opacity = "0.5"));
            n.append(i, " ", r), C.appendChild(n);
        }
    }
    function on() {
        if (!A || "function" != typeof t) return;
        const n = t();
        if (((A.innerHTML = ""), !n.length)) {
            const n = _el("span", { class: "co-plyr-empty" });
            return (n.textContent = "You're here alone."), void A.appendChild(n);
        }
        for (const e of n) {
            const n = `hsl(${_idToHue(e.uid)},100%,65%)`,
                t = _el("button", { class: "co-plyr-btn" });
            (t.style.color = n), (t.title = `Teleportovat k ${e.nick}`);
            const i = document.createElement("span");
            i.textContent = "● ";
            const r = document.createElement("span");
            r.textContent = e.nick;
            const a = document.createElement("span");
            (a.textContent = " ↗"),
                (a.style.opacity = "0.55"),
                t.append(i, r, a),
                t.addEventListener("click", () => {
                    "function" == typeof o && o(e.x, e.y, e.z), W(!1);
                }),
                A.appendChild(t);
        }
    }
    function rn(n) {
        const e = _el("div", { class: "co-msg" + (n.is_admin ? " co-admin" : "") });
        e.dataset.id = n.id;
        const t = _idToHue(n.short_id),
            o = n.is_admin ? "#ff9900" : `hsl(${t},100%,65%)`,
            i = _el("div", { class: "co-msg-header" }),
            r = _el("span", { class: "co-nick" });
        (r.style.color = o), (r.textContent = n.nickname);
        const a = _el("span", { class: "co-sid" });
        a.textContent = "#" + n.short_id;
        const s = _el("span", { class: "co-time" });
        if (((s.textContent = _fmtTime(n.timestamp)), i.append(r, a, s), e.appendChild(i), n.text)) {
            const t = _el("div", { class: "co-text" });
            (t.innerHTML = _linkify(n.text)), e.appendChild(t);
        }
        if (n.image_url) {
            const t = _sanitizeUrl(n.image_url),
                o = t.toLowerCase();
            if (t)
                if (/\.(mp4|webm|ogv)$/i.test(o)) {
                    const n = _el("div", { class: "co-media-wrap" }),
                        o = _el("video");
                    (o.controls = !0), (o.preload = "metadata"), (o.src = t), (o.className = "co-media");
                    const i = _el("button", { class: "co-media-expand", type: "button", title: "Zvětšit" });
                    (i.textContent = "⛶"),
                        i.addEventListener("click", (n) => {
                            n.stopPropagation(), Y("video", t);
                        }),
                        n.append(o, i),
                        e.appendChild(n);
                } else if (/\.(mp3|wav|ogg|aac)$/i.test(o)) {
                    const n = _el("audio");
                    (n.controls = !0), (n.src = t), (n.className = "co-media"), e.appendChild(n);
                } else {
                    const n = _el("img");
                    (n.alt = ""),
                        (n.loading = "lazy"),
                        (n.src = t),
                        (n.className = "co-media"),
                        (n.style.cursor = "zoom-in"),
                        n.addEventListener("click", (n) => {
                            n.stopPropagation(), Y("image", t);
                        }),
                        e.appendChild(n);
                }
        }
        return e;
    }
    return (
        window.addEventListener("keydown", K, { capture: !0 }),
        q.addEventListener("click", (n) => {
            n.target === q && X();
        }),
        G.addEventListener("click", X),
        $.addEventListener("scroll", () => {
            (w = $.scrollHeight - $.scrollTop - $.clientHeight < 40), 0 === $.scrollTop && d && !k && en();
        }),
        (async function e() {
            if (!b) {
                b = !0;
                try {
                    const e = await fetch(`${n}?action=get&since=${c}`, { signal: _abortFor(5e3) });
                    if (!e.ok) throw new Error("HTTP " + e.status);
                    const t = await e.json();
                    if (t.messages?.length) {
                        g && ((g = !1), (d = t.has_more ?? !1), (p = t.messages[0].timestamp));
                        const n = [];
                        for (const e of t.messages)
                            l.has(e.id) ||
                                (l.add(e.id),
                                s.push(e),
                                e.timestamp > c && (c = e.timestamp),
                                n.push(e),
                                !a && h && (u++, (S.textContent = u > 9 ? "9+" : String(u)), (S.hidden = !1)));
                        if (s.length > 300) {
                            const n = s.length - 300;
                            s = s.slice(-300);
                            for (let e = 0; e < n; e++) $.firstElementChild?.remove();
                        }
                        if (n.length) {
                            const e = w,
                                t = document.createDocumentFragment();
                            for (const e of n) t.appendChild(rn(e));
                            $.appendChild(t),
                                (P.hidden = !d),
                                a &&
                                    e &&
                                    requestAnimationFrame(() => {
                                        $.scrollTop = $.scrollHeight;
                                    });
                        }
                    } else g && (g = !1);
                    (h = !0), (v = 1e3);
                } catch {
                    v = Math.min(1.5 * v, 1e4);
                } finally {
                    (b = !1), tn(), (x = setTimeout(e, v));
                }
            }
        })(),
        (f = setInterval(nn, 5e3)),
        (m = setInterval(tn, 5e3)),
        nn(),
        W(!1),
        {
            destroy: function () {
                clearTimeout(x),
                    clearInterval(f),
                    clearInterval(m),
                    clearInterval(y),
                    window.removeEventListener("keydown", Z, { capture: !0 }),
                    window.removeEventListener("keydown", K, { capture: !0 }),
                    q.remove(),
                    _.remove();
            },
            open: () => W(!0),
            close: () => W(!1),
        }
    );
}
function _injectStyles() {
    if (document.getElementById("co-styles")) return;
    if (!document.querySelector('link[href*="Share+Tech+Mono"]')) {
        const n = document.createElement("link");
        (n.rel = "stylesheet"),
            (n.href = "https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap"),
            document.head.appendChild(n);
    }
    const n = document.createElement("style");
    (n.id = "co-styles"), (n.textContent = _CSS), document.head.appendChild(n);
}
const _CSS =
    "\n#co-wrap {\n  position: fixed;\n  bottom: 20px;\n  right: 20px;\n  width: 48px;\n  height: 48px;\n  z-index: 9999;\n  font-family: 'Share Tech Mono', 'Courier New', monospace;\n  user-select: text;\n  -webkit-user-select: text;\n}\n\n/* ── Ticker ──────────────────────────────────────── */\n#co-ticker {\n  position: absolute;\n  bottom: 60px;\n  right: 0;\n  width: 272px;\n  display: flex;\n  flex-direction: column;\n  gap: 3px;\n  pointer-events: none;\n}\n/* ID selector beats the UA stylesheet's [hidden] rule on specificity alone —\n   without this override, setting .hidden on #co-ticker had no visual effect. */\n#co-ticker[hidden] { display: none; }\n.co-tick {\n  padding: 4px 8px;\n  background: rgba(0,0,0,0.62);\n  backdrop-filter: blur(5px);\n  -webkit-backdrop-filter: blur(5px);\n  border-radius: 4px;\n  border-left: 2px solid rgba(255,34,0,0.28);\n  font-size: 11px;\n  line-height: 1.45;\n  word-break: break-word;\n  color: rgba(255,255,255,0.82);\n}\n.co-tick-nick { font-weight: bold; margin-right: 3px; }\n\n/* ── Toggle button ───────────────────────────────── */\n#co-toggle {\n  position: relative;\n  width: 48px;\n  height: 48px;\n  border-radius: 50%;\n  background: rgba(0,0,0,0.82);\n  border: 1px solid rgba(255,34,0,0.45);\n  color: rgba(255,34,0,0.85);\n  cursor: pointer;\n  font-family: inherit;\n  font-size: 9px;\n  letter-spacing: 0.10em;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  transition: border-color 0.18s, background 0.18s;\n}\n#co-toggle:hover {\n  border-color: rgba(255,34,0,0.80);\n  background: rgba(16,0,0,0.92);\n}\n#co-badge {\n  position: absolute;\n  top: -5px; right: -5px;\n  min-width: 18px; height: 18px;\n  border-radius: 9px;\n  background: #ff2200;\n  color: #fff;\n  font-size: 10px;\n  padding: 0 3px;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  pointer-events: none;\n  box-shadow: 0 0 6px rgba(255,34,0,0.65);\n  animation: co-badge-pop 0.25s ease;\n}\n@keyframes co-badge-pop {\n  0%   { transform: scale(0.5); opacity: 0; }\n  70%  { transform: scale(1.2); }\n  100% { transform: scale(1);   opacity: 1; }\n}\n\n/* ── Panel ───────────────────────────────────────── */\n#co-panel {\n  position: absolute;\n  bottom: 60px;\n  right: 0;\n  width: 300px;\n  height: 420px;\n  background: rgba(3,0,0,0.93);\n  border: 1px solid rgba(255,34,0,0.18);\n  border-radius: 8px;\n  display: flex;\n  flex-direction: column;\n  overflow: hidden;\n  backdrop-filter: blur(12px);\n  -webkit-backdrop-filter: blur(12px);\n  box-shadow: 0 8px 32px rgba(0,0,0,0.72);\n}\n/* ID selector beats the UA stylesheet's [hidden] rule on specificity alone —\n   without this override, setting .hidden on #co-panel had no visual effect,\n   so the panel always stayed visible even when JS thought it was closed. */\n#co-panel[hidden] { display: none; }\n\n/* ── Header ──────────────────────────────────────── */\n#co-header {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 8px 10px;\n  border-bottom: 1px solid rgba(255,34,0,0.10);\n  flex-shrink: 0;\n}\n#co-title  { flex:1; color:rgba(255,34,0,0.85); font-size:9px; letter-spacing:0.20em; }\n#co-online { color:rgba(255,255,255,0.28); font-size:9px; white-space:nowrap; }\n#co-close  {\n  background:none; border:none;\n  color:rgba(255,255,255,0.28);\n  cursor:pointer; font-size:16px; line-height:1; padding:0;\n  transition:color 0.15s; font-family:inherit;\n}\n#co-close:hover { color:rgba(255,255,255,0.70); }\n\n/* ── Player strip ────────────────────────────────── */\n#co-players {\n  flex-shrink: 0;\n  padding: 5px 8px;\n  border-bottom: 1px solid rgba(255,34,0,0.08);\n}\n.co-plyr-hdr  { font-size:8px; letter-spacing:0.15em; color:rgba(255,255,255,0.22); margin-bottom:4px; }\n#co-plyr-strip { display:flex; flex-wrap:wrap; gap:4px; }\n.co-plyr-btn  {\n  background:rgba(255,255,255,0.04);\n  border:1px solid rgba(255,255,255,0.10);\n  border-radius:12px;\n  cursor:pointer;\n  font-family:inherit;\n  font-size:10px;\n  padding:3px 8px;\n  display:flex; align-items:center; gap:3px;\n  transition:background 0.15s, border-color 0.15s;\n}\n.co-plyr-btn:hover { background:rgba(255,255,255,0.09); border-color:rgba(255,255,255,0.25); }\n.co-plyr-empty { color:rgba(255,255,255,0.20); font-size:10px; }\n\n/* ── Load-older banner ───────────────────────────── */\n#co-lm-banner {\n  flex-shrink: 0;\n  text-align: center;\n  padding: 5px 0;\n  font-size: 10px;\n  color: rgba(255,255,255,0.32);\n  cursor: pointer;\n  border-bottom: 1px solid rgba(255,34,0,0.07);\n  transition: color 0.18s;\n}\n#co-lm-banner:hover { color:rgba(255,100,100,0.85); }\n\n/* ── Messages ────────────────────────────────────── */\n#co-messages {\n  flex: 1;\n  overflow-y: auto;\n  padding: 6px 8px;\n}\n#co-messages::-webkit-scrollbar { width:3px; }\n#co-messages::-webkit-scrollbar-track { background:transparent; }\n#co-messages::-webkit-scrollbar-thumb { background:rgba(255,34,0,0.20); border-radius:2px; }\n\n.co-msg {\n  margin-bottom: 6px;\n  padding: 5px 7px;\n  background: rgba(255,255,255,0.025);\n  border-left: 2px solid rgba(255,255,255,0.07);\n  border-radius: 3px;\n  word-break: break-word;\n}\n.co-msg.co-admin { border-left-color:rgba(255,153,0,0.40); background:rgba(255,120,0,0.04); }\n\n.co-msg-header {\n  display: flex;\n  align-items: baseline;\n  gap: 4px;\n  margin-bottom: 2px;\n  overflow: hidden;\n}\n.co-nick { font-size:11px; font-weight:bold; flex-shrink:0; }\n.co-sid  { color:rgba(255,255,255,0.18); font-size:9px; flex-shrink:0; }\n.co-time { color:rgba(255,255,255,0.15); font-size:9px; margin-left:auto; white-space:nowrap; flex-shrink:0; }\n\n.co-text { color:rgba(255,255,255,0.78); font-size:11px; line-height:1.55; }\n.co-text a { color:rgba(255,90,40,0.85); text-decoration:none; }\n.co-text a:hover { text-decoration:underline; }\n\n.co-media { display:block; max-width:100%; max-height:90px; margin-top:4px; border-radius:3px; object-fit:contain; }\n.co-empty { color:rgba(255,255,255,0.22); text-align:center; padding:20px 8px; font-size:11px; }\n\n/* ── Media wrap + expand button (video) ──────────── */\n.co-media-wrap {\n  position: relative;\n  display: inline-block;\n  max-width: 100%;\n  margin-top: 4px;\n}\n.co-media-wrap .co-media { margin-top: 0; display: block; }\n.co-media-expand {\n  position: absolute;\n  top: 4px;\n  right: 4px;\n  width: 22px;\n  height: 22px;\n  border-radius: 4px;\n  background: rgba(0,0,0,0.6);\n  border: 1px solid rgba(255,255,255,0.25);\n  color: rgba(255,255,255,0.9);\n  font-size: 12px;\n  line-height: 1;\n  cursor: pointer;\n  font-family: inherit;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  transition: background 0.15s;\n}\n.co-media-expand:hover { background: rgba(255,34,0,0.55); }\n\n/* ── Lightbox ────────────────────────────────────── */\n#co-lightbox {\n  position: fixed;\n  inset: 0;\n  z-index: 10000;\n  background: rgba(0,0,0,0.88);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  cursor: zoom-out;\n}\n/* Same ID-vs-[hidden] specificity issue as #co-panel — explicit override\n   needed or .hidden = true would not actually hide the backdrop. */\n#co-lightbox[hidden] { display: none; }\n#co-lightbox-inner {\n  max-width: 92vw;\n  max-height: 92vh;\n  display: flex;\n  cursor: default;\n}\n#co-lightbox-inner img,\n#co-lightbox-inner video {\n  max-width: 92vw;\n  max-height: 92vh;\n  border-radius: 4px;\n  box-shadow: 0 8px 40px rgba(0,0,0,0.6);\n}\n#co-lightbox-close {\n  position: fixed;\n  top: 18px;\n  right: 22px;\n  background: rgba(0,0,0,0.55);\n  border: 1px solid rgba(255,255,255,0.18);\n  color: rgba(255,255,255,0.85);\n  width: 36px;\n  height: 36px;\n  border-radius: 50%;\n  font-size: 20px;\n  line-height: 1;\n  cursor: pointer;\n  font-family: inherit;\n  transition: background 0.15s, border-color 0.15s;\n}\n#co-lightbox-close:hover { background: rgba(255,34,0,0.35); border-color: rgba(255,34,0,0.5); }\n\n/* ── Footer ──────────────────────────────────────── */\n#co-footer {\n  flex-shrink: 0;\n  padding: 7px 8px;\n  border-top: 1px solid rgba(255,34,0,0.08);\n  display: flex;\n  flex-direction: column;\n  gap: 5px;\n}\n#co-nick-row  { display:flex; gap:5px; }\n#co-input-row { display:flex; gap:5px; }\n#co-nick      { flex:1; }\n#co-adminpass { flex:1; }\n#co-msg-input { flex:1; }\n\n.co-input {\n  background: rgba(255,255,255,0.04);\n  border: 1px solid rgba(255,255,255,0.08);\n  border-radius: 4px;\n  color: rgba(255,255,255,0.82);\n  font-family: inherit;\n  font-size: 11px;\n  padding: 5px 7px;\n  outline: none;\n  transition: border-color 0.18s;\n  box-sizing: border-box;\n  width: 100%;\n}\n.co-input:focus       { border-color:rgba(255,34,0,0.35); }\n.co-input::placeholder { color:rgba(255,255,255,0.18); }\n\n#co-send {\n  flex-shrink: 0;\n  background: rgba(255,34,0,0.10);\n  border: 1px solid rgba(255,34,0,0.22);\n  border-radius: 4px;\n  color: rgba(255,34,0,0.80);\n  cursor: pointer;\n  font-family: inherit;\n  font-size: 14px;\n  padding: 4px 10px;\n  transition: background 0.18s;\n}\n#co-send:hover    { background:rgba(255,34,0,0.26); }\n#co-send:disabled { opacity:0.40; cursor:default; }\n\n#co-status { color:rgba(255,100,0,0.75); font-size:10px; min-height:12px; }\n";
