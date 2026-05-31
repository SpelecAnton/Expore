/**
 * SPELEC BSP Worker — Quake 3 BSP (IBSP v46)
 *
 * Runs as a Web Worker. Processes BSP buffer (parsing, vertex building,
 * index building, lightmap atlas) OFF the main thread and returns finished data
 * via transferable ArrayBuffers — no copying.
 *
 * Communication:
 *   IN  { buffer: ArrayBuffer, textureBase, fallbackTexBase }
 *   OUT { type: 'done',    ...ParsedBSP }   — success
 *   OUT { type: 'error',   message }         — error
 *   OUT { type: 'progress', pct }            — progress 0–100
 *
 * v5 — Q3 BSP brush collision:
 *   parseBSPCollision() extracts planes, nodes, leafs, leafBrushes, brushes,
 *   brushSides from the BSP lumps.  Planes are re-oriented to Three.js space
 *   (Q3 Y↑Z → Three.js Y↑-Z) and scaled by UNIT.  Content flags are read from
 *   the shader/texture lump so physics.js can filter SOLID / PLAYERCLIP brushes.
 *   The BSP tree walk in physics.js uses these to do sphere sweep tests instead
 *   of mesh raycasting — fixing fall-through on angled brush junctions.
 */

'use strict';

// ── Lump indices ──────────────────────────────────────────────────────────────
const MAGIC             = 0x50534249; // 'IBSP'
const VERSION           = 46;
const LUMP_ENTITIES     = 0;
const LUMP_TEXTURES     = 1;
const LUMP_PLANES       = 2;
const LUMP_NODES        = 3;
const LUMP_LEAFS        = 4;
const LUMP_LEAF_BRUSHES = 6;
const LUMP_MODELS       = 7;
const LUMP_BRUSHES      = 8;
const LUMP_BRUSH_SIDES  = 9;
const LUMP_VERTS        = 10;
const LUMP_MESH_VERTS   = 11;
const LUMP_FACES        = 13;
const LUMP_LIGHTMAPS    = 14;

// ── Record sizes (bytes) ──────────────────────────────────────────────────────
const TEX_RECORD_SIZE        = 72;  // char[64] + int flags + int contents
const VERT_RECORD_SIZE       = 44;
const FACE_RECORD_SIZE       = 104;
const MODEL_RECORD_SIZE      = 40;  // float[3]mins + float[3]maxs + int firstFace + numFaces + firstBrush + numBrushes
const PLANE_RECORD_SIZE      = 16;  // float[3] normal + float dist
const NODE_RECORD_SIZE       = 36;  // int plane + int[2] children + int[3] mins + int[3] maxs
const LEAF_RECORD_SIZE       = 48;  // int cluster + area + int[3] mins + int[3] maxs + int firstFace + numFaces + firstBrush + numBrushes
const BRUSH_RECORD_SIZE      = 12;  // int firstSide + numSides + shaderIdx
const BRUSH_SIDE_RECORD_SIZE = 8;   // int planeIdx + shaderIdx
const LM_SIZE                = 128 * 128 * 3;
const UNIT                   = 0.02;

// ── Content flags ─────────────────────────────────────────────────────────────
const CONTENTS_SOLID      = 1;
const CONTENTS_PLAYERCLIP = 0x10000;

// ── Entity classnames that should be passthrough (no collision) ───────────────
const NOCLIP_CLASSNAMES = new Set([
  'func_wall',
  'func_illusionary',
  'func_detail',
  'func_fog',
]);

// ── Texture names that should be invisible but still collide ──────────────────
const INVISIBLE_TEXTURES = new Set([
  'common/clip',
  'common/nodraw',
  'common/hint',
  'common/skip',
  'common/caulk',
  'common/trigger',
  'clip',
  'nodraw',
  'hint',
]);

// ── Light entity classnames ───────────────────────────────────────────────────
const LIGHT_CLASSNAMES = new Set([
  'light',
  'light_spot',
  'light_point',
]);

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

// ── Build noclip face index set from entity + model lump ─────────────────────
function buildNoclipFaceSet(entities, buffer, modelLump) {
  const noclipFaces = new Set();
  const modelCount  = (modelLump.length / MODEL_RECORD_SIZE) | 0;
  const view        = new DataView(buffer);

  for (const e of entities) {
    if (!NOCLIP_CLASSNAMES.has(e.classname)) continue;

    const modelStr = e.model ?? '';
    if (!modelStr.startsWith('*')) continue;

    const subIdx = parseInt(modelStr.slice(1), 10);
    if (isNaN(subIdx) || subIdx < 1 || subIdx >= modelCount) continue;

    const mOff      = modelLump.offset + subIdx * MODEL_RECORD_SIZE;
    const firstFace = view.getInt32(mOff + 24, true);
    const numFaces  = view.getInt32(mOff + 28, true);

    if (firstFace < 0 || numFaces < 0 || numFaces > 100000) {
      console.warn(`[BSP Worker] Skipping ${e.classname} — invalid face values`);
      continue;
    }

    for (let fi = firstFace; fi < firstFace + numFaces; fi++) {
      noclipFaces.add(fi);
    }
  }

  return noclipFaces;
}

// ── Parse light entities ──────────────────────────────────────────────────────
function parseLights(entities) {
  const lights = [];

  for (const e of entities) {
    if (!LIGHT_CLASSNAMES.has(e.classname)) continue;

    const [ox, oy, oz] = (e.origin || '0 0 0').split(' ').map(Number);

    let r = 1, g = 1, b = 1, intensity = 200;

    if (e._light) {
      const parts = e._light.trim().split(/\s+/).map(Number);
      if (parts.length >= 4) {
        r = parts[0] / 255; g = parts[1] / 255; b = parts[2] / 255;
        intensity = parts[3];
      } else if (parts.length === 1) {
        intensity = parts[0];
      }
    } else if (e._color) {
      const parts = e._color.trim().split(/\s+/).map(Number);
      if (parts.length >= 3) { r = parts[0]; g = parts[1]; b = parts[2]; }
    } else if (e.color) {
      const parts = e.color.trim().split(/\s+/).map(Number);
      if (parts.length >= 3) { r = parts[0]; g = parts[1]; b = parts[2]; }
    }

    r = Math.max(0, Math.min(1, r));
    g = Math.max(0, Math.min(1, g));
    b = Math.max(0, Math.min(1, b));

    lights.push({
      x: ox * UNIT, y: oz * UNIT, z: -oy * UNIT,
      r, g, b, intensity,
      sprite: e._sprite === '1',
    });
  }

  return lights;
}

// ── Lightmap atlas ────────────────────────────────────────────────────────────
function buildLightmapAtlas(buffer, lmLump, lmCount) {
  if (lmCount === 0) return null;

  const cols  = Math.ceil(Math.sqrt(lmCount));
  const rows  = Math.ceil(lmCount / cols);
  const W     = cols * 128;
  const H     = rows * 128;
  const atlas = new Uint8Array(W * H * 4);

  const rowRGB = new Uint8Array(128 * 3);
  let nonZero  = 0;

  for (let idx = 0; idx < lmCount; idx++) {
    const chunkOffset = lmLump.offset + idx * LM_SIZE;
    const col = idx % cols;
    const row = (idx / cols) | 0;
    const ox  = col * 128;
    const oy  = row * 128;
    const src = new Uint8Array(buffer, chunkOffset, LM_SIZE);

    for (let y = 0; y < 128; y++) {
      rowRGB.set(src.subarray(y * 384, y * 384 + 384));
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

// ── Vertex buffer parsing ─────────────────────────────────────────────────────
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

// ── BSP Collision Data ────────────────────────────────────────────────────────
// Extracts planes, nodes, leafs, leafBrushes, brushes, brushSides.
// Planes are transformed to Three.js coordinate space and scaled to UNIT.
//
// Q3 coord → Three.js coord:
//   tx = qx * UNIT,  ty = qz * UNIT,  tz = -qy * UNIT
// Plane in Q3: nx*qx + ny*qy + nz*qz = dist
// Substituting: (nx)*tx + (nz)*ty + (-ny)*tz = dist * UNIT
// → Three.js plane normal = (nx, nz, -ny), dist_t = dist * UNIT
//
// Brush content flags come from the shader/texture record at offset 68.
// Only CONTENTS_SOLID (1) and CONTENTS_PLAYERCLIP (0x10000) brushes collide.
// All other brushes (triggers, fog, water…) are ignored by the physics.
//
// NOTE: The BSP tree references ONLY world-model brushes (model 0).
//       Sub-model brushes (func_wall etc.) are never in the leafBrushes list,
//       so they are automatically skipped — no special noclip handling needed.
function parseBSPCollision(buffer, view, lumpFn, texContents) {
  // ── Planes ────────────────────────────────────────────────────────────────
  const planeLump  = lumpFn(LUMP_PLANES);
  const planeCount = (planeLump.length / PLANE_RECORD_SIZE) | 0;
  const planes     = new Float32Array(planeCount * 4); // [nx, ny, nz, dist] × N

  for (let i = 0; i < planeCount; i++) {
    const off  = planeLump.offset + i * PLANE_RECORD_SIZE;
    const qnx  = view.getFloat32(off,      true);
    const qny  = view.getFloat32(off + 4,  true);
    const qnz  = view.getFloat32(off + 8,  true);
    const qdst = view.getFloat32(off + 12, true);
    // Transform: Q3(qx,qy,qz) → Three.js(qx, qz, -qy)
    planes[i * 4]     =  qnx;
    planes[i * 4 + 1] =  qnz;
    planes[i * 4 + 2] = -qny;
    planes[i * 4 + 3] =  qdst * UNIT;
  }

  // ── Brush sides — only planeIdx needed ───────────────────────────────────
  const bsLump  = lumpFn(LUMP_BRUSH_SIDES);
  const bsCount = (bsLump.length / BRUSH_SIDE_RECORD_SIZE) | 0;
  const brushSides = new Int32Array(bsCount);
  for (let i = 0; i < bsCount; i++) {
    brushSides[i] = view.getInt32(bsLump.offset + i * BRUSH_SIDE_RECORD_SIZE, true);
  }

  // ── Brushes: [firstSide, numSides, contentFlags] ─────────────────────────
  const bLump  = lumpFn(LUMP_BRUSHES);
  const bCount = (bLump.length / BRUSH_RECORD_SIZE) | 0;
  const brushes = new Int32Array(bCount * 3);
  for (let i = 0; i < bCount; i++) {
    const off       = bLump.offset + i * BRUSH_RECORD_SIZE;
    const firstSide = view.getInt32(off,     true);
    const numSides  = view.getInt32(off + 4,  true);
    const shaderIdx = view.getInt32(off + 8,  true);
    const contents  = (shaderIdx >= 0 && shaderIdx < texContents.length)
      ? texContents[shaderIdx] : 0;
    brushes[i * 3]     = firstSide;
    brushes[i * 3 + 1] = numSides;
    brushes[i * 3 + 2] = contents;
  }

  // ── Leaf brushes ──────────────────────────────────────────────────────────
  const lbLump     = lumpFn(LUMP_LEAF_BRUSHES);
  const lbCount    = (lbLump.length / 4) | 0;
  // .slice() so we own the buffer and can transfer it
  const leafBrushes = new Int32Array(buffer, lbLump.offset, lbCount).slice();

  // ── Leafs: [firstLeafBrush, numLeafBrushes] ──────────────────────────────
  const leafLump  = lumpFn(LUMP_LEAFS);
  const leafCount = (leafLump.length / LEAF_RECORD_SIZE) | 0;
  const leafs     = new Int32Array(leafCount * 2);
  for (let i = 0; i < leafCount; i++) {
    const off = leafLump.offset + i * LEAF_RECORD_SIZE;
    leafs[i * 2]     = view.getInt32(off + 40, true); // firstLeafBrush
    leafs[i * 2 + 1] = view.getInt32(off + 44, true); // numLeafBrushes
  }

  // ── Nodes: [planeIdx, frontChild, backChild] ─────────────────────────────
  // Children >= 0 are node indices; children < 0 are leaf indices = -(child+1).
  const nodeLump  = lumpFn(LUMP_NODES);
  const nodeCount = (nodeLump.length / NODE_RECORD_SIZE) | 0;
  const nodes     = new Int32Array(nodeCount * 3);
  for (let i = 0; i < nodeCount; i++) {
    const off = nodeLump.offset + i * NODE_RECORD_SIZE;
    nodes[i * 3]     = view.getInt32(off,     true); // planeIdx
    nodes[i * 3 + 1] = view.getInt32(off + 4,  true); // front child
    nodes[i * 3 + 2] = view.getInt32(off + 8,  true); // back child
  }

  console.log(
    `[BSP Worker] Collision: ${planeCount} planes, ${nodeCount} nodes,` +
    ` ${leafCount} leafs, ${bCount} brushes, ${bsCount} brush sides`
  );

  return { planes, brushSides, brushes, leafBrushes, leafs, nodes };
}

// ── Face batching + mesh building ─────────────────────────────────────────────
function buildBatches(buffer, fLump, mvLump, rawPos, rawUV1, rawUV2, rawNorm,
                      lmAtlas, lmCount, noclipFaces, texNames) {
  const view      = new DataView(buffer);
  const fCount    = (fLump.length / FACE_RECORD_SIZE) | 0;
  const mvCount   = (mvLump.length / 4) | 0;
  const meshVerts = new Int32Array(buffer, mvLump.offset, mvCount);

  const batchMap   = new Map();
  const totalVerts = rawPos.length / 3;

  for (let fi = 0; fi < fCount; fi++) {
    const fo       = fLump.offset + fi * FACE_RECORD_SIZE;
    const texIdx   = view.getInt32(fo,      true);
    const faceType = view.getInt32(fo + 8,  true);
    if (faceType !== 1 && faceType !== 3) continue;

    const vertStart = view.getInt32(fo + 12, true);
    const vertCount = view.getInt32(fo + 16, true);
    if (vertCount < 3) continue;
    if (vertStart < 0 || vertStart >= totalVerts) continue;

    const mvStart  = view.getInt32(fo + 20, true);
    const mvCount2 = view.getInt32(fo + 24, true);
    const lmIdx    = view.getInt32(fo + 28, true);

    const isNoclip    = noclipFaces.has(fi);
    const texName     = (texNames[texIdx] || '').toLowerCase();
    const isInvisible = INVISIBLE_TEXTURES.has(texName);

    const key = `${texIdx}:${lmIdx}:${isNoclip ? 'n' : 's'}:${isInvisible ? 'i' : 'v'}`;

    let b = batchMap.get(key);
    if (!b) {
      b = { texIdx, lmIdx, noclip: isNoclip, invisible: isInvisible, absIndices: [] };
      batchMap.set(key, b);
    }

    const abs = b.absIndices;
    if (mvCount2 > 0) {
      for (let m = 0; m < mvCount2; m++) {
        const mvIdx = mvStart + m;
        if (mvIdx < 0 || mvIdx >= mvCount) continue;
        const gi = vertStart + meshVerts[mvIdx];
        if (gi >= 0 && gi < totalVerts) abs.push(gi);
      }
    } else {
      for (let t = 1; t < vertCount - 1; t++) {
        const a = vertStart, c_ = vertStart + t, d_ = vertStart + t + 1;
        if (a < totalVerts && c_ < totalVerts && d_ < totalVerts) {
          abs.push(a, c_, d_);
        }
      }
    }
  }

  const lmCols = lmAtlas ? lmAtlas.cols : 1;
  const lmW    = lmAtlas ? lmAtlas.W    : 1;
  const lmH    = lmAtlas ? lmAtlas.H    : 1;
  const builtBatches = [];

  for (const [, batch] of batchMap) {
    const absIdx = batch.absIndices;
    if (!absIdx.length) continue;

    const g2l = new Map();
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
      lmOffU     = (col * 128) / lmW;
      lmOffV     = (row * 128) / lmH;
      lmScaleU   = 128 / lmW;
      lmScaleV   = 128 / lmH;
    }

    let vertCount = 0;
    for (let i = 0; i < absIdx.length; i++) {
      const gi = absIdx[i];
      let li   = g2l.get(gi);

      if (li === undefined) {
        li = vertCount++;
        g2l.set(gi, li);

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

    builtBatches.push({
      texIdx:   batch.texIdx,
      lmIdx:    batch.lmIdx,
      noclip:   batch.noclip,
      invisible: batch.invisible,
      hasLM:    lmAtlas !== null && batch.lmIdx >= 0 && batch.lmIdx < lmCount,
      pos:      posArr.subarray(0, vertCount * 3),
      nrm:      nrmArr.subarray(0, vertCount * 3),
      uv1:      uv1Arr.subarray(0, vertCount * 2),
      uv2:      uv2Arr.subarray(0, vertCount * 2),
      idx:      idxArr,
    });
  }

  return builtBatches;
}

// ── Worker message handler ────────────────────────────────────────────────────
self.onmessage = function ({ data }) {
  try {
    const { buffer, textureBase, fallbackTexBase } = data;
    const view = new DataView(buffer);

    if (view.getUint32(0, true) !== MAGIC)   throw new Error('File is not IBSP');
    if (view.getInt32(4, true)  !== VERSION) throw new Error(`BSP version ${view.getInt32(4,true)} is not supported`);

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
    const lights  = [];
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

    lights.push(...parseLights(entities));

    self.postMessage({ type: 'progress', pct: 10 });

    // ── Noclip face set (for rendering mesh flags only) ──────────────────────
    const modelLump   = lump(LUMP_MODELS);
    const noclipFaces = buildNoclipFaceSet(entities, buffer, modelLump);

    // ── Texture names + content flags ────────────────────────────────────────
    const texLump  = lump(LUMP_TEXTURES);
    const texCount = (texLump.length / TEX_RECORD_SIZE) | 0;
    const texNames    = [];
    const texContents = new Int32Array(texCount);

    for (let i = 0; i < texCount; i++) {
      const off = texLump.offset + i * TEX_RECORD_SIZE;
      let name = '';
      for (let c = 0; c < 64; c++) {
        const ch = view.getUint8(off + c);
        if (!ch) break;
        name += String.fromCharCode(ch);
      }
      texNames.push(name.toLowerCase().replace(/\\/g, '/').replace(/^textures\//, ''));
      // Content flags at byte offset 68 within the shader record
      texContents[i] = view.getInt32(off + 68, true);
    }

    self.postMessage({ type: 'progress', pct: 20 });

    // ── BSP Collision (planes / nodes / leafs / brushes) ─────────────────────
    const bspCollision = parseBSPCollision(buffer, view, lump, texContents);

    self.postMessage({ type: 'progress', pct: 28 });

    // ── Lightmaps ────────────────────────────────────────────────────────────
    const lmLump  = lump(LUMP_LIGHTMAPS);
    const lmCount = (lmLump.length / LM_SIZE) | 0;
    const lmAtlas = buildLightmapAtlas(buffer, lmLump, lmCount);

    self.postMessage({ type: 'progress', pct: 45 });

    // ── Vertices ─────────────────────────────────────────────────────────────
    const { rawPos, rawUV1, rawUV2, rawNorm } = parseVertices(buffer, lump(LUMP_VERTS));

    self.postMessage({ type: 'progress', pct: 58 });

    // ── Batches ──────────────────────────────────────────────────────────────
    const batches = buildBatches(
      buffer,
      lump(LUMP_FACES),
      lump(LUMP_MESH_VERTS),
      rawPos, rawUV1, rawUV2, rawNorm,
      lmAtlas, lmCount,
      noclipFaces,
      texNames,
    );

    self.postMessage({ type: 'progress', pct: 85 });

    // ── Assemble transferable list ────────────────────────────────────────────
    const transferList = [];

    if (lmAtlas) transferList.push(lmAtlas.atlasData);

    // BSP collision buffers (transferred, zero-copy)
    transferList.push(
      bspCollision.planes.buffer,
      bspCollision.brushSides.buffer,
      bspCollision.brushes.buffer,
      bspCollision.leafBrushes.buffer,
      bspCollision.leafs.buffer,
      bspCollision.nodes.buffer,
    );

    // Batch geometry buffers
    for (const b of batches) {
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
      lights,
      playerStart,
      ambientIntensity,
      ambientColorArr,
      texNames,
      lmAtlas: lmAtlas ? {
        data:    lmAtlas.atlasData,
        W:       lmAtlas.W,
        H:       lmAtlas.H,
        cols:    lmAtlas.cols,
        rows:    lmAtlas.rows,
        nonZero: lmAtlas.nonZero,
      } : null,
      batches,
      // BSP collision data for physics.js
      bspCollision: {
        planes:      bspCollision.planes.buffer,
        brushSides:  bspCollision.brushSides.buffer,
        brushes:     bspCollision.brushes.buffer,
        leafBrushes: bspCollision.leafBrushes.buffer,
        leafs:       bspCollision.leafs.buffer,
        nodes:       bspCollision.nodes.buffer,
      },
    }, transferList);

  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
