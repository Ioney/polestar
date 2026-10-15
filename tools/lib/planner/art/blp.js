'use strict';
// BLP2, the client's texture format (BLP1 and JPEG-in-BLP are not read).
//
//   0   'BLP2'          4   type u32 (1 = direct)
//   8   encoding u8     (1 palettized, 2 DXT, 3 uncompressed BGRA)
//   9   alphaDepth u8   (0, 1, 4, 8)
//   10  alphaEncoding u8 (DXT: 0 DXT1, 1 DXT3, 7 DXT5)
//   11  hasMips u8      12  width u32   16  height u32
//   20  mipOffsets u32[16]   84  mipSizes u32[16]   148  palette BGRA[256]
//
// DXT picks DXT1 at alphaDepth 0 or 1, else DXT5 when alphaEncoding is 7 and
// DXT3 otherwise. A palettized mip is width * height palette indices followed
// by the alpha bits (1 bit LSB-first, 4 bits low nibble first, or 8 bits).

const { decodeBC1, decodeBC2, decodeBC3 } = require('./bc1');

const HEADER = 148;
const PALETTE = 1024;

function formatOf(encoding, alphaDepth, alphaEncoding) {
	if (encoding === 1) return 'palette';
	if (encoding === 3) return 'argb';
	if (encoding === 2) return alphaDepth > 1 ? (alphaEncoding === 7 ? 'dxt5' : 'dxt3') : 'dxt1';
	throw new Error(`BLP2: unknown encoding ${encoding}`);
}

// The header and each mip's raw bytes, nothing decoded.
// -> { width, height, encoding, alphaDepth, alphaEncoding, hasMips, format,
//      palette, mips: [{ width, height, raw }] }
function readBlp(buf) {
	if (buf.length < HEADER + PALETTE || buf.toString('latin1', 0, 4) !== 'BLP2') throw new Error('not a BLP2 file');
	const type = buf.readUInt32LE(4);
	if (type !== 1) throw new Error(`BLP2: type ${type} (JPEG) is not supported`);
	const encoding = buf[8], alphaDepth = buf[9], alphaEncoding = buf[10], hasMips = buf[11];
	const width = buf.readUInt32LE(12), height = buf.readUInt32LE(16);
	const format = formatOf(encoding, alphaDepth, alphaEncoding);
	const mips = [];
	for (let i = 0; i < (hasMips ? 16 : 1); i++) {
		const off = buf.readUInt32LE(20 + 4 * i), size = buf.readUInt32LE(84 + 4 * i);
		const w = Math.max(1, width >> i), h = Math.max(1, height >> i);
		if (!off || !size) break;
		if (off + size > buf.length) throw new Error(`BLP2: mip ${i} (${off}+${size}) past the end (${buf.length} bytes)`);
		mips.push({ width: w, height: h, raw: buf.subarray(off, off + size) });
		if (w === 1 && h === 1) break;
	}
	if (!mips.length) throw new Error('BLP2: no mip levels');
	return { width, height, encoding, alphaDepth, alphaEncoding, hasMips: !!hasMips, format, palette: buf.subarray(HEADER, HEADER + PALETTE), mips };
}

function decodePalette(raw, w, h, palette, alphaDepth) {
	const n = w * h;
	if (raw.length < n + Math.ceil((n * alphaDepth) / 8)) throw new Error(`BLP2: palettized mip too short (${raw.length} bytes for ${w}x${h}, alpha ${alphaDepth})`);
	const out = new Uint8Array(n * 4);
	for (let i = 0; i < n; i++) {
		const p = raw[i] * 4;
		out[i * 4] = palette[p + 2];
		out[i * 4 + 1] = palette[p + 1];
		out[i * 4 + 2] = palette[p];
		let a = 255;
		if (alphaDepth === 1) a = (raw[n + (i >> 3)] >> (i & 7)) & 1 ? 255 : 0;
		else if (alphaDepth === 4) a = ((i & 1 ? raw[n + (i >> 1)] >> 4 : raw[n + (i >> 1)]) & 15) * 17;
		else if (alphaDepth === 8) a = raw[n + i];
		out[i * 4 + 3] = a;
	}
	return out;
}

function decodeArgb(raw, w, h) {
	const n = w * h;
	if (raw.length < n * 4) throw new Error(`BLP2: uncompressed mip too short (${raw.length} bytes for ${w}x${h})`);
	const out = new Uint8Array(n * 4);
	for (let i = 0; i < n; i++) {
		out[i * 4] = raw[i * 4 + 2];
		out[i * 4 + 1] = raw[i * 4 + 1];
		out[i * 4 + 2] = raw[i * 4];
		out[i * 4 + 3] = raw[i * 4 + 3];
	}
	return out;
}

// RGBA of mip i of a readBlp() result.
function decodeMip(blp, i = 0) {
	const { width: w, height: h, raw } = blp.mips[i];
	switch (blp.format) {
		case 'dxt1':
			return decodeBC1(raw, w, h, { opaque: blp.alphaDepth === 0 });
		case 'dxt3':
			return decodeBC2(raw, w, h);
		case 'dxt5':
			return decodeBC3(raw, w, h);
		case 'palette':
			return decodePalette(raw, w, h, blp.palette, blp.alphaDepth);
		default:
			return decodeArgb(raw, w, h);
	}
}

// buf -> readBlp() with `rgba` added to the first `levels` mips (default all).
function decodeBlp(buf, { levels = Infinity } = {}) {
	const blp = readBlp(buf);
	blp.mips.forEach((m, i) => {
		if (i < levels) m.rgba = decodeMip(blp, i);
	});
	return blp;
}

// Level 0's DXT1 blocks as stored, when the file is opaque DXT1 (alphaDepth 0)
// of the given size; else null.
function dxt1Level0(buf, width = 512, height = 512) {
	const blp = readBlp(buf);
	if (blp.format !== 'dxt1' || blp.alphaDepth !== 0 || blp.width !== width || blp.height !== height) return null;
	const raw = blp.mips[0].raw;
	return raw.length === (width / 4) * (height / 4) * 8 ? raw : null;
}

module.exports = { readBlp, decodeMip, decodeBlp, dxt1Level0 };
