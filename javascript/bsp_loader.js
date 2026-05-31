/**
 * SPELEC BSP Loader v5 — BSP BRUSH COLLISION + WORKER EDITION
 *
 * Changes from v4:
 *   bspCollision is extracted from the worker result and passed through in
 *   the return value so engine.js can hand it to createPhysics().
 *   Physics no longer uses scene meshes for collision — pure BSP brush traces.
 *
 * Texture loading strategy:
 *   animated GIF/AVIF/WEBP → ImageDecoder API, all frames pre-decoded
 *   static PNG/JPG/AVIF/WEBP → TextureLoader
 *
 * Invisible clip textures (v4):
 *   Batches with invisible=true get mesh.visible = false (not rendered).
 *   Physics handles them automatically via BSP CONTENTS_PLAYERCLIP flags.
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';

// ── Configuration ─────────────────────────────────────────────────────────────
const TEX_EXTENSIONS = ['.gif', '.avif', '.webp', '.png', '.jpg'];
const ANIM_EXTS      = new Set(['.gif', '.avif', '.webp']);

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

export function tickAnimatedTextures() {
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

function applyTexFilters(tex, { linearMag = false } = {}) {
  tex.wrapS      = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter  = THREE.LinearMipmapLinearFilter;
  tex.magFilter  = linearMag ? THREE.LinearFilter : THREE.NearestFilter;
  tex.anisotropy = _maxAniso;
  tex.generateMipmaps = true;
}

// ── ImageDecoder loader ───────────────────────────────────────────────────────
async function loadAnimatedTex(url) {
  if (typeof ImageDecoder === 'undefined') return loadStaticTex(url);

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

    const decoder = new ImageDecoder({
      data: new Blob([buffer], { type }).stream(), type, preferAnimation: true,
    });
    await decoder.tracks.ready;

    const frames = [];
    let w = 0, h = 0;

    for (let i = 0; i < frameCount; i++) {
      const result   = await decoder.decode({ frameIndex: i });
      const img      = result.image;
      const duration = (img.duration != null ? img.duration / 1000 : 100);
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
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(frames[0].bitmap, 0, 0, w, h);

    const tex = new THREE.CanvasTexture(canvas);
    applyTexFilters(tex);
    tex.needsUpdate = true;

    _animList.push({
      frames, canvas, ctx, tex,
      frameIdx: 0,
      nextFrameTime: performance.now() + frames[0].duration,
    });

    return tex;

  } catch (err) {
    console.warn('[BSP] Animation failed, falling back to static:', url, err.message);
    return loadStaticTex(url);
  }
}

// ── Static texture ────────────────────────────────────────────────────────────
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
  } catch {
    _texCache.set(url, null); return null;
  }
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
        try {
          const r = await fetch(url, { method: 'HEAD' });
          return r.ok ? url : null;
        } catch { return null; }
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
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  return t;
})();

// ── Worker runner ─────────────────────────────────────────────────────────────
async function fetchWorkerCode() {
  const loaderUrl  = import.meta.url;
  const loaderBase = loaderUrl.substring(0, loaderUrl.lastIndexOf('/') + 1);
  const localUrl   = loaderBase + 'bsp_worker.js';
  const remoteUrl  = 'https://spelecanton.github.io/Expore/javascript/bsp_worker.js';

  for (const url of [localUrl, remoteUrl]) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        console.log('[BSP] Worker loaded from:', url);
        return await r.text();
      }
    } catch { /* try next */ }
  }
  throw new Error('bsp_worker.js not found (neither locally nor on GitHub)');
}

function runBSPWorker(buffer, textureBase, fallbackTexBase, onProgress) {
  return new Promise(async (resolve, reject) => {
    try {
      const code    = await fetchWorkerCode();
      const blob    = new Blob([code], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);

      const worker = new Worker(blobUrl);
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress')   { onProgress?.(data.pct); }
        else if (data.type === 'done')  { worker.terminate(); URL.revokeObjectURL(blobUrl); resolve(data); }
        else if (data.type === 'error') { worker.terminate(); URL.revokeObjectURL(blobUrl); reject(new Error(`[BSP Worker] ${data.message}`)); }
      };
      worker.onerror = err => { worker.terminate(); URL.revokeObjectURL(blobUrl); reject(err); };
      worker.postMessage({ buffer, textureBase, fallbackTexBase }, [buffer]);

    } catch (err) {
      reject(err);
    }
  });
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
    pct => onProgress?.(5 + pct * 0.80)
  );

  const { portals, playerStart, ambientIntensity, ambientColorArr, texNames, lmAtlas, batches } = parsed;

  // ── BSP Collision — reconstruct typed arrays from transferred ArrayBuffers ──
  // The worker transferred ownership of these buffers (zero-copy).
  // We wrap them in TypedArrays here; physics.js uses them for sphere traces.
  let bspCollision = null;
  if (parsed.bspCollision) {
    const bc = parsed.bspCollision;
    bspCollision = {
      planes:      new Float32Array(bc.planes),
      brushSides:  new Int32Array(bc.brushSides),
      brushes:     new Int32Array(bc.brushes),
      leafBrushes: new Int32Array(bc.leafBrushes),
      leafs:       new Int32Array(bc.leafs),
      nodes:       new Int32Array(bc.nodes),
    };
    console.log(
      `[BSP] Collision: ${bspCollision.nodes.length / 3} nodes,` +
      ` ${bspCollision.leafs.length / 2} leafs,` +
      ` ${bspCollision.brushes.length / 3} brushes,` +
      ` ${bspCollision.planes.length / 4} planes`
    );
  }

  // ── Lightmap ──────────────────────────────────────────────────────────────
  let lmTex = null;
  if (lmAtlas) {
    if (lmAtlas.nonZero === 0) console.warn('[BSP] No lightmap — Baked light missing.');
    else console.log(`[BSP] Lightmap atlas ${lmAtlas.W}×${lmAtlas.H}, non-zero: ${lmAtlas.nonZero}`);

    const atlasArr = new Uint8Array(lmAtlas.data);
    lmTex = new THREE.DataTexture(atlasArr, lmAtlas.W, lmAtlas.H, THREE.RGBAFormat);
    lmTex.colorSpace = THREE.SRGBColorSpace;
    lmTex.channel    = 1;
    lmTex.minFilter  = THREE.LinearMipmapLinearFilter;
    lmTex.magFilter  = THREE.LinearFilter;
    lmTex.anisotropy = _maxAniso;
    lmTex.generateMipmaps = true;
    lmTex.wrapS = lmTex.wrapT = THREE.ClampToEdgeWrapping;
    lmTex.needsUpdate = true;
  }

  // ── Albedo textures ───────────────────────────────────────────────────────
  const texBases = [textureBase, fallbackTexBase];

  const uniqueNames = [...new Set(
    batches
      .filter(b => !b.invisible)
      .map(b => texNames[b.texIdx] || 'default')
  )];

  const albedoMap = new Map();
  await Promise.all(uniqueNames.map(async name => {
    const tex = await findTex(texBases, name);
    albedoMap.set(name, tex || _whiteTex);
  }));

  onProgress?.(95);

  // ── Build meshes ──────────────────────────────────────────────────────────
  let totalMeshes = 0, meshesWithLM = 0, noclipMeshes = 0, invisibleMeshes = 0;

  for (const b of batches) {
    const pos = new Float32Array(b.pos);
    const nrm = new Float32Array(b.nrm);
    const uv1 = new Float32Array(b.uv1);
    const uv2 = new Float32Array(b.uv2);
    const idx = new Uint32Array(b.idx);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal',   new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv',       new THREE.BufferAttribute(uv1, 2));
    geo.setAttribute('uv1',      new THREE.BufferAttribute(uv2, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();

    const name = texNames[b.texIdx] || 'default';
    let mat;

    if (b.invisible) {
      // Invisible clip brush — not rendered, physics handled by BSP brushes directly
      mat = new THREE.MeshBasicMaterial({
        colorWrite: false,
        depthWrite: false,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
      });
    } else {
      mat = new THREE.MeshLambertMaterial({
        map:       albedoMap.get(name) ?? _whiteTex,
        side:      THREE.DoubleSide,
        alphaTest: 0.5,
      });
    }

    const mesh = new THREE.Mesh(geo, mat);

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
    `[BSP] Meshes: ${totalMeshes}, with lightmap: ${meshesWithLM},` +
    ` noclip: ${noclipMeshes}, invisible clip: ${invisibleMeshes}`
  );
  onProgress?.(100);

  // ── Return value ──────────────────────────────────────────────────────────
  const result = { portals, playerStart, bspCollision };
  if (ambientIntensity !== undefined) result.ambientIntensity = ambientIntensity;
  if (ambientColorArr)  result.ambientColor = new THREE.Color(...ambientColorArr);
  result.lights = parsed.lights ?? [];

  return result;
}
