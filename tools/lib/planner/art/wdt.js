'use strict';
// WDT (a map's tile directory): chunks of { tag (4 bytes, stored reversed:
// 'DIAM' is MAID), size u32, data }. MAID holds 64 x 64 entries of 8 u32
// FileDataIDs (root ADT, obj0, obj1, tex0, lod, map texture, map normal,
// minimap texture) at index row * 64 + col.

const GRID = 64;

// -> Map(tag -> data Buffer) of the top-level chunks (tags read forwards).
function wdtChunks(buf) {
	const out = new Map();
	for (let o = 0; o + 8 <= buf.length; ) {
		const tag = buf.toString('latin1', o, o + 4).split('').reverse().join('');
		const size = buf.readUInt32LE(o + 4);
		if (o + 8 + size > buf.length) throw new Error(`WDT: chunk ${tag} at ${o} (${size} bytes) past the end`);
		out.set(tag, buf.subarray(o + 8, o + 8 + size));
		o += 8 + size;
	}
	return out;
}

// -> [{ col, row, fdid }] of every tile with a minimap texture, index order.
function readMaid(buf) {
	const maid = wdtChunks(buf).get('MAID');
	if (!maid) throw new Error('WDT: no MAID chunk');
	if (maid.length < GRID * GRID * 32) throw new Error(`WDT: MAID is ${maid.length} bytes, not ${GRID * GRID * 32}`);
	const out = [];
	for (let i = 0; i < GRID * GRID; i++) {
		const fdid = maid.readUInt32LE(i * 32 + 28);
		if (fdid) out.push({ col: i % GRID, row: Math.floor(i / GRID), fdid });
	}
	return out;
}

module.exports = { wdtChunks, readMaid, GRID };
