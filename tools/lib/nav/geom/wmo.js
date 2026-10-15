'use strict';
// WMO collision and liquids (wowdev.wiki WMO). Root: MOHD (nGroups at 0x04,
// bounding box at 0x24, min then max, flags u16 at 0x3C: 0x4
// use_liquid_type_dbc_id), MOGN (group names), GFID (group FileDataIDs; with
// LODs it lists numLod x nGroups, the first nGroups being the most detailed).
// Group file: MVER, MOGP whose data is a 68-byte header (groupName 0x00, an
// offset into MOGN; flags 0x08; bounding box 0x0C, min then max;
// groupLiquid 0x34) followed by subchunks: MOPY (2 bytes per triangle:
// flags u8, material u8) or MPY2 (4: flags u16, material u16), MOVI (u16
// indices) or MOVX (u32), MOVT (3 f32 per vertex, model space, z up), MLIQ.
//
// Collision rule, as TrinityCore's vmap extractor
// (src/tools/vmap4_extractor/wmo.cpp, WMOGroup::ConvertToVMAPGroupWmo and
// WMOGroup::ShouldSkip, checked 2026-10-15):
//   a triangle collides when (flags & COLLISION 0x08) or it is a render face,
//   (flags & RENDER 0x20) && !(flags & DETAIL 0x04);
//   a group is skipped when MOGP flags & 0x80 (unreachable), & 0x4000000
//   (antiportal) or its MOGN name is "antiportal".
// A group is indoor when MOGP flags & 0x2000. Doodads (MODD) are left out.
//
// Liquids (wowdev.wiki WMO "MLIQ chunk"; TrinityCore wmo.cpp WMOGroup::open,
// GetLiquidTypeId, and src/common/Collision/Models/WorldModel.cpp
// WmoLiquid::GetLiquidHeight, checked 2026-10-15). MLIQ: xverts, yverts,
// xtiles, ytiles (i32), corner (3 f32, model space), material (u16), then
// xverts * yverts vertices of 8 bytes (height f32 at +4), row-major with x
// fastest, vertex (i, j) at corner + (i, j) * TILE; then xtiles * ytiles tile
// bytes, tile (i, j) at j * xtiles + i, no liquid where (byte & 0x0F) == 0x0F.
// TILE = ADT / 128 = 4.1667 yd. Each present tile is two triangles,
// counter-clockwise seen from above. The LiquidType:
//   root flag 0x4: groupLiquid, mapped by GetLiquidTypeId;
//   else groupLiquid 15 ("green lava"): GetLiquidTypeId(low nibble of the
//     first tile with liquid + 1); else GetLiquidTypeId(groupLiquid + 1);
//   GetLiquidTypeId(id), 0 < id < 21: by (id - 1) & 3, 0 -> 13 WMO Water (14
//     WMO Ocean when MOGP flags & 0x80000), 1 -> 14, 2 -> 19 WMO Magma,
//     3 -> 20 WMO Slime; any other id as it is.
// A group with a liquid type but no MLIQ (or no tiles) is filled with it up
// to its bounding box top, only in WMOs with use_liquid_type_dbc_id
// (wowdev.wiki; TrinityCore's TileAssembler fills any such group, but for
// older WMOs every groupLiquid maps to a type, which would flood all their
// dry groups); its surface is the box's top face.

const { chunks, chunk, UNIT } = require('./adt');

const F_DETAIL = 0x04;
const F_COLLISION = 0x08;
const F_RENDER = 0x20;
const G_UNREACHABLE = 0x80;
const G_INDOOR = 0x2000;
const G_OCEAN = 0x80000;
const G_ANTIPORTAL = 0x4000000;
const ROOT_LIQUID_DBC = 0x4;
const MOGP_HEADER = 68;
const MLIQ_HEADER = 30;
const NO_LIQUID = 0x0f;
const GREEN_LAVA = 15;

const collides = (f) => (f & F_COLLISION) !== 0 || ((f & F_RENDER) !== 0 && (f & F_DETAIL) === 0);

// Root WMO -> { nGroups, flags, box: [6], groups: [fdid] (LOD 0), names: Buffer | null }
function parseRoot(buf) {
	const list = chunks(buf);
	const mohd = chunk(list, 'MOHD');
	if (!mohd) throw new Error('WMO root: no MOHD');
	const nGroups = mohd.readUInt32LE(4);
	const box = [];
	for (let i = 0; i < 6; i++) box.push(mohd.readFloatLE(0x24 + i * 4));
	const gfid = chunk(list, 'GFID');
	if (!gfid) throw new Error('WMO root: no GFID (groups by name)');
	if (gfid.length < nGroups * 4) throw new Error(`WMO root: GFID lists ${gfid.length / 4} groups, MOHD ${nGroups}`);
	const groups = [];
	for (let g = 0; g < nGroups; g++) groups.push(gfid.readUInt32LE(g * 4));
	return { nGroups, flags: mohd.readUInt16LE(0x3c), box, groups, names: chunk(list, 'MOGN') };
}

const nameAt = (names, ofs) => {
	if (!names || ofs >= names.length) return '';
	const end = names.indexOf(0, ofs);
	return names.toString('latin1', ofs, end < 0 ? names.length : end);
};

const NOTHING = () => ({ verts: new Float32Array(0), idx: new Uint32Array(0) });

// The colliding triangles of a group's subchunks, vertices renumbered.
function collision(sub) {
	let polyFlags;
	const mopy = chunk(sub, 'MOPY');
	const mpy2 = chunk(sub, 'MPY2');
	if (mpy2) {
		polyFlags = new Uint16Array(mpy2.length / 4);
		for (let i = 0; i < polyFlags.length; i++) polyFlags[i] = mpy2.readUInt16LE(i * 4);
	} else if (mopy) {
		polyFlags = new Uint16Array(mopy.length / 2);
		for (let i = 0; i < polyFlags.length; i++) polyFlags[i] = mopy[i * 2];
	} else return NOTHING();
	const movx = chunk(sub, 'MOVX');
	const movi = chunk(sub, 'MOVI');
	const movt = chunk(sub, 'MOVT');
	if (!movt || (!movx && !movi)) return NOTHING();
	const index = movx ? (i) => movx.readUInt32LE(i * 4) : (i) => movi.readUInt16LE(i * 2);
	const nIndex = movx ? movx.length / 4 : movi.length / 2;
	const nVerts = movt.length / 12;
	const nTris = Math.min(polyFlags.length, Math.floor(nIndex / 3));
	const remap = new Int32Array(nVerts).fill(-1);
	const kept = [];
	let used = 0;
	for (let t = 0; t < nTris; t++) {
		if (!collides(polyFlags[t])) continue;
		for (let k = 0; k < 3; k++) {
			const v = index(t * 3 + k);
			if (v >= nVerts) throw new Error(`WMO group: index ${v} past ${nVerts} vertices`);
			if (remap[v] < 0) remap[v] = used++;
			kept.push(remap[v]);
		}
	}
	const verts = new Float32Array(used * 3);
	for (let v = 0; v < nVerts; v++) {
		const r = remap[v];
		if (r < 0) continue;
		verts[r * 3] = movt.readFloatLE(v * 12);
		verts[r * 3 + 1] = movt.readFloatLE(v * 12 + 4);
		verts[r * 3 + 2] = movt.readFloatLE(v * 12 + 8);
	}
	return { verts, idx: Uint32Array.from(kept) };
}

// TrinityCore WMOGroup::GetLiquidTypeId (src/tools/vmap4_extractor/wmo.cpp,
// https://github.com/TrinityCore/TrinityCore; GPL-2.0-or-later, taken here
// under GPL-3.0; THIRD_PARTY.md).
function liquidTypeId(id, groupFlags) {
	if (id > 0 && id < 21) {
		switch ((id - 1) & 3) {
			case 0:
				return groupFlags & G_OCEAN ? 14 : 13;
			case 1:
				return 14;
			case 2:
				return 19;
			case 3:
				return 20;
		}
	}
	return id;
}

// A group's liquid -> { type (LiquidType ID), verts, idx } | null.
function groupLiquid(mogp, sub, flags, rootFlags) {
	const gl = mogp.readUInt32LE(0x34);
	const mliq = chunk(sub, 'MLIQ');
	let type;
	if (rootFlags & ROOT_LIQUID_DBC) type = liquidTypeId(gl, flags);
	else if (gl === GREEN_LAVA) type = 0;
	else type = liquidTypeId(gl + 1, flags);
	const xt = mliq && mliq.length >= MLIQ_HEADER ? mliq.readInt32LE(8) : 0;
	const yt = mliq && mliq.length >= MLIQ_HEADER ? mliq.readInt32LE(12) : 0;
	if (!xt || !yt) {
		if (!type || !(rootFlags & ROOT_LIQUID_DBC)) return null;
		// Filled to the bounding box top.
		const [x0, y0, x1, y1, z] = [mogp.readFloatLE(0x0c), mogp.readFloatLE(0x10), mogp.readFloatLE(0x18), mogp.readFloatLE(0x1c), mogp.readFloatLE(0x20)];
		return { type, verts: Float32Array.of(x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z), idx: Uint32Array.of(0, 1, 2, 0, 2, 3) };
	}
	const xv = mliq.readInt32LE(0);
	const yv = mliq.readInt32LE(4);
	if (xv !== xt + 1 || yv !== yt + 1) throw new Error(`WMO MLIQ: ${xv} x ${yv} vertices for ${xt} x ${yt} tiles`);
	const tiles = MLIQ_HEADER + xv * yv * 8;
	if (tiles + xt * yt > mliq.length) throw new Error(`WMO MLIQ: ${mliq.length} bytes, ${tiles + xt * yt} needed`);
	if (!type) {
		for (let i = 0; i < xt * yt && !type; i++) {
			const legacy = mliq[tiles + i] & 0x0f;
			if (legacy !== NO_LIQUID) type = liquidTypeId(legacy + 1, flags);
		}
		if (!type) return null;
	}
	const cx = mliq.readFloatLE(16);
	const cy = mliq.readFloatLE(20);
	const verts = new Float32Array(xv * yv * 3);
	for (let j = 0; j < yv; j++)
		for (let i = 0; i < xv; i++) {
			const v = j * xv + i;
			verts[v * 3] = cx + i * UNIT;
			verts[v * 3 + 1] = cy + j * UNIT;
			verts[v * 3 + 2] = mliq.readFloatLE(MLIQ_HEADER + v * 8 + 4);
		}
	const idx = [];
	for (let j = 0; j < yt; j++)
		for (let i = 0; i < xt; i++) {
			if ((mliq[tiles + j * xt + i] & 0x0f) === NO_LIQUID) continue;
			const a = j * xv + i;
			idx.push(a, a + 1, a + 1 + xv, a, a + 1 + xv, a + xv);
		}
	if (!idx.length) return null;
	return { type, verts, idx: Uint32Array.from(idx) };
}

// Group WMO -> { flags, skip, indoor, verts, idx, liquid }: verts and idx the
// colliding triangles (skipped groups none), liquid { type, verts, idx } or
// null. opts: names (root MOGN), rootFlags (root MOHD flags).
function parseGroup(buf, { names = null, rootFlags = 0 } = {}) {
	const mogp = chunk(chunks(buf), 'MOGP');
	if (!mogp || mogp.length < MOGP_HEADER) throw new Error('WMO group: no MOGP');
	const flags = mogp.readUInt32LE(8);
	const skip = (flags & G_UNREACHABLE) !== 0 || (flags & G_ANTIPORTAL) !== 0 || nameAt(names, mogp.readUInt32LE(0)) === 'antiportal';
	const indoor = (flags & G_INDOOR) !== 0;
	if (skip) return { flags, skip, indoor, ...NOTHING(), liquid: null };
	const sub = chunks(mogp, MOGP_HEADER);
	return { flags, skip, indoor, ...collision(sub), liquid: groupLiquid(mogp, sub, flags, rootFlags) };
}

// get(fdid) -> Promise of Buffer (a 404, err.status, marks a group missing);
// kindOf(liquidTypeId) -> 0 none, 1 water, 2 ocean, 3 magma, 4 slime.
// -> Promise of the whole WMO, its groups merged: { box, verts, idx,
// kind: Uint8Array (per triangle: 1 outdoor, 2 indoor),
// liquid: { verts, idx, kind: Uint8Array (per triangle, 1-4) }, groups, missing: [fdid] }
async function loadWmo(get, fdid, kindOf) {
	const root = parseRoot(await get(fdid));
	const missing = [];
	const parts = (
		await Promise.all(
			root.groups.map(async (g) => {
				if (!g) return null;
				try {
					return parseGroup(await get(g), { names: root.names, rootFlags: root.flags });
				} catch (err) {
					if (err.status === 404) {
						missing.push(g);
						return null;
					}
					throw err;
				}
			}),
		)
	).filter(Boolean);
	const merge = (list, kindOfPart) => {
		let nv = 0;
		let ni = 0;
		for (const p of list) {
			nv += p.verts.length / 3;
			ni += p.idx.length;
		}
		const verts = new Float32Array(nv * 3);
		const idx = new Uint32Array(ni);
		const kind = new Uint8Array(ni / 3);
		let vo = 0;
		let io = 0;
		for (const p of list) {
			verts.set(p.verts, vo * 3);
			for (let i = 0; i < p.idx.length; i++) idx[io + i] = p.idx[i] + vo;
			kind.fill(kindOfPart(p), io / 3, (io + p.idx.length) / 3);
			vo += p.verts.length / 3;
			io += p.idx.length;
		}
		return { verts, idx, kind };
	};
	const solid = merge(parts, (p) => (p.indoor ? 2 : 1));
	const wet = parts.map((p) => p.liquid && { ...p.liquid, kind: kindOf(p.liquid.type) }).filter((l) => l && l.kind);
	return { box: root.box, ...solid, liquid: merge(wet, (l) => l.kind), groups: root.groups.length, missing };
}

module.exports = { parseRoot, parseGroup, loadWmo, collides, liquidTypeId };
