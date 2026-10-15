'use strict';
// Root ADT terrain: the 256 MCNK chunks of a tile (16 x 16, 33.333 yd each)
// and the triangles of their height grids. Checked on Forever 1.60.1
// (Azeroth 32_48, root 778027): MVER MHDR MH2O MCNK x256, each MCNK holding
// MCVT MCCV MCNR MCSE.
//
// Chunks are { tag (4 bytes stored reversed: 'KNCM' is MCNK), size u32,
// data }. MCNK starts with a 128-byte header (wowdev.wiki ADT/v18):
//   0x00 flags (0x10000: holes are the high-res 8 x 8 bits at 0x14-0x1B)
//   0x04 indexX (column, west to east), 0x08 indexY (row, north to south)
//   0x34 areaId, 0x3C holes_low_res (u16, 4 x 4 bits of 2 x 2 quads)
//   0x68 position: wx (north edge), wy (west edge), zBase
// (chunk 0 of 32_48 is at -8533.333, 0: the tile's NW corner), followed by
// subchunks. MCVT is 145 floats relative to zBase in rows of 9 outer and 8
// inner vertices (9, 8, 9, ..., 9): outer vertex (r, c) at
// (wx - r U, wy - c U), inner vertex (r, c) at the centre of quad (r, c),
// U = ADT / 128 = 4.1667 yd. A quad (x, y) is four triangles around its inner
// vertex, counter-clockwise seen from above (normal +z); a holed quad emits
// none. Hole bits: high-res quad (x, y) is byte y bit x; low-res bit
// (y >> 1) * 4 + (x >> 1) (TrinityCore map_extractor holetab_h/holetab_v).

const ADT = 1600 / 3; // 533.333 yd
const CHUNK = ADT / 16;
const UNIT = CHUNK / 8;
const HEADER = 128;

const FLAG_HIGH_RES_HOLES = 0x10000;

// -> [{ tag, data }] of the chunks in buf[start, end).
function chunks(buf, start = 0, end = buf.length) {
	const out = [];
	for (let o = start; o + 8 <= end; ) {
		const tag = String.fromCharCode(buf[o + 3], buf[o + 2], buf[o + 1], buf[o]);
		const size = buf.readUInt32LE(o + 4);
		if (o + 8 + size > end) throw new Error(`chunk ${tag} at ${o} (${size} bytes) runs past the end (${end})`);
		out.push({ tag, data: buf.subarray(o + 8, o + 8 + size) });
		o += 8 + size;
	}
	return out;
}

// -> the first chunk's data with tag, else null.
function chunk(list, tag) {
	for (const c of list) if (c.tag === tag) return c.data;
	return null;
}

// MCNK data -> { indexX, indexY, areaId, wx, wy, z, heights: Float32Array(145), holes: Uint8Array(8) }
// holes: one byte per quad row y (north to south), bit x per quad column.
function parseMcnk(d) {
	if (d.length < HEADER) throw new Error(`MCNK: ${d.length} bytes, header is ${HEADER}`);
	const flags = d.readUInt32LE(0x00);
	const holes = new Uint8Array(8);
	if (flags & FLAG_HIGH_RES_HOLES) for (let y = 0; y < 8; y++) holes[y] = d[0x14 + y];
	else {
		const low = d.readUInt16LE(0x3c);
		if (low)
			for (let y = 0; y < 8; y++)
				for (let x = 0; x < 8; x++) if (low & (1 << ((y >> 1) * 4 + (x >> 1)))) holes[y] |= 1 << x;
	}
	const mcvt = chunk(chunks(d, HEADER), 'MCVT');
	if (!mcvt || mcvt.length < 145 * 4) throw new Error(`MCNK ${d.readUInt32LE(4)},${d.readUInt32LE(8)}: no MCVT`);
	const heights = new Float32Array(145);
	for (let i = 0; i < 145; i++) heights[i] = mcvt.readFloatLE(i * 4);
	return {
		indexX: d.readUInt32LE(0x04),
		indexY: d.readUInt32LE(0x08),
		areaId: d.readUInt32LE(0x34),
		wx: d.readFloatLE(0x68),
		wy: d.readFloatLE(0x6c),
		z: d.readFloatLE(0x70),
		heights,
		holes,
	};
}

// Root ADT -> { mcnk: [256 parsed MCNK], mh2o: Buffer | null }
function parseRoot(buf) {
	const list = chunks(buf);
	const mcnk = list.filter((c) => c.tag === 'MCNK').map((c) => parseMcnk(c.data));
	if (mcnk.length !== 256) throw new Error(`root ADT: ${mcnk.length} MCNK chunks, not 256`);
	return { mcnk, mh2o: chunk(list, 'MH2O') };
}

// The four triangles of each quad, as (outer row, outer col) offsets or 'c'
// for the inner vertex, counter-clockwise seen from above.
const QUAD = [
	[[0, 0], 'c', [0, 1]],
	[[0, 1], 'c', [1, 1]],
	[[1, 1], 'c', [1, 0]],
	[[1, 0], 'c', [0, 0]],
];

// Parsed MCNK list -> { tris: Float32Array (9 per triangle), holes: holed quads }
function terrainTriangles(mcnk) {
	let holes = 0;
	for (const m of mcnk) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (m.holes[y] & (1 << x)) holes++;
	const tris = new Float32Array((mcnk.length * 64 - holes) * 4 * 9);
	let o = 0;
	for (const m of mcnk) {
		const h = m.heights;
		for (let y = 0; y < 8; y++) {
			for (let x = 0; x < 8; x++) {
				if (m.holes[y] & (1 << x)) continue;
				const cx = m.wx - (y + 0.5) * UNIT;
				const cy = m.wy - (x + 0.5) * UNIT;
				const cz = m.z + h[y * 17 + 9 + x];
				for (const tri of QUAD) {
					for (const v of tri) {
						if (v === 'c') {
							tris[o++] = cx;
							tris[o++] = cy;
							tris[o++] = cz;
						} else {
							const r = y + v[0];
							const c = x + v[1];
							tris[o++] = m.wx - r * UNIT;
							tris[o++] = m.wy - c * UNIT;
							tris[o++] = m.z + h[r * 17 + c];
						}
					}
				}
			}
		}
	}
	return { tris, holes };
}

module.exports = { chunks, chunk, parseMcnk, parseRoot, terrainTriangles, ADT, CHUNK, UNIT };
