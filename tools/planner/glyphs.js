'use strict';
// The planner's glyphs: the addon's own family (tools/media/ui.js GLYPHS) plus
// the page's controls, drawn by the same rules: a 24-unit grid, stroke 2.25,
// filled silhouettes and round-capped strokes, signed distance shapes in
// SIZE (32) px space. Rendered for the browser at any size by sampling the
// shape at scaled coordinates, white on transparent (straight alpha), so the
// page tints them with CSS masks.
//
//   renderGlyph(name, px) -> PNG Buffer (px x px), or null for no such glyph
//   renderEmblem(px)      -> PNG of the Polestar emblem (px x px)
//   renderBand()          -> { band, stars }: the night-sky header layers, 1024x128 PNGs
//
// Added here: play, pause, step-back, step-forward, edit, minus, eye,
// eye-off, route, map, fit, undo, redo (their own hooked arrows: ui.js's
// reset and reload are full circles, which read as reload, not as one step
// back), list, character, clock, warning, download, export, pin-add,
// filter, swap, lift.
//
//   mediaPng(group, name) -> PNG of the addon's committed texture
//                            addon/Polestar/Media/<UI|Nav>/<name>.tga, or null

const fs = require('node:fs');
const path = require('node:path');
const { sdf } = require('../lib/tga');
const ui = require('../media/ui');
const { encodePng } = require('../lib/planner/art/png');

const { SIZE } = ui;
const K = SIZE / 24;
const STROKE = 2.25;
const PX_MIN = 24, PX_MAX = 256, PX_DEFAULT = 96;

// The ui.js helpers (grid units -> pixels).
const g = (v) => v * K;
const line = (ax, ay, bx, by, w = STROKE) => sdf.segment(g(ax), g(ay), g(bx), g(by), g(w) / 2);
const poly = (pts) => sdf.polygon(pts.map(([x, y]) => [g(x), g(y)]));
const dot = (cx, cy, r) => sdf.circle(g(cx), g(cy), g(r));
const ring = (cx, cy, r, w = STROKE) => sdf.ring(g(cx), g(cy), g(r), g(w));
const box = (cx, cy, hw, hh, r = 0) => sdf.box(g(cx), g(cy), g(hw), g(hh), g(r));
const polyline = (pts, w = STROKE) => sdf.union(...pts.slice(1).map((p, i) => line(pts[i][0], pts[i][1], p[0], p[1], w)));
const { union, subtract, intersect } = sdf;

// An arc with round caps, degrees in screen space (0 right, 90 down), a0 -> a1 increasing.
function arc(cx, cy, r, a0, a1, w = STROKE) {
	const [px, py, pr, half] = [g(cx), g(cy), g(r), g(w) / 2];
	const t0 = (a0 * Math.PI) / 180, t1 = (a1 * Math.PI) / 180;
	const e0 = [px + pr * Math.cos(t0), py + pr * Math.sin(t0)];
	const e1 = [px + pr * Math.cos(t1), py + pr * Math.sin(t1)];
	return (x, y) => {
		let a = Math.atan2(y - py, x - px);
		while (a < t0) a += Math.PI * 2;
		if (a <= t1) return Math.abs(Math.hypot(x - px, y - py) - pr) - half;
		return Math.min(Math.hypot(x - e0[0], y - e0[1]), Math.hypot(x - e1[0], y - e1[1])) - half;
	};
}

// Rotate about a grid point (degrees, screen space: positive turns clockwise).
function rotate(shape, deg, cx = 12, cy = 12) {
	const t = (-deg * Math.PI) / 180;
	const c = Math.cos(t), s = Math.sin(t);
	const [ox, oy] = [g(cx), g(cy)];
	return (x, y) => {
		const dx = x - ox, dy = y - oy;
		return shape(ox + dx * c - dy * s, oy + dx * s + dy * c);
	};
}

const mirror = (shape) => (x, y) => shape(SIZE - x, y);
const move = (shape, dx, dy) => (x, y) => shape(x - g(dx), y - g(dy));
// The outline of a filled shape, centred on its edge.
const outline = (shape, w = STROKE) => (x, y) => Math.abs(shape(x, y)) - g(w) / 2;
// An eye: a lens (two circles' overlap, 19 x 11 units) outlined, a full pupil.
const lens = intersect(dot(12, 12 + 5.4545, 10.9545), dot(12, 12 - 5.4545, 10.9545));
const eye = union(outline(lens), dot(12, 12, 3));
// A hooked arrow: head pointing left at the top, the shaft curling down and back.
const undo = union(poly([[2.8, 7.6], [8.6, 3], [8.6, 12.2]]), line(8, 7.6, 13.4, 7.6), arc(13.4, 13.4, 5.8, -90, 90), line(13.4, 19.2, 7.4, 19.2));
// A pin (ui.js icon-goto, moved down-left) with a plus clear of it at the top right.
const pin = move(ui.GLYPHS['icon-goto'], -2.4, 1.2);
const plus = union(line(18.6, 1.8, 18.6, 9.4, 2.4), line(14.8, 5.6, 22.4, 5.6, 2.4));
// An arrow down into a tray; export is the same arrow leaving it.
const tray = polyline([[4, 14.8], [4, 20.2], [20, 20.2], [20, 14.8]]);
const arrowDown = union(line(12, 3.2, 12, 14.6), polyline([[7.4, 10.2], [12, 14.8], [16.6, 10.2]]));
const arrowUp = union(line(12, 4, 12, 15.4), polyline([[7.4, 8.4], [12, 3.8], [16.6, 8.4]]));

const PLANNER = {
	play: poly([[7, 4], [19.6, 12], [7, 20]]),
	pause: union(box(8, 12, 2.4, 7.6, 0.8), box(16, 12, 2.4, 7.6, 0.8)),
	'step-back': union(line(5.6, 6, 5.6, 18, 2.6), poly([[19.4, 5.4], [8.6, 12], [19.4, 18.6]])),
	'step-forward': union(line(18.4, 6, 18.4, 18, 2.6), poly([[4.6, 5.4], [15.4, 12], [4.6, 18.6]])),
	// A pencil, point down-left: the body, a ferrule band cut out, the tip.
	edit: rotate(
		union(
			subtract(box(12, 9, 3.2, 7.6, 0.6), line(8, 4.6, 16, 4.6, 1.2)),
			poly([[8.8, 17.6], [15.2, 17.6], [12, 22.6]]),
		),
		45,
	),
	minus: line(5, 12, 19, 12, 2.4),
	eye,
	'eye-off': union(subtract(eye, line(3.6, 3.6, 20.4, 20.4, 5.4)), line(4.4, 4.4, 19.6, 19.6)),
	// A route: from a hollow start, three dashes along a quarter circle to a filled end.
	route: union(
		ring(5, 19, 2.4, 1.8),
		dot(19, 5, 2.8),
		...[-153, -135, -117].map((a) => arc(19, 19, 14, a - 2.5, a + 2.5, 2)),
	),
	// A folded map: three panels, the folds cut through.
	map: subtract(poly([[3, 6], [9, 3.6], [15, 6], [21, 3.6], [21, 18], [15, 20.4], [9, 18], [3, 20.4]]), union(line(9, 3.6, 9, 18, 1.2), line(15, 6, 15, 20.4, 1.2))),
	fit: union(
		polyline([[4, 9.5], [4, 4], [9.5, 4]]), polyline([[14.5, 4], [20, 4], [20, 9.5]]),
		polyline([[20, 14.5], [20, 20], [14.5, 20]]), polyline([[9.5, 20], [4, 20], [4, 14.5]]),
	),
	undo,
	redo: mirror(undo),
	list: union(
		dot(5, 6.5, 1.7), dot(5, 12, 1.7), dot(5, 17.5, 1.7),
		line(9.5, 6.5, 20, 6.5), line(9.5, 12, 20, 12), line(9.5, 17.5, 20, 17.5),
	),
	// A bust: the head, the shoulders as a dome, a gap between them.
	character: union(dot(12, 7.6, 4.4), subtract(intersect(dot(12, 23.4, 9.8), box(12, 18, 10, 4.4)), dot(12, 7.6, 6.2))),
	clock: union(ring(12, 12, 9), polyline([[12, 6.8], [12, 12], [15.6, 14.4]])),
	warning: subtract(sdf.offset(poly([[12, 4.6], [20.4, 19], [3.6, 19]]), g(1.4)), union(line(12, 9.6, 12, 13.8, 2.4), dot(12, 16.8, 1.4))),
	download: union(arrowDown, tray),
	export: union(arrowUp, tray),
	'pin-add': union(subtract(pin, sdf.offset(plus, g(1.6))), plus),
	filter: poly([[3, 4.4], [21, 4.4], [14, 12.6], [14, 19], [10, 21.2], [10, 12.6]]),
	swap: union(
		line(4, 8, 17, 8), poly([[20.8, 8], [15.4, 3.6], [15.4, 12.4]]),
		line(7, 16, 20, 16), poly([[3.2, 16], [8.6, 11.6], [8.6, 20.4]]),
	),
	// A lift: the car as a rounded outline, an up and a down arrowhead inside.
	lift: union(
		subtract(box(12, 12, 7.4, 9.2, 1.6), box(12, 12, 5.15, 6.95, 0.6)),
		poly([[12, 6.6], [15.4, 10.6], [8.6, 10.6]]),
		poly([[12, 17.4], [15.4, 13.4], [8.6, 13.4]]),
	),
};

const GLYPHS = { ...ui.GLYPHS, ...PLANNER };
const NAMES = Object.keys(GLYPHS);

// px from a query: an integer in PX_MIN..PX_MAX, PX_DEFAULT when absent or not a number.
function clampPx(px) {
	const n = Math.round(Number(px));
	if (px === undefined || px === null || px === '' || !Number.isFinite(n)) return PX_DEFAULT;
	return Math.max(PX_MIN, Math.min(PX_MAX, n));
}

// shape (in an n0-px space) sampled at n px -> straight-alpha white RGBA.
function rasterize(shape, n, n0 = SIZE) {
	const s = n0 / n;
	const out = new Uint8Array(n * n * 4);
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			const d = shape((x + 0.5) * s, (y + 0.5) * s) / s;
			const cov = Math.max(0, Math.min(1, 0.5 - d));
			const i = (y * n + x) * 4;
			out[i] = out[i + 1] = out[i + 2] = 255;
			out[i + 3] = Math.round(cov * 255);
		}
	}
	return out;
}

const cache = new Map(); // `${name}@${px}` -> PNG
const CACHE_MAX = 1024;
function remember(key, make) {
	let png = cache.get(key);
	if (!png) {
		png = make();
		if (cache.size >= CACHE_MAX) cache.clear();
		cache.set(key, png);
	}
	return png;
}

function renderGlyph(name, px = PX_DEFAULT) {
	if (!Object.hasOwn(GLYPHS, name)) return null;
	const n = clampPx(px);
	return remember(`${name}@${n}`, () => encodePng(rasterize(GLYPHS[name], n), n, n));
}

function renderEmblem(px = PX_DEFAULT) {
	const n = clampPx(px);
	return remember(`emblem@${n}`, () => encodePng(rasterize(ui.emblemShape(n), n, n), n, n));
}

// A tga.js Canvas (float straight RGBA) -> PNG.
function canvasPng(c) {
	const q = new Uint8Array(c.px.length);
	for (let i = 0; i < q.length; i++) q[i] = Math.max(0, Math.min(255, Math.round(c.px[i] * 255)));
	return encodePng(q, c.width, c.height);
}

let bandPngs = null;
function renderBand() {
	if (!bandPngs) bandPngs = { band: canvasPng(ui.band()), stars: canvasPng(ui.bandStars()) };
	return bandPngs;
}

// An uncompressed true-colour TGA (24 or 32 bit; top-left origin when the
// descriptor's bit 5 is set, else bottom-left) -> straight RGBA, or null.
function decodeTga(buf) {
	if (buf.length < 18 || buf[2] !== 2 || (buf[16] !== 24 && buf[16] !== 32)) return null;
	const w = buf.readUInt16LE(12), h = buf.readUInt16LE(14), bpp = buf[16] / 8, top = (buf[17] & 0x20) !== 0;
	const start = 18 + buf[0] + (buf[1] ? buf.readUInt16LE(5) * Math.ceil(buf[7] / 8) : 0);
	if (!w || !h || buf.length < start + w * h * bpp) return null;
	const out = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++) {
		const row = top ? y : h - 1 - y;
		for (let x = 0; x < w; x++) {
			const i = start + (row * w + x) * bpp, o = (y * w + x) * 4;
			out[o] = buf[i + 2];
			out[o + 1] = buf[i + 1];
			out[o + 2] = buf[i];
			out[o + 3] = bpp === 4 ? buf[i + 3] : 255;
		}
	}
	return { width: w, height: h, rgba: out };
}

const MEDIA = path.join(__dirname, '..', '..', 'addon', 'Polestar', 'Media');
const MEDIA_GROUPS = new Set(['UI', 'Nav']);
const media = new Map(); // `${group}/${name}` -> PNG | null
function mediaPng(group, name) {
	if (!MEDIA_GROUPS.has(group) || !/^[a-z0-9-]+$/.test(String(name))) return null;
	const id = `${group}/${name}`;
	if (!media.has(id)) {
		let png = null;
		try {
			const img = decodeTga(fs.readFileSync(path.join(MEDIA, group, `${name}.tga`)));
			if (img) png = encodePng(img.rgba, img.width, img.height);
		} catch {
			png = null;
		}
		media.set(id, png);
	}
	return media.get(id);
}

module.exports = { GLYPHS, NAMES, PLANNER_GLYPHS: Object.keys(PLANNER), renderGlyph, renderEmblem, renderBand, mediaPng, decodeTga, clampPx, PX_MIN, PX_MAX, PX_DEFAULT };
