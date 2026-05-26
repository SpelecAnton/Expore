/**
 * SPELEC BSP Loader v3 — WORKER EDITION + ANIMATED TEXTURES
 *
 * Strategie načítání textur:
 *   animované GIF/AVIF/WEBP → ImageDecoder API, všechny framy předekódovány
 *                              do ImageBitmap pole → tick je synchronní, bez async
 *   statické PNG/JPG/AVIF/WEBP (1 frame) → TextureLoader
 *
 * findTex: paralelní HEAD probe pro všechny přípony → rychlý loading
 *
 * v2 — func_wall / noclip:
 *   Batch s noclip=true dostane material.depthWrite = false
 *   → physics.js ho automaticky vynechá z kolizních objektů.
 *   Mesh je stále viditelný, jen bez kolize.
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';

// ── Konfigurace ───────────────────────────────────────────────────────────────
const TEX_EXTENSIONS = ['.gif', '.avif', '.webp', '.png', '.jpg'];
const ANIM_EXTS      = new Set(['.gif', '.avif', '.webp']);

// ── Interní state ─────────────────────────────────────────────────────────────
const _texCache = new Map();
const _loader   = new THREE.TextureLoader();

// Každý záznam: { frames: [{bitmap, duration}], canvas, ctx, tex, frameIdx, nextFrameTime }
const _animList = [];

// ── Tick — voláno každý frame z render loopu ──────────────────────────────────
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

// ── ImageDecoder loader ───────────────────────────────────────────────────────
async function loadAnimatedTex(url) {
  if (typeof ImageDecoder === 'undefined') {
    console.warn('[BSP] ImageDecoder is not available, static fallback:', url);
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
      data: new Blob([buffer], { type }).stream(),
      type,
      preferAnimation: true,
    });
    await probeDecoder.tracks.ready;
    const frameCount = probeDecoder.tracks.selectedTrack?.frameCount ?? 1;
    probeDecoder.close();

    if (frameCount <= 1) return loadStaticTex(url);

    console.log(`[BSP] Animated texture ${url}: ${frameCount} frames, decoding...`);

    const decoder = new ImageDecoder({
      data: new Blob([buffer], { type }).stream(),
      type,
      preferAnimation: true,
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
    canvas.width  = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(frames[0].bitmap, 0, 0, w, h);

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS       = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace  = THREE.SRGBColorSpace;
    tex.needsUpdate = true;

    _animList.push({
      frames,
      canvas,
      ctx,
      tex,
      frameIdx:      0,
      nextFrameTime: performance.now() + frames[0].duration,
    });

    return tex;

  } catch (err) {
    console.warn('[BSP] Animation is not working, showing static picture instead:', url, err.message);
    return loadStaticTex(url);
  }
}

// ── Statická textura ──────────────────────────────────────────────────────────
function loadStaticTex(url) {
  return new Promise(res => {
    _loader.load(
      url,
      tex => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        res(tex);
      },
      undefined,
      () => res(null)
    );
  });
}

// ── tryLoadTex ────────────────────────────────────────────────────────────────
async function tryLoadTex(url) {
  if (_texCache.has(url)) return _texCache.get(url);

  try {
    const probe = await fetch(url, { method: 'HEAD' });
    if (!probe.ok) { _texCache.set(url, null); return null; }
  } catch {
    _texCache.set(url, null);
    return null;
  }

  const ext = url.substring(url.lastIndexOf('.')).toLowerCase();
  const tex  = ANIM_EXTS.has(ext)
    ? await loadAnimatedTex(url)
    : await loadStaticTex(url);

  _texCache.set(url, tex);
  return tex;
}

// ── findTex — paralelní HEAD probe ────────────────────────────────────────────
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
    const tex  = ANIM_EXTS.has(ext)
      ? await loadAnimatedTex(found)
      : await loadStaticTex(found);

    _texCache.set(found, tex);
    if (tex) return tex;
  }
  return null;
}

// ── Fallback bílá textura ─────────────────────────────────────────────────────
const _whiteTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  c.getContext('2d').fillStyle = '#fff';
  c.getContext('2d').fillRect(0, 0, 1, 1);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

// ── Worker runner ─────────────────────────────────────────────────────────────
// Zkusí načíst worker v tomto pořadí:
//   1. Relativní cesta vedle loaderu (lokální dev)
//   2. GitHub CDN (produkce)
async function fetchWorkerCode() {
  // Zjisti base URL tohoto modulu — worker hledáme vedle něj
  const loaderUrl  = import.meta.url;
  const loaderBase = loaderUrl.substring(0, loaderUrl.lastIndexOf('/') + 1);
  const localUrl   = loaderBase + 'bsp_worker.js';
  const remoteUrl  = 'https://spelecanton.github.io/Expore/javascript/bsp_worker.js';

  for (const url of [localUrl, remoteUrl]) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        console.log('[BSP] Worker načten z:', url);
        return await r.text();
      }
    } catch { /* zkusíme další */ }
  }
  throw new Error('bsp_worker.js nenalezen (ani lokálně ani na GitHubu)');
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

  // ── Lightmap ──────────────────────────────────────────────────────────────
  let lmTex = null;
  if (lmAtlas) {
    if (lmAtlas.nonZero === 0) console.warn('[BSP] No lightmap — Baked light missing.');
    else console.log(`[BSP] Lightmap atlas ${lmAtlas.W}×${lmAtlas.H}, non-zero: ${lmAtlas.nonZero}`);

    const atlasArr = new Uint8Array(lmAtlas.data);
    lmTex = new THREE.DataTexture(atlasArr, lmAtlas.W, lmAtlas.H, THREE.RGBAFormat);
    lmTex.colorSpace  = THREE.SRGBColorSpace;
    lmTex.channel     = 1;
    lmTex.needsUpdate = true;
    lmTex.wrapS = lmTex.wrapT = THREE.ClampToEdgeWrapping;
    lmTex.minFilter = lmTex.magFilter = THREE.LinearFilter;
  }

  // ── Albedo textury ────────────────────────────────────────────────────────
  const texBases    = [textureBase, fallbackTexBase];
  const uniqueNames = [...new Set(batches.map(b => texNames[b.texIdx] || 'default'))];
  const albedoMap   = new Map();

  await Promise.all(uniqueNames.map(async name => {
    const tex = await findTex(texBases, name);
    albedoMap.set(name, tex || _whiteTex);
  }));

  onProgress?.(95);

  // ── Build meshů ───────────────────────────────────────────────────────────
  let totalMeshes = 0, meshesWithLM = 0, noclipMeshes = 0;

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

    const name   = texNames[b.texIdx] || 'default';
    const albedo = albedoMap.get(name);

    const mat = new THREE.MeshLambertMaterial({
      map:       albedo,
      side:      THREE.DoubleSide,
      alphaTest: 0.5,
    });

    // ── Noclip (func_wall apod.) ──────────────────────────────────────────
    // userData.noclip = true → physics.js ho přeskočí při buildování collidables
    // Material je normální — depthWrite zapnutý, žádný z-fighting.
    const mesh = new THREE.Mesh(geo, mat);
    if (b.noclip) {
      mesh.userData.noclip = true;
      noclipMeshes++;
    }

    if (b.hasLM && lmTex) {
      mat.lightMap          = lmTex;
      mat.lightMapIntensity = 1.0;
      meshesWithLM++;
    }

    scene.add(mesh);
    totalMeshes++;
  }

  console.log(`[BSP] Meshes: ${totalMeshes}, s lightmapou: ${meshesWithLM}, noclip: ${noclipMeshes}`);
  onProgress?.(100);

  const result = { portals, playerStart };
  if (ambientIntensity !== undefined) result.ambientIntensity = ambientIntensity;
  if (ambientColorArr)  result.ambientColor = new THREE.Color(...ambientColorArr);
  return result;
}
