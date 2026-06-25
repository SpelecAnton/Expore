/**
 * SPELEC BSP Loader v5.9 — LOAD TIMING DIAGNOSTICS
 *
 * Changes over v5.8:
 *
 * 16. PER-PHASE TIMING REPORT:
 *    - loadBSP() now records a performance.now() timestamp at the start of
 *      every major phase and logs the elapsed time when that phase ends.
 *      Phases timed (each printed to console with a ⏱ prefix):
 *        • BSP download + arrayBuffer()  — network + browser decode
 *        • BSP Worker parse              — all work inside the worker
 *        • Lightmap DataTexture create   — atlas Uint8Array → DataTexture
 *        • Geometry merge                — mergeBatchGeometries() CPU pass
 *        • Initial texture batch         — the BLOCKING findTex() calls
 *        • Mesh build (progressive)      — GPU BufferGeometry uploads
 *        • Total to first frame          — sum of all blocking phases
 *      This tells you immediately which phase is the bottleneck without
 *      having to instrument the code yourself.
 *
 * 17. TEXTURE PROBE STATISTICS:
 *    - New module-level _probeStats object tracks across the whole session:
 *        • attempts   — total findTex() calls (= unique texture names)
 *        • resolved   — how many got a real texture (not whiteTex fallback)
 *        • fallback   — how many fell back to whiteTex (file not found)
 *        • requests   — total individual fetch/load attempts fired
 *                       (attempts × TEX_EXTENSIONS.length × bases.length)
 *        • hitMs      — cumulative ms inside findTex() for successful finds
 *        • missMs     — cumulative ms for names that resolved to nothing
 *        • avgMs      — average ms per unique texture name
 *    - Printed in the final summary table so you can see exactly how much
 *      time the texture probing phase consumes, and how many unnecessary
 *      404-level requests are flying (= good argument for adding a texture
 *      manifest JSON as the next optimization).
 *
 * 18. BSP FILE SIZE IN LOGS:
 *    - BSP download line now includes the file size in MB so you can tell
 *      at a glance whether the download itself is the dominant cost.
 *
 * 19. DRAW-CALL COUNT IN MERGE LOG:
 *    - Geometry merge line now prints both the input batch count AND the
 *      output merged draw-call count so you can see how much consolidation
 *      actually happened (high output count → many unique tex/lm combos,
 *      possible over-segmentation in the map).
 *
 * None of the above changes any runtime behaviour — all timing is read-only
 * observation. The diagnostic output can be removed or guarded behind a
 * DEBUG flag once the bottleneck is identified and fixed.
 *
 * --- Previous changelog (v5.8 — FASTER TEXTURE RESOLUTION EDITION) --------
 *
 * 12. REMOVED THE HEAD-THEN-GET DOUBLE ROUND TRIP
 * 13. SILENT PROBING vs. LOUD DIRECT LOOKUPS
 * 14. PER-CANDIDATE TIMEOUT (TEX_PROBE_TIMEOUT_MS)
 * 15. INITIAL_BATCHES 2 → 1
 *
 * --- Previous changelog (v5.7 — PORTAL MEDIA TEXTURE EDITION) -------------
 * 11. GENERIC loadTextureFromUrl() EXPORT
 *
 * --- Previous changelog (v5.6 — GLSL SHADER TEXTURE EDITION) -------------
 * 10. GLSL SHADER TEXTURES (.frag)
 *
 * --- Previous changelog (v5.5 — CHAT MEDIA ISOLATION EDITION) ------------
 *  9. BSP TEXTURE VIDEO MARKER (data-spelec-bsp-video)
 *
 * --- Previous changelog (v5.4 — VIDEO TEXTURE EDITION) --------------------
 *  8. AUDIO UNMUTE ON USER GESTURE (unmuteVideos export)
 *
 * --- Previous changelog (v5.3 — VIDEO TEXTURE EDITION) --------------------
 *  7. REAL VIDEO TEXTURE SUPPORT (.mp4 / .webm)
 *
 * --- Previous changelog (v5.2 — LARGE MAP EDITION) -----------------------
 *  1–6. MESH_YIELD_EVERY, TEXTURE_BATCH_SIZE, progressive swap, BVH,
 *       lightmap deferral, geometry dispose guard
 *
 * Backward compat: exports loadBSP, tickAnimatedTextures, initTexLoader,
 * unmuteVideos, loadTextureFromUrl.
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';

// ── Optional BVH acceleration ─────────────────────────────────────────────────
let _bvhAvailable       = false;
let _MeshBVH            = null;
let _acceleratedRaycast = null;

(async () => {
  try {
    const bvhModule     = await import('https://cdn.jsdelivr.net/npm/three-mesh-bvh@0.7.3/build/index.module.js');
    _MeshBVH            = bvhModule.MeshBVH;
    _acceleratedRaycast = bvhModule.acceleratedRaycast;
    _bvhAvailable       = true;
    console.log('[BSP] three-mesh-bvh loaded — BVH raycasting enabled');
  } catch {
    console.warn('[BSP] three-mesh-bvh not available — using standard raycasting');
  }
})();

const _bvhQueue    = [];
let   _bvhScheduled = false;

function scheduleBVHBuild(geometry) {
  _bvhQueue.push(geometry);
  if (_bvhScheduled) return;
  _bvhScheduled = true;

  const schedFn = typeof requestIdleCallback === 'function'
    ? cb => requestIdleCallback(cb, { timeout: 2000 })
    : cb => setTimeout(cb, 0);

  schedFn(function drainBVHQueue(deadline) {
    const hasTime = () => deadline ? deadline.timeRemaining() > 2 : true;
    while (_bvhQueue.length && hasTime()) {
      const geo = _bvhQueue.shift();
      try {
        geo.boundsTree  = new _MeshBVH(geo);
        geo.rawcastFunc = _acceleratedRaycast;
      } catch { /* non-indexed or already disposed */ }
    }
    if (_bvhQueue.length) {
      schedFn(drainBVHQueue);
    } else {
      _bvhScheduled = false;
    }
  });
}

function buildBVH(geometry) {
  if (!_bvhAvailable || !_MeshBVH || !_acceleratedRaycast) return;
  scheduleBVHBuild(geometry);
}

// ── Configuration ─────────────────────────────────────────────────────────────
const VIDEO_EXTS         = new Set(['.mp4', '.webm']);
const SHADER_EXTS        = new Set(['.frag']);
const TEX_EXTENSIONS     = ['.mp4', '.webm', '.frag', '.gif', '.avif', '.webp', '.png', '.jpg'];
const ANIM_EXTS          = new Set(['.gif', '.avif', '.webp']);
const TEXTURE_BATCH_SIZE = 4;
const MESH_YIELD_EVERY   = 10;
const MAX_ATLAS_MIPMAP   = 4096;
const SHADER_TEX_SIZE    = 512;
const TEX_PROBE_TIMEOUT_MS = 10000;

// ── Anisotropy ────────────────────────────────────────────────────────────────
let _maxAniso = 1;

export function initTexLoader(renderer) {
  _maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  console.log(`[BSP] Anisotropic filtering: ${_maxAniso}×`);
}

// ── Internal state ────────────────────────────────────────────────────────────
const _texCache   = new Map();
const _loader     = new THREE.TextureLoader();
const _animList   = [];
const _videoList  = [];
const _shaderList = [];

// ── Diagnostic probe stats (v5.9) ─────────────────────────────────────────────
// Accumulated across all findTex() calls for the current page load.
// Printed in the final summary table inside loadBSP().
const _probeStats = {
  attempts:  0,   // total findTex() calls (= unique texture names probed)
  resolved:  0,   // names that found a real texture
  fallback:  0,   // names that fell back to whiteTex (nothing found)
  requests:  0,   // individual fetch/load attempts fired (attempts × exts × bases)
  hitMs:     0,   // cumulative ms for successful findTex() calls
  missMs:    0,   // cumulative ms for failed findTex() calls
};

// ── Tick animated textures ────────────────────────────────────────────────────
export function tickAnimatedTextures() {
  if (_animList.length) {
    const now = performance.now();
    for (const anim of _animList) {
      if (now < anim.nextFrameTime) continue;
      const frame = anim.frames[anim.frameIdx];
      anim.ctx.clearRect(0, 0, anim.canvas.width, anim.canvas.height);
      anim.ctx.drawImage(frame.bitmap, 0, 0, anim.canvas.width, anim.canvas.height);
      anim.tex.needsUpdate = true;
      anim.frameIdx      = (anim.frameIdx + 1) % anim.frames.length;
      anim.nextFrameTime = now + frame.duration;
    }
  }

  if (_videoList.length) {
    for (const video of _videoList) {
      if (video.paused && !video.ended) {
        video.play().catch(() => {});
      }
    }
  }

  if (_shaderList.length) {
    for (const shader of _shaderList) {
      shader.tex.needsUpdate = true;
    }
  }
}

// ── Unmute video textures (call on first user gesture) ───────────────────────
export function unmuteVideos() {
  for (const video of _videoList) {
    if (video.muted) {
      video.muted = false;
      video.play().catch(() => {});
    }
  }
}

// ── Texture filter helper ─────────────────────────────────────────────────────
function applyTexFilters(tex, { linearMag = false } = {}) {
  tex.wrapS      = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter  = THREE.LinearMipmapLinearFilter;
  tex.magFilter  = linearMag ? THREE.LinearFilter : THREE.NearestFilter;
  tex.anisotropy = _maxAniso;
  tex.generateMipmaps = true;
}

// ── Timeout helper for fetch() based loaders ──────────────────────────────────
function fetchWithTimeout(url, ms = TEX_PROBE_TIMEOUT_MS, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ── Video texture loader ──────────────────────────────────────────────────────
function loadVideoTex(url, silent = false) {
  return new Promise(resolve => {
    const video = document.createElement('video');
    video.src         = url;
    video.loop        = true;
    video.muted       = true;
    video.playsInline = true;
    video.autoplay    = true;
    video.preload     = 'auto';
    video.crossOrigin = 'anonymous';
    video.dataset.spelecBspVideo = '';

    video.style.position      = 'absolute';
    video.style.top           = '0';
    video.style.left          = '0';
    video.style.width         = '1px';
    video.style.height        = '1px';
    video.style.opacity       = '0';
    video.style.pointerEvents = 'none';

    document.body.appendChild(video);

    const tex = new THREE.VideoTexture(video);
    tex.colorSpace      = THREE.SRGBColorSpace;
    tex.minFilter       = THREE.LinearFilter;
    tex.magFilter       = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;

    let settled = false;

    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(result);
    };

    const onReady = () => {
      _videoList.push(video);
      video.play().catch(() => {});
      console.log(`[BSP] Video texture ready: ${url}`);
      finish(tex);
    };

    const onError = () => {
      if (!silent) console.warn('[BSP] Video texture failed to load:', url);
      video.remove();
      finish(null);
    };

    const timeoutId = setTimeout(() => {
      if (!silent) console.warn('[BSP] Video texture timed out:', url);
      video.remove();
      finish(null);
    }, TEX_PROBE_TIMEOUT_MS);

    video.addEventListener('loadeddata', onReady, { once: true });
    video.addEventListener('error', onError, { once: true });

    video.load();
  });
}

// ── GlslCanvas lazy loader ────────────────────────────────────────────────────
let _glslCanvasLoadPromise = null;

function ensureGlslCanvasLoaded() {
  if (window.GlslCanvas) return Promise.resolve();
  if (_glslCanvasLoadPromise) return _glslCanvasLoadPromise;

  const loaderUrl  = import.meta.url;
  const loaderBase = loaderUrl.substring(0, loaderUrl.lastIndexOf('/') + 1);
  const localUrl    = loaderBase + 'GlslCanvas.js';
  const remoteUrl   = 'https://spelecanton.github.io/Expore/javascript/GlslCanvas.js';

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script   = document.createElement('script');
      script.src     = src;
      script.onload  = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
  }

  _glslCanvasLoadPromise = loadScript(localUrl)
    .catch(() => loadScript(remoteUrl))
    .then(() => {
      if (!window.GlslCanvas) throw new Error('GlslCanvas.js loaded but window.GlslCanvas is missing');
      console.log('[BSP] GlslCanvas.js loaded');
    });

  return _glslCanvasLoadPromise;
}

// ── GLSL shader texture loader ────────────────────────────────────────────────
function loadShaderTex(url, silent = false) {
  return fetchWithTimeout(url)
    .then(res => {
      if (!res.ok) {
        if (!silent) console.warn('[BSP] Shader texture fetch failed:', url, res.status);
        return null;
      }
      return res.text();
    })
    .then(async fragSource => {
      if (!fragSource) return null;

      await ensureGlslCanvasLoaded();

      const canvas = document.createElement('canvas');
      canvas.width  = canvas.height = SHADER_TEX_SIZE;
      canvas.style.position      = 'absolute';
      canvas.style.top           = '0';
      canvas.style.left          = '0';
      canvas.style.width         = SHADER_TEX_SIZE + 'px';
      canvas.style.height        = SHADER_TEX_SIZE + 'px';
      canvas.style.opacity       = '0';
      canvas.style.pointerEvents = 'none';
      canvas.dataset.spelecBspShader = '';
      canvas.setAttribute('data-fragment', fragSource);

      document.body.appendChild(canvas);

      let sandbox;
      try {
        sandbox = new window.GlslCanvas(canvas);
      } catch (err) {
        console.warn('[BSP] GlslCanvas init failed:', url, err.message);
        canvas.remove();
        return null;
      }

      if (!sandbox.isValid) {
        console.warn('[BSP] Shader failed to compile, skipping texture:', url);
        sandbox.destroy?.();
        canvas.remove();
        return null;
      }

      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace      = THREE.SRGBColorSpace;
      tex.minFilter       = THREE.LinearFilter;
      tex.magFilter       = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;

      _shaderList.push({ canvas, sandbox, tex });
      console.log(`[BSP] Shader texture ready: ${url}`);
      return tex;
    })
    .catch(err => {
      if (!silent) console.warn('[BSP] Shader texture load failed:', url, err.message);
      return null;
    });
}

// ── Animated texture loader ───────────────────────────────────────────────────
async function loadAnimatedTex(url, silent = false) {
  if (typeof ImageDecoder === 'undefined') {
    if (!silent) console.warn('[BSP] ImageDecoder not available, static fallback:', url);
    return loadStaticTex(url);
  }
  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    const ext     = url.substring(url.lastIndexOf('.')).toLowerCase();
    const typeMap = { '.gif': 'image/gif', '.avif': 'image/avif', '.webp': 'image/webp' };
    const type    = typeMap[ext] ?? 'image/gif';

    const probeDecoder = new ImageDecoder({
      data: new Blob([buffer], { type }).stream(), type, preferAnimation: true,
    });
    await probeDecoder.tracks.ready;
    const frameCount = probeDecoder.tracks.selectedTrack?.frameCount ?? 1;
    probeDecoder.close();
    if (frameCount <= 1) return loadStaticTex(url);

    console.log(`[BSP] Animated texture ${url}: ${frameCount} frames`);
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
    if (!frames.length) return loadStaticTex(url);

    const canvas = document.createElement('canvas');
    canvas.width  = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(frames[0].bitmap, 0, 0, w, h);

    const tex = new THREE.CanvasTexture(canvas);
    applyTexFilters(tex);
    tex.needsUpdate = true;

    _animList.push({ frames, canvas, ctx, tex, frameIdx: 0, nextFrameTime: performance.now() + frames[0].duration });
    return tex;
  } catch (err) {
    if (!silent) console.warn('[BSP] Animation load failed, fallback static:', url, err.message);
    return loadStaticTex(url);
  }
}

// ── Static texture loader ─────────────────────────────────────────────────────
function loadStaticTex(url) {
  return new Promise(res => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      res(null);
    }, TEX_PROBE_TIMEOUT_MS);

    _loader.load(url, tex => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      applyTexFilters(tex);
      res(tex);
    }, undefined, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res(null);
    });
  });
}

// ── Per-extension format dispatcher ──────────────────────────────────────────
function loadTexByExt(url, ext, silent = false) {
  if (VIDEO_EXTS.has(ext))  return loadVideoTex(url, silent);
  if (SHADER_EXTS.has(ext)) return loadShaderTex(url, silent);
  if (ANIM_EXTS.has(ext))   return loadAnimatedTex(url, silent);
  return loadStaticTex(url);
}

async function tryLoadTex(url) {
  if (_texCache.has(url)) return _texCache.get(url);
  const ext = url.substring(url.lastIndexOf('.')).toLowerCase();
  const tex = await loadTexByExt(url, ext);
  _texCache.set(url, tex);
  return tex;
}

// ── Generic texture loader for an arbitrary, already-known URL ───────────────
export async function loadTextureFromUrl(url) {
  if (_texCache.has(url)) return _texCache.get(url);
  const ext = url.substring(url.lastIndexOf('.')).toLowerCase();
  const tex = await loadTexByExt(url, ext);
  _texCache.set(url, tex);
  return tex;
}

// ── findTex — parallel format-priority probe (v5.9: with diagnostic stats) ───
// v5.9 adds per-call timing and probe counting on top of the v5.8 parallel
// logic. The actual probing behaviour is identical to v5.8 — only the
// instrumentation is new.
async function findTex(bases, name) {
  const t0 = performance.now();
  // Count how many individual load attempts this call will fire so we can
  // accumulate the total in _probeStats.requests.
  const activeBases = bases.filter(Boolean);
  _probeStats.requests += activeBases.length * TEX_EXTENSIONS.length;

  for (const base of activeBases) {
    const attempts = await Promise.all(
      TEX_EXTENSIONS.map(async ext => {
        const url = base + name + ext;
        if (_texCache.has(url)) {
          const cached = _texCache.get(url);
          return cached ? { url, tex: cached } : null;
        }
        const tex = await loadTexByExt(url, ext, /* silent */ true);
        _texCache.set(url, tex);
        return tex ? { url, tex } : null;
      })
    );

    const hit = attempts.find(a => a !== null);
    if (hit) {
      // Successful probe — record timing and return.
      const elapsed = performance.now() - t0;
      _probeStats.attempts++;
      _probeStats.resolved++;
      _probeStats.hitMs += elapsed;
      return hit.tex;
    }
  }

  // Nothing found in any base — whiteTex fallback will be used by caller.
  const elapsed = performance.now() - t0;
  _probeStats.attempts++;
  _probeStats.fallback++;
  _probeStats.missMs += elapsed;
  return null;
}

// ── Fallback white texture ────────────────────────────────────────────────────
const _whiteTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  c.getContext('2d').fillStyle = '#fff';
  c.getContext('2d').fillRect(0, 0, 1, 1);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  return t;
})();

// ── Shared invisible material ─────────────────────────────────────────────────
const _invisibleMat = new THREE.MeshBasicMaterial({
  colorWrite:  false,
  depthWrite:  false,
  transparent: true,
  opacity:     0,
  side:        THREE.DoubleSide,
});

// ── Worker runner ─────────────────────────────────────────────────────────────
async function fetchWorkerCode() {
  const loaderUrl  = import.meta.url;
  const loaderBase = loaderUrl.substring(0, loaderUrl.lastIndexOf('/') + 1);
  const localUrl   = loaderBase + 'bsp_worker.js';
  const remoteUrl  = 'https://spelecanton.github.io/Expore/javascript/bsp_worker.js';
  for (const url of [localUrl, remoteUrl]) {
    try {
      const r = await fetch(url);
      if (r.ok) { console.log('[BSP] Worker loaded from:', url); return await r.text(); }
    } catch { /* try next */ }
  }
  throw new Error('bsp_worker.js not found');
}

function runBSPWorker(buffer, textureBase, fallbackTexBase, onProgress) {
  return new Promise(async (resolve, reject) => {
    try {
      const code    = await fetchWorkerCode();
      const blob    = new Blob([code], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      const worker  = new Worker(blobUrl);
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress')   { onProgress?.(data.pct); }
        else if (data.type === 'done')  { worker.terminate(); URL.revokeObjectURL(blobUrl); resolve(data); }
        else if (data.type === 'error') { worker.terminate(); URL.revokeObjectURL(blobUrl); reject(new Error(`[BSP Worker] ${data.message}`)); }
      };
      worker.onerror = err => { worker.terminate(); URL.revokeObjectURL(blobUrl); reject(err); };
      worker.postMessage({ buffer, textureBase, fallbackTexBase }, [buffer]);
    } catch (err) { reject(err); }
  });
}

// ── Geometry merging with vertex budget splits ────────────────────────────────
const MAX_VERTS_PER_DRAW = 60000;

function buildGeometry(parts) {
  const geos = [];

  let currentParts = [];
  let currentVerts = 0;

  function flush() {
    if (!currentParts.length) return;

    let totalVerts   = 0;
    let totalIndices = 0;
    for (const b of currentParts) {
      totalVerts   += new Float32Array(b.pos).length / 3;
      totalIndices += new Uint32Array(b.idx).length;
    }

    const mergedPos = new Float32Array(totalVerts * 3);
    const mergedNrm = new Float32Array(totalVerts * 3);
    const mergedUV1 = new Float32Array(totalVerts * 2);
    const mergedUV2 = new Float32Array(totalVerts * 2);
    const mergedIdx = new Uint32Array(totalIndices);

    let vOffset = 0;
    let iOffset = 0;

    for (const b of currentParts) {
      const pos    = new Float32Array(b.pos);
      const nrm    = new Float32Array(b.nrm);
      const uv1    = new Float32Array(b.uv1);
      const uv2    = new Float32Array(b.uv2);
      const idx    = new Uint32Array(b.idx);
      const vCount = pos.length / 3;

      mergedPos.set(pos, vOffset * 3);
      mergedNrm.set(nrm, vOffset * 3);
      mergedUV1.set(uv1, vOffset * 2);
      mergedUV2.set(uv2, vOffset * 2);

      for (let i = 0; i < idx.length; i++) {
        mergedIdx[iOffset + i] = idx[i] + vOffset;
      }
      vOffset += vCount;
      iOffset += idx.length;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(mergedPos, 3));
    geo.setAttribute('normal',   new THREE.BufferAttribute(mergedNrm, 3));
    geo.setAttribute('uv',       new THREE.BufferAttribute(mergedUV1, 2));
    geo.setAttribute('uv1',      new THREE.BufferAttribute(mergedUV2, 2));
    geo.setIndex(new THREE.BufferAttribute(mergedIdx, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    buildBVH(geo);

    geos.push(geo);
    currentParts = [];
    currentVerts = 0;
  }

  for (const b of parts) {
    const vCount = new Float32Array(b.pos).length / 3;
    if (currentVerts + vCount > MAX_VERTS_PER_DRAW && currentVerts > 0) {
      flush();
    }
    currentParts.push(b);
    currentVerts += vCount;
  }
  flush();

  return geos;
}

function mergeBatchGeometries(batches) {
  const groups = new Map();

  for (const b of batches) {
    const key = `${b.texIdx}|${b.lmIdx}|${b.noclip ? 1 : 0}|${b.invisible ? 1 : 0}`;
    if (!groups.has(key)) {
      groups.set(key, {
        texIdx:    b.texIdx,
        lmIdx:     b.lmIdx,
        noclip:    b.noclip,
        invisible: b.invisible,
        hasLM:     b.hasLM,
        parts:     [],
      });
    }
    groups.get(key).parts.push(b);
  }

  const merged = [];
  for (const [, group] of groups) {
    const geos = buildGeometry(group.parts);
    for (const geo of geos) {
      merged.push({
        geo,
        texIdx:    group.texIdx,
        lmIdx:     group.lmIdx,
        noclip:    group.noclip,
        invisible: group.invisible,
        hasLM:     group.hasLM,
      });
    }
  }
  return merged;
}

// ── Yield helper ──────────────────────────────────────────────────────────────
function yieldToEventLoop() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ── Build meshes progressively ────────────────────────────────────────────────
async function buildMeshesProgressively(mergedBatches, texNames, lmTex, albedoMap, scene, onProgress) {
  let totalMeshes = 0, meshesWithLM = 0, noclipMeshes = 0, invisibleMeshes = 0;
  const pendingSwap = new Map();

  for (let i = 0; i < mergedBatches.length; i++) {
    if (i > 0 && i % MESH_YIELD_EVERY === 0) {
      onProgress?.(90 + (i / mergedBatches.length) * 10);
      await yieldToEventLoop();
    }

    const b    = mergedBatches[i];
    const name = texNames[b.texIdx] || 'default';
    let mat;

    if (b.invisible) {
      mat = _invisibleMat;
    } else {
      const tex = albedoMap.get(name) ?? null;
      mat = new THREE.MeshLambertMaterial({
        map:       tex ?? _whiteTex,
        side:      THREE.DoubleSide,
        alphaTest: 0.5,
      });
      if (!tex) {
        if (!pendingSwap.has(name)) pendingSwap.set(name, []);
        pendingSwap.get(name).push(mat);
      }
    }

    const mesh = new THREE.Mesh(b.geo, mat);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.frustumCulled = true;

    if (b.invisible) {
      mesh.userData.invisible = true;
      invisibleMeshes++;
    }
    if (b.noclip) {
      mesh.userData.noclip = true;
      noclipMeshes++;
    }
    if (b.hasLM && lmTex && !b.invisible) {
      mat.lightMap          = lmTex;
      mat.lightMapIntensity = 1.0;
      meshesWithLM++;
    }

    scene.add(mesh);
    totalMeshes++;
  }

  console.log(
    `[BSP] Meshes: ${totalMeshes} total, with lightmap: ${meshesWithLM},` +
    ` noclip: ${noclipMeshes}, invisible clip: ${invisibleMeshes}`
  );

  return { totalMeshes, pendingSwap };
}

// ── Batch texture loader ──────────────────────────────────────────────────────
const INITIAL_BATCHES = 1;

async function loadTexturesInBatches(uniqueNames, texBases, onProgress, pendingSwapRef) {
  const albedoMap = new Map();
  const total     = uniqueNames.length;

  for (let i = 0; i < total; i += TEXTURE_BATCH_SIZE) {
    const chunk = uniqueNames.slice(i, i + TEXTURE_BATCH_SIZE);
    await Promise.all(chunk.map(async name => {
      const tex = await findTex(texBases, name);
      albedoMap.set(name, tex || _whiteTex);

      if (pendingSwapRef && tex) {
        const mats = pendingSwapRef.get(name);
        if (mats) {
          for (const mat of mats) {
            mat.map = tex;
            mat.needsUpdate = true;
          }
          pendingSwapRef.delete(name);
        }
      }
    }));
    onProgress?.(82 + ((i + chunk.length) / total) * 8);
  }

  return albedoMap;
}

// ── Main loader ───────────────────────────────────────────────────────────────
export async function loadBSP({
  url,
  scene,
  textureBase     = '',
  fallbackTexBase = '',
  onProgress      = null,
}) {
  // ── Phase timing helpers (v5.9) ───────────────────────────────────────────
  // ms() returns a formatted elapsed-time string from a previous timestamp.
  // phase() logs a labelled phase line and returns the current timestamp for
  // use as the start of the next phase.
  const ms   = t  => `${(performance.now() - t).toFixed(0)} ms`;
  const phase = (label, t, extra = '') => {
    const elapsed = (performance.now() - t).toFixed(0);
    console.log(`[BSP] ⏱  ${label.padEnd(30)} ${String(elapsed).padStart(6)} ms${extra ? '  — ' + extra : ''}`);
    return performance.now();
  };

  const tTotal = performance.now();
  console.log('[BSP] ════════════════════════════════════════ LOAD START');

  // ── Phase 1: fetch BSP + decode ArrayBuffer ───────────────────────────────
  onProgress?.(0);
  let t = performance.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`BSP fetch failed: ${url} (${res.status})`);
  const buffer = await res.arrayBuffer();
  const sizeMB = (buffer.byteLength / 1048576).toFixed(2);
  t = phase('BSP download + decode', t, `${sizeMB} MB`);
  onProgress?.(5);

  // ── Phase 2: BSP worker (parse + build batches) ───────────────────────────
  const parsed = await runBSPWorker(
    buffer, textureBase, fallbackTexBase,
    pct => onProgress?.(5 + pct * 0.75)
  );
  const { portals, playerStart, ambientIntensity, ambientColorArr, texNames, lmAtlas, batches } = parsed;
  t = phase('BSP Worker parse', t,
    `${batches.length} raw batches, ${[...new Set(batches.map(b => b.texIdx))].length} tex refs`);

  // ── Phase 3: lightmap DataTexture ─────────────────────────────────────────
  let lmTex = null;
  if (lmAtlas) {
    if (lmAtlas.nonZero === 0) {
      console.warn('[BSP] No lightmap — baked light missing.');
    } else {
      console.log(`[BSP] Lightmap atlas ${lmAtlas.W}×${lmAtlas.H}, non-zero: ${lmAtlas.nonZero}`);
    }

    const atlasArr   = new Uint8Array(lmAtlas.data);
    lmTex            = new THREE.DataTexture(atlasArr, lmAtlas.W, lmAtlas.H, THREE.RGBAFormat);
    lmTex.colorSpace = THREE.SRGBColorSpace;
    lmTex.channel    = 1;

    const atlasTooBig = lmAtlas.W > MAX_ATLAS_MIPMAP || lmAtlas.H > MAX_ATLAS_MIPMAP;
    if (atlasTooBig) {
      console.warn(
        `[BSP] Atlas ${lmAtlas.W}×${lmAtlas.H} exceeds ${MAX_ATLAS_MIPMAP}px — mipmaps disabled.` +
        ` Consider -lightmapsize 128 in q3map2.`
      );
      lmTex.generateMipmaps = false;
      lmTex.minFilter       = THREE.LinearFilter;
    } else {
      lmTex.generateMipmaps = true;
      lmTex.minFilter       = THREE.LinearMipmapLinearFilter;
    }

    lmTex.magFilter  = THREE.LinearFilter;
    lmTex.anisotropy = _maxAniso;
    lmTex.wrapS = lmTex.wrapT = THREE.ClampToEdgeWrapping;
    setTimeout(() => { lmTex.needsUpdate = true; }, 0);
  }
  t = phase('Lightmap DataTexture', t, lmAtlas ? `${lmAtlas.W}×${lmAtlas.H}` : 'none');

  // ── Phase 4: geometry merge (CPU) ─────────────────────────────────────────
  console.log(`[BSP] Merging ${batches.length} batches (vertex budget: ${MAX_VERTS_PER_DRAW})...`);
  const mergedBatches = mergeBatchGeometries(batches);
  t = phase('Geometry merge', t,
    `${batches.length} → ${mergedBatches.length} draw calls`);

  // ── Phase 5: initial texture batch (BLOCKING — holds up first frame) ──────
  const texBases    = [textureBase, fallbackTexBase];
  const uniqueNames = [...new Set(batches.filter(b => !b.invisible).map(b => texNames[b.texIdx] || 'default'))];
  const initialNames = uniqueNames.slice(0, INITIAL_BATCHES * TEXTURE_BATCH_SIZE);

  console.log(`[BSP] Unique textures: ${uniqueNames.length}  |  initial (blocking): ${initialNames.length}`);
  console.log(`[BSP] Probe candidates per texture: ${texBases.filter(Boolean).length} base(s) × ${TEX_EXTENSIONS.length} ext(s) = ${texBases.filter(Boolean).length * TEX_EXTENSIONS.length} requests`);

  const albedoMap = new Map();
  await Promise.all(initialNames.map(async name => {
    const tex = await findTex(texBases, name);
    albedoMap.set(name, tex || _whiteTex);
  }));
  t = phase('Initial texture batch', t,
    `${initialNames.length} textures, ${_probeStats.resolved}/${_probeStats.attempts} resolved`);
  onProgress?.(82);

  // ── Phase 6: mesh build (GPU uploads, yields every MESH_YIELD_EVERY) ──────
  const { pendingSwap } = await buildMeshesProgressively(
    mergedBatches, texNames, lmTex, albedoMap, scene, onProgress
  );
  t = phase('Mesh build (initial)', t, `${mergedBatches.length} draw calls → scene`);

  onProgress?.(100);

  // ── Summary report (v5.9) ─────────────────────────────────────────────────
  const totalBlockingMs = (performance.now() - tTotal).toFixed(0);
  const avgProbeMs = _probeStats.attempts > 0
    ? (_probeStats.hitMs + _probeStats.missMs) / _probeStats.attempts
    : 0;

  console.log('[BSP] ════════════════════════════════════════ LOAD SUMMARY');
  console.log(`[BSP] Total time to first frame : ${totalBlockingMs} ms`);
  console.log('[BSP] Texture probe stats:');
  console.log(`[BSP]   unique names probed     : ${_probeStats.attempts}`);
  console.log(`[BSP]   resolved (real texture) : ${_probeStats.resolved}`);
  console.log(`[BSP]   fallback (not found)    : ${_probeStats.fallback}`);
  console.log(`[BSP]   total fetch attempts    : ${_probeStats.requests}`);
  console.log(`[BSP]   avg ms per texture      : ${avgProbeMs.toFixed(1)} ms`);
  console.log(`[BSP]   total probe time (hit)  : ${_probeStats.hitMs.toFixed(0)} ms`);
  console.log(`[BSP]   total probe time (miss) : ${_probeStats.missMs.toFixed(0)} ms`);
  console.log('[BSP] ════════════════════════════════════════════════════');

  // Background-load remaining textures (non-blocking, swap in as ready).
  const remainingNames = uniqueNames.slice(initialNames.length);
  if (remainingNames.length > 0) {
    console.log(`[BSP] Background-loading ${remainingNames.length} remaining textures...`);
    loadTexturesInBatches(remainingNames, texBases, null, pendingSwap).then(() => {
      const totalProbeMs = (_probeStats.hitMs + _probeStats.missMs).toFixed(0);
      console.log(`[BSP] ✓ All textures loaded — total probe time: ${totalProbeMs} ms`);
    }).catch(err => {
      console.warn('[BSP] Background texture load error:', err);
    });
  }

  const result = { portals, playerStart };
  if (ambientIntensity !== undefined) result.ambientIntensity = ambientIntensity;
  if (ambientColorArr)  result.ambientColor = new THREE.Color(...ambientColorArr);
  result.lights = parsed.lights ?? [];

  return result;
}
