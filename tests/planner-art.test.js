'use strict';
// The planner's map art (tools/lib/planner/art): BLP2 decoding of every
// encoding the client uses, the BC1 codec and the tile mip chain, the WDT's
// MAID, the PNG writer, and buildArt over a synthetic offline cache (the
// pyramid's tile math, the sea fill, incremental rebuilds, zone compositing).
// No network.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { readBlp, decodeBlp, dxt1Level0 } = require('../tools/lib/planner/art/blp');
const { decodeBC1, decodeBC3, encodeBC1, mipChainBC1, CHAIN_BYTES } = require('../tools/lib/planner/art/bc1');
const { readMaid } = require('../tools/lib/planner/art/wdt');
const { encodePng } = require('../tools/lib/planner/art/png');
const { buildArt } = require('../tools/lib/planner/art/build');
const { tmpdir } = require('./helpers/tmp');

// A BLP2 file: mips are the raw level bytes, palette 256 BGRA entries.
function blp({ encoding, alphaDepth = 0, alphaEncoding = 0, w, h, mips, palette = [] }) {
	const head = Buffer.alloc(148 + 1024);
	head.write('BLP2', 0, 'latin1');
	head.writeUInt32LE(1, 4);
	head[8] = encoding;
	head[9] = alphaDepth;
	head[10] = alphaEncoding;
	head[11] = mips.length > 1 ? 1 : 0;
	head.writeUInt32LE(w, 12);
	head.writeUInt32LE(h, 16);
	let off = head.length;
	mips.forEach((m, i) => {
		head.writeUInt32LE(off, 20 + 4 * i);
		head.writeUInt32LE(m.length, 84 + 4 * i);
		off += m.length;
	});
	palette.forEach(([r, g, b], i) => head.set([b, g, r, 255], 148 + 4 * i));
	return Buffer.concat([head, ...mips]);
}

// One BC1 block: endpoints (565) and 16 indices.
function bc1Block(c0, c1, idx) {
	const b = Buffer.alloc(8);
	b.writeUInt16LE(c0, 0);
	b.writeUInt16LE(c1, 2);
	let bits = 0;
	for (let i = 15; i >= 0; i--) bits = bits * 4 + idx[i];
	b.writeUInt32LE(bits >>> 0, 4);
	return b;
}

const px = (rgba, w, x, y) => [...rgba.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
const flat = (w, h, [r, g, b]) => {
	const out = new Uint8Array(w * h * 4);
	for (let i = 0; i < out.length; i += 4) out.set([r, g, b, 255], i);
	return out;
};
const near = (got, want, tol, msg) => assert.ok(want.every((v, i) => Math.abs(got[i] - v) <= tol), `${msg}: ${got} vs ${want} (±${tol})`);

test('BLP2 DXT1: four-colour palette, mips, and level 0 kept as stored', () => {
	const idx = Array.from({ length: 16 }, (_, i) => i % 4);
	const block = bc1Block(0xf800, 0x001f, idx); // red, blue: four-colour mode
	const file = blp({ encoding: 2, w: 4, h: 4, mips: [block] });
	const d = decodeBlp(file);
	assert.equal(d.format, 'dxt1');
	assert.deepEqual([d.width, d.height, d.mips.length], [4, 4, 1]);
	assert.deepEqual(px(d.mips[0].rgba, 4, 0, 0), [255, 0, 0, 255]);
	assert.deepEqual(px(d.mips[0].rgba, 4, 1, 0), [0, 0, 255, 255]);
	assert.deepEqual(px(d.mips[0].rgba, 4, 2, 0), [170, 0, 85, 255]);
	assert.deepEqual(px(d.mips[0].rgba, 4, 3, 0), [85, 0, 170, 255]);

	// 8 x 8 with mips 4 x 4, 2 x 2, 1 x 1: one block each below level 0.
	const l0 = Buffer.concat([0, 1, 2, 3].map((k) => bc1Block(0xffff, 0, Array(16).fill(k & 1))));
	const small = bc1Block(0x07e0, 0x07e0, Array(16).fill(0)); // green
	const big = blp({ encoding: 2, w: 8, h: 8, mips: [l0, small, small, small] });
	const b = decodeBlp(big);
	assert.deepEqual(b.mips.map((m) => [m.width, m.height]), [[8, 8], [4, 4], [2, 2], [1, 1]]);
	assert.deepEqual(px(b.mips[0].rgba, 8, 0, 0), [255, 255, 255, 255]);
	assert.deepEqual(px(b.mips[0].rgba, 8, 4, 0), [0, 0, 0, 255]);
	assert.deepEqual(px(b.mips[3].rgba, 1, 0, 0), [0, 255, 0, 255]);
	assert.deepEqual([...dxt1Level0(big, 8, 8)], [...l0]);
	assert.equal(dxt1Level0(big), null); // not 512 x 512
});

test('BLP2 DXT1 with 1-bit alpha: three-colour index 3 is transparent; opaque files read it black', () => {
	const block = bc1Block(0x001f, 0xf800, [0, 1, 2, 3, ...Array(12).fill(0)]); // c0 <= c1
	const a1 = decodeBlp(blp({ encoding: 2, alphaDepth: 1, w: 4, h: 4, mips: [block] })).mips[0].rgba;
	assert.deepEqual(px(a1, 4, 2, 0), [128, 0, 128, 255]);
	assert.deepEqual(px(a1, 4, 3, 0), [0, 0, 0, 0]);
	const a0 = decodeBlp(blp({ encoding: 2, alphaDepth: 0, w: 4, h: 4, mips: [block] })).mips[0].rgba;
	assert.deepEqual(px(a0, 4, 3, 0), [0, 0, 0, 255]);
});

test('BLP2 DXT3 and DXT5 alpha', () => {
	const colour = bc1Block(0xffff, 0xffff, Array(16).fill(0));
	const dxt3 = Buffer.concat([Buffer.from([0x0f, 0xf0, 0, 0, 0, 0, 0, 0]), colour]);
	const d3 = decodeBlp(blp({ encoding: 2, alphaDepth: 8, alphaEncoding: 1, w: 4, h: 4, mips: [dxt3] }));
	assert.equal(d3.format, 'dxt3');
	assert.deepEqual([0, 1, 2, 3].map((i) => d3.mips[0].rgba[i * 4 + 3]), [255, 0, 0, 255]);
	// DXT5: a0 = 200, a1 = 100 (8-value mode); pixel 0 index 0, pixel 1 index 1, pixel 2 index 2.
	const bits = 0 | (1 << 3) | (2 << 6);
	const dxt5 = Buffer.concat([Buffer.from([200, 100, bits & 255, bits >> 8, 0, 0, 0, 0]), colour]);
	const d5 = decodeBlp(blp({ encoding: 2, alphaDepth: 8, alphaEncoding: 7, w: 4, h: 4, mips: [dxt5] }));
	assert.equal(d5.format, 'dxt5');
	assert.deepEqual([0, 1, 2].map((i) => d5.mips[0].rgba[i * 4 + 3]), [200, 100, 186]);
	// 6-value mode (a0 <= a1): indices 6 and 7 are 0 and 255.
	const six = Buffer.concat([Buffer.from([10, 20, (6 | (7 << 3)) & 255, 0, 0, 0, 0, 0]), colour]);
	assert.deepEqual([0, 1].map((i) => decodeBC3(six, 4, 4)[i * 4 + 3]), [0, 255]);
});

test('BLP2 palettized with 0, 1, 4 and 8-bit alpha, and uncompressed BGRA', () => {
	const palette = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [9, 8, 7]];
	const idx = Buffer.from([0, 1, 2, 3]);
	const cases = [
		[0, Buffer.alloc(0), [255, 255, 255, 255]],
		[1, Buffer.from([0b0101]), [255, 0, 255, 0]],
		[4, Buffer.from([0x50, 0xaf]), [0, 85, 255, 170]],
		[8, Buffer.from([1, 2, 3, 4]), [1, 2, 3, 4]],
	];
	for (const [depth, alpha, want] of cases) {
		const d = decodeBlp(blp({ encoding: 1, alphaDepth: depth, w: 2, h: 2, mips: [Buffer.concat([idx, alpha])], palette }));
		assert.equal(d.format, 'palette');
		assert.deepEqual(px(d.mips[0].rgba, 2, 1, 1).slice(0, 3), [9, 8, 7]);
		assert.deepEqual([0, 1, 2, 3].map((i) => d.mips[0].rgba[i * 4 + 3]), want, `alphaDepth ${depth}`);
	}
	const argb = decodeBlp(blp({ encoding: 3, alphaDepth: 8, w: 1, h: 1, mips: [Buffer.from([30, 20, 10, 40])] }));
	assert.deepEqual(px(argb.mips[0].rgba, 1, 0, 0), [10, 20, 30, 40]);
	assert.throws(() => readBlp(Buffer.from('BLP1')), /not a BLP2/);
});

test('BC1 encode: a flat 565 colour round-trips exactly, a flat off-grid colour within 2', () => {
	for (const [colour, tol] of [[[33, 65, 99], 0], [[20, 33, 51], 2], [[255, 255, 255], 0], [[0, 0, 0], 0]]) {
		const dec = decodeBC1(encodeBC1(flat(8, 8, colour), 8, 8), 8, 8);
		for (let i = 0; i < 64; i++) near(px(dec, 8, i % 8, i >> 3), [...colour, 255], tol, `flat ${colour}`);
	}
});

// RMSE and max abs error of a BC1 round trip of a 64 x 64 image; every block four-colour.
function roundTrip(colourAt) {
	const w = 64, h = 64;
	const img = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.set([...colourAt(x, y), 255], (y * w + x) * 4);
	const enc = encodeBC1(img, w, h);
	assert.equal(enc.length, (w / 4) * (h / 4) * 8);
	for (let o = 0; o < enc.length; o += 8) assert.ok(enc.readUInt16LE(o) >= enc.readUInt16LE(o + 2), 'c0 >= c1');
	const dec = decodeBC1(enc, w, h, { opaque: true });
	let se = 0, max = 0;
	for (let i = 0; i < img.length; i++) {
		if (i % 4 === 3) continue;
		const e = Math.abs(dec[i] - img[i]);
		se += e * e;
		max = Math.max(max, e);
	}
	return { rmse: Math.sqrt(se / (w * h * 3)), max };
}

test('BC1 encode: gradients decode within a small error', () => {
	// Along one colour line (what a BC1 block represents): bounded by the 565 step.
	const line = roundTrip((x) => [x * 4, 255 - x * 3, 40 + x]);
	assert.ok(line.rmse < 1.8 && line.max <= 4, `line ${JSON.stringify(line)}`);
	// A colour plane (two independent ramps): BC1's palette is a line, so
	// ~3 RMSE is its floor here (exhaustive endpoint search gets 5% lower).
	const plane = roundTrip((x, y) => [x * 4, y * 4, 255 - (x + y) * 2]);
	assert.ok(plane.rmse < 3.2 && plane.max <= 10, `plane ${JSON.stringify(plane)}`);
});

test('mip chain: 512 .. 4, 174,760 bytes, level 0 verbatim when given', () => {
	assert.equal(CHAIN_BYTES, 174760);
	const img = flat(512, 512, [33, 65, 99]);
	const chain = mipChainBC1(img);
	assert.equal(chain.length, 174760);
	let o = 0;
	for (let s = 512; s >= 4; s >>= 1) {
		near(px(decodeBC1(chain, s, s, { offset: o }), s, s - 1, s - 1), [33, 65, 99, 255], 0, `mip ${s}`);
		o += (s * s) / 2;
	}
	assert.equal(o, chain.length);
	const raw = Buffer.alloc(131072, 0xab);
	assert.deepEqual(mipChainBC1(img, raw).subarray(0, 131072), raw);
	assert.deepEqual(mipChainBC1(img, raw).subarray(131072), chain.subarray(131072));
});

// A WDT: MVER, MPHD, MAIN, MAID (tags reversed), minimap fdids at (col, row).
function wdt(minimaps) {
	const chunk = (tag, data) => {
		const h = Buffer.alloc(8);
		h.write(tag.split('').reverse().join(''), 0, 'latin1');
		h.writeUInt32LE(data.length, 4);
		return Buffer.concat([h, data]);
	};
	const maid = Buffer.alloc(4096 * 32);
	const main = Buffer.alloc(4096 * 8);
	for (const [col, row, fdid] of minimaps) {
		maid.writeUInt32LE(fdid + 1000, (row * 64 + col) * 32); // root ADT, not the minimap
		maid.writeUInt32LE(fdid, (row * 64 + col) * 32 + 28);
		main.writeUInt32LE(1, (row * 64 + col) * 8);
	}
	return Buffer.concat([chunk('MVER', Buffer.from([18, 0, 0, 0])), chunk('MPHD', Buffer.alloc(32)), chunk('MAIN', main), chunk('MAID', maid)]);
}

test('WDT MAID: the 8th FileDataID of each entry is the minimap block, index row * 64 + col', () => {
	assert.deepEqual(readMaid(wdt([[32, 48, 204493], [0, 1, 7]])), [
		{ col: 0, row: 1, fdid: 7 },
		{ col: 32, row: 48, fdid: 204493 },
	]);
	assert.throws(() => readMaid(Buffer.concat([Buffer.from('REVM'), Buffer.from([4, 0, 0, 0, 18, 0, 0, 0])])), /no MAID/);
});

// PNG -> { w, h, type, rgba }: chunk CRCs checked, IDAT inflated and unfiltered.
function readPng(buf) {
	assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	let o = 8, ihdr, idat = [];
	while (o < buf.length) {
		const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8);
		assert.equal(buf.readUInt32BE(o + 8 + len), zlib.crc32(buf.subarray(o + 4, o + 8 + len)), `${type} CRC`);
		if (type === 'IHDR') ihdr = buf.subarray(o + 8, o + 8 + len);
		if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
		o += 12 + len;
	}
	const w = ihdr.readUInt32BE(0), h = ihdr.readUInt32BE(4), type = ihdr[9];
	assert.equal(ihdr[8], 8);
	const bpp = type === 6 ? 4 : 3, stride = w * bpp;
	const raw = zlib.inflateSync(Buffer.concat(idat));
	assert.equal(raw.length, (stride + 1) * h);
	const rgba = new Uint8Array(w * h * 4);
	let prev = new Uint8Array(stride);
	for (let y = 0; y < h; y++) {
		const f = raw[y * (stride + 1)], cur = new Uint8Array(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
		for (let i = 0; i < stride; i++) {
			const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
			const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
			const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
			cur[i] = (cur[i] + pred) & 255;
		}
		for (let x = 0; x < w; x++) rgba.set([...cur.subarray(x * bpp, x * bpp + bpp), ...(bpp === 3 ? [255] : [])], (y * w + x) * 4);
		prev = cur;
	}
	return { w, h, type, rgba };
}

test('PNG: RGB when opaque, RGBA otherwise, pixels survive inflate + unfilter', () => {
	const w = 37, h = 11;
	const img = new Uint8Array(w * h * 4);
	for (let i = 0; i < w * h; i++) img.set([(i * 7) & 255, (i * 13) & 255, (i * i) & 255, 255], i * 4);
	const rgb = readPng(encodePng(img, w, h));
	assert.deepEqual([rgb.w, rgb.h, rgb.type], [w, h, 2]);
	assert.deepEqual(rgb.rgba, img);
	img[3] = 7;
	const rgba = readPng(encodePng(img, w, h));
	assert.equal(rgba.type, 6);
	assert.deepEqual(rgba.rgba, img);
});

// A synthetic offline cache: Forever build 1.60.1.99999, continent 0 with
// blocks at (32, 48) and (33, 49), and zone 1426 (2 x 2 base tiles of 4 x 4 on
// a 6 x 5 layer, one translucent overlay).
function fixture() {
	const root = tmpdir('polestar-art-');
	const sources = path.join(root, 'sources'), data = path.join(root, 'data'), out = path.join(root, 'art');
	const casc = path.join(sources, 'casc', 'wow_classic_beta', '1.60.1.99999');
	const wago = path.join(sources, 'wago', '1.60.1.99999');
	fs.mkdirSync(casc, { recursive: true });
	fs.mkdirSync(wago, { recursive: true });
	fs.mkdirSync(data, { recursive: true });
	const put = (fdid, buf) => fs.writeFileSync(path.join(casc, `${fdid}.blp`), buf);
	put(100, wdt([[32, 48, 201], [33, 49, 202]]));
	put(201, blp({ encoding: 2, w: 512, h: 512, mips: [encodeBC1(flat(512, 512, [33, 65, 99]), 512, 512)] }));
	const pal4 = (rgb) => blp({ encoding: 1, w: 4, h: 4, mips: [Buffer.alloc(16)], palette: [rgb] });
	put(202, pal4([255, 255, 255]));
	put(301, pal4([200, 0, 0]));
	put(302, pal4([0, 200, 0]));
	put(303, pal4([0, 0, 200]));
	put(304, pal4([200, 200, 0]));
	put(401, blp({ encoding: 1, alphaDepth: 8, w: 16, h: 16, mips: [Buffer.concat([Buffer.alloc(256), Buffer.alloc(256, 128)])], palette: [[255, 255, 255]] }));
	const csv = (name, rows) => fs.writeFileSync(path.join(wago, `${name}.csv`), `${rows.map((r) => r.join(',')).join('\n')}\n`);
	csv('Map', [['ID', 'Directory', 'MapName_lang', 'WdtFileDataID'], [0, 'Azeroth', 'Eastern Kingdoms', 100]]);
	csv('UiMap', [['Name_lang', 'ID', 'Type'], ['Dun Morogh', 1426, 3], ['Eastern Kingdoms', 1415, 2]]);
	csv('UiMapXMapArt', [['ID', 'PhaseID', 'UiMapArtID', 'UiMapID'], [1, 0, 5, 1426]]);
	csv('UiMapArt', [['ID', 'HighlightFileDataID', 'HighlightAtlasID', 'UiMapArtStyleID'], [5, 0, 0, 2]]);
	csv('UiMapArtStyleLayer', [['ID', 'LayerIndex', 'LayerWidth', 'LayerHeight', 'TileWidth', 'TileHeight', 'UiMapArtStyleID'], [1, 0, 6, 5, 4, 4, 2]]);
	csv('UiMapArtTile', [['ID', 'RowIndex', 'ColIndex', 'LayerIndex', 'FileDataID', 'UiMapArtID'], [1, 0, 0, 0, 301, 5], [2, 0, 1, 0, 302, 5], [3, 1, 0, 0, 303, 5], [4, 1, 1, 0, 304, 5]]);
	csv('WorldMapOverlay', [['ID', 'UiMapArtID', 'TextureWidth', 'TextureHeight', 'OffsetX', 'OffsetY'], [9, 5, 4, 2, 1, 1]]);
	csv('WorldMapOverlayTile', [['ID', 'RowIndex', 'ColIndex', 'LayerIndex', 'FileDataID', 'WorldMapOverlayID'], [1, 0, 0, 0, 401, 9]]);
	const frame = { c: 0, left: -1000, right: -2000, top: 500, bottom: -500 };
	fs.writeFileSync(path.join(data, 'map-frames.json'), JSON.stringify({ era: { 1415: { c: 0, left: 1, right: 2, top: 3, bottom: 4 } }, forever: { 1426: frame } }));
	return { sources, data, out, put, frame };
}

const tilePx = (file, x, y) => px(decodeBC1(zlib.gunzipSync(fs.readFileSync(file)), 512, 512, { opaque: true }), 512, x, y);

test('buildArt: pyramid levels, sea fill, index, incremental rebuild, zone art', async () => {
	const fx = fixture();
	const opts = { outDir: fx.out, sourcesDir: fx.sources, dataDir: fx.data, offline: true, workers: 0 };
	const r = await buildArt(opts);
	assert.deepEqual(r, { build: '1.60.1.99999', continents: [0], tiles: 8, zones: 1, warnings: [] });
	const index = JSON.parse(fs.readFileSync(path.join(fx.out, 'index.json'), 'utf8'));
	assert.deepEqual(index.tile, { px: 512, mips: 8, format: 'bc1', adtYards: 1600 / 3, sea: [8, 16, 16] });
	const ek = index.continents['0'];
	assert.deepEqual([ek.name, ek.directory, ek.maxLevel], ['Eastern Kingdoms', 'Azeroth', 6]);
	assert.deepEqual(ek.bounds, { minCol: 32, maxCol: 33, minRow: 48, maxRow: 49 });
	assert.deepEqual(ek.sea, [8, 16, 16]);
	assert.deepEqual(ek.levels, { 0: [[32, 48], [33, 49]], 1: [[16, 24]], 2: [[8, 12]], 3: [[4, 6]], 4: [[2, 3]], 5: [[1, 1]], 6: [[0, 0]] });

	const tile = (L, tx, ty) => path.join(fx.out, 'tiles', '0', String(L), `${tx}_${ty}.bc1.gz`);
	assert.equal(zlib.gunzipSync(fs.readFileSync(tile(0, 32, 48))).length, 174760);
	// Level 0 of a native 512 DXT1 block is its own data.
	assert.deepEqual(zlib.gunzipSync(fs.readFileSync(tile(0, 32, 48))).subarray(0, 131072), dxt1Level0(fs.readFileSync(path.join(fx.sources, 'casc', 'wow_classic_beta', '1.60.1.99999', '201.blp'))));
	// Level 1 (16, 24): (32, 48) top-left, (33, 49) bottom-right, sea elsewhere.
	near(tilePx(tile(1, 16, 24), 10, 10), [33, 65, 99, 255], 0, 'top-left block');
	near(tilePx(tile(1, 16, 24), 400, 400), [255, 255, 255, 255], 0, 'bottom-right block');
	near(tilePx(tile(1, 16, 24), 400, 10), [8, 16, 16, 255], 0, 'top-right sea');
	near(tilePx(tile(1, 16, 24), 10, 400), [8, 16, 16, 255], 0, 'bottom-left sea');
	// Level 2 (8, 12): the level-1 tile in its top-left quadrant.
	near(tilePx(tile(2, 8, 12), 10, 10), [33, 65, 99, 255], 0, 'level 2');
	near(tilePx(tile(2, 8, 12), 300, 10), [8, 16, 16, 255], 0, 'level 2 sea');

	// Zone: base tiles cropped to 6 x 5, the half-transparent white overlay over x 1..4, y 1..2.
	assert.deepEqual(index.zones['1426'], { c: 0, name: 'Dun Morogh', file: 'zones/1426.png', w: 6, h: 5, frame: { left: -1000, right: -2000, top: 500, bottom: -500 } });
	const png = readPng(fs.readFileSync(path.join(fx.out, 'zones', '1426.png')));
	assert.deepEqual([png.w, png.h], [6, 5]);
	assert.deepEqual(px(png.rgba, 6, 0, 0), [200, 0, 0, 255]);
	assert.deepEqual(px(png.rgba, 6, 5, 0), [0, 200, 0, 255]);
	assert.deepEqual(px(png.rgba, 6, 0, 4), [0, 0, 200, 255]);
	assert.deepEqual(px(png.rgba, 6, 1, 1), [228, 128, 128, 255]);
	assert.deepEqual(px(png.rgba, 6, 3, 2), [228, 128, 128, 255]);
	assert.deepEqual(px(png.rgba, 6, 4, 1), [128, 228, 128, 255]);
	assert.deepEqual(px(png.rgba, 6, 4, 3), [0, 200, 0, 255]);

	// A rebuilt block refreshes every tile above it; the rest stays.
	const before = fs.statSync(tile(0, 33, 49)).mtimeMs;
	fx.put(201, blp({ encoding: 1, w: 4, h: 4, mips: [Buffer.alloc(16)], palette: [[0, 0, 0]] }));
	fs.rmSync(tile(0, 32, 48));
	const again = await buildArt(opts);
	assert.deepEqual(again.warnings, []);
	near(tilePx(tile(1, 16, 24), 10, 10), [0, 0, 0, 255], 0, 'rebuilt level 1');
	near(tilePx(tile(6, 0, 0), 258, 386), [0, 0, 0, 255], 0, 'rebuilt level 6');
	near(tilePx(tile(6, 0, 0), 100, 100), [8, 16, 16, 255], 0, 'level 6 sea');
	near(tilePx(tile(4, 2, 3), 0, 0), [0, 0, 0, 255], 0, 'rebuilt level 4');
	near(tilePx(tile(1, 16, 24), 400, 400), [255, 255, 255, 255], 0, 'kept block');
	assert.equal(fs.statSync(tile(0, 33, 49)).mtimeMs, before);
});

test('buildArt: a continent whose uniform blocks share another colour takes it as its sea', async () => {
	const fx = fixture();
	const black = Array.from({ length: 8 }, (_, i) => [40 + i, 40, 500 + i]);
	fx.put(100, wdt([[32, 48, 201], [33, 49, 202], ...black]));
	for (const [, , fdid] of black) fx.put(fdid, blp({ encoding: 2, w: 4, h: 4, mips: [bc1Block(0, 0, Array(16).fill(0))] }));
	const r = await buildArt({ outDir: fx.out, sourcesDir: fx.sources, dataDir: fx.data, offline: true, workers: 0, zones: false });
	assert.deepEqual(r.warnings, []);
	const index = JSON.parse(fs.readFileSync(path.join(fx.out, 'index.json'), 'utf8'));
	assert.deepEqual(index.continents['0'].sea, [0, 0, 0]);
	assert.deepEqual(index.tile.sea, [8, 16, 16]);
	near(tilePx(path.join(fx.out, 'tiles', '0', '1', '16_24.bc1.gz'), 400, 10), [0, 0, 0, 255], 0, 'sea fill');
});
