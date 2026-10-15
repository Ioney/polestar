// BC1 (DXT1) -> RGBA decoder for browsers without WEBGL_compressed_texture_s3tc.
// Message { id, buf: ArrayBuffer (a tile file: level 0 first), w, h }
// -> { id, rgba: Uint8Array w * h * 4 } (level 0 only; the page builds mips).
// Colour 3 of the 3-colour mode is opaque black, as COMPRESSED_RGB_S3TC_DXT1.

const expand = (c) => {
	const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
	return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
};

function decode(src, w, h) {
	const out = new Uint8Array(w * h * 4);
	const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
	const pal = new Uint8Array(16);
	const bw = Math.max(1, w >> 2), bh = Math.max(1, h >> 2);
	let p = 0;
	for (let by = 0; by < bh; by++) {
		for (let bx = 0; bx < bw; bx++, p += 8) {
			const c0 = dv.getUint16(p, true), c1 = dv.getUint16(p + 2, true);
			const bits = dv.getUint32(p + 4, true);
			const a = expand(c0), b = expand(c1);
			pal[0] = a[0]; pal[1] = a[1]; pal[2] = a[2];
			pal[4] = b[0]; pal[5] = b[1]; pal[6] = b[2];
			if (c0 > c1) {
				for (let k = 0; k < 3; k++) {
					pal[8 + k] = (2 * a[k] + b[k] + 1) / 3 | 0;
					pal[12 + k] = (a[k] + 2 * b[k] + 1) / 3 | 0;
				}
			} else {
				for (let k = 0; k < 3; k++) {
					pal[8 + k] = (a[k] + b[k]) >> 1;
					pal[12 + k] = 0;
				}
			}
			for (let py = 0; py < 4; py++) {
				const y = by * 4 + py;
				if (y >= h) break;
				let o = (y * w + bx * 4) * 4;
				for (let px = 0; px < 4; px++, o += 4) {
					if (bx * 4 + px >= w) break;
					const i = ((bits >>> (2 * (py * 4 + px))) & 3) * 4;
					out[o] = pal[i]; out[o + 1] = pal[i + 1]; out[o + 2] = pal[i + 2]; out[o + 3] = 255;
				}
			}
		}
	}
	return out;
}

self.onmessage = (e) => {
	const { id, buf, w, h } = e.data;
	try {
		const rgba = decode(new Uint8Array(buf), w, h);
		self.postMessage({ id, rgba }, [rgba.buffer]);
	} catch (err) {
		self.postMessage({ id, error: String(err && err.message || err) });
	}
};
