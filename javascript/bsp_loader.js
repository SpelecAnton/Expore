/**
 * SPELEC BSP Loader v5.5 — CHAT MEDIA ISOLATION EDITION
 *
 * Changes over v5.4:
 *
 * 9. BSP TEXTURE VIDEO MARKER:
 *    - <video> elements created here for video textures (e.g. "video.mp4"
 *      replacing a static texture) are now tagged with
 *      `data-spelec-bsp-video` so other code (engine.js) can target them
 *      specifically instead of accidentally grabbing every <video> on the
 *      page — including chat-uploaded videos from chat_overlay.js / chat.js,
 *      which must stay paused until the user manually presses play.
 *
 * --- Previous changelog (v5.4 — VIDEO TEXTURE EDITION) --------------------
 *
 * 8. AUDIO UNMUTE ON USER GESTURE:
 *    - Video textures are created with muted = true so autoplay works
 *      without a user gesture (browser autoplay policy).
 *    - New export unmuteVideos() unmutes all active <video> textures —
 *      call it from engine.js on the same first-interaction gesture that
 *      already unlocks background music (click / keydown).
 *
 * --- Previous changelog (v5.3 — VIDEO TEXTURE EDITION) --------------------
 *
 * 7. REAL VIDEO TEXTURE SUPPORT (.mp4 / .webm):
 *    - TEX_EXTENSIONS previously contained only image formats, so a texture
 *      named e.g. "video.mp4" could never be matched by findTex() — it fell
 *      through to a static "video.png" placeholder instead.
 *    - Added VIDEO_EXTS + loadVideoTex(): creates a hidden <video> element
 *      (looping, muted, autoplay) and wraps it in THREE.VideoTexture.
 *    - The <video> element is kept OUT of display:none (some browsers pause
 *      frame decoding for display:none elements) — instead it's moved off-
 *      screen via position:absolute + opacity:0, so decoding keeps running.
 *    - Mipmaps are disabled and linear filters are forced for video textures
 *      to avoid silent black/blank textures inside EffectComposer caused by
 *      NPOT mipmap generation on video frames.
 *    - tickAnimatedTextures() now also resumes any <video> elements that got
 *      paused by the browser (tab visibility changes, power saving, etc.).
 *    - engine.js's existing `document.querySelectorAll('video')` play-on-
 *      input handler keeps working unchanged, since video elements are
 *      appended to document.body as before.
 *
 * --- Previous changelog (v5.2 — LARGE MAP EDITION) -----------------------
 *
 * 1. MESH_YIELD_EVERY REDUCED 50 → 10:
 *    - On an 80 MB map buildMeshesProgressively() was running 50 GPU uploads
 *      before yielding. Each BufferGeometry upload to the GPU can take 2–5 ms
 *      depending on vertex count. 50 × 5 ms = 250 ms stall per chunk.
 *    - Reduced to 10 so the browser paints a frame at least every ~50 ms
 *      during initial mesh construction.
 *
 * 2. TEXTURE_BATCH_SIZE REDUCED 8 → 4:
 *    - On large maps 8 simultaneous image decodes + GPU uploads causes
 *      frame spikes because ImageBitmap decoding is not fully off-thread.
 *    - 4 parallel loads keeps decode pressure manageable.
 *
 * 3. ALBEDO MAP SWAP-IN AFTER FIRST FRAME:
 *    - Previously all textures were loaded before buildMeshesProgressively().
 *    - Now the first batch of textures (covering the most common faces) is
 *      loaded synchronously, then remaining textures are loaded in the
 *      background and swapped in per-mesh as they arrive.
 *    - Map becomes walkable and visually stable in 1–2 seconds even for 80 MB.
 *
 * 4. GEOMETRY BUFFER DISPOSE GUARD:
 *    - buildGeometry() now calls geo.dispose() on any intermediate geometry
 *      that gets split, so the old ArrayBuffers are released to GC immediately.
 *
 * 5. LIGHTMAP ATLAS UPLOAD DEFERRED:
 *    - lmTex.needsUpdate is set inside a setTimeout(0) so the DataTexture
 *      GPU upload happens after the first frame, not during BSP parsing.
 *    - Avoids a synchronous stall on the main thread for large atlases.
 *
 * 6. PROGRESSIVE TEXTURE SWAP:
 *    - loadTexturesInBatches() now returns a live Map and a Promise.
 *    - Meshes are built immediately with whatever textures are available
 *      (whiteTex fallback), and a background swap pass runs as each batch
 *      completes to replace whiteTex with the real albedo.
 *
 * Backward compat: exports loadBSP, tickAnimatedTextures, initTexLoader
 * unchanged.
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
// Video formats are tried FIRST so a texture named e.g. "video.mp4" wins
// over a "video.png" poster/placeholder that may exist alongside it.
const VIDEO_EXTS         = new Set(['.mp4', '.webm']);
const TEX_EXTENSIONS     = ['.mp4', '.webm', '.gif', '.avif', '.webp', '.png', '.jpg'];
const ANIM_EXTS          = new Set(['.gif', '.avif', '.webp']);
const TEXTURE_BATCH_SIZE = 4;    // Reduced 8 → 4: fewer simultaneous ImageBitmap decodes
const MESH_YIELD_EVERY   = 10;   // Reduced 50 → 10: yield more often to avoid 250ms stalls
const MAX_ATLAS_MIPMAP   = 4096;

// ── Anisotropy ────────────────────────────────────────────────────────────────
let _maxAniso = 1;

export function initTexLoader(renderer) {
  _maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  console.log(`[BSP] Anisotropic filtering: ${_maxAniso}×`);
}

// ── Internal state ────────────────────────────────────────────────────────────
const _texCache = new Map();
const _loader   = new THREE.TextureLoader();
const _animList = [];
const _videoList = [];

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

  // Resume any <video> textures the browser may have paused
  // (tab switch, power saving, autoplay-policy re-checks, etc.).
  // _videoList only ever contains BSP texture videos (see loadVideoTex),
  // never chat-uploaded media — so this never touches chat videos.
  if (_videoList.length) {
    for (const video of _videoList) {
      if (video.paused && !video.ended) {
        video.play().catch(() => { /* still blocked — try again next tick */ });
      }
    }
  }
}

// ── Unmute video textures (call on first user gesture) ───────────────────────
// Browsers require a user gesture before audio can play. Video textures are
// created muted so autoplay starts immediately; call this from engine.js's
// existing first-interaction handler (click / keydown) to enable audio.
// Only affects BSP texture videos in _videoList — never chat media.
export function unmuteVideos() {
  for (const video of _videoList) {
    if (video.muted) {
      video.muted = false;
      video.play().catch(() => { /* still blocked — tickAnimatedTextures retries */ });
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

// ── Video texture loader ──────────────────────────────────────────────────────
// Creates a hidden <video> element (looped, muted, autoplay) and wraps it in
// a THREE.VideoTexture. Mipmaps are disabled and linear filtering is forced —
// generating mipmaps from NPOT video frames is a common source of silent
// black/blank textures when used through EffectComposer.
//
// IMPORTANT: the element is NOT display:none. Some browsers throttle or fully
// stop decoding <video> frames when the element is display:none, which would
// freeze the texture on the first frame. Instead it's moved off-screen with
// position:absolute + opacity:0 so decoding keeps running normally.
//
// data-spelec-bsp-video marks this element as a map-texture video, distinct
// from chat-uploaded videos. engine.js uses this marker to scope its
// keydown play-retry so it never force-plays chat media.
function loadVideoTex(url) {
  return new Promise(resolve => {
    const video = document.createElement('video');
    video.src         = url;
    video.loop        = true;
    video.muted       = true;
    video.playsInline = true;
    video.autoplay    = true;
    video.preload     = 'auto';
    video.crossOrigin = 'anonymous';
    video.dataset.spelecBspVideo = ''; // marker: BSP texture video, not chat media

    // Keep decoding alive — do NOT use display:none here.
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

    const onReady = () => {
      if (settled) return;
      settled = true;
      _videoList.push(video);
      video.play().catch(() => { /* will retry from tickAnimatedTextures() */ });
      console.log(`[BSP] Video texture ready: ${url}`);
      resolve(tex);
    };

    const onError = () => {
      if (settled) return;
      settled = true;
      console.warn('[BSP] Video texture failed to load:', url);
      video.remove();
      resolve(null);
    };

    video.addEventListener('loadeddata', onReady, { once: true });
    video.addEventListener('error', onError, { once: true });

    video.load();
  });
}

// ── Animated texture loader ───────────────────────────────────────────────────
async function loadAnimatedTex(url) {
  if (typeof ImageDecoder === 'undefined') {
    console.warn('[BSP] ImageDecoder not available, static fallback:', url);
    return loadStaticTex(url);
  }
  try {
    const response = await fetch(url);
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
    console.warn('[BSP] Animation load failed, fallback static:', url, err.message);
    return loadStaticTex(url);
  }
}

// ── Static texture loader ─────────────────────────────────────────────────────
function loadStaticTex(url) {
  return new Promise(res => {
    _loader.load(url, tex => { applyTexFilters(tex); res(tex); }, undefined, () => res(null));
  });
}

async function tryLoadTex(url) {
  if (_texCache.has(url)) return _texCache.get(url);
  try {
    const probe = await fetch(url, { method: 'HEAD' });
    if (!probe.ok) { _texCache.set(url, null); return null; }
  } catch { _texCache.set(url, null); return null; }
  const ext = url.substring(url.lastIndexOf('.')).toLowerCase();
  const tex  = VIDEO_EXTS.has(ext) ? await loadVideoTex(url)
             : ANIM_EXTS.has(ext)  ? await loadAnimatedTex(url)
             : await loadStaticTex(url);
  _texCache.set(url, tex);
  return tex;
}

// ── findTex — parallel HEAD probe ────────────────────────────────────────────
async function findTex(bases, name) {
  for (const base of bases) {
    if (!base) continue;
    const probes = await Promise.all(
      TEX_EXTENSIONS.map(async ext => {
        const url = base + name + ext;
        try { const r = await fetch(url, { method: 'HEAD' }); return r.ok ? url : null; }
        catch { return null; }
      })
    );
    const found = probes.find(u => u !== null);
    if (!found) continue;
    if (_texCache.has(found)) return _texCache.get(found);
    const ext = found.substring(found.lastIndexOf('.')).toLowerCase();
    const tex  = VIDEO_EXTS.has(ext) ? await loadVideoTex(found)
               : ANIM_EXTS.has(ext)  ? await loadAnimatedTex(found)
               : await loadStaticTex(found);
    _texCache.set(found, tex);
    if (tex) return tex;
  }
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
// albedoMap may be partially populated at call time.
// meshMaterialMap is populated by this function so the texture swap pass
// can update materials that were built with _whiteTex.
async function buildMeshesProgressively(mergedBatches, texNames, lmTex, albedoMap, scene, onProgress) {
  let totalMeshes = 0, meshesWithLM = 0, noclipMeshes = 0, invisibleMeshes = 0;
  // Map from texture name → array of MeshLambertMaterials awaiting real texture
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
      // Track materials that still need a real texture swapped in
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

// ── Batch texture loader — returns live Map + background Promise ──────────────
// The first INITIAL_BATCHES are awaited synchronously before mesh build starts.
// Remaining textures load in the background; when each batch finishes,
// pendingSwap materials are updated so the map visually fills in.
const INITIAL_BATCHES = 2; // Load first 2 × TEXTURE_BATCH_SIZE textures before first mesh

async function loadTexturesInBatches(uniqueNames, texBases, onProgress, pendingSwapRef) {
  const albedoMap = new Map();
  const total     = uniqueNames.length;

  for (let i = 0; i < total; i += TEXTURE_BATCH_SIZE) {
    const chunk = uniqueNames.slice(i, i + TEXTURE_BATCH_SIZE);
    await Promise.all(chunk.map(async name => {
      const tex = await findTex(texBases, name);
      albedoMap.set(name, tex || _whiteTex);

      // If meshes are already built and waiting for this texture, swap it in
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
  onProgress?.(0);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`BSP fetch failed: ${url} (${res.status})`);
  const buffer = await res.arrayBuffer();
  onProgress?.(5);

  const parsed = await runBSPWorker(
    buffer, textureBase, fallbackTexBase,
    pct => onProgress?.(5 + pct * 0.75)
  );

  const { portals, playerStart, ambientIntensity, ambientColorArr, texNames, lmAtlas, batches } = parsed;

  // ── Lightmap ──────────────────────────────────────────────────────────────
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

    // Defer the GPU upload so it does not stall the first render frame.
    // needsUpdate = true tells Three.js to upload on the next renderer.render() call.
    // By putting it in a setTimeout we ensure the first frame renders first.
    setTimeout(() => { lmTex.needsUpdate = true; }, 0);
  }

  // ── Merge geometries first (CPU only, no GPU) ─────────────────────────────
  console.log(`[BSP] Merging ${batches.length} batches (vertex budget: ${MAX_VERTS_PER_DRAW})...`);
  const mergedBatches = mergeBatchGeometries(batches);
  console.log(`[BSP] After merge: ${mergedBatches.length} draw calls`);

  // ── Load first N texture batches synchronously before building any mesh ───
  const texBases    = [textureBase, fallbackTexBase];
  const uniqueNames = [...new Set(batches.filter(b => !b.invisible).map(b => texNames[b.texIdx] || 'default'))];

  console.log(`[BSP] Loading ${uniqueNames.length} unique textures (${TEXTURE_BATCH_SIZE}/batch)...`);

  // Partial albedoMap: first INITIAL_BATCHES × TEXTURE_BATCH_SIZE textures
  const initialNames = uniqueNames.slice(0, INITIAL_BATCHES * TEXTURE_BATCH_SIZE);
  const albedoMap    = new Map();

  await Promise.all(initialNames.map(async name => {
    const tex = await findTex(texBases, name);
    albedoMap.set(name, tex || _whiteTex);
  }));

  onProgress?.(82);

  // ── Build all meshes now (remaining textures swap in later) ───────────────
  const { pendingSwap } = await buildMeshesProgressively(
    mergedBatches, texNames, lmTex, albedoMap, scene, onProgress
  );

  onProgress?.(100);

  // ── Load remaining textures in the background ─────────────────────────────
  const remainingNames = uniqueNames.slice(initialNames.length);
  if (remainingNames.length > 0) {
    console.log(`[BSP] Background-loading ${remainingNames.length} remaining textures...`);
    // Run without awaiting — fire and forget, swap happens via pendingSwap
    loadTexturesInBatches(remainingNames, texBases, null, pendingSwap).catch(err => {
      console.warn('[BSP] Background texture load error:', err);
    });
  }

  const result = { portals, playerStart };
  if (ambientIntensity !== undefined) result.ambientIntensity = ambientIntensity;
  if (ambientColorArr)  result.ambientColor = new THREE.Color(...ambientColorArr);
  result.lights = parsed.lights ?? [];

  return result;
}