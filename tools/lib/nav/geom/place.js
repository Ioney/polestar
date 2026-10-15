'use strict';
// obj0 ADT placements (wowdev.wiki ADT/v18 MDDF, MODF) and the transform from
// model space to world yards.
//
// MDDF (36 bytes): nameId u32, uniqueId u32, position 3 f32, rotation 3 f32
//   (degrees), scale u16 (/ 1024), flags u16 (0x40: nameId is a FileDataID)
// MODF (64 bytes): nameId u32, uniqueId u32, position 3 f32, rotation 3 f32,
//   extents (min 3 f32, max 3 f32), flags u16 (0x4: scale is set, 0x8: nameId
//   is a FileDataID), doodadSet u16, nameSet u16, scale u16 (/ 1024)
// Forever's obj0 files hold only MVER MDDF MODF, every entry by FileDataID
// (checked on Azeroth and Kalimdor tiles, 1.60.1); an entry by name (an index
// into MMID/MWID, which these files do not carry) is reported as an error.
//
// Placement space (p0, p1, p2) is y-up; world is wx north, wy west, z up:
//   wx = 17066.666 - p2, wy = 17066.666 - p0, z = p1
// (checked on 32_48; the extents convert the same way). Model space (WMO
// MOVT, M2 collision positions) is (x, y, z), z up. TrinityCore's vmap
// extractor and ModelInstance (src/tools/vmap4_extractor/model.cpp
// Doodad::Extract / MapObject::Extract with fixCoords(p) = (p2, p0, p1),
// src/common/Collision/Models/ModelInstance.cpp) place a model at
// fixCoords(position), rotated by
//   R = fromEulerAnglesZYX(rot.y, rot.x, rot.z) = Rz(rot.y) Ry(rot.x) Rx(rot.z)
// (G3D, right-handed), in a frame that is world turned 180 degrees about z
// (x' = 17066.666 - wx, y' = 17066.666 - wy). In world coordinates:
//   world = position + Rz(rot.y + 180) Ry(rot.x) Rx(rot.z) (scale * v).
// Verified 2026-10-15 against MODF extents: the transformed WMO root
// bounding box of every placement on Azeroth 32_48, 35_47, 37_43, 38_46 and
// 41_45 (tilted up to 22.5 degrees, scaled 0.25 to 1) is within 0.05 yd of
// its extents (tests/navmesh-geom.test.js keeps 32_48 and 41_45).

const ORIGIN = 32 * (1600 / 3); // 17066.666
const MDDF_SIZE = 36;
const MODF_SIZE = 64;
const MDDF_FILEDATA = 0x40;
const MODF_SCALE = 0x4;
const MODF_FILEDATA = 0x8;

const toWorld = (buf, o) => [ORIGIN - buf.readFloatLE(o + 8), ORIGIN - buf.readFloatLE(o), buf.readFloatLE(o + 4)];

// obj0 placements: list of { tag, data } chunks (adt.js chunks)
// -> { m2: [{ fdid, uniqueId, pos, rot, scale, flags }],
//      wmo: [{ fdid, uniqueId, pos, rot, scale, flags, doodadSet, nameSet, extents }] }
// pos [wx, wy, z]; rot [rx, ry, rz] degrees as stored; extents [minWx, minWy,
// minZ, maxWx, maxWy, maxZ].
function parsePlacements(list) {
	const m2 = [];
	const wmo = [];
	for (const { tag, data } of list) {
		if (tag === 'MDDF') {
			for (let o = 0; o + MDDF_SIZE <= data.length; o += MDDF_SIZE) {
				const flags = data.readUInt16LE(o + 34);
				if (!(flags & MDDF_FILEDATA)) throw new Error(`MDDF entry ${o / MDDF_SIZE}: model by name (flags ${flags.toString(16)}), not a FileDataID`);
				m2.push({
					fdid: data.readUInt32LE(o),
					uniqueId: data.readUInt32LE(o + 4),
					pos: toWorld(data, o + 8),
					rot: [data.readFloatLE(o + 20), data.readFloatLE(o + 24), data.readFloatLE(o + 28)],
					scale: data.readUInt16LE(o + 32) / 1024,
					flags,
				});
			}
		} else if (tag === 'MODF') {
			for (let o = 0; o + MODF_SIZE <= data.length; o += MODF_SIZE) {
				const flags = data.readUInt16LE(o + 56);
				if (!(flags & MODF_FILEDATA)) throw new Error(`MODF entry ${o / MODF_SIZE}: WMO by name (flags ${flags.toString(16)}), not a FileDataID`);
				const a = toWorld(data, o + 32);
				const b = toWorld(data, o + 44);
				wmo.push({
					fdid: data.readUInt32LE(o),
					uniqueId: data.readUInt32LE(o + 4),
					pos: toWorld(data, o + 8),
					rot: [data.readFloatLE(o + 20), data.readFloatLE(o + 24), data.readFloatLE(o + 28)],
					scale: flags & MODF_SCALE ? data.readUInt16LE(o + 62) / 1024 : 1,
					flags,
					doodadSet: data.readUInt16LE(o + 58),
					nameSet: data.readUInt16LE(o + 60),
					extents: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
				});
			}
		}
	}
	return { m2, wmo };
}

const RAD = Math.PI / 180;

// Placement -> Float64Array(12): row-major 3 x 4 [R * scale | position],
// world = M * (x, y, z, 1).
function placementMatrix({ pos, rot, scale = 1 }) {
	const z = (rot[1] + 180) * RAD;
	const y = rot[0] * RAD;
	const x = rot[2] * RAD;
	const cz = Math.cos(z), sz = Math.sin(z);
	const cy = Math.cos(y), sy = Math.sin(y);
	const cx = Math.cos(x), sx = Math.sin(x);
	// Rz * Ry * Rx
	return Float64Array.of(
		cz * cy * scale, (cz * sy * sx - sz * cx) * scale, (cz * sy * cx + sz * sx) * scale, pos[0],
		sz * cy * scale, (sz * sy * sx + cz * cx) * scale, (sz * sy * cx - cz * sx) * scale, pos[1],
		-sy * scale, cy * sx * scale, cy * cx * scale, pos[2],
	);
}

// Transforms the points of src (x, y, z triples) by m into dst (same layout).
function transformPoints(m, src, dst = new Float32Array(src.length)) {
	for (let i = 0; i < src.length; i += 3) {
		const x = src[i], y = src[i + 1], z = src[i + 2];
		dst[i] = m[0] * x + m[1] * y + m[2] * z + m[3];
		dst[i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
		dst[i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
	}
	return dst;
}

// World AABB [minX, minY, minZ, maxX, maxY, maxZ] of a model-space box under m.
function transformBox(m, box) {
	const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
	const p = new Float64Array(3);
	for (let k = 0; k < 8; k++) {
		const v = [box[k & 1 ? 3 : 0], box[k & 2 ? 4 : 1], box[k & 4 ? 5 : 2]];
		for (let r = 0; r < 3; r++) p[r] = m[r * 4] * v[0] + m[r * 4 + 1] * v[1] + m[r * 4 + 2] * v[2] + m[r * 4 + 3];
		for (let r = 0; r < 3; r++) {
			if (p[r] < out[r]) out[r] = p[r];
			if (p[r] > out[r + 3]) out[r + 3] = p[r];
		}
	}
	return out;
}

module.exports = { parsePlacements, placementMatrix, transformPoints, transformBox, ORIGIN };
