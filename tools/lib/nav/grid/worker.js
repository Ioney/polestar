'use strict';
// The navigation build's per-tile work (build.js), run in a worker thread or
// inline:
//
//   { op: 'surfaces', dir, c, col, row, root, obj0, casc, geom? }
//       client geometry (geom: given triangles, else tileGeometry through a
//       Casc opened from `casc` { sourcesDir, product, build, offline })
//       -> rasterise -> surfaces -> <dir>/<col>_<row>.surf.gz (no links)
//       and its walls -> <dir>/<col>_<row>.walls.gz
//       answers { tris, entries, walkable, swim, dropped, geom: tileGeometry stats }
//   { op: 'links', dir, c, col, row }
//       the tile and its 8 neighbours' surfaces and walls -> links, falls,
//       components -> <dir>/<col>_<row>.nav.gz; answers { entries, walkable, falls, comps }
//   { op: 'graph', dir, c, col, row, rides }
//       the linked tile and its neighbours -> its part of the abstract graph
//       -> <dir>/<col>_<row>.hpa.gz; answers { nodes }
//
// Files are written through a temporary name, so a present file is whole.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { isMainThread, parentPort } = require('node:worker_threads');
const { encodeTile, decodeTile, encodeWalls, decodeWalls, tileKey, FLAG } = require('./format');
const { rasterise } = require('./rasterise');
const { buildSurfaces } = require('./surfaces');
const { linkTile } = require('./links');
const { localComponents } = require('./regions');
const { tileGraph } = require('./graph');

const GEOM_CACHE_MAX = 1500; // parsed WMO/M2 models kept per worker
const TILE_CACHE_MAX = 36; // surfaces and walls files

let cascPromise = null;
let cascKey = null;
const geomCache = new Map();
const tiles = new Map(); // file -> { mtime, size, tile } (surfaces and walls files)

function writeAtomic(file, data) {
	const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}

function getCasc(opts) {
	const key = JSON.stringify(opts);
	if (cascKey !== key) {
		const { openCasc } = require('../../planner/art/casc');
		cascPromise = openCasc(opts);
		cascKey = key;
	}
	return cascPromise;
}

// A tile's surfaces: the linked file if present, else the surfaces-only one; null if neither.
function readTile(dir, col, row, { linked = false } = {}) {
	for (const ext of linked ? ['nav'] : ['nav', 'surf']) {
		const tile = readCached(path.join(dir, `${tileKey(col, row)}.${ext}.gz`), decodeTile);
		if (tile) return tile;
	}
	return null;
}

function readCached(file, decode) {
	let st;
	try {
		st = fs.statSync(file);
	} catch {
		return null;
	}
	const hit = tiles.get(file);
	if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) {
		tiles.delete(file);
		tiles.set(file, hit);
		return hit.tile;
	}
	const tile = decode(fs.readFileSync(file));
	tiles.set(file, { mtime: st.mtimeMs, size: st.size, tile });
	while (tiles.size > TILE_CACHE_MAX) tiles.delete(tiles.keys().next().value);
	return tile;
}

function around(dir, col, row, opts) {
	const out = [];
	for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) out.push(readTile(dir, col + dc, row + dr, opts));
	return out;
}

// The 3 x 3 tiles' surfaces with their walls (null where a tile has none).
function aroundWithWalls(dir, col, row) {
	return around(dir, col, row).map((t, x) => {
		if (!t) return null;
		const walls = readCached(path.join(dir, `${tileKey(col + (x % 3) - 1, row + Math.floor(x / 3) - 1)}.walls.gz`), decodeWalls);
		return { ...t, walls };
	});
}

async function geometryOf(job) {
	if (job.geom) return job.geom;
	const { tileGeometry } = require('../geom');
	const casc = await getCasc(job.casc);
	if (geomCache.size > GEOM_CACHE_MAX) geomCache.clear();
	return tileGeometry(casc, { c: job.c, col: job.col, row: job.row, root: job.root, obj0: job.obj0 }, { cache: geomCache });
}

async function runJob(job) {
	fs.mkdirSync(job.dir, { recursive: true });
	const base = path.join(job.dir, tileKey(job.col, job.row));
	if (job.op === 'surfaces') {
		const geom = await geometryOf(job);
		const hf = rasterise(geom, job);
		const { tile, stats } = buildSurfaces(hf, { ...geom, c: job.c, col: job.col, row: job.row });
		writeAtomic(`${base}.walls.gz`, encodeWalls(tile.walls));
		writeAtomic(`${base}.surf.gz`, encodeTile(tile));
		// The tile's links and graph part are stale now (the links pass redoes them).
		fs.rmSync(`${base}.nav.gz`, { force: true });
		fs.rmSync(`${base}.hpa.gz`, { force: true });
		return { tris: geom.kind.length, ...stats, geom: geom.stats || null };
	}
	if (job.op === 'links') {
		const ar = aroundWithWalls(job.dir, job.col, job.row);
		if (!ar[4]) throw new Error(`nav ${job.c} ${tileKey(job.col, job.row)}: no surfaces to link`);
		const t = ar[4];
		Object.assign(t, linkTile(ar));
		delete t.walls;
		Object.assign(t, localComponents(t));
		writeAtomic(`${base}.nav.gz`, encodeTile(t));
		let walkable = 0;
		for (let e = 0; e < t.n; e++) if (!(t.flags[e] & FLAG.BLOCKED)) walkable++;
		return { entries: t.n, walkable, falls: t.fallFrom.length, comps: t.nComp };
	}
	if (job.op === 'graph') {
		const ar = around(job.dir, job.col, job.row, { linked: true });
		if (!ar[4]) throw new Error(`nav ${job.c} ${tileKey(job.col, job.row)}: not linked`);
		// Lift rides from this tile (build.js): edges of its Space, ends as nodes.
		const rides = job.rides || [];
		ar[4].lifts = rides.length ? new Map() : null;
		for (const r of rides) {
			if (!ar[4].lifts.has(r.from)) ar[4].lifts.set(r.from, []);
			ar[4].lifts.get(r.from).push({ col: r.to.col, row: r.to.row, k: r.to.k, entry: r.to.entry, h: r.h });
		}
		const part = tileGraph(ar, rides.map((r) => r.from));
		writeAtomic(`${base}.hpa.gz`, zlib.gzipSync(JSON.stringify(part)));
		return { nodes: part.nodes.length };
	}
	throw new Error(`nav worker: unknown op ${job.op}`);
}

if (!isMainThread && parentPort) {
	parentPort.on('message', ({ job }) => {
		runJob(job).then(
			(out) => parentPort.postMessage({ out }),
			(err) => parentPort.postMessage({ error: err && err.stack ? err.stack : String(err) }),
		);
	});
}

module.exports = { runJob };
