'use strict';
// S3TC block compression: BC1 (DXT1), BC2 (DXT3) and BC3 (DXT5) decoding to
// RGBA, a BC1 encoder, and the planner's tile mip chain.
//
// A BC1 block is 8 bytes for 4 x 4 pixels: two RGB565 endpoints (c0, c1,
// little-endian) and 16 2-bit indices (pixel 0 in the low bits, row-major).
// c0 > c1 is four-colour mode (p2 = (2 p0 + p1) / 3, p3 = (p0 + 2 p1) / 3);
// c0 <= c1 three-colour mode (p2 = (p0 + p1) / 2, p3 = transparent black).
// The encoder always writes four-colour blocks: endpoints from the block's
// principal axis, quantised to 565, then refit by least squares on the
// chosen indices; a flat block uses the best interpolated 565 pair per
// channel, exact when the colour is a 565 colour.

const TILE = 512;
// 512 x 512 and its mips down to 4 x 4, BC1 (half a byte per pixel).
const CHAIN_LEVELS = 8;
const CHAIN_BYTES = (() => {
	let n = 0;
	for (let s = TILE, i = 0; i < CHAIN_LEVELS; i++, s >>= 1) n += (s * s) / 2;
	return n;
})();

const exp5 = (v) => (v << 3) | (v >> 2);
const exp6 = (v) => (v << 2) | (v >> 4);
const lerp13 = (a, b) => ((2 * a + b + 1) / 3) | 0;
const half = (a, b) => (a + b + 1) >> 1;

// Bytes of a BC1 image of w x h (blocks of 4 x 4, edges rounded up).
const bc1Size = (w, h) => Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * 8;

// The four RGBA colours of a colour block at src[o]; `four` forces
// four-colour mode (BC2/BC3), `opaque` makes three-colour index 3 opaque black.
function palette(src, o, pal, four, opaque) {
	const c0 = src[o] | (src[o + 1] << 8);
	const c1 = src[o + 2] | (src[o + 3] << 8);
	const r0 = exp5(c0 >> 11), g0 = exp6((c0 >> 5) & 63), b0 = exp5(c0 & 31);
	const r1 = exp5(c1 >> 11), g1 = exp6((c1 >> 5) & 63), b1 = exp5(c1 & 31);
	pal[0] = r0; pal[1] = g0; pal[2] = b0; pal[3] = 255;
	pal[4] = r1; pal[5] = g1; pal[6] = b1; pal[7] = 255;
	if (four || c0 > c1) {
		pal[8] = lerp13(r0, r1); pal[9] = lerp13(g0, g1); pal[10] = lerp13(b0, b1); pal[11] = 255;
		pal[12] = lerp13(r1, r0); pal[13] = lerp13(g1, g0); pal[14] = lerp13(b1, b0); pal[15] = 255;
	} else {
		pal[8] = half(r0, r1); pal[9] = half(g0, g1); pal[10] = half(b0, b1); pal[11] = 255;
		pal[12] = 0; pal[13] = 0; pal[14] = 0; pal[15] = opaque ? 255 : 0;
	}
}

// Shared walk over the blocks of a w x h image; block(bx, by, o) fills
// px (16 RGBA pixels), then they are copied into out with edge clipping.
function decodeBlocks(src, w, h, offset, bytes, block) {
	const out = new Uint8Array(w * h * 4);
	const px = new Uint8Array(64);
	const bw = Math.max(1, Math.ceil(w / 4)), bh = Math.max(1, Math.ceil(h / 4));
	if (src.length < offset + bw * bh * bytes) throw new Error(`BC data too short: ${src.length - offset} bytes for ${w}x${h}`);
	let o = offset;
	for (let by = 0; by < bh; by++) {
		for (let bx = 0; bx < bw; bx++, o += bytes) {
			block(o, px);
			for (let y = 0; y < 4; y++) {
				const iy = by * 4 + y;
				if (iy >= h) break;
				for (let x = 0; x < 4; x++) {
					const ix = bx * 4 + x;
					if (ix >= w) break;
					const d = (iy * w + ix) * 4, s = (y * 4 + x) * 4;
					out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = px[s + 3];
				}
			}
		}
	}
	return out;
}

function colourBlock(src, o, px, pal, four, opaque) {
	palette(src, o, pal, four, opaque);
	const bits = (src[o + 4] | (src[o + 5] << 8) | (src[o + 6] << 16) | (src[o + 7] << 24)) >>> 0;
	for (let i = 0; i < 16; i++) {
		const k = ((bits >>> (2 * i)) & 3) * 4;
		px[i * 4] = pal[k]; px[i * 4 + 1] = pal[k + 1]; px[i * 4 + 2] = pal[k + 2]; px[i * 4 + 3] = pal[k + 3];
	}
}

// opts: { offset = 0, opaque = false } (opaque: three-colour index 3 is black, not transparent).
function decodeBC1(src, w, h, { offset = 0, opaque = false } = {}) {
	const pal = new Uint8Array(16);
	return decodeBlocks(src, w, h, offset, 8, (o, px) => colourBlock(src, o, px, pal, false, opaque));
}

function decodeBC2(src, w, h, { offset = 0 } = {}) {
	const pal = new Uint8Array(16);
	return decodeBlocks(src, w, h, offset, 16, (o, px) => {
		colourBlock(src, o + 8, px, pal, true, true);
		for (let i = 0; i < 16; i++) {
			const b = src[o + (i >> 1)];
			px[i * 4 + 3] = ((i & 1 ? b >> 4 : b & 15) * 17);
		}
	});
}

function decodeBC3(src, w, h, { offset = 0 } = {}) {
	const pal = new Uint8Array(16);
	const a = new Uint8Array(8);
	return decodeBlocks(src, w, h, offset, 16, (o, px) => {
		colourBlock(src, o + 8, px, pal, true, true);
		const a0 = src[o], a1 = src[o + 1];
		a[0] = a0; a[1] = a1;
		if (a0 > a1) for (let i = 1; i < 7; i++) a[i + 1] = (((7 - i) * a0 + i * a1 + 3) / 7) | 0;
		else {
			for (let i = 1; i < 5; i++) a[i + 1] = (((5 - i) * a0 + i * a1 + 2) / 5) | 0;
			a[6] = 0; a[7] = 255;
		}
		// 48 bits of 3-bit indices, pixel 0 lowest.
		let lo = (src[o + 2] | (src[o + 3] << 8) | (src[o + 4] << 16)) >>> 0;
		let hi = (src[o + 5] | (src[o + 6] << 8) | (src[o + 7] << 16)) >>> 0;
		for (let i = 0; i < 8; i++) px[i * 4 + 3] = a[(lo >>> (3 * i)) & 7];
		for (let i = 0; i < 8; i++) px[(i + 8) * 4 + 3] = a[(hi >>> (3 * i)) & 7];
	});
}

// The one RGB colour every pixel of opaque BC1 data decodes to, else null
// (identical blocks are compared bytewise, others decoded; stops at the
// first difference).
function flatColour(src, w, h, { offset = 0 } = {}) {
	const n = Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4));
	if (src.length < offset + n * 8) return null;
	const pal = new Uint8Array(16), px = new Uint8Array(64);
	colourBlock(src, offset, px, pal, false, true);
	const r = px[0], g = px[1], b = px[2];
	for (let i = 0, o = offset; i < n; i++, o += 8) {
		if (i && src.compare(src, offset, offset + 8, o, o + 8) === 0) continue;
		colourBlock(src, o, px, pal, false, true);
		for (let k = 0; k < 64; k += 4) if (px[k] !== r || px[k + 1] !== g || px[k + 2] !== b) return null;
	}
	return [r, g, b];
}

// Single-colour fit: for each 8-bit value, the endpoint pair (a, b) whose
// lerp13 lands closest to it (a == b preferred on ties), per channel width.
function singleTable(bits) {
	const n = 1 << bits;
	const exp = bits === 5 ? exp5 : exp6;
	const t = new Uint8Array(512);
	for (let v = 0; v < 256; v++) {
		let best = Infinity;
		for (let a = 0; a < n; a++) {
			for (let b = 0; b < n; b++) {
				const e = Math.abs(lerp13(exp(a), exp(b)) - v) * 1024 + Math.abs(a - b);
				if (e < best) {
					best = e;
					t[v * 2] = a;
					t[v * 2 + 1] = b;
				}
			}
		}
	}
	return t;
}
const OM5 = singleTable(5);
const OM6 = singleTable(6);

// Scratch for the encoder (one block at a time).
const PX = new Int32Array(48);
const IDX = new Uint8Array(16);
const TRY = new Uint8Array(16);
const PAL = new Int32Array(12);

const q5 = (v) => Math.round((Math.min(255, Math.max(0, v)) * 31) / 255);
const q6 = (v) => Math.round((Math.min(255, Math.max(0, v)) * 63) / 255);

// Squared error of the four-colour palette of (c0 > c1) over PX; indices -> out.
function evaluate(c0, c1, out) {
	const r0 = exp5(c0 >> 11), g0 = exp6((c0 >> 5) & 63), b0 = exp5(c0 & 31);
	const r1 = exp5(c1 >> 11), g1 = exp6((c1 >> 5) & 63), b1 = exp5(c1 & 31);
	PAL[0] = r0; PAL[1] = g0; PAL[2] = b0;
	PAL[3] = r1; PAL[4] = g1; PAL[5] = b1;
	PAL[6] = lerp13(r0, r1); PAL[7] = lerp13(g0, g1); PAL[8] = lerp13(b0, b1);
	PAL[9] = lerp13(r1, r0); PAL[10] = lerp13(g1, g0); PAL[11] = lerp13(b1, b0);
	const n = c0 === c1 ? 1 : 4;
	let err = 0;
	for (let i = 0; i < 16; i++) {
		const r = PX[i * 3], g = PX[i * 3 + 1], b = PX[i * 3 + 2];
		let best = Infinity, bi = 0;
		for (let k = 0; k < n; k++) {
			const dr = r - PAL[k * 3], dg = g - PAL[k * 3 + 1], db = b - PAL[k * 3 + 2];
			const e = dr * dr + dg * dg + db * db;
			if (e < best) {
				best = e;
				bi = k;
			}
		}
		out[i] = bi;
		err += best;
	}
	return err;
}

function writeBlock(out, o, c0, c1, idx) {
	// Four-colour mode needs c0 > c1: swap the endpoints and remap indices.
	let swap = false;
	if (c0 < c1) {
		const t = c0;
		c0 = c1;
		c1 = t;
		swap = true;
	}
	let bits = 0;
	for (let i = 15; i >= 0; i--) {
		let k = c0 === c1 ? 0 : idx[i];
		if (swap) k ^= 1;
		bits = bits * 4 + k;
	}
	out[o] = c0 & 255; out[o + 1] = c0 >> 8;
	out[o + 2] = c1 & 255; out[o + 3] = c1 >> 8;
	out[o + 4] = bits & 255; out[o + 5] = (bits >>> 8) & 255; out[o + 6] = (bits >>> 16) & 255; out[o + 7] = (bits >>> 24) & 255;
}

const pack = (r, g, b) => (q5(r) << 11) | (q6(g) << 5) | q5(b);
// Endpoint weights of index k: c0 * W0[k] + c1 * W1[k].
const W0 = [1, 0, 2 / 3, 1 / 3];
const W1 = [0, 1, 1 / 3, 2 / 3];

function encodeBlock(out, o) {
	let minR = 255, minG = 255, minB = 255, maxR = 0, maxG = 0, maxB = 0;
	let mr = 0, mg = 0, mb = 0;
	for (let i = 0; i < 16; i++) {
		const r = PX[i * 3], g = PX[i * 3 + 1], b = PX[i * 3 + 2];
		mr += r; mg += g; mb += b;
		if (r < minR) minR = r;
		if (r > maxR) maxR = r;
		if (g < minG) minG = g;
		if (g > maxG) maxG = g;
		if (b < minB) minB = b;
		if (b > maxB) maxB = b;
	}
	if (minR === maxR && minG === maxG && minB === maxB) {
		const c0 = (OM5[minR * 2] << 11) | (OM6[minG * 2] << 5) | OM5[minB * 2];
		const c1 = (OM5[minR * 2 + 1] << 11) | (OM6[minG * 2 + 1] << 5) | OM5[minB * 2 + 1];
		IDX.fill(c0 === c1 ? 0 : 2);
		writeBlock(out, o, c0, c1, IDX);
		return;
	}
	mr /= 16; mg /= 16; mb /= 16;
	let crr = 0, crg = 0, crb = 0, cgg = 0, cgb = 0, cbb = 0;
	for (let i = 0; i < 16; i++) {
		const r = PX[i * 3] - mr, g = PX[i * 3 + 1] - mg, b = PX[i * 3 + 2] - mb;
		crr += r * r; crg += r * g; crb += r * b;
		cgg += g * g; cgb += g * b; cbb += b * b;
	}
	// Principal axis by power iteration, seeded with the bounding box diagonal.
	let vr = maxR - minR, vg = maxG - minG, vb = maxB - minB;
	for (let k = 0; k < 6; k++) {
		const r = crr * vr + crg * vg + crb * vb;
		const g = crg * vr + cgg * vg + cgb * vb;
		const b = crb * vr + cgb * vg + cbb * vb;
		const m = Math.max(Math.abs(r), Math.abs(g), Math.abs(b));
		if (m === 0) break;
		vr = r / m; vg = g / m; vb = b / m;
	}
	const len2 = vr * vr + vg * vg + vb * vb;
	let tMin = Infinity, tMax = -Infinity;
	for (let i = 0; i < 16; i++) {
		const t = ((PX[i * 3] - mr) * vr + (PX[i * 3 + 1] - mg) * vg + (PX[i * 3 + 2] - mb) * vb) / len2;
		if (t < tMin) tMin = t;
		if (t > tMax) tMax = t;
	}
	let c0 = pack(mr + tMax * vr, mg + tMax * vg, mb + tMax * vb);
	let c1 = pack(mr + tMin * vr, mg + tMin * vg, mb + tMin * vb);
	let err = evaluate(c0, c1, IDX);
	// Least-squares refit of the endpoints to the chosen indices.
	for (let pass = 0; pass < 2 && err > 0; pass++) {
		let aa = 0, ab = 0, bb = 0, ar = 0, ag = 0, abl = 0, br = 0, bg = 0, bbl = 0;
		for (let i = 0; i < 16; i++) {
			const k = IDX[i];
			const a = W0[k], b = W1[k];
			const r = PX[i * 3], g = PX[i * 3 + 1], bl = PX[i * 3 + 2];
			aa += a * a; ab += a * b; bb += b * b;
			ar += a * r; ag += a * g; abl += a * bl;
			br += b * r; bg += b * g; bbl += b * bl;
		}
		const det = aa * bb - ab * ab;
		if (Math.abs(det) < 1e-9) break;
		const f = 1 / det;
		const n0 = pack((ar * bb - br * ab) * f, (ag * bb - bg * ab) * f, (abl * bb - bbl * ab) * f);
		const n1 = pack((br * aa - ar * ab) * f, (bg * aa - ag * ab) * f, (bbl * aa - abl * ab) * f);
		if (n0 === c0 && n1 === c1) break;
		const e = evaluate(n0, n1, TRY);
		if (e >= err) break;
		err = e;
		c0 = n0;
		c1 = n1;
		IDX.set(TRY);
	}
	writeBlock(out, o, c0, c1, IDX);
}

// rgba: w x h RGBA pixels (alpha ignored). -> out (a new Buffer by default)
// holding bc1Size(w, h) bytes at offset. Edge blocks repeat the last pixel.
function encodeBC1(rgba, w, h, out = Buffer.alloc(bc1Size(w, h)), offset = 0) {
	const bw = Math.max(1, Math.ceil(w / 4)), bh = Math.max(1, Math.ceil(h / 4));
	let o = offset;
	for (let by = 0; by < bh; by++) {
		for (let bx = 0; bx < bw; bx++, o += 8) {
			for (let y = 0; y < 4; y++) {
				const iy = Math.min(h - 1, by * 4 + y);
				for (let x = 0; x < 4; x++) {
					const s = (iy * w + Math.min(w - 1, bx * 4 + x)) * 4, d = (y * 4 + x) * 3;
					PX[d] = rgba[s]; PX[d + 1] = rgba[s + 1]; PX[d + 2] = rgba[s + 2];
				}
			}
			encodeBlock(out, o);
		}
	}
	return out;
}

// 2 x 2 box filter of a w x h RGBA image (w, h even) -> (w/2) x (h/2).
function downsample2(rgba, w, h) {
	const W = w >> 1, H = h >> 1;
	const out = new Uint8Array(W * H * 4);
	for (let y = 0; y < H; y++) {
		const r0 = 2 * y * w * 4, r1 = r0 + w * 4;
		for (let x = 0; x < W; x++) {
			const a = r0 + x * 8, b = r1 + x * 8, d = (y * W + x) * 4;
			for (let c = 0; c < 4; c++) out[d + c] = (rgba[a + c] + rgba[a + 4 + c] + rgba[b + c] + rgba[b + 4 + c] + 2) >> 2;
		}
	}
	return out;
}

// The tile file body: BC1 of a 512 x 512 RGBA image and its 7 box-filtered
// mips (256 .. 4), level 0 first, CHAIN_BYTES (174,760) bytes. level0Raw,
// when given, is used as level 0 verbatim (a block's own DXT1 data); the
// mips are still made from rgba512.
function mipChainBC1(rgba512, level0Raw) {
	const out = Buffer.alloc(CHAIN_BYTES);
	if (level0Raw) {
		if (level0Raw.length !== bc1Size(TILE, TILE)) throw new Error(`mipChainBC1: level 0 is ${level0Raw.length} bytes, not ${bc1Size(TILE, TILE)}`);
		out.set(level0Raw, 0);
	} else encodeBC1(rgba512, TILE, TILE, out, 0);
	let img = rgba512;
	let o = bc1Size(TILE, TILE);
	for (let s = TILE >> 1; s >= 4; s >>= 1) {
		img = downsample2(img, s * 2, s * 2);
		encodeBC1(img, s, s, out, o);
		o += bc1Size(s, s);
	}
	return out;
}

module.exports = { decodeBC1, decodeBC2, decodeBC3, encodeBC1, mipChainBC1, downsample2, flatColour, bc1Size, CHAIN_BYTES, CHAIN_LEVELS, TILE };
