/**
 * SPELEC BSP Loader v5.8 — VIDEO TEXTURES via DataTexture + getImageData
 *
 * Texture loading strategy:
 *   video WebM/MP4            → hidden <video> + hidden <canvas> → DataTexture (Uint8Array)
 *                               Each tick: ctx.drawImage(video) → getImageData → tex.image.data copy → needsUpdate
 *                               DataTexture has no special internal handling in Three.js — 100% safe with EffectComposer.
 *   animated GIF/AVIF/WEBP   → ImageDecoder API → CanvasTexture (manual needsUpdate)
 *   static PNG/JPG/AVIF/WEBP → TextureLoader
 *
 * Extension probe priority: .webm → .mp4 → .gif → .avif → .webp → .png → .jpg
 *
 * v5.2 FIX: removed CanvasTexture for video.
 *   Three.js 0.165 setTexture2D() calls updateVideoTexture() / texture.update()
 *   when it detects an HTMLVideoElement as texture.image source — even indirectly.
 *   Using DataTexture completely bypasses this code path.
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';

// ── Configuration ─────────────────────────────────────────────────────────────
const VIDEO_EXTS     = ['.webm', '.mp4'];
const ANIM_EXTS      = new Set(['.gif', '.avif', '.webp']);
const VIDEO_EXTS_SET = new Set(VIDEO_EXTS);
const TEX_EXTENSIONS = ['.webm', '.mp4', '.gif', '.avif', '.webp', '.png', '.jpg'];

// ── Codec sniff ───────────────────────────────────────────────────────────────
const _videoSupport = (() => {
  const v = document.createElement('video');
  return {
    webm: v.canPlayType('video/webm; codecs="av01.0.00M.08"') !== '' ||
          v.canPlayType('video/webm; codecs="vp9"')           !== '' ||
          v.canPlayType('video/webm')                          !== '',
    mp4:  v.canPlayType('video/mp4; codecs="avc1.42E01E"')    !== '' ||
          v.canPlayType('video/mp4')                           !== '',
  };
})();
console.log(`[BSP] Video support — WebM: ${_videoSupport.webm}, MP4: ${_videoSupport.mp4}`);

// ── Anisotropy ────────────────────────────────────────────────────────────────
let _maxAniso = 1;
export function initTexLoader(renderer) {
  _maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  console.log(`[BSP] Anisotropic filtering: ${_maxAniso}×`);
}

// ── Internal state ────────────────────────────────────────────────────────────
const _texCache        = new Map();
const _loader          = new THREE.TextureLoader();
const _animList        = []; // GIF/AVIF/WEBP canvas entries
const _videoDataList   = []; // video → DataTexture entries
window._bspVideoDebug  = _videoDataList; // exposed for console debugging

// ── Tick ──────────────────────────────────────────────────────────────────────
export function tickAnimatedTextures() {
  const now = performance.now();

  // Animated images (GIF/AVIF/WEBP)
  for (const anim of _animList) {
    if (now < anim.nextFrameTime) continue;
    const frame = anim.frames[anim.frameIdx];
    anim.ctx.clearRect(0, 0, anim.canvas.width, anim.canvas.height);
    anim.ctx.drawImage(frame.bitmap, 0, 0, anim.canvas.width, anim.canvas.height);
    anim.tex.needsUpdate = true;
    anim.frameIdx      = (anim.frameIdx + 1) % anim.frames.length;
    anim.nextFrameTime = now + frame.duration;
  }

  // Video: draw into canvas → read pixels → copy into DataTexture buffer.
  for (const entry of _videoDataList) {
    const v = entry.video;

    // One-time debug log per entry
    if (!entry._debugged) {
      entry._debugged = true;
      console.log('[BSP VIDEO DEBUG]',
        'readyState:', v.readyState,
        'paused:', v.paused,
        'muted:', v.muted,
        'currentTime:', v.currentTime,
        'error:', v.error,
        'src:', v.src.slice(-40)
      );
      // Attach visible debug canvas to page corner to confirm decode
      const dbgCanvas = document.createElement('canvas');
      dbgCanvas.width  = 320;
      dbgCanvas.height = 180;
      dbgCanvas.style.cssText = 'position:fixed;bottom:8px;right:8px;width:320px;height:180px;z-index:9999;border:2px solid red;background:#000;';
      document.body.appendChild(dbgCanvas);
      entry._dbgCanvas = dbgCanvas;
      entry._dbgCtx    = dbgCanvas.getContext('2d');
    }

    if (v.readyState < 2) continue;

    const { ctx, W, H, tex } = entry;
    ctx.save();
    ctx.translate(0, H);
    ctx.scale(1, -1);
    ctx.drawImage(v, 0, 0, W, H);
    ctx.restore();
    // Write directly into the DataTexture's own buffer — avoids aliasing issues
    // where Three.js might hold a different reference than our local pixelBuf.
    tex.image.data.set(ctx.getImageData(0, 0, W, H).data);
    tex.needsUpdate = true;

    // Mirror to debug canvas (not flipped — for human readability)
    if (entry._dbgCtx) {
      entry._dbgCtx.drawImage(v, 0, 0, 320, 180);
    }
  }
}

// ── Texture filter helper ─────────────────────────────────────────────────────
function applyTexFilters(tex, { linearMag = false, mipmaps = true } = {}) {
  tex.wrapS      = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter  = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.magFilter  = linearMag ? THREE.LinearFilter : THREE.NearestFilter;
  tex.anisotropy = _maxAniso;
  tex.generateMipmaps = mipmaps;
}

// ── Video texture loader ──────────────────────────────────────────────────────
/**
 * Returns a THREE.DataTexture backed by a Uint8Array pixel buffer.
 * tickAnimatedTextures() copies decoded video pixels into the buffer each frame.
 * DataTexture has no special-casing in Three.js internals — works fine with EffectComposer.
 */
/**
 * Determine the "intended" texture size that Q3 editor used when baking UV coords.
 * Strategy (in priority order):
 *  1. WxH hint in filename:  screen_320x180.webm  → { w:320, h:180 }
 *  2. Companion JSON sidecar: screen.json = {"w":320,"h":180}
 *  3. Static image probe: load screen.png / .jpg and read naturalWidth/naturalHeight
 *  4. Fallback: null → repeat=(1,1)
 */
async function getVideoTargetSize(url, bases, texName) {
  // 1. WxH hint in filename
  const base     = url.substring(0, url.lastIndexOf('.'));
  const hinMatch = base.match(/_(\d+)[xX](\d+)$/);
  if (hinMatch) return { w: parseInt(hinMatch[1], 10), h: parseInt(hinMatch[2], 10) };

  // 2. Companion JSON sidecar
  try {
    const r = await fetch(base + '.json');
    if (r.ok) {
      const d = await r.json();
      if (d.w && d.h) return { w: d.w, h: d.h };
    }
  } catch { /* no sidecar */ }

  // 3. Probe static image with same texture name — read natural dimensions.
  // These are the dimensions Q3 editor saw when it built the UV coords.
  const STATIC_EXTS = ['.png', '.jpg', '.webp', '.avif'];
  for (const staticBase of bases) {
    if (!staticBase) continue;
    for (const ext of STATIC_EXTS) {
      const imgUrl = staticBase + texName + ext;
      try {
        const probe = await fetch(imgUrl, { method: 'HEAD' });
        if (!probe.ok) continue;
        // Load image to get naturalWidth/naturalHeight
        const size = await new Promise(res => {
          const img = new Image();
          img.onload  = () => res({ w: img.naturalWidth, h: img.naturalHeight });
          img.onerror = () => res(null);
          img.src = imgUrl;
        });
        if (size && size.w > 0) {
          console.log(`[BSP] Video UV reference: ${imgUrl} (${size.w}×${size.h})`);
          return size;
        }
      } catch { /* try next */ }
    }
  }

  return null;
}

async function loadVideoTex(url, bases = [], texName = '') {
  const ext = url.substring(url.lastIndexOf('.')).toLowerCase();
  if (ext === '.webm' && !_videoSupport.webm) { console.warn('[BSP] WebM not supported:', url); return null; }
  if (ext === '.mp4'  && !_videoSupport.mp4)  { console.warn('[BSP] MP4 not supported:', url);  return null; }

  // Fetch target size hint before starting video (non-blocking if no sidecar)
  const targetSize = await getVideoTargetSize(url, bases, texName);

  return new Promise(resolve => {
    const video       = document.createElement('video');
    video.src         = url;
    video.loop        = true;
    video.muted       = true;
    video.autoplay    = true;
    video.playsInline = true;
    // 2×2 keeps the element alive for decode without showing it
    video.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:2px;height:2px;opacity:0;pointer-events:none;';
    document.body.appendChild(video);

    let resolved = false;

    const done = (ok) => {
      if (resolved) return;
      resolved = true;
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('error',   onError);

      if (!ok) { document.body.removeChild(video); resolve(null); return; }

      const W = video.videoWidth  || 512;
      const H = video.videoHeight || 512;

      // Off-screen canvas for pixel readback — never attached to DOM
      const canvas  = document.createElement('canvas');
      canvas.width  = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      // Draw first frame now so the texture has valid data on frame 0.
      // Flip vertically here since DataTexture uses flipY=false.
      ctx.save();
      ctx.translate(0, H);
      ctx.scale(1, -1);
      ctx.drawImage(video, 0, 0, W, H);
      ctx.restore();
      const firstFrame = ctx.getImageData(0, 0, W, H);

      // DataTexture owns its own Uint8Array — no canvas reference in .image
      // DataTexture takes ownership of the Uint8Array.
      // We always write into tex.image.data directly — never a separate copy —
      // so Three.js always reads the latest pixels without buffer aliasing issues.
      const pixelBuf = new Uint8Array(W * H * 4);
      pixelBuf.set(firstFrame.data);
      const tex = new THREE.DataTexture(pixelBuf, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.wrapS       = THREE.RepeatWrapping;
      tex.wrapT       = THREE.RepeatWrapping;
      tex.minFilter   = THREE.LinearFilter;
      tex.magFilter   = THREE.LinearFilter;
      tex.colorSpace  = THREE.SRGBColorSpace;
      tex.generateMipmaps = false;
      tex.flipY       = false;
      tex.anisotropy  = _maxAniso;
      tex.needsUpdate = true;
      tex._isBspVideo = true;

      // Set UV repeat so UV=1.0 corresponds to targetSize pixels.
      // If targetSize is null, repeat=(1,1) which means full video = one tile.
      if (targetSize && targetSize.w > 0 && targetSize.h > 0) {
        tex.repeat.set(W / targetSize.w, H / targetSize.h);
        console.log(`[BSP] Video DataTexture ready: ${url} (${W}×${H}), target: ${targetSize.w}×${targetSize.h}, repeat: ${(W/targetSize.w).toFixed(2)}×${(H/targetSize.h).toFixed(2)}`);
      } else {
        tex.repeat.set(1, 1);
        console.log(`[BSP] Video DataTexture ready: ${url} (${W}×${H}), repeat: 1×1 (no hint found)`);
      }

      _videoDataList.push({ video, canvas, ctx, W, H, tex });
      resolve(tex);
    };

    const onCanPlay = () => done(true);
    const onPlaying = () => done(true);
    const onError   = () => { console.warn('[BSP] Video error:', url); done(false); };

    video.addEventListener('canplay', onCanPlay, { once: true });
    video.addEventListener('playing', onPlaying, { once: true });
    video.addEventListener('error',   onError,   { once: true });

    video.play().catch(() => {
      console.warn('[BSP] Autoplay blocked, waiting for user interaction:', url);
    });

    setTimeout(() => { if (!resolved) { console.warn('[BSP] Video timeout:', url); done(false); } }, 8000);
  });
}

// ── Resume videos after user gesture ─────────────────────────────────────────
(function attachVideoResume() {
  const resume = () => {
    for (const { video } of _videoDataList) {
      if (video.paused) video.play().catch(() => {});
    }
  };
  ['click', 'keydown', 'touchstart'].forEach(e =>
    window.addEventListener(e, resume, { once: false, passive: true })
  );
})();

// ── Animated image loader (GIF / AVIF / WEBP) ────────────────────────────────
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

    const probe = new ImageDecoder({ data: new Blob([buffer], { type }).stream(), type, preferAnimation: true });
    await probe.tracks.ready;
    const frameCount = probe.tracks.selectedTrack?.frameCount ?? 1;
    probe.close();

    if (frameCount <= 1) return loadStaticTex(url);

    console.log(`[BSP] Animated ${url}: ${frameCount} frames`);
    const decoder = new ImageDecoder({ data: new Blob([buffer], { type }).stream(), type, preferAnimation: true });
    await decoder.tracks.ready;

    const frames = [];
    let w = 0, h = 0;
    for (let i = 0; i < frameCount; i++) {
      const result   = await decoder.decode({ frameIndex: i });
      const img      = result.image;
      const duration = img.duration != null ? img.duration / 1000 : 100;
      if (i === 0) { w = img.displayWidth || img.codedWidth || 128; h = img.displayHeight || img.codedHeight || 128; }
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
    _animList.push({ frames, canvas, ctx, tex, frameIdx: 0, nextFrameTime: performance.now() + frames[0].duration });
    return tex;

  } catch (err) {
    console.warn('[BSP] Anim decode failed, static fallback:', url, err.message);
    return loadStaticTex(url);
  }
}

// ── Static texture ────────────────────────────────────────────────────────────
function loadStaticTex(url) {
  return new Promise(res => {
    _loader.load(url, tex => { applyTexFilters(tex); res(tex); }, undefined, () => res(null));
  });
}

// ── tryLoadTex ────────────────────────────────────────────────────────────────
async function tryLoadTex(url) {
  if (_texCache.has(url)) return _texCache.get(url);
  try { const p = await fetch(url, { method: 'HEAD' }); if (!p.ok) { _texCache.set(url, null); return null; } }
  catch { _texCache.set(url, null); return null; }
  const ext = url.substring(url.lastIndexOf('.')).toLowerCase();
  const tex = VIDEO_EXTS_SET.has(ext) ? await loadVideoTex(url)
            : ANIM_EXTS.has(ext)      ? await loadAnimatedTex(url)
            :                           await loadStaticTex(url);
  _texCache.set(url, tex);
  return tex;
}

// ── findTex ───────────────────────────────────────────────────────────────────
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
    const tex = VIDEO_EXTS_SET.has(ext) ? await loadVideoTex(found, bases, name)
              : ANIM_EXTS.has(ext)      ? await loadAnimatedTex(found)
              :                           await loadStaticTex(found);
    _texCache.set(found, tex);
    if (tex) return tex;
  }
  return null;
}

// ── White fallback ────────────────────────────────────────────────────────────
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

// ── Worker runner ─────────────────────────────────────────────────────────────
async function fetchWorkerCode() {
  const base   = import.meta.url.substring(0, import.meta.url.lastIndexOf('/') + 1);
  const local  = base + 'bsp_worker.js';
  const remote = 'https://spelecanton.github.io/Expore/javascript/bsp_worker.js';
  for (const url of [local, remote]) {
    try { const r = await fetch(url); if (r.ok) { console.log('[BSP] Worker from:', url); return await r.text(); } }
    catch { /* try next */ }
  }
  throw new Error('bsp_worker.js not found');
}

function runBSPWorker(buffer, textureBase, fallbackTexBase, onProgress) {
  return new Promise(async (resolve, reject) => {
    try {
      const blob   = new Blob([await fetchWorkerCode()], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      const worker  = new Worker(blobUrl);
      worker.onmessage = ({ data }) => {
        if      (data.type === 'progress') onProgress?.(data.pct);
        else if (data.type === 'done')     { worker.terminate(); URL.revokeObjectURL(blobUrl); resolve(data); }
        else if (data.type === 'error')    { worker.terminate(); URL.revokeObjectURL(blobUrl); reject(new Error(`[BSP Worker] ${data.message}`)); }
      };
      worker.onerror = e => { worker.terminate(); URL.revokeObjectURL(blobUrl); reject(e); };
      worker.postMessage({ buffer, textureBase, fallbackTexBase }, [buffer]);
    } catch (e) { reject(e); }
  });
}

// ── Main loader ───────────────────────────────────────────────────────────────
export async function loadBSP({ url, scene, textureBase = '', fallbackTexBase = '', onProgress = null }) {
  onProgress?.(0);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`BSP fetch failed: ${url} (${res.status})`);
  const buffer = await res.arrayBuffer();
  onProgress?.(5);

  const parsed = await runBSPWorker(buffer, textureBase, fallbackTexBase,
    pct => onProgress?.(5 + pct * 0.80));

  const { portals, playerStart, ambientIntensity, ambientColorArr, texNames, lmAtlas, batches } = parsed;

  // ── Lightmap ──────────────────────────────────────────────────────────────
  let lmTex = null;
  if (lmAtlas) {
    if (lmAtlas.nonZero === 0) console.warn('[BSP] No lightmap data.');
    else console.log(`[BSP] Lightmap ${lmAtlas.W}×${lmAtlas.H}, nonZero: ${lmAtlas.nonZero}`);
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
  const texBases    = [textureBase, fallbackTexBase];
  const uniqueNames = [...new Set(batches.filter(b => !b.invisible).map(b => texNames[b.texIdx] || 'default'))];
  const albedoMap   = new Map();
  let videoCount    = 0;

  await Promise.all(uniqueNames.map(async name => {
    const tex = await findTex(texBases, name);
    albedoMap.set(name, tex || _whiteTex);
    if (tex?._isBspVideo) videoCount++;
  }));

  if (videoCount > 0) console.log(`[BSP] Video textures active: ${videoCount}`);
  onProgress?.(95);

  // ── Build meshes ──────────────────────────────────────────────────────────
  let totalMeshes = 0, meshesWithLM = 0, noclipMeshes = 0, invisibleMeshes = 0;

  for (const b of batches) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.pos), 3));
    geo.setAttribute('normal',   new THREE.BufferAttribute(new Float32Array(b.nrm), 3));
    geo.setAttribute('uv',       new THREE.BufferAttribute(new Float32Array(b.uv1), 2));
    geo.setAttribute('uv1',      new THREE.BufferAttribute(new Float32Array(b.uv2), 2));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(b.idx), 1));
    geo.computeBoundingSphere();

    const name   = texNames[b.texIdx] || 'default';
    const albedo = albedoMap.get(name) ?? _whiteTex;
    const isVid  = albedo._isBspVideo === true;
    let mat;

    if (b.invisible) {
      mat = new THREE.MeshBasicMaterial({
        colorWrite: false, depthWrite: false, transparent: true, opacity: 0, side: THREE.DoubleSide,
      });
    } else if (isVid) {
      // Video textures: MeshBasicMaterial — self-illuminated, ignores scene lighting.
      // This ensures the video is always visible regardless of ambient/lightmap state.
      // UV repeat/offset are handled by the DataTexture directly.
      mat = new THREE.MeshBasicMaterial({
        map:  albedo,
        side: THREE.DoubleSide,
      });
    } else {
      mat = new THREE.MeshLambertMaterial({
        map:       albedo,
        side:      THREE.DoubleSide,
        alphaTest: 0.5,
      });
    }

    const mesh = new THREE.Mesh(geo, mat);
    if (b.invisible) { mesh.userData.invisible = true; invisibleMeshes++; }
    if (b.noclip)    { mesh.userData.noclip    = true; noclipMeshes++;    }

    if (b.hasLM && lmTex && !b.invisible && !isVid) {
      mat.lightMap          = lmTex;
      mat.lightMapIntensity = 1.0;
      meshesWithLM++;
    }

    scene.add(mesh);
    totalMeshes++;
  }

  console.log(
    `[BSP] Meshes: ${totalMeshes}, lightmapped: ${meshesWithLM},` +
    ` noclip: ${noclipMeshes}, invisible: ${invisibleMeshes}, video: ${videoCount}`
  );
  onProgress?.(100);

  const result = { portals, playerStart };
  if (ambientIntensity !== undefined) result.ambientIntensity = ambientIntensity;
  if (ambientColorArr)  result.ambientColor = new THREE.Color(...ambientColorArr);
  result.lights = parsed.lights ?? [];
  return result;
}
