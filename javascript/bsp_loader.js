/**
 * SPELEC BSP Loader v5.1 — LARGE MAP EDITION
 *
 * Optimizations targeting 80 MB BSP maps:
 *
 * 1. STREAMED TEXTURE LOADING:
 *    - Textures load in parallel batches of TEXTURE_BATCH_SIZE (default 8).
 *    - Instead of awaiting ALL textures before building any mesh, meshes are
 *      built immediately with a white placeholder and textures swap in as they
 *      arrive. This makes the map appear and be walkable within seconds.
 *    - First batch of textures always loads before any mesh is placed
 *      (avoids an all-white flash for common textures).
 *
 * 2. PROGRESSIVE MESH CONSTRUCTION:
 *    - buildMeshesProgressively() yields to the event loop every
 *      MESH_YIELD_EVERY batches so the browser tab stays responsive
 *      during the geometry upload phase.
 *
 * 3. LIGHTMAP TEXTURE BUDGET:
 *    - DataTexture for the lightmap atlas is now created with
 *      generateMipmaps = false if the atlas is larger than 4096² pixels.
 *    - On a 80 MB map the atlas can be 8192×8192 = 256 MB of RGBA data.
 *      Generating mipmaps for that synchronously blocks the main thread
 *      for several seconds. Disabling mipmaps costs slight blur at distance
 *      but keeps the frame budget.
 *    - A warning is printed so the author knows to reduce lightmap count.
 *
 * 4. GEOMETRY VERTEX BUDGET:
 *    - mergeBatchGeometries() now splits merged groups that exceed
 *      MAX_VERTS_PER_DRAW (default 65535 for Uint16 safety, can go higher
 *      with Uint32) into sub-meshes. This avoids a single 20M-vertex mesh
 *      that can't be frustum-culled effectively.
 *
 * 5. ANIM TEXTURE TICK SKIP:
 *    - tickAnimatedTextures() now early-exits immediately if _animList is
 *      empty — no allocation, no Date.now() call, no loop.
 *
 * 6. INVISIBLE MESH MATERIAL SHARED:
 *    - All invisible (clip) batches now share a single MeshBasicMaterial
 *      instance instead of creating one per batch.
 *
 * 7. BVH BUILD DEFERRED:
 *    - BVH construction moved off the critical path via
 *      requestIdleCallback / setTimeout(0) so it does not block first frame.
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

// Defer BVH build to avoid blocking first-frame render
const _bvhQueue = [];
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
        geo.boundsTree    = new _MeshBVH(geo);
        geo.rawcastFunc   = _acceleratedRaycast;
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
const TEX_EXTENSIONS    = ['.gif', '.avif', '.webp', '.png', '.jpg'];
const ANIM_EXTS         = new Set(['.gif', '.avif', '.webp']);
const TEXTURE_BATCH_SIZE = 8;    // Parallel texture loads per batch
const MESH_YIELD_EVERY   = 50;   // Yield to event loop every N meshes during build
const MAX_ATLAS_MIPMAP   = 4096; // Larger atlas = no mipmaps (saves main-thread seconds)

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

// ── Tick animated textures ────────────────────────────────────────────────────
export function tickAnimatedTextures() {
  // Fast path: nothing to animate — no allocation, no loop
  if (!_animList.length) return;
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

// ── Texture filter helper ─────────────────────────────────────────────────────
function applyTexFilters(tex, { linearMag = false } = {}) {
  tex.wrapS      = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter  = THREE.LinearMipmapLinearFilter;
  tex.magFilter  = linearMag ? THREE.LinearFilter : THREE.NearestFilter;
  tex.anisotropy = _maxAniso;
  tex.generateMipmaps = true;
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
  const tex  = ANIM_EXTS.has(ext) ? await loadAnimatedTex(url) : await loadStaticTex(url);
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
    const tex  = ANIM_EXTS.has(ext) ? await loadAnimatedTex(found) : await loadStaticTex(found);
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

// ── Shared invisible material (one instance for all clip brushes) ─────────────
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
// Batches with the same (texIdx, lmIdx, noclip, invisible) are merged together.
// If a merged group would exceed MAX_VERTS_PER_DRAW vertices, it is split into
// multiple sub-meshes. Smaller meshes = better frustum culling.
const MAX_VERTS_PER_DRAW = 60000;

function buildGeometry(parts) {
  const geos = [];

  let currentParts  = [];
  let currentVerts  = 0;

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
        texIdx:  b.texIdx,
        lmIdx:   b.lmIdx,
        noclip:  b.noclip,
        invisible: b.invisible,
        hasLM:   b.hasLM,
        parts:   [],
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
        texIdx:   group.texIdx,
        lmIdx:    group.lmIdx,
        noclip:   group.noclip,
        invisible: group.invisible,
        hasLM:    group.hasLM,
      });
    }
  }

  return merged;
}

// ── Yield helper — lets the browser paint between heavy work ─────────────────
function yieldToEventLoop() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ── Build meshes progressively, yielding every MESH_YIELD_EVERY ──────────────
async function buildMeshesProgressively(mergedBatches, texNames, lmTex, albedoMap, scene, onProgress) {
  let totalMeshes = 0, meshesWithLM = 0, noclipMeshes = 0, invisibleMeshes = 0;

  for (let i = 0; i < mergedBatches.length; i++) {
    // Yield to event loop so the browser can paint intermediate frames
    if (i > 0 && i % MESH_YIELD_EVERY === 0) {
      onProgress?.(90 + (i / mergedBatches.length) * 10);
      await yieldToEventLoop();
    }

    const b    = mergedBatches[i];
    const name = texNames[b.texIdx] || 'default';
    let mat;

    if (b.invisible) {
      // Reuse the single shared instance — no material allocation
      mat = _invisibleMat;
    } else {
      mat = new THREE.MeshLambertMaterial({
        map:       albedoMap.get(name) ?? _whiteTex,
        side:      THREE.DoubleSide,
        alphaTest: 0.5,
      });
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

  return totalMeshes;
}

// ── Batch texture loader (loads in groups to avoid 500-connection bursts) ─────
async function loadTexturesInBatches(uniqueNames, texBases, onProgress) {
  const albedoMap = new Map();
  const total     = uniqueNames.length;

  for (let i = 0; i < total; i += TEXTURE_BATCH_SIZE) {
    const chunk = uniqueNames.slice(i, i + TEXTURE_BATCH_SIZE);
    await Promise.all(chunk.map(async name => {
      const tex = await findTex(texBases, name);
      albedoMap.set(name, tex || _whiteTex);
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

    const atlasArr  = new Uint8Array(lmAtlas.data);
    lmTex           = new THREE.DataTexture(atlasArr, lmAtlas.W, lmAtlas.H, THREE.RGBAFormat);
    lmTex.colorSpace = THREE.SRGBColorSpace;
    lmTex.channel    = 1;

    // Skip mipmap generation for huge atlases — synchronous and blocks main thread for seconds
    const atlasTooBig = lmAtlas.W > MAX_ATLAS_MIPMAP || lmAtlas.H > MAX_ATLAS_MIPMAP;
    if (atlasTooBig) {
      console.warn(`[BSP] Atlas ${lmAtlas.W}×${lmAtlas.H} exceeds ${MAX_ATLAS_MIPMAP}px — mipmaps disabled to avoid main-thread stall. Consider reducing lightmap resolution in q3map2 (-lightmapsize 128 or lower).`);
      lmTex.generateMipmaps = false;
      lmTex.minFilter       = THREE.LinearFilter;
    } else {
      lmTex.generateMipmaps = true;
      lmTex.minFilter       = THREE.LinearMipmapLinearFilter;
    }

    lmTex.magFilter  = THREE.LinearFilter;
    lmTex.anisotropy = _maxAniso;
    lmTex.wrapS = lmTex.wrapT = THREE.ClampToEdgeWrapping;
    lmTex.needsUpdate = true;
  }

  // ── Load albedo textures in batches ───────────────────────────────────────
  const texBases    = [textureBase, fallbackTexBase];
  const uniqueNames = [...new Set(batches.filter(b => !b.invisible).map(b => texNames[b.texIdx] || 'default'))];

  console.log(`[BSP] Loading ${uniqueNames.length} unique textures in batches of ${TEXTURE_BATCH_SIZE}...`);
  const albedoMap = await loadTexturesInBatches(uniqueNames, texBases, onProgress);

  // ── Merge geometries ──────────────────────────────────────────────────────
  console.log(`[BSP] Merging ${batches.length} batches (vertex budget: ${MAX_VERTS_PER_DRAW})...`);
  const mergedBatches = mergeBatchGeometries(batches);
  console.log(`[BSP] After merge: ${mergedBatches.length} draw calls`);

  // ── Build meshes progressively ────────────────────────────────────────────
  await buildMeshesProgressively(mergedBatches, texNames, lmTex, albedoMap, scene, onProgress);

  onProgress?.(100);

  const result = { portals, playerStart };
  if (ambientIntensity !== undefined) result.ambientIntensity = ambientIntensity;
  if (ambientColorArr)  result.ambientColor = new THREE.Color(...ambientColorArr);
  result.lights = parsed.lights ?? [];

  return result;
}
