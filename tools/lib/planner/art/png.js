'use strict';
// PNG writer: 8-bit RGBA, or RGB when every pixel is opaque; each row takes
// the filter (none, sub, up, average, Paeth) with the smallest sum of
// absolute bytes; one zlib IDAT.

const zlib = require('node:zlib');

function chunk(type, data) {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 'latin1');
	out.set(data, 8);
	out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

const paeth = (a, b, c) => {
	const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// rgba: w x h RGBA bytes -> PNG file Buffer.
function encodePng(rgba, w, h) {
	let opaque = true;
	for (let i = 3; i < w * h * 4; i += 4) {
		if (rgba[i] !== 255) {
			opaque = false;
			break;
		}
	}
	const bpp = opaque ? 3 : 4;
	const stride = w * bpp;
	const raw = Buffer.alloc((stride + 1) * h);
	let prev = new Uint8Array(stride);
	let cur = new Uint8Array(stride);
	const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) for (let c = 0; c < bpp; c++) cur[x * bpp + c] = rgba[(y * w + x) * 4 + c];
		let best = 0, bestSum = Infinity;
		for (let f = 0; f < 5; f++) {
			const out = cand[f];
			let sum = 0;
			for (let i = 0; i < stride; i++) {
				const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
				const p = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
				const v = (cur[i] - p) & 255;
				out[i] = v;
				sum += v < 128 ? v : 256 - v;
			}
			if (sum < bestSum) {
				bestSum = sum;
				best = f;
			}
		}
		raw[y * (stride + 1)] = best;
		raw.set(cand[best], y * (stride + 1) + 1);
		const t = prev;
		prev = cur;
		cur = t;
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = opaque ? 2 : 6;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

module.exports = { encodePng };
