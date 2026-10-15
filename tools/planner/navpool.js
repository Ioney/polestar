'use strict';
// The planner's terrain routes (docs/ARCHITECTURE.md, "Navigation grid"):
// walk legs routed on the navigation grid (tools/lib/nav/path.js)
// in a worker pool, cached by leg, and the grid's overlays for the page.
//
//   const routes = new NavRoutes({ dir: 'data/local/nav', workers, log });
//   routes.info()          -> { available, build, continents: [c] } (rechecks the files first)
//   routes.provider()      -> { routes(a, b, profile), misses: Map }
//     routes: the synchronous provider buildTimeline takes: a cached route,
//     else null (a miss, recorded in `misses`) or { ok: false } for a
//     continent the grid does not cover.
//   routes.compute(misses) -> job { progress: { id, pending, done }, promise }
//     the misses computed by the pool (legs already in flight are shared);
//     the promise resolves when every one has an answer.
//   routes.walkable(c, col, row) -> PNG Buffer (256 x 256) | null
//   routes.close()
//
// A leg's key: its ends quantised to 1 yd (`c:wx:wy`; z when known) and the
// profile's speeds; the route is computed between the quantised ends. The
// cache belongs to the nav build id (navBuild: a hash of index.json,
// lifts.json and the route code), kept in memory and appended to
// <dir>/routes-<build>.jsonl, so a restart is warm. A changed build (the
// grid rebuilt, the route code edited) drops the cache and restarts the
// workers. Errors (a tile being rewritten) are kept in memory only.
//
// Workers: one per CPU but one, at most one per 4 GiB of memory (each holds
// its own Nav and tile cache).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');
const { ROOT } = require('../lib/paths');
const { encodePng } = require('../lib/planner/art/png');

const NAV_LIB = path.join(ROOT, 'tools', 'lib', 'nav');
// The files a route depends on besides the data: their text is part of the build id.
const CODE = ['path.js', 'move.js', 'grid/search.js', 'grid/format.js', 'grid/graph.js'].map((f) => path.join(NAV_LIB, f));
const DATA_FILES = ['index.json', 'lifts.json'];
const BATCH = 6; // legs per worker message (consecutive legs share tiles)
const WORKER_TILES = 64;
const WALKABLE_CACHE = 256;
const GIB = 1024 ** 3;

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { openNav } = require(workerData.lib);
const nav = openNav({ dir: workerData.dir, cacheTiles: workerData.cacheTiles });
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
parentPort.on('message', (jobs) => {
	const out = [];
	for (const j of jobs) {
		try {
			const r = nav.route(j.a, j.b, j.profile);
			const byClass = {};
			for (const [k, v] of Object.entries(r.byClass || {})) if (v > 0) byClass[k] = r2(v);
			out.push({ k: j.k, r: r.ok
				? { ok: true, pts: Array.from(r.pts, r1), cls: Array.from(r.cls), yards: r1(r.yards), seconds: r2(r.seconds), byClass, falls: (r.falls || []).map((f) => ({ h: r1(f.h), damage: r2(f.damage) })) }
				: { ok: false, reason: r.reason || 'no path' } });
		} catch (err) {
			out.push({ k: j.k, error: String((err && err.message) || err) });
		}
	}
	parentPort.postMessage(out);
});
`;

// The nav build id of a data directory (null without index.json).
function navBuild(dir) {
	const h = crypto.createHash('sha1');
	try {
		h.update(fs.readFileSync(path.join(dir, 'index.json')));
	} catch {
		return null;
	}
	for (const f of [path.join(dir, 'lifts.json'), ...CODE]) {
		try {
			h.update(fs.readFileSync(f));
		} catch {
			h.update('-');
		}
	}
	return h.digest('hex').slice(0, 12);
}

// The speeds of a movement profile (tools/lib/nav/move.js) as a key.
function profileKey(p) {
	return [p.run, p.swim, p.outdoor, p.indoor, p.remount].map((v) => r3(v || 0)).join('/');
}

const q = (v) => Math.round(v);
const endKey = (e) => `${e.c}:${q(e.wx)}:${q(e.wy)}${e.z != null ? `:${q(e.z)}` : ''}`;
const quantised = (e) => (e.z != null ? { c: e.c, wx: q(e.wx), wy: q(e.wy), z: q(e.z) } : { c: e.c, wx: q(e.wx), wy: q(e.wy) });

// Walkable classes of a column (the Walkable layer), RGBA straight: the
// page's tokens (docs/DESIGN.md) for amber (warning), orange (achievement),
// cyan (spell) and violet (dungeon); none a dark red.
const TINT = {
	none: [0x8c, 0x1c, 0x1c, 0.35],
	steep: [0xfa, 0xbf, 0x4d, 0.35],
	climb: [0xff, 0xa3, 0x52, 0.45],
	swim: [0x78, 0xdb, 0xed, 0.3],
	indoor: [0xa3, 0x85, 0xff, 0.3],
};

class NavRoutes extends EventEmitter {
	// opts: { dir (default data/local/nav), workers, log }
	constructor({ dir = path.join(ROOT, 'data', 'local', 'nav'), workers = null, log = () => {} } = {}) {
		super();
		this.dir = path.resolve(dir);
		this.log = log;
		this.workerCount = workers || Math.max(1, Math.min(os.cpus().length - 1, Math.floor(os.totalmem() / (4 * GIB))));
		this.sig = null; // the files' mtimes when the build id was taken
		this.build = null;
		this.index = null;
		this.cache = new Map(); // key -> compact route
		this.errors = new Map(); // key -> { ok: false, reason } (this session only)
		this.inflight = new Map(); // key -> [job]
		this.jobs = new Map(); // key -> the leg in flight { k, a, b, profile }
		this.jobSeq = 0;
		this.workers = [];
		this.walkCache = new Map();
		this.closed = false;
		this.refresh();
	}

	// Rechecks the data and code files; a new build drops the cache.
	refresh() {
		const sig = [...DATA_FILES.map((f) => path.join(this.dir, f)), ...CODE].map((f) => {
			try {
				return fs.statSync(f).mtimeMs;
			} catch {
				return 0;
			}
		}).join(',');
		if (sig === this.sig) return;
		this.sig = sig;
		const build = navBuild(this.dir);
		if (build === this.build) return;
		this.reset(build);
	}

	reset(build) {
		if (this.build) this.log(`nav build ${build || 'gone'} (was ${this.build}): route cache dropped`);
		this.build = build;
		this.index = null;
		try {
			this.index = build ? JSON.parse(fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8')) : null;
		} catch {
			this.index = null;
		}
		this.cache = new Map();
		this.errors = new Map();
		this.walkCache = new Map();
		// Legs in flight are asked again of the new build's workers.
		this.stopWorkers();
		this.queue = [...this.inflight.keys()].map((k) => this.jobs.get(k)).filter(Boolean);
		if (!this.build) return;
		const file = this.file();
		let n = 0;
		try {
			for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
				if (!line) continue;
				try {
					const { k, r } = JSON.parse(line);
					this.cache.set(k, r);
					n++;
				} catch {
					// a torn last line
				}
			}
		} catch {
			n = 0;
		}
		if (n) this.log(`nav routes: ${n} cached legs from ${path.relative(ROOT, file)}`);
		this.pump();
	}

	file() {
		return path.join(this.dir, `routes-${this.build}.jsonl`);
	}

	get available() {
		return !!(this.index && this.index.continents && Object.keys(this.index.continents).length);
	}

	info() {
		this.refresh();
		return { available: this.available, build: this.available ? this.build : null, continents: this.available ? Object.keys(this.index.continents).map(Number) : [] };
	}

	// The synchronous provider of one timeline build, and the legs it missed.
	provider() {
		this.refresh();
		const misses = new Map();
		const covered = new Set(this.available ? Object.keys(this.index.continents).map(Number) : []);
		const routes = (a, b, profile) => {
			if (!covered.has(a.c) || a.c !== b.c) return { ok: false, reason: `no navigation grid for continent ${a.c}` };
			const k = `${endKey(a)}>${endKey(b)}|${profileKey(profile)}`;
			const hit = this.cache.get(k) || this.errors.get(k);
			if (hit) return hit;
			if (!misses.has(k)) misses.set(k, { k, a: quantised(a), b: quantised(b), profile });
			return null;
		};
		return { routes, misses };
	}

	// Computes the missed legs -> { progress: { id, pending, done }, promise }.
	compute(misses) {
		const job = { progress: { id: ++this.jobSeq, pending: 0, done: 0 }, left: 0, resolve: null };
		job.promise = new Promise((resolve) => (job.resolve = resolve));
		for (const m of misses.values()) {
			if (this.cache.has(m.k) || this.errors.has(m.k)) continue;
			job.left++;
			job.progress.pending++;
			if (this.inflight.has(m.k)) this.inflight.get(m.k).push(job);
			else {
				this.inflight.set(m.k, [job]);
				this.jobs.set(m.k, m);
				this.queue.push(m);
			}
		}
		if (!job.left) job.resolve();
		else this.pump();
		return job;
	}

	// The answer to leg k: stored (routes and certain failures) and its jobs told.
	answer(k, r, error) {
		const jobs = this.inflight.get(k);
		if (!jobs) return;
		this.inflight.delete(k);
		this.jobs.delete(k);
		if (error) this.errors.set(k, { ok: false, reason: `error: ${error}` });
		else {
			this.cache.set(k, r);
			try {
				fs.appendFileSync(this.file(), `${JSON.stringify({ k, r })}\n`);
			} catch (err) {
				this.log(`nav routes: cannot write ${this.file()}: ${err.message}`);
			}
		}
		for (const job of jobs) {
			job.left--;
			job.progress.pending--;
			job.progress.done++;
			if (!job.left) job.resolve();
		}
		this.emit('progress');
	}

	pump() {
		if (this.closed || !this.queue.length) return;
		if (!this.available) {
			for (const j of this.queue.splice(0)) this.answer(j.k, null, 'no navigation data');
			return;
		}
		while (this.workers.length < this.workerCount) this.spawn();
		for (const w of this.workers) if (!w.busy) this.feed(w);
	}

	spawn() {
		const worker = new Worker(WORKER, { eval: true, workerData: { lib: path.join(NAV_LIB, 'path.js'), dir: this.dir, cacheTiles: WORKER_TILES } });
		const w = { worker, busy: null };
		worker.unref();
		worker.on('message', (out) => {
			if (!this.workers.includes(w)) return; // terminated (a new build): its answers are stale
			w.busy = null;
			for (const { k, r, error } of out) this.answer(k, r, error);
			this.feed(w);
		});
		worker.on('error', (err) => {
			if (!this.workers.includes(w)) return;
			this.log(`nav worker failed: ${err.message || err}`);
			const lost = w.busy || [];
			w.busy = null;
			this.workers = this.workers.filter((x) => x !== w);
			for (const j of lost) this.answer(j.k, null, String(err.message || err));
			this.pump();
		});
		this.workers.push(w);
	}

	feed(w) {
		if (this.closed || w.busy || !this.queue.length) return;
		w.busy = this.queue.splice(0, BATCH);
		w.worker.postMessage(w.busy);
	}

	stopWorkers() {
		for (const w of this.workers) {
			if (w.busy) this.queue.unshift(...w.busy);
			w.worker.terminate();
		}
		this.workers = [];
	}

	// The Walkable layer of one ADT tile: per column, its outdoor ground (the
	// highest walkable surface not indoors) by slope (steep, climb), else a
	// swim surface, else indoor floors only, else nothing walkable (none);
	// plain walkable ground is transparent. null when the tile is not built.
	walkable(c, col, row) {
		this.refresh();
		const key = `${c}:${col}_${row}`;
		if (this.walkCache.has(key)) return this.walkCache.get(key);
		let png = null;
		try {
			const { decodeTile, FLAG, WALK_MAX, STEEP_MAX } = require('../lib/nav/grid/format');
			const t = decodeTile(fs.readFileSync(path.join(this.dir, 'tiles', String(c), `${col}_${row}.nav.gz`)));
			const px = new Uint8Array(256 * 256 * 4);
			const put = (k, tint) => {
				const o = k * 4;
				px[o] = tint[0];
				px[o + 1] = tint[1];
				px[o + 2] = tint[2];
				px[o + 3] = Math.round(tint[3] * 255);
			};
			for (let k = 0; k < 65536; k++) {
				let ground = -1;
				let swim = false;
				let indoor = false;
				for (let e = t.first[k]; e < t.first[k + 1]; e++) {
					const f = t.flags[e];
					if (f & FLAG.BLOCKED) continue;
					if (f & FLAG.SWIM) swim = true;
					else if (f & FLAG.INDOOR) indoor = true;
					else ground = e;
				}
				// Column k = j * 256 + i: i eastward, j southward, as the image's x and y.
				if (ground >= 0) {
					const s = t.slope[ground];
					if (s > STEEP_MAX) put(k, TINT.climb);
					else if (s > WALK_MAX || t.flags[ground] & FLAG.STEEP) put(k, TINT.steep);
				} else if (swim) put(k, TINT.swim);
				else if (indoor) put(k, TINT.indoor);
				else put(k, TINT.none);
			}
			png = encodePng(px, 256, 256);
		} catch (err) {
			if (err.code !== 'ENOENT') this.log(`walkable ${key}: ${err.message || err}`);
			png = null;
		}
		this.walkCache.set(key, png);
		while (this.walkCache.size > WALKABLE_CACHE) this.walkCache.delete(this.walkCache.keys().next().value);
		return png;
	}

	close() {
		this.closed = true;
		this.stopWorkers();
		this.queue = [];
		for (const [k] of [...this.inflight]) this.answer(k, null, 'closed');
	}
}

module.exports = { NavRoutes, navBuild, profileKey };
