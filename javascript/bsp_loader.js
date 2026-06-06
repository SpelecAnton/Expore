/**
 * SPELEC BSP Loader v5.1 — WORKER EDITION + ANIMATED TEXTURES + VIDEO TEXTURES + INVISIBLE CLIP MESHES
 *
 * Texture loading strategy:
 *   video WebM/MP4            → <video> element decoded to CanvasTexture each frame via drawImage()
 *   animated GIF/AVIF/WEBP   → ImageDecoder API, all frames pre-decoded into ImageBitmap array
 *   static PNG/JPG/AVIF/WEBP → TextureLoader
 *
 * Extension probe priority (findTex):
 *   .webm → .mp4 → .gif → .avif → .webp → .png → .jpg
 *   Parallel HEAD requests per base; first hit wins.
 *
 * Video behaviour:
 *   - muted, looped, autoplayed, playsinline (no user gesture required)
 *   - Video frame is drawn into an off-screen canvas every tick via ctx.drawImage()
 *   - CanvasTexture.needsUpdate = true is set manually — avoids THREE.VideoTexture
 *     internals that fail silently when used with EffectComposer
 *   - Codec support is sniffed via HTMLVideoElement.canPlayType before loading
 *   - Video elements tagged isVideoTexture = true for downstream checks
 *
 * v2 — func_wall / noclip:
 *   Batches with noclip=true get material.depthWrite = false
 *   → physics.js automatically skips them from collision objects.
 *
 * v3 — mipmaps + anisotropic filtering:
 *   minFilter = LinearMipmapLinearFilter, magFilter = NearestFilter (retro look)
 *   initTexLoader(renderer) must be called from engine.js before loadBSP().
 *
 * v4 — invisible clip textures:
 *   Batches with invisible=true (common/clip, common/nodraw …) get mesh.visible = false.
 *   depthWrite stays true so physics raycasts still hit them.
 *
 * v5 — VIDEO TEXTURE SUPPORT:
 *   .webm (AV1 / VP9) and .mp4 (H.264) files are treated as video textures.
 *   Each video gets its own <video> + <canvas> pair.
 *   Multiple BSP surfaces sharing the same filename reuse the same texture object.
 *
 * v5.1 — FIX: replaced THREE.VideoTexture with manual canvas-based approach.
 *   THREE.VideoTexture's auto-update does not fire reliably when the scene is
 *   rendered through EffectComposer instead of renderer.render() directly.
 *   Solution: draw video into a canvas every tick and set needsUpdate = true,
 *   identical to how GIF/AVIF animated textures are handled.
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';

// ── Configuration ─────────────────────────────────────────────────────────────
const VIDEO_EXTS     = ['.webm', '.mp4'];
const ANIM_EXTS      = new Set(['.gif', '.avif', '.webp']);
const VIDEO_EXTS_SET = new Set(VIDEO_EXTS);

// Full probe order: video first, then animated images, then static images.
const TEX_EXTENSIONS = ['.webm', '.mp4', '.gif', '.avif', '.webp', '.png', '.jpg'];

// ── Codec capability sniff (run once at module load) ─────────────────────────
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

console.log(`[BSP] Video codec support — WebM: ${_videoSupport.webm}, MP4: ${_videoSupport.mp4}`);

// ── Anisotropy — set from engine.js via initTexLoader() ──────────────────────
let _maxAniso = 1;

export function initTexLoader(renderer) {
  _maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  console.log(`[BSP] Anisotropic filtering: ${_maxAniso}×`);
}

// ── Internal state ────────────────────────────────────────────────────────────
const _texCache = new Map();
const _loader   = new THREE.TextureLoader();

// GIF/AVIF/WEBP animated entries
// { frames: [{bitmap, duration}], canvas, ctx, tex, frameIdx, nextFrameTime }
const _animList = [];

// Video entries — drawn into canvas every tick
// { video: HTMLVideoElement, canvas, ctx, tex: THREE.CanvasTexture }
const _videoCanvasList = [];

// ── Tick — called every frame from engine.js render loop ─────────────────────
export function tickAnimatedTextures() {
  const now = performance.now();

  // GIF/AVIF/WEBP: advance frame when duration expires
  for (const anim of _animList) {
    if (now < anim.nextFrameTime) continue;
    const frame = anim.frames[anim.frameIdx];
    anim.ctx.clearRect(0, 0, anim.canvas.width, anim.canvas.height);
    anim.ctx.drawImage(frame.bitmap, 0, 0, anim.canvas.width, anim.canvas.height);
    anim.tex.needsUpdate = true;
    anim.frameIdx      = (anim.frameIdx + 1) % anim.frames.length;
    anim.nextFrameTime = now + frame.duration;
  }

  // Video: blit current decoded frame into canvas every tick.
  // Only upload to GPU when video has actual pixel data (readyState >= 2).
  for (const entry of _videoCanvasList) {
    const v = entry.video;
    if (v.readyState < 2 || v.paused || v.ended) continue;
    entry.ctx.drawImage(v, 0, 0, entry.canvas.width, entry.canvas.height);
    entry.tex.needsUpdate = true;
  }
}

// ── Apply shared filter settings to a texture ─────────────────────────────────
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
 * Creates a hidden <video> element and a matching <canvas>.
 * Returns a THREE.CanvasTexture backed by the canvas.
 * tickAnimatedTextures() blits video → canvas every frame.
 *
 * Using CanvasTexture instead of THREE.VideoTexture because VideoTexture's
 * internal update mechanism is bypassed by EffectComposer, causing a black texture.
 */
async function loadVideoTex(url) {
  const ext = url.substring(url.lastIndexOf('.')).toLowerCase();

  if (ext === '.webm' && !_videoSupport.webm) {
    console.warn('[BSP] WebM not supported by this browser, skipping:', url);
    return null;
  }
  if (ext === '.mp4' && !_videoSupport.mp4) {
    console.warn('[BSP] MP4 not supported by this browser, skipping:', url);
    return null;
  }

  return new Promise(resolve => {
    const video = document.createElement('video');
    video.src         = url;
    video.loop        = true;
    video.muted       = true;
    video.autoplay    = true;
    video.playsInline = true;
    // Non-zero size so browsers decode the video — 2×2 is invisible but valid.
    video.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:2px;height:2px;opacity:0;pointer-events:none;';
    document.body.appendChild(video);

    let resolved = false;

    const finish = (ok) => {
      if (resolved) return;
      resolved = true;
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('error',   onError);

      if (!ok) {
        document.body.removeChild(video);
        resolve(null);
        return;
      }

      const W = video.videoWidth  || 512;
      const H = video.videoHeight || 512;

      // Off-screen canvas — same resolution as the video
      const canvas  = document.createElement('canvas');
      canvas.width  = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d');

      // Draw first frame immediately so the texture is never black on frame 0
      ctx.drawImage(video, 0, 0, W, H);

      const tex = new THREE.CanvasTexture(canvas);
      // No mipmaps for video — dimensions may be non-power-of-two
      applyTexFilters(tex, { linearMag: true, mipmaps: false });
      tex.minFilter   = THREE.LinearFilter;
      tex.needsUpdate = true;

      // Mark as video so downstream code (lightmap skip, alphaTest) can detect it
      tex.isVideoTexture = true;

      _videoCanvasList.push({ video, canvas, ctx, tex });
      console.log(`[BSP] Video texture ready: ${url} (${W}×${H})`);
      resolve(tex);
    };

    const onCanPlay = () => finish(true);
    const onPlaying = () => finish(true);
    const onError   = () => { console.warn('[BSP] Video load error:', url); finish(false); };

    video.addEventListener('canplay', onCanPlay, { once: true });
    video.addEventListener('playing', onPlaying, { once: true });
    video.addEventListener('error',   onError,   { once: true });

    video.play().catch(() => {
      // Autoplay blocked — canplay still fires once buffered; resume on user gesture below.
      console.warn('[BSP] Video autoplay blocked, waiting for user interaction:', url);
    });

    // Timeout safety — give up after 8 s
    setTimeout(() => {
      if (!resolved) {
        console.warn('[BSP] Video texture load timed out:', url);
        finish(false);
      }
    }, 8000);
  });
}

// ── Resume paused videos on first user gesture ────────────────────────────────
(function attachVideoResume() {
  const resume = () => {
    for (const { video } of _videoCanvasList) {
      if (video.paused) video.play().catch(() => {});
    }
  };
  ['click', 'keydown', 'touchstart'].forEach(evt =>
    window.addEventListener(evt, resume, { once: false, passive: true })
  );
})();

// ── ImageDecoder loader (animated GIF / AVIF / WEBP) ─────────────────────────
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
      data: new Blob([buffer], { type }).stream(),
      type,
      preferAnimation: true,
    });
    await probeDecoder.tracks.ready;
    const frameCount = probeDecoder.tracks.selectedTrack?.frameCount ?? 1;
    probeDecoder.close();

    if (frameCount <= 1) return loadStaticTex(url);

    console.log(`[BSP] Animated texture ${url}: ${frameCount} frames`);

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
    console.warn('[BSP] Animation decode failed, static fallback:', url, err.message);
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
  try {
    const probe = await fetch(url, { method: 'HEAD' });
    if (!probe.ok) { _texCache.set(url, null); return null; }
  } catch { _texCache.set(url, null); return null; }

  const ext = url.substring(url.lastIndexOf('.')).toLowerCase();
  const tex = VIDEO_EXTS_SET.has(ext) ? await loadVideoTex(url)
            : ANIM_EXTS.has(ext)      ? await loadAnimatedTex(url)
            :                           await loadStaticTex(url);
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
    const tex = VIDEO_EXTS_SET.has(ext) ? await loadVideoTex(found)
              : ANIM_EXTS.has(ext)      ? await loadAnimatedTex(found)
              :                           await loadStaticTex(found);
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
  t.minFilter  = THREE.LinearFilter;
  t.magFilter  = THREE.LinearFilter;
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
        if      (data.type === 'progress') onProgress?.(data.pct);
        else if (data.type === 'done')     { worker.terminate(); URL.revokeObjectURL(blobUrl); resolve(data); }
        else if (data.type === 'error')    { worker.terminate(); URL.revokeObjectURL(blobUrl); reject(new Error(`[BSP Worker] ${data.message}`)); }
      };
      worker.onerror = err => { worker.terminate(); URL.revokeObjectURL(blobUrl); reject(err); };
      worker.postMessage({ buffer, textureBase, fallbackTexBase }, [buffer]);
    } catch (err) { reject(err); }
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
    if (lmAtlas.nonZero === 0) console.warn('[BSP] No lightmap — baked light missing.');
    else console.log(`[BSP] Lightmap atlas ${lmAtlas.W}×${lmAtlas.H}, non-zero: ${lmAtlas.nonZero}`);

    const atlasArr = new Uint8Array(lmAtlas.data);
    lmTex = new THREE.DataTexture(atlasArr, lmAtlas.W, lmAtlas.H, THREE.RGBAFormat);
    lmTex.colorSpace      = THREE.SRGBColorSpace;
    lmTex.channel         = 1;
    lmTex.minFilter       = THREE.LinearMipmapLinearFilter;
    lmTex.magFilter       = THREE.LinearFilter;
    lmTex.anisotropy      = _maxAniso;
    lmTex.generateMipmaps = true;
    lmTex.wrapS = lmTex.wrapT = THREE.ClampToEdgeWrapping;
    lmTex.needsUpdate = true;
  }

  // ── Albedo textures ───────────────────────────────────────────────────────
  const texBases    = [textureBase, fallbackTexBase];
  const uniqueNames = [...new Set(
    batches.filter(b => !b.invisible).map(b => texNames[b.texIdx] || 'default')
  )];

  const albedoMap = new Map();
  let videoCount  = 0;

  await Promise.all(uniqueNames.map(async name => {
    const tex = await findTex(texBases, name);
    albedoMap.set(name, tex || _whiteTex);
    if (tex?.isVideoTexture) videoCount++;
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
    const isVid  = albedo.isVideoTexture === true;
    let mat;

    if (b.invisible) {
      mat = new THREE.MeshBasicMaterial({
        colorWrite: false, depthWrite: false, transparent: true, opacity: 0, side: THREE.DoubleSide,
      });
    } else {
      mat = new THREE.MeshLambertMaterial({
        map:       albedo,
        side:      THREE.DoubleSide,
        alphaTest: isVid ? 0 : 0.5,   // no alpha test for video — avoids flicker
      });
    }

    const mesh = new THREE.Mesh(geo, mat);

    if (b.invisible) { mesh.userData.invisible = true; invisibleMeshes++; }
    if (b.noclip)    { mesh.userData.noclip    = true; noclipMeshes++;    }

    // Lightmap — skip for video textures (they are self-illuminated)
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
