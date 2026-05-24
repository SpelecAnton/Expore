/**
 * SPELEC BSP Worker — Quake 3 BSP (IBSP v46)
 *
 * Spouští se jako Web Worker. Zpracuje BSP buffer (parsing, vertex building,
 * index building, lightmap atlas) MIMO main thread a vrátí hotová data
 * přes transferable ArrayBuffers — žádné kopírování.
 *
 * Komunikace:
 *   IN  { buffer: ArrayBuffer, textureBase, fallbackTexBase }
 *   OUT { type: 'done',    ...ParsedBSP }   — úspěch
 *   OUT { type: 'error',   message }         — chyba
 *   OUT { type: 'progress', pct }            — průběh 0–100
 */

'use strict';

// ── Konstanty ─────────────────────────────────────────────────────────────────
const MAGIC           = 0x50534249; // 'IBSP'
const VERSION         = 46;
const LUMP_ENTITIES   = 0;
const LUMP_TEXTURES   = 1;
const LUMP_LIGHTMAPS  = 14;
const LUMP_VERTS      = 10;
const LUMP_MESH_VERTS = 11;
const LUMP_FACES      = 13;

const TEX_RECORD_SIZE  = 72;
const VERT_RECORD_SIZE = 44;
const FACE_RECORD_SIZE = 104;
const LM_SIZE          = 128 * 128 * 3;
const UNIT             = 0.02;

// ── Entity parser ─────────────────────────────────────────────────────────────
function parseEntityLump(text) {
  const entities = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    while (i < n && text[i] !== '{') i++;
    if (i >= n) break;
    i++;

    const props = {};
    while (i < n && text[i] !== '}') {
      while (i < n && text[i] !== '"' && text[i] !== '}') i++;
      if (i >= n || text[i] === '}') break;

      i++;
      let key = '';
      while (i < n && text[i] !== '"') key += text[i++];
      i++;

      while (i < n && text[i] !== '"') i++;
      i++;

      let val = '';
      while (i < n && text[i] !== '"') val += text[i++];
      i++;

      if (key) props[key] = val;
    }
    i++;
    if (Object.keys(props).length) entities.push(props);
  }
  return entities;
}

// ── Lightmap atlas — kopírování po řádcích místo po pixelech ─────────────────
// Uint8Array.set() je nativní memcpy — cca 20× rychlejší než pixel-loop.
// RGB → RGBA konverze: pomocný buffer, pak set po řádcích.
function buildLightmapAtlas(buffer, lmLump, lmCount) {
  if (lmCount === 0) return null;

  const cols  = Math.ceil(Math.sqrt(lmCount));
  const rows  = Math.ceil(lmCount / cols);
  const W     = cols * 128;
  const H     = rows * 128;
  const atlas = new Uint8Array(W * H * 4);

  // Předalokovaný řádkový buffer (128 px * 3 kanály)
  const rowRGB = new Uint8Array(128 * 3);

  let nonZero = 0;

  for (let idx = 0; idx < lmCount; idx++) {
    const chunkOffset = lmLump.offset + idx * LM_SIZE;
    const col = idx % cols;
    const row = (idx / cols) | 0;
    const ox  = col * 128;
    const oy  = row * 128;

    const src = new Uint8Array(buffer, chunkOffset, LM_SIZE);

    for (let y = 0; y < 128; y++) {
      // Jeden řádek RGB (128 * 3 bytes)
      rowRGB.set(src.subarray(y * 384, y * 384 + 384));

      // Zapsat do atlasu (RGBA) — konverze inline po řádku
      const dstBase = ((oy + y) * W + ox) * 4;
      for (let x = 0; x < 128; x++) {
        const s = x * 3;
        const d = dstBase + x * 4;
        atlas[d]     = rowRGB[s];
        atlas[d + 1] = rowRGB[s + 1];
        atlas[d + 2] = rowRGB[s + 2];
        atlas[d + 3] = 255;
        if (rowRGB[s] | rowRGB[s + 1] | rowRGB[s + 2]) nonZero++;
      }
    }
  }

  return { atlasData: atlas.buffer, W, H, cols, rows, nonZero };
}

// ── Vertex buffer parsing — přímý DataView bez mezikopií ─────────────────────
function parseVertices(buffer, vLump) {
  const vCount = (vLump.length / VERT_RECORD_SIZE) | 0;
  const view   = new DataView(buffer);

  const rawPos  = new Float32Array(vCount * 3);
  const rawUV1  = new Float32Array(vCount * 2);
  const rawUV2  = new Float32Array(vCount * 2);
  const rawNorm = new Float32Array(vCount * 3);

  for (let i = 0; i < vCount; i++) {
    const o  = vLump.offset + i * VERT_RECORD_SIZE;
    const qx = view.getFloat32(o,      true);
    const qy = view.getFloat32(o + 4,  true);
    const qz = view.getFloat32(o + 8,  true);

    rawPos[i * 3]     =  qx * UNIT;
    rawPos[i * 3 + 1] =  qz * UNIT;
    rawPos[i * 3 + 2] = -qy * UNIT;

    rawUV1[i * 2]     = view.getFloat32(o + 12, true);
    rawUV1[i * 2 + 1] = view.getFloat32(o + 16, true);
    rawUV2[i * 2]     = view.getFloat32(o + 20, true);
    rawUV2[i * 2 + 1] = view.getFloat32(o + 24, true);

    const nx = view.getFloat32(o + 28, true);
    const ny = view.getFloat32(o + 32, true);
    const nz = view.getFloat32(o + 36, true);
    rawNorm[i * 3]     =  nx;
    rawNorm[i * 3 + 1] =  nz;
    rawNorm[i * 3 + 2] = -ny;
  }

  return { rawPos, rawUV1, rawUV2, rawNorm };
}

// ── Face batching + mesh building — vše v Workeru ─────────────────────────────
// Vrací pole batch objektů; každý obsahuje hotové Float32Array buffery
// připravené rovnou pro THREE.BufferGeometry (lze transferovat).
function buildBatches(buffer, fLump, mvLump, rawPos, rawUV1, rawUV2, rawNorm, lmAtlas, lmCount) {
  const view     = new DataView(buffer);
  const fCount   = (fLump.length / FACE_RECORD_SIZE) | 0;
  const mvCount  = (mvLump.length / 4) | 0;
  const meshVerts = new Int32Array(buffer, mvLump.offset, mvCount);

  // ── Fáze 1: nasbírej indexy do batchů ────────────────────────────────────
  const batchMap = new Map(); // key → { texIdx, lmIdx, absIndices: Int32Array[] }

  for (let fi = 0; fi < fCount; fi++) {
    const fo       = fLump.offset + fi * FACE_RECORD_SIZE;
    const texIdx   = view.getInt32(fo,      true);
    const faceType = view.getInt32(fo + 8,  true);
    if (faceType !== 1 && faceType !== 3) continue;

    const vertStart = view.getInt32(fo + 12, true);
    const vertCount = view.getInt32(fo + 16, true);
    if (vertCount < 3) continue;

    const mvStart  = view.getInt32(fo + 20, true);
    const mvCount2 = view.getInt32(fo + 24, true);
    const lmIdx    = view.getInt32(fo + 28, true);

    const key = `${texIdx}:${lmIdx}`;
    let b = batchMap.get(key);
    if (!b) {
      b = { texIdx, lmIdx, absIndices: [] };
      batchMap.set(key, b);
    }

    const abs = b.absIndices;
    if (mvCount2 > 0) {
      for (let m = 0; m < mvCount2; m++) {
        abs.push(vertStart + meshVerts[mvStart + m]);
      }
    } else {
      for (let t = 1; t < vertCount - 1; t++) {
        abs.push(vertStart, vertStart + t, vertStart + t + 1);
      }
    }
  }

  // ── Fáze 2: build geometry buffers ───────────────────────────────────────
  const lmCols   = lmAtlas ? lmAtlas.cols : 1;
  const lmW      = lmAtlas ? lmAtlas.W    : 1;
  const lmH      = lmAtlas ? lmAtlas.H    : 1;

  const builtBatches = [];

  for (const [, batch] of batchMap) {
    const absIdx = batch.absIndices;
    if (!absIdx.length) continue;

    // Int32Array jako přímý lookup: globalIndex → localIndex (-1 = neexistuje)
    // Najdi max global index pro alokaci
    let maxGI = 0;
    for (const gi of absIdx) if (gi > maxGI) maxGI = gi;
    const g2l = new Int32Array(maxGI + 1).fill(-1);

    // Předalokuj výstupní buffery (worst case = absIdx.length unikátních vrcholů)
    const maxVerts = absIdx.length;
    const posArr  = new Float32Array(maxVerts * 3);
    const nrmArr  = new Float32Array(maxVerts * 3);
    const uv1Arr  = new Float32Array(maxVerts * 2);
    const uv2Arr  = new Float32Array(maxVerts * 2);
    const idxArr  = new Uint32Array(absIdx.length);

    let lmOffU = 0, lmOffV = 0, lmScaleU = 1, lmScaleV = 1;
    if (lmAtlas && batch.lmIdx >= 0 && batch.lmIdx < lmCount) {
      const col  = batch.lmIdx % lmCols;
      const row  = (batch.lmIdx / lmCols) | 0;
      lmOffU    = (col * 128) / lmW;
      lmOffV    = (row * 128) / lmH;
      lmScaleU  = 128 / lmW;
      lmScaleV  = 128 / lmH;
    }

    let vertCount = 0;

    for (let i = 0; i < absIdx.length; i++) {
      const gi = absIdx[i];
      let li   = g2l[gi];

      if (li === -1) {
        li = vertCount++;
        g2l[gi] = li;

        posArr[li * 3]     = rawPos[gi * 3];
        posArr[li * 3 + 1] = rawPos[gi * 3 + 1];
        posArr[li * 3 + 2] = rawPos[gi * 3 + 2];

        nrmArr[li * 3]     = rawNorm[gi * 3];
        nrmArr[li * 3 + 1] = rawNorm[gi * 3 + 1];
        nrmArr[li * 3 + 2] = rawNorm[gi * 3 + 2];

        uv1Arr[li * 2]     = rawUV1[gi * 2];
        uv1Arr[li * 2 + 1] = 1.0 - rawUV1[gi * 2 + 1];

        uv2Arr[li * 2]     = rawUV2[gi * 2]     * lmScaleU + lmOffU;
        uv2Arr[li * 2 + 1] = rawUV2[gi * 2 + 1] * lmScaleV + lmOffV;
      }

      idxArr[i] = li;
    }

    // Ořízni na skutečnou velikost (subarray = zero-copy view)
    builtBatches.push({
      texIdx:  batch.texIdx,
      lmIdx:   batch.lmIdx,
      hasLM:   lmAtlas !== null && batch.lmIdx >= 0 && batch.lmIdx < lmCount,
      pos:     posArr.subarray(0, vertCount * 3),
      nrm:     nrmArr.subarray(0, vertCount * 3),
      uv1:     uv1Arr.subarray(0, vertCount * 2),
      uv2:     uv2Arr.subarray(0, vertCount * 2),
      idx:     idxArr,
    });
  }

  return builtBatches;
}

// ── Worker message handler ────────────────────────────────────────────────────
self.onmessage = function ({ data }) {
  try {
    const { buffer, textureBase, fallbackTexBase } = data;
    const view = new DataView(buffer);

    if (view.getUint32(0, true) !== MAGIC)   throw new Error('Soubor není IBSP');
    if (view.getInt32(4, true)  !== VERSION) throw new Error(`BSP verze ${view.getInt32(4,true)} není podporována`);

    const lump = id => ({
      offset: view.getInt32(8 + id * 8,     true),
      length: view.getInt32(8 + id * 8 + 4, true),
    });

    self.postMessage({ type: 'progress', pct: 5 });

    // ── Entities ────────────────────────────────────────────────────────────
    const entLump = lump(LUMP_ENTITIES);
    const entText = new TextDecoder().decode(new Uint8Array(buffer, entLump.offset, entLump.length));
    const entities = parseEntityLump(entText);

    const portals = [];
    let playerStart = null;
    let ambientIntensity, ambientColorArr;

    for (const e of entities) {
      if (e.classname === 'trigger_portal') {
        portals.push(e);
      } else if (e.classname === 'info_player_start') {
        const [ox, oy, oz] = (e.origin || '0 0 0').split(' ').map(Number);
        playerStart = { x: ox*UNIT, y: oz*UNIT, z: -oy*UNIT, angle: parseFloat(e.angle || '0') };
      } else if (e.classname === 'worldspawn') {
        const ambVal = parseFloat(e['_ambient']);
        if (!isNaN(ambVal)) ambientIntensity = ambVal;
        if (e['_ambient_color']) {
          const [r,g,b] = e['_ambient_color'].trim().split(/\s+/).map(Number);
          if (!isNaN(r)) ambientColorArr = [r/255, g/255, b/255];
        }
      }
    }

    self.postMessage({ type: 'progress', pct: 10 });

    // ── Texture names ────────────────────────────────────────────────────────
    const texLump  = lump(LUMP_TEXTURES);
    const texCount = (texLump.length / TEX_RECORD_SIZE) | 0;
    const texNames = [];

    for (let i = 0; i < texCount; i++) {
      const off = texLump.offset + i * TEX_RECORD_SIZE;
      let name = '';
      for (let c = 0; c < 64; c++) {
        const ch = view.getUint8(off + c);
        if (!ch) break;
        name += String.fromCharCode(ch);
      }
      texNames.push(name.toLowerCase().replace(/\\/g, '/').replace(/^textures\//, ''));
    }

    self.postMessage({ type: 'progress', pct: 20 });

    // ── Lightmaps ────────────────────────────────────────────────────────────
    const lmLump  = lump(LUMP_LIGHTMAPS);
    const lmCount = (lmLump.length / LM_SIZE) | 0;
    const lmAtlas = buildLightmapAtlas(buffer, lmLump, lmCount);

    self.postMessage({ type: 'progress', pct: 40 });

    // ── Vertices ─────────────────────────────────────────────────────────────
    const { rawPos, rawUV1, rawUV2, rawNorm } = parseVertices(buffer, lump(LUMP_VERTS));

    self.postMessage({ type: 'progress', pct: 55 });

    // ── Batches + geometry buffers ───────────────────────────────────────────
    const batches = buildBatches(
      buffer,
      lump(LUMP_FACES),
      lump(LUMP_MESH_VERTS),
      rawPos, rawUV1, rawUV2, rawNorm,
      lmAtlas, lmCount
    );

    self.postMessage({ type: 'progress', pct: 85 });

    // ── Připrav transferable seznam ──────────────────────────────────────────
    // Subarray sdílí buffer s originálem — musíme slice() pro bezpečný transfer
    const transferList = [];
    if (lmAtlas) transferList.push(lmAtlas.atlasData);

    for (const b of batches) {
      // slice = vlastní buffer (subarray je jen view)
      b.pos = b.pos.slice().buffer;
      b.nrm = b.nrm.slice().buffer;
      b.uv1 = b.uv1.slice().buffer;
      b.uv2 = b.uv2.slice().buffer;
      b.idx = b.idx.buffer;
      transferList.push(b.pos, b.nrm, b.uv1, b.uv2, b.idx);
    }

    self.postMessage({ type: 'progress', pct: 95 });

    self.postMessage({
      type: 'done',
      portals,
      playerStart,
      ambientIntensity,
      ambientColorArr,
      texNames,
      lmAtlas: lmAtlas ? {
        data: lmAtlas.atlasData,
        W: lmAtlas.W,
        H: lmAtlas.H,
        cols: lmAtlas.cols,
        rows: lmAtlas.rows,
        nonZero: lmAtlas.nonZero,
      } : null,
      batches,
    }, transferList);

  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
