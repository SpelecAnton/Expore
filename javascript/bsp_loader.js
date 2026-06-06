/**
 * SPELEC BSP Loader v5 — WORKER EDITION + ANIMATED TEXTURES + VIDEO TEXTURES + INVISIBLE CLIP MESHES
 *
 * Texture loading strategy:
 *   video WebM/MP4            → <video> element + THREE.VideoTexture (GPU-updated every frame)
 *   animated GIF/AVIF/WEBP   → ImageDecoder API, all frames pre-decoded into ImageBitmap array
 *   static PNG/JPG/AVIF/WEBP → TextureLoader
 *
 * Extension probe priority (findTex):
 *   .webm → .mp4 → .gif → .avif → .webp → .png → .jpg
 *   Parallel HEAD requests per base; first hit wins.
 *
 * Video behaviour:
 *   - muted, looped, autoplayed, playsinline (no user gesture required)
 *   - THREE.VideoTexture handles needsUpdate automatically each render frame
 *   - Video elements are tracked in _videoList so they can be paused/resumed
 *   - Codec support is sniffed via HTMLVideoElement.canPlayType before loading
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
 *   Each video gets its own <video> element hidden off-screen.
 *   Multiple surfaces sharing the same video file reuse the same VideoTexture.
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';

// ── Configuration ─────────────────────────────────────────────────────────────
// Video extensions checked BEFORE image extensions so a .webm/.mp4 always wins
// when both a video and an image of the same name exist.
const VIDEO_EXTS = ['.webm', '.mp4'];
const ANIM_EXTS  = new Set(['.gif', '.avif', '.webp']);
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

/**
 * Called from engine.js immediately after creating the renderer.
 * Queries max supported GPU anisotropy and stores it for all textures.
 */
export function initTexLoader(renderer) {
  _maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  console.log(`[BSP] Anisotropic filtering: ${_maxAniso}×`);
}

// ── Internal state ────────────────────────────────────────────────────────────
const _texCache = new Map();   // url → THREE.Texture | null
const _loader   = new THREE.TextureLoader();

// Animated (GIF/AVIF/WEBP) entries: { frames, canvas, ctx, tex, frameIdx, nextFrameTime }
const _animList  = [];

// Video entries: { video: HTMLVideoElement, tex: THREE.VideoTexture }
// VideoTexture updates needsUpdate itself — we only track these for lifecycle.
const _videoList = [];

// ── Tick — called every frame from the render loop ───────────────────────────
export function tickAnimatedTextures() {
  const now = performance.now();

  // Frame-based animated textures (GIF/AVIF/WEBP)
  for (const anim of _animList) {
    if (now < anim.nextFrameTime) continue;

    const frame = anim.frames[anim.frameIdx];
    anim.ctx.clearRect(0, 0, anim.canvas.width, anim.canvas.height);
    anim.ctx.drawImage(frame.bitmap, 0, 0, anim.canvas.width, anim.canvas.height);
    anim.tex.needsUpdate = true;

    anim.frameIdx      = (anim.frameIdx + 1) % anim.frames.length;
    anim.nextFrameTime = now + frame.duration;
  }

  // VideoTexture: Three.js handles needsUpdate internally when video is playing.
  // Nothing extra required here — the loop exists for future pause/seek support.
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
 * Creates a hidden <video> element, waits until metadata is loaded,
 * then wraps it in a THREE.VideoTexture.
 *
 * VideoTexture sets needsUpdate = true automatically on each frame
 * (Three.js checks video.readyState >= HAVE_CURRENT_DATA internally).
 *
 * Returns null if the browser cannot play the format.
 */
async function loadVideoTex(url) {
  const ext = url.substring(url.lastIndexOf('.')).toLowerCase();

  // Guard: skip format if browser cannot play it
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
    video.crossOrigin = 'anonymous';
    // Keep the element off-screen but in the DOM so autoplay policies are satisfied.
    // Must have non-zero rendered size — some browsers refuse to decode a 0×0 video.
    video.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:2px;height:2px;opacity:0;pointer-events:none;';
    document.body.appendChild(video);

    let resolved = false;

    const cleanup = (eventName) => {
      video.removeEventListener('canplay',  onCanPlay);
      video.removeEventListener('error',    onError);
      video.removeEventListener('playing',  onPlaying);
    };

    // Called once video has buffered enough to paint its first frame.
    // At this point readyState >= HAVE_FUTURE_DATA so WebGL upload is safe.
    const buildTexture = () => {
      if (resolved) return;
      resolved = true;
      cleanup();

      const tex = new THREE.VideoTexture(video);
      // VideoTexture does NOT support mipmaps (size may be non-power-of-two).
      applyTexFilters(tex, { linearMag: true, mipmaps: false });
      tex.minFilter   = THREE.LinearFilter; // override — no mips for video
      tex.needsUpdate = true;

      _videoList.push({ video, tex });
      console.log(`[BSP] Video texture ready: ${url} (${video.videoWidth}×${video.videoHeight})`);
      resolve(tex);
    };

    // 'canplay' fires when the browser has decoded at least one frame.
    const onCanPlay = () => buildTexture();

    // Fallback: if the video starts actually playing we definitely have pixel data.
    const onPlaying = () => buildTexture();

    const onError = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      document.body.removeChild(video);
      console.warn('[BSP] Video load failed:', url);
      resolve(null);
    };

    video.addEventListener('canplay',  onCanPlay,  { once: true });
    video.addEventListener('playing',  onPlaying,  { once: true });
    video.addEventListener('error',    onError,    { once: true });

    // Kick off decode — play() returns a promise; rejection just means autoplay
    // was blocked, the 'canplay' event will still fire once data is buffered.
    video.play().catch(() => {
      // Autoplay blocked — browser will still buffer and fire 'canplay'.
      // The attachVideoResume() handler below will call play() on user gesture.
      console.warn('[BSP] Video autoplay blocked, waiting for user interaction:', url);
    });

    // Safety timeout: if neither canplay nor error fires within 8 s, give up.
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        console.warn('[BSP] Video texture timed out:', url);
        resolve(null);
      }
    }, 8000);
  });
}

// ── Resume all paused videos on first user gesture ───────────────────────────
// Some browsers block autoplay until a user interaction occurs.
(function attachVideoResume() {
  const resume = () => {
    for (const { video } of _videoList) {
      if (video.paused) {
        video.play().catch(() => {});
      }
    }
  };
  ['click', 'keydown', 'touchstart'].forEach(evt =>
    window.addEventListener(evt, resume, { once: false, passive: true })
  );
})();

// ── ImageDecoder loader (animated GIF / AVIF / WEBP) ─────────────────────────
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
    applyTexFilters(tex);
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
    console.warn('[BSP] Animation failed, showing static picture instead:', url, err.message);
    return loadStaticTex(url);
  }
}

// ── Static texture ────────────────────────────────────────────────────────────
function loadStaticTex(url) {
  return new Promise(res => {
    _loader.load(
      url,
      tex => {
        applyTexFilters(tex);
        res(tex);
      },
      undefined,
      () => res(null)
    );
  });
}

// ── tryLoadTex — load any supported format ────────────────────────────────────
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
  let tex;

  if (VIDEO_EXTS_SET.has(ext)) {
    tex = await loadVideoTex(url);
  } else if (ANIM_EXTS.has(ext)) {
    tex = await loadAnimatedTex(url);
  } else {
    tex = await loadStaticTex(url);
  }

  _texCache.set(url, tex);
  return tex;
}

// ── findTex — parallel HEAD probe across bases and extensions ─────────────────
/**
 * Probes all (base × extension) combinations in parallel.
 * Returns the first texture that loads successfully, or null.
 *
 * Video formats (.webm, .mp4) are listed first in TEX_EXTENSIONS so they
 * win when both a video and a static image exist with the same base name.
 */
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

    // Respect extension priority order
    const found = probes.find(u => u !== null);
    if (!found) continue;

    if (_texCache.has(found)) return _texCache.get(found);

    const ext = found.substring(found.lastIndexOf('.')).toLowerCase();
    let tex;

    if (VIDEO_EXTS_SET.has(ext)) {
      tex = await loadVideoTex(found);
    } else if (ANIM_EXTS.has(ext)) {
      tex = await loadAnimatedTex(found);
    } else {
      tex = await loadStaticTex(found);
    }

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
        if      (data.type === 'progress') { onProgress?.(data.pct); }
        else if (data.type === 'done')     { worker.terminate(); URL.revokeObjectURL(blobUrl); resolve(data); }
        else if (data.type === 'error')    { worker.terminate(); URL.revokeObjectURL(blobUrl); reject(new Error(`[BSP Worker] ${data.message}`)); }
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
    lmTex.colorSpace = THREE.SRGBColorSpace;
    lmTex.channel    = 1;
    lmTex.minFilter  = THREE.LinearMipmapLinearFilter;
    lmTex.magFilter  = THREE.LinearFilter;
    lmTex.anisotropy = _maxAniso;
    lmTex.generateMipmaps = true;
    lmTex.wrapS = lmTex.wrapT = THREE.ClampToEdgeWrapping;
    lmTex.needsUpdate = true;
  }

  // ── Albedo textures (images + videos) ────────────────────────────────────
  const texBases = [textureBase, fallbackTexBase];

  const uniqueNames = [...new Set(
    batches
      .filter(b => !b.invisible)
      .map(b => texNames[b.texIdx] || 'default')
  )];

  const albedoMap = new Map();
  let videoCount = 0;

  await Promise.all(uniqueNames.map(async name => {
    const tex = await findTex(texBases, name);
    albedoMap.set(name, tex || _whiteTex);
    if (tex && tex.isVideoTexture) videoCount++;
  }));

  if (videoCount > 0) {
    console.log(`[BSP] Video textures active: ${videoCount}`);
  }

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
      // Invisible clip brush: renders nothing, but raycaster still hits it.
      mat = new THREE.MeshBasicMaterial({
        colorWrite:  false,
        depthWrite:  false,
        transparent: true,
        opacity:     0,
        side:        THREE.DoubleSide,
      });
    } else {
      const albedo = albedoMap.get(name) ?? _whiteTex;
      const isVideo = albedo.isVideoTexture;

      mat = new THREE.MeshLambertMaterial({
        map:       albedo,
        side:      THREE.DoubleSide,
        // Video textures are always opaque — skip alpha test to avoid flickering
        alphaTest: isVideo ? 0 : 0.5,
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

    // Lightmap — skip for video textures (they supply their own luminance)
    const albedo = albedoMap.get(name);
    const isVideo = albedo?.isVideoTexture ?? false;

    if (b.hasLM && lmTex && !b.invisible && !isVideo) {
      mat.lightMap          = lmTex;
      mat.lightMapIntensity = 1.0;
      meshesWithLM++;
    }

    scene.add(mesh);
    totalMeshes++;
  }

  console.log(
    `[BSP] Meshes: ${totalMeshes}, with lightmap: ${meshesWithLM},` +
    ` noclip: ${noclipMeshes}, invisible clip: ${invisibleMeshes}` +
    ` video textures: ${videoCount}`
  );
  onProgress?.(100);

  const result = { portals, playerStart };
  if (ambientIntensity !== undefined) result.ambientIntensity = ambientIntensity;
  if (ambientColorArr)  result.ambientColor = new THREE.Color(...ambientColorArr);
  result.lights = parsed.lights ?? [];

  return result;
}
