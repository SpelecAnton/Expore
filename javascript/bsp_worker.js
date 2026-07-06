"use strict";
// SPELEC BSP Worker — parses the compiled BSP tree (planes/nodes/leafs) and
// PVS visdata, and tags render batches with their cluster id(s). This is what
// lets engine.js do camera-cluster occlusion culling instead of rendering the
// whole map every frame. Falls back cleanly (hasTree/hasVis = false) when a
// map has no tree/visdata lumps (e.g. compiled without a -vis pass) — legacy
// maps keep rendering fully, unchanged.
//
// IMPORTANT: per-cluster batch splitting (buildBatches) only kicks in when
// hasVis is true. A leaf's cluster id exists from the -bsp phase regardless
// of whether -vis ever ran, but without visdata there is no PVS matrix to
// cull anything with — splitting batches by cluster in that case would only
// add draw calls/duplicated geometry for zero benefit, which is a real perf
// regression, not an optimization. So: no usable visdata -> exactly the old
// single-batch-per-texture/lightmap behavior, no fragmentation at all.
//
// IMPORTANT #2: a face can be referenced by more than one leaf (boundary
// faces between clusters, or large surfaces cut across many leafs). Each
// face keeps the FULL list of clusters that reference it (not just the last
// one seen) — otherwise a boundary face gets assigned to only one cluster
// and disappears when the camera is standing in another cluster that can
// also see it.

const MAGIC = 1347633737,
    VERSION = 46,
    LUMP_ENTITIES = 0,
    LUMP_TEXTURES = 1,
    LUMP_PLANES = 2,
    LUMP_NODES = 3,
    LUMP_LEAFS = 4,
    LUMP_LEAFFACES = 5,
    LUMP_MODELS = 7,
    LUMP_LIGHTMAPS = 14,
    LUMP_VERTS = 10,
    LUMP_MESH_VERTS = 11,
    LUMP_FACES = 13,
    LUMP_VISDATA = 16,
    TEX_RECORD_SIZE = 72,
    VERT_RECORD_SIZE = 44,
    FACE_RECORD_SIZE = 104,
    MODEL_RECORD_SIZE = 40,
    PLANE_RECORD_SIZE = 16,
    NODE_RECORD_SIZE = 36,
    LEAF_RECORD_SIZE = 48,
    LEAFFACE_RECORD_SIZE = 4,
    LM_SIZE = 49152,
    UNIT = 0.02,
    MAX_CLUSTERS_PER_FACE = 64,
    NOCLIP_CLASSNAMES = new Set(["func_wall", "func_illusionary", "func_detail", "func_fog"]),
    INVISIBLE_TEXTURES = new Set([
        "common/clip",
        "common/nodraw",
        "common/hint",
        "common/skip",
        "common/caulk",
        "common/trigger",
        "clip",
        "nodraw",
        "hint",
    ]),
    LIGHT_CLASSNAMES = new Set(["light", "light_spot", "light_point"]);

function parseEntityLump(text) {
    const entities = [];
    let pos = 0;
    const len = text.length;
    while (pos < len) {
        while (pos < len && text[pos] !== "{") pos++;
        if (pos >= len) break;
        pos++;
        const ent = {};
        while (pos < len && text[pos] !== "}") {
            while (pos < len && text[pos] !== '"' && text[pos] !== "}") pos++;
            if (pos >= len || text[pos] === "}") break;
            pos++; // consume key's opening quote
            let key = "";
            while (pos < len && text[pos] !== '"') key += text[pos++];
            pos++; // consume key's closing quote
            while (pos < len && text[pos] !== '"') pos++; // skip to value's opening quote
            pos++; // consume value's opening quote
            let value = "";
            while (pos < len && text[pos] !== '"') value += text[pos++];
            pos++; // consume value's closing quote
            if (key) ent[key] = value;
        }
        pos++;
        if (Object.keys(ent).length) entities.push(ent);
    }
    return entities;
}

function buildNoclipFaceSet(entities, buffer, modelsLump) {
    const noclipFaces = new Set(),
        numModels = (modelsLump.length / MODEL_RECORD_SIZE) | 0,
        dv = new DataView(buffer);
    for (const ent of entities) {
        if (!NOCLIP_CLASSNAMES.has(ent.classname)) continue;
        const modelStr = ent.model ?? "";
        if (!modelStr.startsWith("*")) continue;
        const modelIdx = parseInt(modelStr.slice(1), 10);
        if (isNaN(modelIdx) || modelIdx < 1 || modelIdx >= numModels) continue;
        const o = modelsLump.offset + MODEL_RECORD_SIZE * modelIdx,
            firstFace = dv.getInt32(o + 24, true),
            numFaces = dv.getInt32(o + 28, true);
        console.log(`[BSP Worker] ${ent.classname} model=*${modelIdx}: firstFace=${firstFace}, numFaces=${numFaces}`);
        if (firstFace < 0 || numFaces < 0 || numFaces > 1e5) {
            console.warn(`[BSP Worker] Skipping ${ent.classname} — invalid face values`);
        } else {
            for (let f = firstFace; f < firstFace + numFaces; f++) noclipFaces.add(f);
        }
    }
    return noclipFaces;
}

function parseLights(entities) {
    const lights = [];
    for (const ent of entities) {
        if (!LIGHT_CLASSNAMES.has(ent.classname)) continue;
        const [ox, oy, oz] = (ent.origin || "0 0 0").split(" ").map(Number);
        let r = 1,
            g = 1,
            b = 1,
            intensity = 200,
            hasColor = false,
            hasIntensity = false;

        if (ent.color) {
            const parts = ent.color.trim().split(/\s+/).map(Number);
            if (parts.length >= 3) {
                r = parts[0] / 255;
                g = parts[1] / 255;
                b = parts[2] / 255;
                hasColor = true;
            }
        } else if (ent._color) {
            const parts = ent._color.trim().split(/\s+/).map(Number);
            if (parts.length >= 3) {
                r = parts[0] / 255;
                g = parts[1] / 255;
                b = parts[2] / 255;
                hasColor = true;
            }
        }

        const lightVal = parseFloat(ent.light);
        if (!isNaN(lightVal)) {
            intensity = lightVal;
            hasIntensity = true;
        }

        if (ent._light) {
            const parts = ent._light.trim().split(/\s+/).map(Number);
            if (parts.length >= 4) {
                if (!hasColor) {
                    r = parts[0] / 255;
                    g = parts[1] / 255;
                    b = parts[2] / 255;
                    hasColor = true;
                }
                if (!hasIntensity) {
                    intensity = parts[3];
                    hasIntensity = true;
                }
            } else if (parts.length === 1 && !hasIntensity) {
                intensity = parts[0];
                hasIntensity = true;
            }
        }

        r = Math.max(0, Math.min(1, r));
        g = Math.max(0, Math.min(1, g));
        b = Math.max(0, Math.min(1, b));
        const sprite = ent._sprite === "1";
        lights.push({ x: UNIT * ox, y: UNIT * oz, z: UNIT * -oy, r, g, b, intensity, sprite });
    }
    if (lights.length > 0) {
        const spriteCount = lights.filter((l) => l.sprite).length;
        console.log(`[BSP Worker] Lights: ${lights.length} total, ${spriteCount} with sprite`);
    }
    return lights;
}

function buildLightmapAtlas(buffer, lightmapsLump, numLightmaps) {
    if (numLightmaps === 0) return null;
    const cols = Math.ceil(Math.sqrt(numLightmaps)),
        rows = Math.ceil(numLightmaps / cols),
        W = 128 * cols,
        H = 128 * rows,
        atlas = new Uint8Array(W * H * 4),
        rowBuf = new Uint8Array(384);
    let nonZero = 0;
    for (let lm = 0; lm < numLightmaps; lm++) {
        const srcOffset = lightmapsLump.offset + LM_SIZE * lm,
            destX = (lm % cols) * 128,
            destY = 128 * ((lm / cols) | 0),
            src = new Uint8Array(buffer, srcOffset, LM_SIZE);
        for (let y = 0; y < 128; y++) {
            rowBuf.set(src.subarray(384 * y, 384 * y + 384));
            const rowBase = 4 * ((destY + y) * W + destX);
            for (let x = 0; x < 128; x++) {
                const s = 3 * x,
                    d = rowBase + 4 * x;
                atlas[d] = rowBuf[s];
                atlas[d + 1] = rowBuf[s + 1];
                atlas[d + 2] = rowBuf[s + 2];
                atlas[d + 3] = 255;
                if (rowBuf[s] | rowBuf[s + 1] | rowBuf[s + 2]) nonZero++;
            }
        }
    }
    return { atlasData: atlas.buffer, W, H, cols, rows, nonZero };
}

function parseVertices(buffer, vertsLump) {
    const numVerts = (vertsLump.length / VERT_RECORD_SIZE) | 0,
        dv = new DataView(buffer),
        rawPos = new Float32Array(3 * numVerts),
        rawUV1 = new Float32Array(2 * numVerts),
        rawUV2 = new Float32Array(2 * numVerts),
        rawNorm = new Float32Array(3 * numVerts);
    for (let i = 0; i < numVerts; i++) {
        const o = vertsLump.offset + VERT_RECORD_SIZE * i,
            vx = dv.getFloat32(o, true),
            vy = dv.getFloat32(o + 4, true),
            vz = dv.getFloat32(o + 8, true);
        rawPos[3 * i] = UNIT * vx;
        rawPos[3 * i + 1] = UNIT * vz;
        rawPos[3 * i + 2] = UNIT * -vy;
        rawUV1[2 * i] = dv.getFloat32(o + 12, true);
        rawUV1[2 * i + 1] = dv.getFloat32(o + 16, true);
        rawUV2[2 * i] = dv.getFloat32(o + 20, true);
        rawUV2[2 * i + 1] = dv.getFloat32(o + 24, true);
        const nx = dv.getFloat32(o + 28, true),
            ny = dv.getFloat32(o + 32, true),
            nz = dv.getFloat32(o + 36, true);
        rawNorm[3 * i] = nx;
        rawNorm[3 * i + 1] = nz;
        rawNorm[3 * i + 2] = -ny;
    }
    return { rawPos, rawUV1, rawUV2, rawNorm };
}

// Parses planes/nodes/leafs/leaffaces/visdata. Plane normal/dist are
// converted into the same coordinate space as vertices/lights (permutation
// x,z,-y + UNIT scale) so findCluster() in engine.js can test camera position
// directly, no per-frame conversion needed.
//
// faceClusterOffsets/faceClusterList is a CSR-style (offset + flat list)
// encoding of "which clusters reference this face" — a face can belong to
// several, so this is NOT a single value per face.
function parseBSPTree(buffer, planesLump, nodesLump, leafsLump, leaffacesLump, visLump, numFaces) {
    const dv = new DataView(buffer);

    const numPlanes = (planesLump.length / PLANE_RECORD_SIZE) | 0;
    const planes = new Float32Array(4 * numPlanes);
    for (let i = 0; i < numPlanes; i++) {
        const o = planesLump.offset + PLANE_RECORD_SIZE * i,
            nx = dv.getFloat32(o, true),
            ny = dv.getFloat32(o + 4, true),
            nz = dv.getFloat32(o + 8, true),
            d = dv.getFloat32(o + 12, true);
        planes[4 * i] = nx;
        planes[4 * i + 1] = nz;
        planes[4 * i + 2] = -ny;
        planes[4 * i + 3] = d * UNIT;
    }

    const numNodes = (nodesLump.length / NODE_RECORD_SIZE) | 0;
    const nodePlane = new Int32Array(numNodes);
    const nodeChildren = new Int32Array(2 * numNodes);
    for (let i = 0; i < numNodes; i++) {
        const o = nodesLump.offset + NODE_RECORD_SIZE * i;
        nodePlane[i] = dv.getInt32(o, true);
        nodeChildren[2 * i] = dv.getInt32(o + 4, true);
        nodeChildren[2 * i + 1] = dv.getInt32(o + 8, true);
    }

    const numLeafs = (leafsLump.length / LEAF_RECORD_SIZE) | 0;
    const leafCluster = new Int32Array(numLeafs);
    const leafFirstFace = new Int32Array(numLeafs);
    const leafNumFaces = new Int32Array(numLeafs);
    for (let i = 0; i < numLeafs; i++) {
        const o = leafsLump.offset + LEAF_RECORD_SIZE * i;
        leafCluster[i] = dv.getInt32(o, true);
        leafFirstFace[i] = dv.getInt32(o + 32, true);
        leafNumFaces[i] = dv.getInt32(o + 36, true);
    }

    const numLeafFaces = (leaffacesLump.length / LEAFFACE_RECORD_SIZE) | 0;
    const leafFaces = new Int32Array(numLeafFaces);
    for (let i = 0; i < numLeafFaces; i++) leafFaces[i] = dv.getInt32(leaffacesLump.offset + 4 * i, true);

    // Collect every cluster that references each face (a plain array of Sets
    // — most faces only ever get one entry, boundary/large faces get a few).
    const faceClusterSets = new Array(numFaces);
    for (let l = 0; l < numLeafs; l++) {
        const cluster = leafCluster[l];
        if (cluster < 0) continue;
        const first = leafFirstFace[l],
            count = leafNumFaces[l];
        for (let f = 0; f < count; f++) {
            const li = first + f;
            if (li < 0 || li >= numLeafFaces) continue;
            const faceIdx = leafFaces[li];
            if (faceIdx < 0 || faceIdx >= numFaces) continue;
            if (!faceClusterSets[faceIdx]) faceClusterSets[faceIdx] = new Set();
            faceClusterSets[faceIdx].add(cluster);
        }
    }

    // Flatten into CSR form: faceClusterOffsets[f]..faceClusterOffsets[f+1]
    // is the slice of faceClusterList belonging to face f. A face with zero
    // entries (never referenced, or touches more clusters than the safety
    // cap below) is left empty — buildBatches treats an empty slice as
    // "always visible", the same safe fallback used when PVS is unavailable.
    const faceClusterOffsets = new Int32Array(numFaces + 1);
    const clusterListTmp = [];
    let oversizedFaces = 0;
    for (let f = 0; f < numFaces; f++) {
        faceClusterOffsets[f] = clusterListTmp.length;
        const set = faceClusterSets[f];
        if (set && set.size > 0) {
            if (set.size <= MAX_CLUSTERS_PER_FACE) {
                for (const c of set) clusterListTmp.push(c);
            } else {
                oversizedFaces++;
            }
        }
    }
    faceClusterOffsets[numFaces] = clusterListTmp.length;
    const faceClusterList = Int32Array.from(clusterListTmp);
    if (oversizedFaces > 0) {
        console.warn(`[BSP Worker] ${oversizedFaces} face(s) touch more than ${MAX_CLUSTERS_PER_FACE} clusters — left always-visible`);
    }

    // IBSP46 stores visdata as a plain per-cluster bit matrix (no RLE, unlike
    // Quake1/2) — numClusters rows of bytesPerCluster bytes each, right after
    // the 8-byte header.
    let numClusters = 0,
        bytesPerCluster = 0,
        visBits = null;
    if (visLump.length >= 8) {
        numClusters = dv.getInt32(visLump.offset, true);
        bytesPerCluster = dv.getInt32(visLump.offset + 4, true);
        const need = 8 + numClusters * bytesPerCluster;
        if (numClusters > 0 && bytesPerCluster > 0 && visLump.length >= need) {
            visBits = new Uint8Array(buffer, visLump.offset + 8, numClusters * bytesPerCluster).slice();
        } else {
            numClusters = 0;
            bytesPerCluster = 0;
        }
    }

    const hasTree = numNodes > 0 && numPlanes > 0 && numLeafs > 0;
    const hasVis = hasTree && visBits !== null;

    if (hasVis) {
        console.log(`[BSP Worker] PVS: ${numClusters} clusters, ${bytesPerCluster} bytes/row — occlusion culling enabled`);
    } else if (hasTree) {
        console.warn(
            `[BSP Worker] BSP tree found (${numNodes} nodes, ${numLeafs} leafs) but no usable visdata ` +
            `(visLump.length=${visLump.length}, parsed numClusters=${numClusters}, bytesPerCluster=${bytesPerCluster}). ` +
            "PVS culling disabled — map renders fully (legacy behavior). Was this map compiled with q3map2 -vis, and does the .bsp/.expore actually come from that fresh compile (not a cached/older build)?"
        );
    } else {
        console.log("[BSP Worker] No BSP tree lumps found — PVS culling disabled, map renders fully (legacy behavior)");
    }

    return {
        hasTree,
        hasVis,
        planes,
        nodePlane,
        nodeChildren,
        leafCluster,
        faceClusterOffsets,
        faceClusterList,
        numClusters,
        bytesPerCluster,
        visBits,
    };
}

function buildBatches(buffer, facesLump, meshvertsLump, rawPos, rawUV1, rawUV2, rawNorm, lmAtlas, numLightmaps, noclipFaceSet, texNames, faceClusterInfo) {
    const dv = new DataView(buffer),
        numFaces = (facesLump.length / FACE_RECORD_SIZE) | 0,
        numMeshVerts = (meshvertsLump.length / 4) | 0,
        meshVerts = new Int32Array(buffer, meshvertsLump.offset, numMeshVerts),
        groups = new Map(),
        numVerts = rawPos.length / 3,
        singleAlwaysVisible = [-1];

    for (let f = 0; f < numFaces; f++) {
        const o = facesLump.offset + FACE_RECORD_SIZE * f,
            texIdx = dv.getInt32(o, true),
            faceType = dv.getInt32(o + 8, true);
        
        if (faceType !== 1 && faceType !== 2 && faceType !== 3) continue;
        
        const firstVert = dv.getInt32(o + 12, true),
            numVertsInFace = dv.getInt32(o + 16, true);
        if (numVertsInFace < 3) continue;
        if (firstVert < 0 || firstVert >= numVerts) continue;
        
        const firstMeshVert = dv.getInt32(o + 20, true),
            numMeshVertsInFace = dv.getInt32(o + 24, true),
            lmIdx = dv.getInt32(o + 28, true),
            noclip = noclipFaceSet.has(f),
            texLower = (texNames[texIdx] || "").toLowerCase(),
            invisible = INVISIBLE_TEXTURES.has(texLower);

        const faceIndices = [];
        
        if (faceType === 2) {
            // Biquadratic Bezier Patch
            const patchWidth = dv.getInt32(o + 96, true),
                  patchHeight = dv.getInt32(o + 100, true);
            if (patchWidth > 0 && patchHeight > 0 && patchWidth * patchHeight <= numVertsInFace) {
                // Tessellate patch by rendering the control point grid directly for simplicity,
                // which fills the gap and provides collision.
                for (let y = 0; y < patchHeight - 1; y++) {
                    for (let x = 0; x < patchWidth - 1; x++) {
                        const a = firstVert + y * patchWidth + x;
                        const b = firstVert + (y + 1) * patchWidth + x;
                        const c = firstVert + (y + 1) * patchWidth + (x + 1);
                        const d = firstVert + y * patchWidth + (x + 1);
                        faceIndices.push(a, b, c);
                        faceIndices.push(a, c, d);
                    }
                }
            }
        } else if (numMeshVertsInFace > 0) {
            for (let i = 0; i < numMeshVertsInFace; i++) {
                const mv = firstMeshVert + i;
                if (mv < 0 || mv >= numMeshVerts) continue;
                const vi = firstVert + meshVerts[mv];
                if (vi >= 0 && vi < numVerts) faceIndices.push(vi);
            }
        } else {
            for (let i = 1; i < numVertsInFace - 1; i++) {
                const a = firstVert,
                    b = firstVert + i,
                    c = firstVert + i + 1;
                if (a < numVerts && b < numVerts && c < numVerts) faceIndices.push(a, b, c);
            }
        }
        if (!faceIndices.length) continue;

        // Merge key does NOT include cluster — geometry merges by
        // texture/lightmap/flags only, keeping draw calls low.  We track
        // which clusters each merged batch covers via clusterSet so the
        // engine can still do PVS visibility per mesh.
        const key = `${texIdx}:${lmIdx}:${noclip ? "n" : "s"}:${invisible ? "i" : "v"}`;
        let group = groups.get(key);
        if (!group) {
            group = { texIdx, lmIdx, noclip, invisible, clusterSet: new Set(), absIndices: [] };
            groups.set(key, group);
        }

        // Record which clusters this face belongs to (for PVS lookup).
        if (faceClusterInfo) {
            const start = faceClusterInfo.offsets[f],
                end = faceClusterInfo.offsets[f + 1];
            if (end > start) {
                for (let ci = start; ci < end; ci++) group.clusterSet.add(faceClusterInfo.list[ci]);
            } else {
                group.clusterSet.add(-1);
            }
        } else {
            group.clusterSet.add(-1);
        }

        // Face indices added ONCE (not duplicated per cluster).
        for (const idx of faceIndices) group.absIndices.push(idx);
    }

    const lmCols = lmAtlas ? lmAtlas.cols : 1,
        lmW = lmAtlas ? lmAtlas.W : 1,
        lmH = lmAtlas ? lmAtlas.H : 1,
        batches = [];

    for (const [, group] of groups) {
        const indices = group.absIndices;
        if (!indices.length) continue;

        const remap = new Map(),
            count = indices.length,
            pos = new Float32Array(3 * count),
            nrm = new Float32Array(3 * count),
            uv1 = new Float32Array(2 * count),
            uv2 = new Float32Array(2 * count),
            idx = new Uint32Array(indices.length);

        let lmOffX = 0,
            lmOffY = 0,
            lmScaleX = 1,
            lmScaleY = 1;
        if (lmAtlas && group.lmIdx >= 0 && group.lmIdx < numLightmaps) {
            lmOffX = ((group.lmIdx % lmCols) * 128) / lmW;
            lmOffY = (128 * ((group.lmIdx / lmCols) | 0)) / lmH;
            lmScaleX = 128 / lmW;
            lmScaleY = 128 / lmH;
        }

        let next = 0;
        for (let i = 0; i < indices.length; i++) {
            const v = indices[i];
            let mapped = remap.get(v);
            if (mapped === undefined) {
                mapped = next++;
                remap.set(v, mapped);
                pos[3 * mapped] = rawPos[3 * v];
                pos[3 * mapped + 1] = rawPos[3 * v + 1];
                pos[3 * mapped + 2] = rawPos[3 * v + 2];
                nrm[3 * mapped] = rawNorm[3 * v];
                nrm[3 * mapped + 1] = rawNorm[3 * v + 1];
                nrm[3 * mapped + 2] = rawNorm[3 * v + 2];
                uv1[2 * mapped] = rawUV1[2 * v];
                uv1[2 * mapped + 1] = 1 - rawUV1[2 * v + 1];
                uv2[2 * mapped] = rawUV2[2 * v] * lmScaleX + lmOffX;
                uv2[2 * mapped + 1] = rawUV2[2 * v + 1] * lmScaleY + lmOffY;
            }
            idx[i] = mapped;
        }

        batches.push({
            texIdx: group.texIdx,
            lmIdx: group.lmIdx,
            noclip: group.noclip,
            invisible: group.invisible,
            clusters: Array.from(group.clusterSet),
            hasLM: lmAtlas !== null && group.lmIdx >= 0 && group.lmIdx < numLightmaps,
            pos: pos.subarray(0, 3 * next),
            nrm: nrm.subarray(0, 3 * next),
            uv1: uv1.subarray(0, 2 * next),
            uv2: uv2.subarray(0, 2 * next),
            idx,
        });
    }
    return batches;
}

self.onmessage = function ({ data }) {
    try {
        const { buffer, textureBase, fallbackTexBase } = data,
            dv = new DataView(buffer);
        if (dv.getUint32(0, true) !== MAGIC) throw new Error("File is not IBSP");
        if (dv.getInt32(4, true) !== VERSION) throw new Error(`BSP version ${dv.getInt32(4, true)} is not supported`);
        const lump = (i) => ({ offset: dv.getInt32(8 + 8 * i, true), length: dv.getInt32(8 + 8 * i + 4, true) });

        self.postMessage({ type: "progress", pct: 5 });

        const entitiesLump = lump(LUMP_ENTITIES),
            entities = parseEntityLump(new TextDecoder().decode(new Uint8Array(buffer, entitiesLump.offset, entitiesLump.length))),
            portals = [];
        let ambientIntensity, ambientColorArr, playerStart = null;

        for (const ent of entities) {
            if (ent.classname === "trigger_portal") {
                portals.push(ent);
            } else if (ent.classname === "info_player_start") {
                const [px, py, pz] = (ent.origin || "0 0 0").split(" ").map(Number);
                playerStart = { x: UNIT * px, y: UNIT * pz, z: UNIT * -py, angle: parseFloat(ent.angle || "0") };
            } else if (ent.classname === "worldspawn") {
                const amb = parseFloat(ent._ambient);
                if (!isNaN(amb)) ambientIntensity = amb;
                if (ent._ambient_color) {
                    const [r, g, b] = ent._ambient_color.trim().split(/\s+/).map(Number);
                    if (!isNaN(r)) ambientColorArr = [r / 255, g / 255, b / 255];
                }
            }
        }

        const lights = parseLights(entities);
        self.postMessage({ type: "progress", pct: 10 });

        const noclipFaceSet = buildNoclipFaceSet(entities, buffer, lump(LUMP_MODELS));
        if (noclipFaceSet.size > 0) console.log(`[BSP Worker] Noclip faces: ${noclipFaceSet.size} (func_wall etc.)`);

        const texturesLump = lump(LUMP_TEXTURES),
            numTextures = (texturesLump.length / TEX_RECORD_SIZE) | 0,
            texNames = [];
        for (let i = 0; i < numTextures; i++) {
            const o = texturesLump.offset + TEX_RECORD_SIZE * i;
            let name = "";
            for (let c = 0; c < 64; c++) {
                const byte = dv.getUint8(o + c);
                if (!byte) break;
                name += String.fromCharCode(byte);
            }
            texNames.push(name.replace(/\\/g, "/").replace(/^textures\//i, ""));
        }
        self.postMessage({ type: "progress", pct: 20 });

        const lightmapsLump = lump(LUMP_LIGHTMAPS),
            numLightmaps = (lightmapsLump.length / LM_SIZE) | 0,
            lmAtlas = buildLightmapAtlas(buffer, lightmapsLump, numLightmaps);
        self.postMessage({ type: "progress", pct: 35 });

        const { rawPos, rawUV1, rawUV2, rawNorm } = parseVertices(buffer, lump(LUMP_VERTS));
        self.postMessage({ type: "progress", pct: 48 });

        const facesLump = lump(LUMP_FACES),
            numFaces = (facesLump.length / FACE_RECORD_SIZE) | 0;

        let bspTree = null;
        try {
            bspTree = parseBSPTree(buffer, lump(LUMP_PLANES), lump(LUMP_NODES), lump(LUMP_LEAFS), lump(LUMP_LEAFFACES), lump(LUMP_VISDATA), numFaces);
        } catch (e) {
            console.warn("[BSP Worker] BSP tree parse failed — PVS culling disabled:", e.message);
        }
        self.postMessage({ type: "progress", pct: 55 });

        // Per-cluster batch splitting only when we actually have usable PVS
        // data (hasVis). Splitting on cluster id alone (hasTree, no vis)
        // would fragment geometry into more draw calls with nothing to gain
        // from it, since there'd be no visibility matrix to cull against.
        const batches = buildBatches(
            buffer,
            facesLump,
            lump(LUMP_MESH_VERTS),
            rawPos,
            rawUV1,
            rawUV2,
            rawNorm,
            lmAtlas,
            numLightmaps,
            noclipFaceSet,
            texNames,
            bspTree && bspTree.hasVis ? { offsets: bspTree.faceClusterOffsets, list: bspTree.faceClusterList } : null
        );
        self.postMessage({ type: "progress", pct: 85 });

        const transfer = [];
        if (lmAtlas) transfer.push(lmAtlas.atlasData);
        for (const b of batches) {
            b.pos = b.pos.slice().buffer;
            b.nrm = b.nrm.slice().buffer;
            b.uv1 = b.uv1.slice().buffer;
            b.uv2 = b.uv2.slice().buffer;
            b.idx = b.idx.buffer;
            transfer.push(b.pos, b.nrm, b.uv1, b.uv2, b.idx);
        }

        let bspTreeMsg = null;
        if (bspTree && bspTree.hasTree) {
            bspTreeMsg = {
                hasVis: bspTree.hasVis,
                planes: bspTree.planes.buffer,
                nodePlane: bspTree.nodePlane.buffer,
                nodeChildren: bspTree.nodeChildren.buffer,
                leafCluster: bspTree.leafCluster.buffer,
                numClusters: bspTree.numClusters,
                bytesPerCluster: bspTree.bytesPerCluster,
                visBits: bspTree.visBits ? bspTree.visBits.buffer : null,
            };
            transfer.push(bspTreeMsg.planes, bspTreeMsg.nodePlane, bspTreeMsg.nodeChildren, bspTreeMsg.leafCluster);
            if (bspTreeMsg.visBits) transfer.push(bspTreeMsg.visBits);
        }

        self.postMessage({ type: "progress", pct: 95 });
        self.postMessage(
            {
                type: "done",
                portals,
                lights,
                playerStart,
                ambientIntensity,
                ambientColorArr,
                texNames,
                lmAtlas: lmAtlas
                    ? { data: lmAtlas.atlasData, W: lmAtlas.W, H: lmAtlas.H, cols: lmAtlas.cols, rows: lmAtlas.rows, nonZero: lmAtlas.nonZero }
                    : null,
                batches,
                bspTree: bspTreeMsg,
            },
            transfer
        );
    } catch (err) {
        self.postMessage({ type: "error", message: err.message });
    }
};
