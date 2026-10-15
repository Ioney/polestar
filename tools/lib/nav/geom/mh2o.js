'use strict';
// MH2O (root ADT liquids, wowdev.wiki ADT/v18 "MH2O chunk (WotLK+)"):
//   256 x { offsetInstances u32, layerCount u32, offsetAttributes u32 }
//   (one per MCNK, index indexY * 16 + indexX; offsets from the chunk data)
//   instance (24 bytes): liquidType u16, liquidObjectOrLvf u16, minHeight f32,
//   maxHeight f32, xOffset u8, yOffset u8, width u8, height u8,
//   offsetExistsBitmap u32, offsetVertexData u32
// An instance covers quads [xOffset, xOffset + width) x [yOffset, yOffset +
// height) of its chunk's 8 x 8 (x eastward, y southward). The exists bitmap
// (absent: all exist) has a bit per covered quad, row-major, low bit first.
// The vertex data ((width + 1) x (height + 1) vertices, row-major) starts with
// the heights (f32) unless the vertex format (LVF) is 2 (depth only); absent
// vertex data or LVF 2 means every vertex is at minHeight. The LVF is
// liquidObjectOrLvf when below 42, else LiquidObject -> LiquidType ->
// LiquidMaterial.LVF (the caller's `liquid.lvf`).
//
// Output: 128 x 128 quads of the tile, row-major from the NW corner (row
// indexY * 8 + y, column indexX * 8 + x); type 0 none, 1 water, 2 ocean,
// 3 magma, 4 slime; z the mean of the quad's four vertex heights. Where a
// chunk has several layers, the highest surface wins.

const GRID = 128;
const NONE = 0;

// buf: MH2O data; liquid: { kind(liquidType) -> 0..4, lvf(liquidType, objectOrLvf) -> LVF }
// -> { type: Uint8Array(16384), z: Float32Array(16384) }
function parseMh2o(buf, liquid) {
	const type = new Uint8Array(GRID * GRID);
	const z = new Float32Array(GRID * GRID);
	if (!buf) return { type, z };
	if (buf.length < 256 * 12) throw new Error(`MH2O: ${buf.length} bytes, header is ${256 * 12}`);
	for (let ci = 0; ci < 256; ci++) {
		const ofs = buf.readUInt32LE(ci * 12);
		const layers = buf.readUInt32LE(ci * 12 + 4);
		if (!ofs || !layers) continue;
		const row0 = (ci >> 4) * 8;
		const col0 = (ci & 15) * 8;
		for (let k = 0; k < layers; k++) {
			const p = ofs + k * 24;
			const liquidType = buf.readUInt16LE(p);
			const objectOrLvf = buf.readUInt16LE(p + 2);
			const minHeight = buf.readFloatLE(p + 4);
			const xo = buf[p + 12];
			const yo = buf[p + 13];
			const w = buf[p + 14];
			const h = buf[p + 15];
			const ofsExists = buf.readUInt32LE(p + 16);
			const ofsVerts = buf.readUInt32LE(p + 20);
			const kind = liquid.kind(liquidType);
			if (kind === NONE || !w || !h) continue;
			const heights = ofsVerts && liquid.lvf(liquidType, objectOrLvf) !== 2 ? ofsVerts : 0;
			const vz = (vx, vy) => (heights ? buf.readFloatLE(heights + (vy * (w + 1) + vx) * 4) : minHeight);
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					const bit = y * w + x;
					if (ofsExists && !(buf[ofsExists + (bit >> 3)] & (1 << (bit & 7)))) continue;
					const qz = (vz(x, y) + vz(x + 1, y) + vz(x, y + 1) + vz(x + 1, y + 1)) / 4;
					const i = (row0 + yo + y) * GRID + col0 + xo + x;
					if (type[i] !== NONE && z[i] >= qz) continue;
					type[i] = kind;
					z[i] = qz;
				}
			}
		}
	}
	return { type, z };
}

module.exports = { parseMh2o, GRID };
