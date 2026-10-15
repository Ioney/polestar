'use strict';
// M2 collision (wowdev.wiki M2). Forever's models are chunked: chunks with
// tags stored forwards ('MD21', 'TXAC', 'LDV1', 'SFID', ...), MD21 wrapping
// the MD20 header and data (version 272 on 1.60.1); older files are a bare
// MD20. Header offsets (from the MD20 start, version >= 264, as
// TrinityCore's vmap4_extractor modelheaders.h ModelHeader):
//   0xBC collision box (min 3 f32, max 3 f32)
//   0xD8 collision indices M2Array<u16> (count, offset), 3 per triangle
//   0xE0 collision positions M2Array<C3Vector> (model space, z up)
// Checked on 1.60.1 Northshire models (e.g. 7549691: 144 indices, 30
// positions, all indices < 30, positions spanning exactly the collision box).
// A model without collision (count 0) emits nothing. TrinityCore uses the
// positions as they are (its fixCoordSystem swap is undone before writing).

// M2 file -> { verts: Float32Array, idx: Uint32Array, box: [6] }
function parseM2(buf) {
	let d = null;
	if (buf.toString('latin1', 0, 4) === 'MD20') d = buf;
	else {
		for (let o = 0; o + 8 <= buf.length; ) {
			const size = buf.readUInt32LE(o + 4);
			if (buf.toString('latin1', o, o + 4) === 'MD21') {
				d = buf.subarray(o + 8, o + 8 + size);
				break;
			}
			o += 8 + size;
		}
	}
	if (!d || d.toString('latin1', 0, 4) !== 'MD20') throw new Error('M2: no MD20 header');
	const version = d.readUInt32LE(4);
	if (version < 264) throw new Error(`M2: version ${version} (pre-WotLK header layout)`);
	const box = [];
	for (let i = 0; i < 6; i++) box.push(d.readFloatLE(0xbc + i * 4));
	const ni = d.readUInt32LE(0xd8);
	const oi = d.readUInt32LE(0xdc);
	const nv = d.readUInt32LE(0xe0);
	const ov = d.readUInt32LE(0xe4);
	if (!ni || !nv) return { verts: new Float32Array(0), idx: new Uint32Array(0), box };
	if (oi + ni * 2 > d.length || ov + nv * 12 > d.length) throw new Error('M2: collision arrays past the end');
	const idx = new Uint32Array(ni - (ni % 3));
	for (let i = 0; i < idx.length; i++) {
		idx[i] = d.readUInt16LE(oi + i * 2);
		if (idx[i] >= nv) throw new Error(`M2: collision index ${idx[i]} past ${nv} positions`);
	}
	const verts = new Float32Array(nv * 3);
	for (let i = 0; i < nv * 3; i++) verts[i] = d.readFloatLE(ov + i * 4);
	return { verts, idx, box };
}

module.exports = { parseM2 };
