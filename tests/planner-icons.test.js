'use strict';
// The planner's icons: Polestar's glyphs rendered at any size
// (tools/planner/glyphs.js), the game's icons resolved from client tables and
// paths to PNGs with a fake wago.tools and CASC (tools/planner/icons.js), and
// the server routes that serve both, with their key checks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { tmpdir } = require('./helpers/tmp');
const { DATA_DIR } = require('./helpers/dsl');
const glyphs = require('../tools/planner/glyphs');
const { openIcons, keyOf, UI } = require('../tools/planner/icons');
const { encodePng } = require('../tools/lib/planner/art/png');
const { tableUrl } = require('../tools/lib/data/wago');
const { Workspace } = require('../tools/planner/workspace');
const { startServer } = require('../tools/planner/server');

const MINI = path.join(__dirname, 'fixtures', 'packs', 'mini');
const BUILD = '1.60.1.1';

// PNG -> { w, h, rgba } (8-bit RGBA or RGB, the filters png.js writes).
function decodePng(buf) {
	assert.equal(buf.toString('latin1', 1, 4), 'PNG');
	let p = 8, w, h, type;
	const idat = [];
	while (p < buf.length) {
		const len = buf.readUInt32BE(p), t = buf.toString('latin1', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
		if (t === 'IHDR') [w, h, type] = [d.readUInt32BE(0), d.readUInt32BE(4), d[9]];
		if (t === 'IDAT') idat.push(d);
		p += 12 + len;
	}
	const bpp = type === 6 ? 4 : 3, stride = w * bpp, raw = zlib.inflateSync(Buffer.concat(idat));
	const rgba = new Uint8Array(w * h * 4);
	let prev = new Uint8Array(stride);
	for (let y = 0; y < h; y++) {
		const f = raw[y * (stride + 1)], cur = new Uint8Array(stride);
		for (let i = 0; i < stride; i++) {
			const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
			const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
			const pr = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
			cur[i] = (raw[y * (stride + 1) + 1 + i] + pr) & 255;
		}
		for (let x = 0; x < w; x++) {
			for (let k = 0; k < 3; k++) rgba[(y * w + x) * 4 + k] = cur[x * bpp + k];
			rgba[(y * w + x) * 4 + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
		}
		prev = cur;
	}
	return { w, h, rgba };
}

// An uncompressed BLP2 (one mip) of w x h, pixel (x, y) -> [r, g, b, a].
function blp(w, h, color) {
	const head = Buffer.alloc(148 + 1024);
	head.write('BLP2', 0, 'latin1');
	head.writeUInt32LE(1, 4);
	head[8] = 3;
	head[9] = 8;
	head.writeUInt32LE(w, 12);
	head.writeUInt32LE(h, 16);
	head.writeUInt32LE(head.length, 20);
	head.writeUInt32LE(w * h * 4, 84);
	const data = Buffer.alloc(w * h * 4);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const [r, g, b, a] = color(x, y);
			data.set([b, g, r, a], (y * w + x) * 4);
		}
	}
	return Buffer.concat([head, data]);
}

// A 64 px icon: a red frame 4 px wide (inside the 0.07 inset) around green.
const ICON = blp(64, 64, (x, y) => (x < 4 || y < 4 || x >= 60 || y >= 60 ? [255, 0, 0, 255] : [0, 200, 0, 255]));
// A 16 px UI texture, half transparent.
const UI_TEX = blp(16, 16, (x) => (x < 8 ? [255, 255, 255, 255] : [0, 0, 0, 0]));

const ITEM_CSV = 'ID,ClassID,IconFileDataID\n750,12,133972\n2,0,0\n6948,15,134414\n';
const FILES = { 136456: 'interface/minimap/tracking/flightmaster.blp', 136458: 'interface/minimap/tracking/innkeeper.blp' };

// A fake wago.tools (tables and file search) and CASC; `calls` lists every URL and fdid asked.
function fakes() {
	const calls = [];
	const files = { 133972: ICON, 134414: ICON, 136456: UI_TEX, 136458: UI_TEX };
	const reply = (status, body) => ({ ok: status === 200, status, arrayBuffer: async () => new TextEncoder().encode(body).buffer });
	const fetchImpl = async (url) => {
		calls.push(url);
		if (url === tableUrl('Item', BUILD)) return reply(200, ITEM_CSV);
		if (url.startsWith('https://wago.tools/api/files?search=')) {
			const q = decodeURIComponent(/search=([^&]+)/.exec(url)[1]);
			return reply(200, JSON.stringify(Object.fromEntries(Object.entries(FILES).filter(([, p]) => p.includes(q)))));
		}
		return reply(404, 'not found');
	};
	const casc = {
		build: BUILD,
		get: async (fdid) => {
			calls.push(fdid);
			if (files[fdid]) return files[fdid];
			throw Object.assign(new Error(`HTTP 404 ${fdid}`), { status: 404 });
		},
	};
	return { calls, fetchImpl, casc };
}

test('glyphs: every name renders white on transparent at its size, px clamped', () => {
	for (const name of glyphs.NAMES) {
		const { w, h, rgba } = decodePng(glyphs.renderGlyph(name, 48));
		assert.deepEqual([w, h], [48, 48], name);
		let cover = 0;
		for (let i = 0; i < rgba.length; i += 4) {
			if (rgba[i + 3]) assert.deepEqual([rgba[i], rgba[i + 1], rgba[i + 2]], [255, 255, 255], name);
			cover += rgba[i + 3];
		}
		assert.ok(cover > 0, `${name} draws nothing`);
		assert.ok(cover < 48 * 48 * 255, `${name} fills the whole square`);
	}
	for (const name of ['play', 'pause', 'step-back', 'step-forward', 'edit', 'minus', 'eye', 'eye-off', 'route', 'map', 'fit', 'undo', 'redo', 'list', 'character', 'clock', 'warning', 'download', 'export', 'pin-add', 'filter', 'swap']) {
		assert.ok(glyphs.PLANNER_GLYPHS.includes(name), name);
	}
	assert.equal(glyphs.renderGlyph('nope', 48), null);
	assert.equal(decodePng(glyphs.renderGlyph('play', 4)).w, glyphs.PX_MIN);
	assert.equal(decodePng(glyphs.renderGlyph('play', 9999)).w, glyphs.PX_MAX);
	assert.equal(decodePng(glyphs.renderGlyph('play')).w, glyphs.PX_DEFAULT);
	assert.equal(glyphs.clampPx('abc'), glyphs.PX_DEFAULT);
	assert.equal(decodePng(glyphs.renderEmblem(64)).w, 64);
	const { band, stars } = glyphs.renderBand();
	assert.deepEqual([decodePng(band).w, decodePng(band).h, decodePng(stars).w], [1024, 128, 1024]);
	assert.deepEqual([decodePng(glyphs.mediaPng('Nav', 'arrow')).w > 0, glyphs.mediaPng('Nav', '../UI/check'), glyphs.mediaPng('Other', 'arrow')], [true, null, null]);
});

test('keys are checked per kind and named canonically', () => {
	assert.equal(keyOf('item', '750'), '750');
	for (const bad of ['0', '-1', '7.5', 'abc', '../750', '750/..', '1234567890']) assert.equal(keyOf('item', bad), null, bad);
	assert.equal(keyOf('skill', 'First Aid'), 'first-aid');
	assert.equal(keyOf('skill', '186'), '186');
	assert.equal(keyOf('skill', '../x'), null);
	assert.equal(keyOf('class', 'shaman'), 'SHAMAN');
	assert.equal(keyOf('class', 'DEATHKNIGHT'), null);
	assert.equal(keyOf('race', 'nightelf-FEMALE'), 'NightElf-female');
	assert.equal(keyOf('race', 'Dwarf'), null);
	assert.equal(keyOf('ui', 'flightmaster'), 'flightmaster');
	assert.equal(keyOf('ui', 'constructor'), null);
	assert.equal(keyOf('nope', '1'), null);
});

test('item -> Item.csv -> fdid -> the cropped 64 px PNG, cached; misses cached too', async () => {
	const tmp = tmpdir('polestar-icons-');
	const f = fakes();
	const icons = openIcons({ sourcesDir: path.join(tmp, 'sources'), outDir: path.join(tmp, 'icons'), fetchImpl: f.fetchImpl, casc: f.casc });
	const png = await icons.icon('item', '750');
	const { w, h, rgba } = decodePng(png);
	assert.deepEqual([w, h], [64, 64]);
	// The red frame lies outside the inset: only green is left.
	for (let i = 0; i < rgba.length; i += 4) assert.deepEqual([rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]], [0, 200, 0, 255]);
	assert.deepEqual(png, encodePng(rgba, 64, 64));
	assert.ok(fs.existsSync(path.join(tmp, 'sources', 'wago', BUILD, 'Item.csv')));
	assert.ok(fs.existsSync(path.join(tmp, 'icons', 'item', '750.png')));
	// The ui hearthstone is item 6948's icon.
	assert.equal(decodePng(await icons.icon('ui', 'hearthstone')).w, 64);

	// No icon (fdid 0), no such item, a file not in the client: null, remembered on disk.
	assert.equal(await icons.icon('item', '2'), null);
	assert.equal(await icons.icon('item', '999'), null);
	assert.equal(await icons.icon('fdid', '424242'), null);
	for (const k of ['item/2', 'item/999', 'fdid/424242']) assert.ok(fs.existsSync(path.join(tmp, 'icons', `${k}.miss`)), k);
	assert.equal(await icons.icon('item', 'abc'), null);

	// A fresh service answers from the cache alone, even offline.
	const again = fakes();
	const cached = openIcons({ sourcesDir: path.join(tmp, 'sources'), outDir: path.join(tmp, 'icons'), fetchImpl: again.fetchImpl, casc: again.casc, offline: true });
	assert.deepEqual(await cached.icon('item', '750'), png);
	assert.equal(await cached.icon('item', '2'), null);
	assert.deepEqual(again.calls, []);
});

test('ui keys resolve client paths through the file search, kept in paths.json; UI textures keep their frame', async () => {
	const tmp = tmpdir('polestar-icons-');
	const f = fakes();
	const icons = openIcons({ sourcesDir: path.join(tmp, 'sources'), outDir: path.join(tmp, 'icons'), fetchImpl: f.fetchImpl, casc: f.casc });
	const { w, h, rgba } = decodePng(await icons.icon('ui', 'flightmaster'));
	assert.deepEqual([w, h], [16, 16]);
	assert.deepEqual([rgba[3], rgba[15 * 4 + 3]], [255, 0]);
	const paths = JSON.parse(fs.readFileSync(path.join(tmp, 'icons', 'paths.json'), 'utf8'));
	assert.equal(paths['interface/minimap/tracking/flightmaster.blp'], 136456);
	assert.equal(await icons.icon('ui', 'mailbox'), null);
	assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'icons', 'paths.json'), 'utf8'))['interface/minimap/tracking/mailbox.blp'], null);
	const searches = f.calls.filter((c) => typeof c === 'string' && c.includes('/api/files')).length;
	await icons.icon('ui', 'flightmaster');
	assert.equal(f.calls.filter((c) => typeof c === 'string' && c.includes('/api/files')).length, searches);
	assert.ok(icons.info().ui.includes('quest-available'));
	assert.deepEqual(icons.info().ui, Object.keys(UI));

	// Offline with nothing cached: null, and nothing remembered as a miss.
	const off = openIcons({ sourcesDir: path.join(tmp, 'none'), outDir: path.join(tmp, 'off'), offline: true, fetchImpl: async () => assert.fail('no network offline') });
	assert.equal(await off.icon('item', '750'), null);
	assert.equal(await off.icon('ui', 'innkeeper'), null);
	assert.equal(fs.existsSync(path.join(tmp, 'off', 'item', '750.miss')), false);
});

test('server: glyph, emblem, band, font, media and icon routes, with strict keys', async (t) => {
	const tmp = tmpdir('polestar-icons-');
	const dir = path.join(tmp, 'mini');
	fs.cpSync(MINI, dir, { recursive: true });
	const f = fakes();
	const icons = openIcons({ sourcesDir: path.join(tmp, 'sources'), outDir: path.join(tmp, 'icons'), fetchImpl: f.fetchImpl, casc: f.casc });
	const ws = new Workspace({ dataDir: DATA_DIR, official: false, packs: [dir], watch: false, lintDelay: 60000 });
	const server = await startServer({ port: 0, workspace: ws, icons });
	t.after(async () => {
		await server.close();
		ws.close();
	});
	const get = (p) => fetch(server.url + p);
	const image = async (p, size) => {
		const res = await get(p);
		assert.equal(res.status, 200, p);
		assert.equal(res.headers.get('content-type'), 'image/png', p);
		assert.equal(res.headers.get('cache-control'), 'max-age=604800', p);
		const img = decodePng(Buffer.from(await res.arrayBuffer()));
		if (size) assert.deepEqual([img.w, img.h], size, p);
		return img;
	};
	await image('glyph/play.png', [96, 96]);
	await image('glyph/icon-kill.png?px=128', [128, 128]);
	await image('glyph/route.png?px=2000', [256, 256]);
	await image('emblem.png?px=40', [40, 40]);
	await image('band.png', [1024, 128]);
	await image('band-stars.png', [1024, 128]);
	await image('media/Nav/arrow.png');
	await image('icon/item/750.png', [64, 64]);
	await image('icon/ui/flightmaster.png', [16, 16]);
	const font = await get('fonts/Inter-Regular.ttf');
	assert.equal(font.status, 200);
	assert.equal(font.headers.get('content-type'), 'font/ttf');

	for (const [p, status] of [
		['glyph/nope.png', 404],
		['glyph/../index.html.png', 404],
		['icon/bogus/1.png', 404],
		['icon/item/2.png', 404],
		['icon/item/abc.png', 400],
		['icon/item/..%2f..%2fpaths.json.png', 400],
		['icon/ui/%2e%2e.png', 400],
		['icon/race/Dwarf.png', 400],
		['fonts/Inter-OFL.txt', 404],
		['fonts/..%2f..%2fREADME.ttf', 404],
		['media/Nav/..%2fUI%2fcheck.png', 404],
		['media/Other/arrow.png', 404],
		['media/Nav/nope.png', 404],
	]) {
		const res = await get(p);
		assert.equal(res.status, status, p);
		assert.match(res.headers.get('content-type'), /^application\/json/, p);
	}

	const r = await fetch(`${server.url}api/cmd`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'planner_info' }) });
	const info = (await r.json()).result.icons;
	assert.ok(info.glyphs.includes('play') && info.glyphs.includes('icon-kill'));
	assert.deepEqual(info.ui, Object.keys(UI));
	assert.equal(info.available, true);
});
