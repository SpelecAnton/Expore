/**
 * SPELEC BSP Worker v6 — Q3 BSP (IBSP v46)
 *
 * v6 — Bezier patch tessellation (face type 2):
 *   Q3 maps use bi-quadratic Bezier patches for curved surfaces (arches, domes,
 *   organic walls).  Skipping them leaves large holes in the geometry.
 *   buildPatchBatches() tessellates each 3×3 sub-patch into PATCH_TESS×PATCH_TESS
 *   quads using standard Bernstein basis evaluation and appends the resulting
 *   geometry batches alongside the regular polygon/mesh batches.
 *
 * v5 — BSP brush collision data (planes/nodes/leafs/brushes/brushSides).
 * v4 — invisible clip textures.
 * v3 — light entity + bloom sprite.
 * v2 — func_wall / noclip support.
 */

'use strict';

// ── Lump indices ──────────────────────────────────────────────────────────────
const MAGIC             = 0x50534249;
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
const TEX_RECORD_SIZE        = 72;
const VERT_RECORD_SIZE       = 44;
const FACE_RECORD_SIZE       = 104;
const MODEL_RECORD_SIZE      = 40;
const PLANE_RECORD_SIZE      = 16;
const NODE_RECORD_SIZE       = 36;
const LEAF_RECORD_SIZE       = 48;
const BRUSH_RECORD_SIZE      = 12;
const BRUSH_SIDE_RECORD_SIZE = 8;
const LM_SIZE                = 128 * 128 * 3;
const UNIT                   = 0.02;

// ── Patch tessellation level ──────────────────────────────────────────────────
// Each 3×3 sub-patch is subdivided into PATCH_TESS×PATCH_TESS quads.
// 5 → 36 vertices + 50 triangles per sub-patch (good quality/performance balance).
const PATCH_TESS = 5;

// ── Content flags ─────────────────────────────────────────────────────────────
const CONTENTS_SOLID      = 1;
const CONTENTS_PLAYERCLIP = 0x10000;

// ── Classnames / texture sets ─────────────────────────────────────────────────
const NOCLIP_CLASSNAMES = new Set([
  'func_wall', 'func_illusionary', 'func_detail', 'func_fog',
]);

const INVISIBLE_TEXTURES = new Set([
  'common/clip', 'common/nodraw', 'common/hint', 'common/skip',
  'common/caulk', 'common/trigger', 'clip', 'nodraw', 'hint',
]);

const LIGHT_CLASSNAMES = new Set(['light', 'light_spot', 'light_point']);

// ── Entity parser ─────────────────────────────────────────────────────────────
function parseEntityLump(text) {
  const entities = [];
  let i = 0, n = text.length;
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

// ── Noclip face set ───────────────────────────────────────────────────────────
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
    if (firstFace < 0 || numFaces < 0 || numFaces > 100000) continue;
    for (let fi = firstFace; fi < firstFace + numFaces; fi++) noclipFaces.add(fi);
  }
  return noclipFaces;
}

// ── Light entity parser ───────────────────────────────────────────────────────
function parseLights(entities) {
  const lights = [];
  for (const e of entities) {
    if (!LIGHT_CLASSNAMES.has(e.classname)) continue;
    const [ox, oy, oz] = (e.origin || '0 0 0').split(' ').map(Number);
    let r = 1, g = 1, b = 1, intensity = 200;
    if (e._light) {
      const p = e._light.trim().split(/\s+/).map(Number);
      if (p.length >= 4) { r=p[0]/255; g=p[1]/255; b=p[2]/255; intensity=p[3]; }
      else if (p.length === 1) intensity = p[0];
    } else if (e._color) {
      const p = e._color.trim().split(/\s+/).map(Number);
      if (p.length >= 3) { r=p[0]; g=p[1]; b=p[2]; }
    }
    r = Math.max(0, Math.min(1, r));
    g = Math.max(0, Math.min(1, g));
    b = Math.max(0, Math.min(1, b));
    lights.push({ x:ox*UNIT, y:oz*UNIT, z:-oy*UNIT, r, g, b, intensity, sprite: e._sprite==='1' });
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
  let nonZero = 0;
  for (let idx = 0; idx < lmCount; idx++) {
    const chunkOffset = lmLump.offset + idx * LM_SIZE;
    const col = idx % cols, row = (idx / cols) | 0;
    const ox = col * 128, oy = row * 128;
    const src = new Uint8Array(buffer, chunkOffset, LM_SIZE);
    for (let y = 0; y < 128; y++) {
      const dstBase = ((oy + y) * W + ox) * 4;
      for (let x = 0; x < 128; x++) {
        const s = (y * 128 + x) * 3;
        const d = dstBase + x * 4;
        atlas[d]   = src[s]; atlas[d+1] = src[s+1]; atlas[d+2] = src[s+2]; atlas[d+3] = 255;
        if (src[s] | src[s+1] | src[s+2]) nonZero++;
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
    const qx = view.getFloat32(o,     true);
    const qy = view.getFloat32(o+4,   true);
    const qz = view.getFloat32(o+8,   true);
    rawPos[i*3]   =  qx * UNIT;
    rawPos[i*3+1] =  qz * UNIT;
    rawPos[i*3+2] = -qy * UNIT;
    rawUV1[i*2]   = view.getFloat32(o+12, true);
    rawUV1[i*2+1] = view.getFloat32(o+16, true);
    rawUV2[i*2]   = view.getFloat32(o+20, true);
    rawUV2[i*2+1] = view.getFloat32(o+24, true);
    const nx = view.getFloat32(o+28, true);
    const ny = view.getFloat32(o+32, true);
    const nz = view.getFloat32(o+36, true);
    rawNorm[i*3]   =  nx;
    rawNorm[i*3+1] =  nz;
    rawNorm[i*3+2] = -ny;
  }
  return { rawPos, rawUV1, rawUV2, rawNorm };
}

// ── Atlas UV helpers ──────────────────────────────────────────────────────────
function lmAtlasParams(lmAtlas, lmIdx, lmCount) {
  if (!lmAtlas || lmIdx < 0 || lmIdx >= lmCount) return { u0:0, v0:0, su:1, sv:1, valid:false };
  const col  = lmIdx % lmAtlas.cols;
  const row  = (lmIdx / lmAtlas.cols) | 0;
  return {
    u0: (col * 128) / lmAtlas.W,
    v0: (row * 128) / lmAtlas.H,
    su:  128 / lmAtlas.W,
    sv:  128 / lmAtlas.H,
    valid: true,
  };
}

// ── Regular face batches (type 1 polygon, type 3 mesh) ────────────────────────
function buildBatches(buffer, fLump, mvLump, rawPos, rawUV1, rawUV2, rawNorm,
                      lmAtlas, lmCount, noclipFaces, texNames) {
  const view      = new DataView(buffer);
  const fCount    = (fLump.length / FACE_RECORD_SIZE) | 0;
  const mvCount   = (mvLump.length / 4) | 0;
  const meshVerts = new Int32Array(buffer, mvLump.offset, mvCount);
  const batchMap  = new Map();
  const totalVerts = rawPos.length / 3;

  for (let fi = 0; fi < fCount; fi++) {
    const fo       = fLump.offset + fi * FACE_RECORD_SIZE;
    const texIdx   = view.getInt32(fo,     true);
    const faceType = view.getInt32(fo+8,   true);
    if (faceType !== 1 && faceType !== 3) continue;   // skip patches & billboards

    const vertStart = view.getInt32(fo+12, true);
    const vertCount = view.getInt32(fo+16, true);
    if (vertCount < 3) continue;
    if (vertStart < 0 || vertStart >= totalVerts) continue;

    const mvStart  = view.getInt32(fo+20, true);
    const mvCount2 = view.getInt32(fo+24, true);
    const lmIdx    = view.getInt32(fo+28, true);

    const isNoclip    = noclipFaces.has(fi);
    const texName     = (texNames[texIdx] || '').toLowerCase();
    const isInvisible = INVISIBLE_TEXTURES.has(texName);
    const key = `${texIdx}:${lmIdx}:${isNoclip?'n':'s'}:${isInvisible?'i':'v'}`;

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
        const a = vertStart, c = vertStart + t, d = vertStart + t + 1;
        if (a < totalVerts && c < totalVerts && d < totalVerts) abs.push(a, c, d);
      }
    }
  }

  const builtBatches = [];

  for (const [, batch] of batchMap) {
    const absIdx = batch.absIndices;
    if (!absIdx.length) continue;

    const lm = lmAtlasParams(lmAtlas, batch.lmIdx, lmCount);
    const g2l = new Map();
    const maxV = absIdx.length;
    const posArr = new Float32Array(maxV * 3), nrmArr = new Float32Array(maxV * 3);
    const uv1Arr = new Float32Array(maxV * 2), uv2Arr = new Float32Array(maxV * 2);
    const idxArr = new Uint32Array(absIdx.length);
    let vertCount = 0;

    for (let i = 0; i < absIdx.length; i++) {
      const gi = absIdx[i];
      let li   = g2l.get(gi);
      if (li === undefined) {
        li = vertCount++;
        g2l.set(gi, li);
        posArr[li*3]   = rawPos[gi*3];   posArr[li*3+1] = rawPos[gi*3+1]; posArr[li*3+2] = rawPos[gi*3+2];
        nrmArr[li*3]   = rawNorm[gi*3];  nrmArr[li*3+1] = rawNorm[gi*3+1]; nrmArr[li*3+2] = rawNorm[gi*3+2];
        uv1Arr[li*2]   = rawUV1[gi*2];   uv1Arr[li*2+1] = 1.0 - rawUV1[gi*2+1];
        uv2Arr[li*2]   = rawUV2[gi*2]   * lm.su + lm.u0;
        uv2Arr[li*2+1] = rawUV2[gi*2+1] * lm.sv + lm.v0;
      }
      idxArr[i] = li;
    }

    builtBatches.push({
      texIdx: batch.texIdx, lmIdx: batch.lmIdx,
      noclip: batch.noclip, invisible: batch.invisible,
      hasLM:  lmAtlas !== null && lm.valid,
      pos: posArr.subarray(0, vertCount * 3), nrm: nrmArr.subarray(0, vertCount * 3),
      uv1: uv1Arr.subarray(0, vertCount * 2), uv2: uv2Arr.subarray(0, vertCount * 2),
      idx: idxArr,
    });
  }
  return builtBatches;
}

// ── Bezier patch tessellation (face type 2) ───────────────────────────────────
//
// Q3 curved surfaces are bi-quadratic Bezier patches.  Each face of type 2 has:
//   patchWidth × patchHeight  control points  (always odd dimensions ≥ 3)
// These are divided into  ((W-1)/2) × ((H-1)/2)  sub-patches of 3×3 points each.
// Each 3×3 sub-patch is tessellated into a PATCH_TESS×PATCH_TESS quad grid.
//
// Bernstein basis for t ∈ [0,1]:
//   B0(t) = (1-t)²    B1(t) = 2t(1-t)    B2(t) = t²
//
// Surface point P(s,t) = ΣΣ B_i(s) · B_j(t) · cp[i][j]
//
// All attributes (position, normal, tex UV, lightmap UV) are interpolated the
// same way.  rawPos/rawUV1/rawUV2/rawNorm are already in Three.js space.
function buildPatchBatches(buffer, fLump, rawPos, rawUV1, rawUV2, rawNorm,
                            lmAtlas, lmCount, noclipFaces, texNames) {
  const view   = new DataView(buffer);
  const fCount = (fLump.length / FACE_RECORD_SIZE) | 0;
  const totalVerts = rawPos.length / 3;

  // Each patch face gets its own batch (no de-duplication needed — typical maps
  // have a few hundred patches total, each with a unique texture+lm combo).
  const patchBatches = [];
  const N  = PATCH_TESS;
  const N1 = N + 1;

  for (let fi = 0; fi < fCount; fi++) {
    const fo       = fLump.offset + fi * FACE_RECORD_SIZE;
    const faceType = view.getInt32(fo + 8, true);
    if (faceType !== 2) continue;

    const texIdx    = view.getInt32(fo,      true);
    const vertStart = view.getInt32(fo + 12, true);
    const vertCount = view.getInt32(fo + 16, true);
    const lmIdx     = view.getInt32(fo + 28, true);
    const patchW    = view.getInt32(fo + 96, true);
    const patchH    = view.getInt32(fo + 100, true);

    // Basic validity checks
    if (patchW < 3 || patchH < 3) continue;
    if ((patchW - 1) % 2 !== 0 || (patchH - 1) % 2 !== 0) continue;
    if (vertStart < 0 || vertCount !== patchW * patchH) continue;
    if (vertStart + vertCount > totalVerts) continue;

    const texName   = (texNames[texIdx] || '').toLowerCase();
    const isInvis   = INVISIBLE_TEXTURES.has(texName);
    const isNoclip  = noclipFaces.has(fi);
    const lm        = lmAtlasParams(lmAtlas, lmIdx, lmCount);

    const subW = (patchW - 1) / 2;
    const subH = (patchH - 1) / 2;
    const vertsPerSub = N1 * N1;
    const trisPerSub  = N  * N * 2;
    const totalV      = subW * subH * vertsPerSub;
    const totalI      = subW * subH * trisPerSub * 3;

    const posArr = new Float32Array(totalV * 3);
    const nrmArr = new Float32Array(totalV * 3);
    const uv1Arr = new Float32Array(totalV * 2);
    const uv2Arr = new Float32Array(totalV * 2);
    const idxArr = new Uint32Array(totalI);

    let vOff = 0, iOff = 0;

    for (let si = 0; si < subH; si++) {
      for (let sj = 0; sj < subW; sj++) {

        // Extract the 9 control-point vertex indices for this 3×3 sub-patch
        const cpI = new Int32Array(9);
        for (let ri = 0; ri < 3; ri++) {
          for (let ci = 0; ci < 3; ci++) {
            cpI[ri * 3 + ci] = vertStart + (si * 2 + ri) * patchW + (sj * 2 + ci);
          }
        }

        const vBase = vOff;

        // Generate (N+1)×(N+1) tessellated vertices by bi-quadratic evaluation
        for (let i = 0; i <= N; i++) {
          const s   = i / N;
          const b0s = (1-s)*(1-s), b1s = 2*(1-s)*s, b2s = s*s;

          for (let j = 0; j <= N; j++) {
            const t   = j / N;
            const b0t = (1-t)*(1-t), b1t = 2*(1-t)*t, b2t = t*t;

            const bS = [b0s, b1s, b2s];
            const bT = [b0t, b1t, b2t];

            let px=0, py=0, pz=0, pu1=0, pv1=0, pu2=0, pv2=0, pnx=0, pny=0, pnz=0;

            for (let ri = 0; ri < 3; ri++) {
              for (let ci = 0; ci < 3; ci++) {
                const w  = bS[ri] * bT[ci];
                const vi = cpI[ri * 3 + ci];
                px  += rawPos[vi*3]   * w;  py  += rawPos[vi*3+1] * w;  pz  += rawPos[vi*3+2] * w;
                pu1 += rawUV1[vi*2]   * w;  pv1 += rawUV1[vi*2+1] * w;
                pu2 += rawUV2[vi*2]   * w;  pv2 += rawUV2[vi*2+1] * w;
                pnx += rawNorm[vi*3]  * w;  pny += rawNorm[vi*3+1] * w;  pnz += rawNorm[vi*3+2] * w;
              }
            }

            // Re-normalise interpolated normal
            const nl = Math.sqrt(pnx*pnx + pny*pny + pnz*pnz);
            if (nl > 0.001) { pnx /= nl; pny /= nl; pnz /= nl; }

            posArr[vOff*3]   = px;  posArr[vOff*3+1] = py;  posArr[vOff*3+2] = pz;
            nrmArr[vOff*3]   = pnx; nrmArr[vOff*3+1] = pny; nrmArr[vOff*3+2] = pnz;
            uv1Arr[vOff*2]   = pu1; uv1Arr[vOff*2+1] = 1 - pv1; // V-flip for Three.js
            uv2Arr[vOff*2]   = pu2 * lm.su + lm.u0;
            uv2Arr[vOff*2+1] = pv2 * lm.sv + lm.v0;
            vOff++;
          }
        }

        // Quad grid indices: two triangles per cell, CCW winding
        for (let i = 0; i < N; i++) {
          for (let j = 0; j < N; j++) {
            const a = vBase + i * N1 + j;
            const b = a + N1;            // row below
            // triangle 1: a, b, a+1
            idxArr[iOff++] = a;
            idxArr[iOff++] = b;
            idxArr[iOff++] = a + 1;
            // triangle 2: b, b+1, a+1
            idxArr[iOff++] = b;
            idxArr[iOff++] = b + 1;
            idxArr[iOff++] = a + 1;
          }
        }
      }
    }

    if (vOff === 0) continue;

    patchBatches.push({
      texIdx, lmIdx,
      noclip:   isNoclip,
      invisible: isInvis,
      hasLM:    lm.valid,
      pos: posArr.subarray(0, vOff * 3), nrm: nrmArr.subarray(0, vOff * 3),
      uv1: uv1Arr.subarray(0, vOff * 2), uv2: uv2Arr.subarray(0, vOff * 2),
      idx: idxArr.subarray(0, iOff),
    });
  }

  console.log(`[BSP Worker] Patch batches: ${patchBatches.length} (TESS=${N})`);
  return patchBatches;
}

// ── BSP Collision Data ────────────────────────────────────────────────────────
function parseBSPCollision(buffer, view, lumpFn, texContents) {
  // Planes: transform Q3(x,y,z) → Three.js(x,z,-y), scale dist by UNIT
  const planeLump  = lumpFn(LUMP_PLANES);
  const planeCount = (planeLump.length / PLANE_RECORD_SIZE) | 0;
  const planes     = new Float32Array(planeCount * 4);
  for (let i = 0; i < planeCount; i++) {
    const off  = planeLump.offset + i * PLANE_RECORD_SIZE;
    planes[i*4]   =  view.getFloat32(off,    true);
    planes[i*4+1] =  view.getFloat32(off+8,  true);
    planes[i*4+2] = -view.getFloat32(off+4,  true);
    planes[i*4+3] =  view.getFloat32(off+12, true) * UNIT;
  }

  // Brush sides — planeIdx only
  const bsLump  = lumpFn(LUMP_BRUSH_SIDES);
  const bsCount = (bsLump.length / BRUSH_SIDE_RECORD_SIZE) | 0;
  const brushSides = new Int32Array(bsCount);
  for (let i = 0; i < bsCount; i++)
    brushSides[i] = view.getInt32(bsLump.offset + i * BRUSH_SIDE_RECORD_SIZE, true);

  // Brushes: [firstSide, numSides, contentFlags]
  const bLump  = lumpFn(LUMP_BRUSHES);
  const bCount = (bLump.length / BRUSH_RECORD_SIZE) | 0;
  const brushes = new Int32Array(bCount * 3);
  for (let i = 0; i < bCount; i++) {
    const off       = bLump.offset + i * BRUSH_RECORD_SIZE;
    const shaderIdx = view.getInt32(off+8, true);
    const contents  = (shaderIdx >= 0 && shaderIdx < texContents.length) ? texContents[shaderIdx] : 0;
    brushes[i*3]   = view.getInt32(off,   true);
    brushes[i*3+1] = view.getInt32(off+4, true);
    brushes[i*3+2] = contents;
  }

  // Leaf brushes
  const lbLump     = lumpFn(LUMP_LEAF_BRUSHES);
  const lbCount    = (lbLump.length / 4) | 0;
  const leafBrushes = new Int32Array(buffer, lbLump.offset, lbCount).slice();

  // Leafs: [firstLeafBrush, numLeafBrushes]
  const leafLump  = lumpFn(LUMP_LEAFS);
  const leafCount = (leafLump.length / LEAF_RECORD_SIZE) | 0;
  const leafs     = new Int32Array(leafCount * 2);
  for (let i = 0; i < leafCount; i++) {
    const off = leafLump.offset + i * LEAF_RECORD_SIZE;
    leafs[i*2]   = view.getInt32(off+40, true);
    leafs[i*2+1] = view.getInt32(off+44, true);
  }

  // Nodes: [planeIdx, frontChild, backChild]
  const nodeLump  = lumpFn(LUMP_NODES);
  const nodeCount = (nodeLump.length / NODE_RECORD_SIZE) | 0;
  const nodes     = new Int32Array(nodeCount * 3);
  for (let i = 0; i < nodeCount; i++) {
    const off = nodeLump.offset + i * NODE_RECORD_SIZE;
    nodes[i*3]   = view.getInt32(off,   true);
    nodes[i*3+1] = view.getInt32(off+4, true);
    nodes[i*3+2] = view.getInt32(off+8, true);
  }

  console.log(`[BSP Worker] Collision: ${planeCount} planes, ${nodeCount} nodes, ${leafCount} leafs, ${bCount} brushes`);
  return { planes, brushSides, brushes, leafBrushes, leafs, nodes };
}

// ── Worker message handler ────────────────────────────────────────────────────
self.onmessage = function ({ data }) {
  try {
    const { buffer, textureBase, fallbackTexBase } = data;
    const view = new DataView(buffer);

    if (view.getUint32(0, true) !== MAGIC)   throw new Error('Not IBSP');
    if (view.getInt32(4, true)  !== VERSION) throw new Error(`BSP version ${view.getInt32(4,true)} not supported`);

    const lump = id => ({
      offset: view.getInt32(8 + id * 8,     true),
      length: view.getInt32(8 + id * 8 + 4, true),
    });

    self.postMessage({ type: 'progress', pct: 5 });

    // ── Entities ──────────────────────────────────────────────────────────────
    const entLump = lump(LUMP_ENTITIES);
    const entText = new TextDecoder().decode(new Uint8Array(buffer, entLump.offset, entLump.length));
    const entities = parseEntityLump(entText);

    const portals = [], lights = [];
    let playerStart = null, ambientIntensity, ambientColorArr;
    for (const e of entities) {
      if (e.classname === 'trigger_portal') {
        portals.push(e);
      } else if (e.classname === 'info_player_start') {
        const [ox, oy, oz] = (e.origin || '0 0 0').split(' ').map(Number);
        playerStart = { x:ox*UNIT, y:oz*UNIT, z:-oy*UNIT, angle:parseFloat(e.angle||'0') };
      } else if (e.classname === 'worldspawn') {
        const v = parseFloat(e['_ambient']);
        if (!isNaN(v)) ambientIntensity = v;
        if (e['_ambient_color']) {
          const [r,g,b] = e['_ambient_color'].trim().split(/\s+/).map(Number);
          if (!isNaN(r)) ambientColorArr = [r/255, g/255, b/255];
        }
      }
    }
    lights.push(...parseLights(entities));

    self.postMessage({ type: 'progress', pct: 10 });

    // ── Noclip face set ───────────────────────────────────────────────────────
    const modelLump   = lump(LUMP_MODELS);
    const noclipFaces = buildNoclipFaceSet(entities, buffer, modelLump);

    // ── Texture names + content flags ─────────────────────────────────────────
    const texLump     = lump(LUMP_TEXTURES);
    const texCount    = (texLump.length / TEX_RECORD_SIZE) | 0;
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
      texContents[i] = view.getInt32(off + 68, true);
    }

    self.postMessage({ type: 'progress', pct: 20 });

    // ── BSP Collision ─────────────────────────────────────────────────────────
    const bspCollision = parseBSPCollision(buffer, view, lump, texContents);
    self.postMessage({ type: 'progress', pct: 28 });

    // ── Lightmaps ─────────────────────────────────────────────────────────────
    const lmLump  = lump(LUMP_LIGHTMAPS);
    const lmCount = (lmLump.length / LM_SIZE) | 0;
    const lmAtlas = buildLightmapAtlas(buffer, lmLump, lmCount);
    self.postMessage({ type: 'progress', pct: 42 });

    // ── Vertices ──────────────────────────────────────────────────────────────
    const { rawPos, rawUV1, rawUV2, rawNorm } = parseVertices(buffer, lump(LUMP_VERTS));
    self.postMessage({ type: 'progress', pct: 55 });

    // ── Polygon / mesh batches ────────────────────────────────────────────────
    const regularBatches = buildBatches(
      buffer, lump(LUMP_FACES), lump(LUMP_MESH_VERTS),
      rawPos, rawUV1, rawUV2, rawNorm,
      lmAtlas, lmCount, noclipFaces, texNames
    );
    self.postMessage({ type: 'progress', pct: 72 });

    // ── Bezier patch batches ──────────────────────────────────────────────────
    const patchBatches = buildPatchBatches(
      buffer, lump(LUMP_FACES),
      rawPos, rawUV1, rawUV2, rawNorm,
      lmAtlas, lmCount, noclipFaces, texNames
    );
    self.postMessage({ type: 'progress', pct: 85 });

    const batches = [...regularBatches, ...patchBatches];
    console.log(`[BSP Worker] Total batches: ${batches.length} (${regularBatches.length} regular + ${patchBatches.length} patch)`);

    // ── Build transferable list ───────────────────────────────────────────────
    const transferList = [];
    if (lmAtlas) transferList.push(lmAtlas.atlasData);

    transferList.push(
      bspCollision.planes.buffer, bspCollision.brushSides.buffer,
      bspCollision.brushes.buffer, bspCollision.leafBrushes.buffer,
      bspCollision.leafs.buffer, bspCollision.nodes.buffer,
    );

    for (const b of batches) {
      b.pos = b.pos.slice().buffer; b.nrm = b.nrm.slice().buffer;
      b.uv1 = b.uv1.slice().buffer; b.uv2 = b.uv2.slice().buffer;
      b.idx = b.idx.slice().buffer;
      transferList.push(b.pos, b.nrm, b.uv1, b.uv2, b.idx);
    }

    self.postMessage({ type: 'progress', pct: 95 });

    self.postMessage({
      type: 'done',
      portals, lights, playerStart, ambientIntensity, ambientColorArr,
      texNames,
      lmAtlas: lmAtlas ? { data:lmAtlas.atlasData, W:lmAtlas.W, H:lmAtlas.H,
                            cols:lmAtlas.cols, rows:lmAtlas.rows, nonZero:lmAtlas.nonZero } : null,
      batches,
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
