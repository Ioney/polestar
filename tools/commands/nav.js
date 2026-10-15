'use strict';
// `node tools/polestar.js nav`: terrain navigation from the Forever client's
// own geometry (docs/ARCHITECTURE.md, "Navigation grid").
// `nav build` builds the grid under data/local/nav (tools/lib/nav/grid);
// `nav path` routes between two map points on it (tools/lib/nav/path.js);
// `nav aids` generates the arrow's crossings, open borders and approach
// chains from it and measures them (tools/lib/nav/aids.js, arrow.js).

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('../lib/cli');
const { ROOT, DATA, SOURCES } = require('../lib/paths');

const DEFAULT_DIR = path.join(ROOT, 'data', 'local', 'nav');

const usage = `usage: node tools/polestar.js nav build [--continents 0,1] [--force] [--offline] [--workers N] [--out <dir>] [--product <p>]
       node tools/polestar.js nav path <map> <x>,<y> <map> <x>,<y> [--class C] [--level N] [--frame era|forever] [--json] [--dir <dir>]
       node tools/polestar.js nav aids [--out <file>] [--lua <file>] [--report] [--continents 0,1] [--workers N] [--reference <file>] [--dir <dir>]

build   the navigation grid of every continent map-frames.json names (or
        --continents): client geometry per ADT tile through the CASC cache
        (data/sources/casc), walkable surfaces, links, regions and the
        abstract graph, in worker threads, written to data/local/nav (--out).
        A tile already built is kept unless --force; --offline only reads
        cached client files.
path    a route between two map points: <map> a uiMapID, <x>,<y> percent on
        it (the Era frame unless --frame forever). Prints yards, seconds by
        class, falls and the simplified points (map percent of the first
        map); --json prints the whole result. --class (e.g. Druid) and --level
        (default 10) choose the movement profile.
aids    the arrow's aids from the grid (tools/lib/nav/aids.js): zone
        crossings, open borders and approach chains in the crossings schema,
        validated, written to data/local/nav/aids.json (--out). --lua writes
        them as a Crossings.lua for a local test (never into
        addon/Polestar_Travel); to build a test copy of the data addon:
        node tools/polestar.js travel build --offline --crossings data/local/nav/aids.json --travel-addon <test folder> --json <test folder>/travel.json --lua <test folder>/TravelData.lua
        Pockets are tested in --workers threads (default: up to 6).
        --report also plans every consecutive pair of located goals in our
        guides with the addon's planner without and with the aids and writes
        aids-report.json and aids-report.md next to --out, comparing with the
        reference crossings file (--reference, default
        data/local/crossings.json; read only).`;

const usageError = (msg) => Object.assign(new Error(msg), { exit: 2 });

async function build(argv) {
	const { opts: o, positional, error } = parseArgs(argv, { flags: ['--force', '--offline'], options: ['--continents', '--workers', '--out', '--product'] });
	if (error || positional.length) throw usageError(error || `unexpected argument "${positional[0]}"`);
	let continents = null;
	if (o.continents !== undefined) {
		continents = String(o.continents).split(',').map((s) => Number(s.trim()));
		if (continents.some((c) => !Number.isInteger(c) || c < 0)) throw usageError('--continents needs map ids, e.g. 0,1');
	}
	const { buildNav, defaultWorkers } = require('../lib/nav/grid/build');
	const workers = o.workers === undefined ? defaultWorkers() : Number(o.workers);
	if (!Number.isInteger(workers) || workers < 0) throw usageError('--workers needs a number (0: no threads)');
	const outDir = o.out ? path.resolve(o.out) : DEFAULT_DIR;
	const t0 = Date.now();
	const r = await buildNav({
		outDir, sourcesDir: SOURCES, dataDir: DATA, product: o.product || 'wow_classic_beta', continents,
		force: !!o.force, offline: !!o.offline, workers, log: (m) => console.error(m),
	});
	for (const w of r.warnings) console.error(`warning: ${w}`);
	let tiles = 0;
	let surfaces = 0;
	for (const c of Object.values(r.index.continents)) {
		tiles += c.tiles.length;
		surfaces += c.surfaces;
	}
	console.log(`nav ${r.build}: ${Object.keys(r.index.continents).length} continents, ${tiles} tiles, ${surfaces} walkable surfaces in ${path.relative(process.cwd(), outDir) || '.'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
	return 0;
}

function readJson(file) {
	if (!fs.existsSync(file)) throw Object.assign(new Error(`${file} not found (node tools/polestar.js data build)`), { exit: 1 });
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function point(mapArg, xyArg) {
	const map = Number(mapArg);
	const m = /^\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/.exec(String(xyArg || ''));
	if (!Number.isInteger(map) || !m) throw usageError(`expected <map> <x>,<y>, got "${mapArg} ${xyArg || ''}"`);
	return { map, x: Number(m[1]), y: Number(m[2]) };
}

const fmt = (s) => (s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${s.toFixed(1)} s`);

async function route(argv) {
	const { opts: o, positional, error } = parseArgs(argv, { flags: ['--json'], options: ['--class', '--level', '--frame', '--dir'] });
	if (error) throw usageError(error);
	if (positional.length !== 4) throw usageError('nav path needs <map> <x>,<y> <map> <x>,<y>');
	const level = o.level === undefined ? 10 : Number(o.level);
	if (!Number.isInteger(level) || level < 1) throw usageError('--level needs a level');
	const frame = o.frame === undefined || o.frame === 'era' ? 'e' : o.frame === 'forever' ? 'l' : null;
	if (!frame) throw usageError('--frame is era or forever');
	const a = point(positional[0], positional[1]);
	const b = point(positional[2], positional[3]);
	const { Geo } = require('../lib/planner/geo');
	const geo = new Geo(readJson(path.join(DATA, 'map-frames.json')), readJson(path.join(DATA, 'zones.json')));
	const wa = geo.toWorld(a.map, a.x, a.y, frame);
	const wb = geo.toWorld(b.map, b.x, b.y, frame);
	if (!wa) throw usageError(`map ${a.map} has no frame in map-frames.json`);
	if (!wb) throw usageError(`map ${b.map} has no frame in map-frames.json`);
	const { openNav } = require('../lib/nav/path');
	const { profileFor } = require('../lib/nav/move');
	const nav = openNav({ dir: o.dir ? path.resolve(o.dir) : DEFAULT_DIR });
	if (!nav.available) throw Object.assign(new Error('no navigation grid: run `node tools/polestar.js nav build`'), { exit: 1 });
	const profile = profileFor({ cls: o.class || null, level });
	const t0 = process.hrtime.bigint();
	const r = nav.route(wa, wb, profile);
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	const pts = [];
	for (let i = 0; i < r.pts.length; i += 3) {
		const m = geo.toMap(a.map, wa.c, r.pts[i], r.pts[i + 1], frame);
		pts.push({ wx: r.pts[i], wy: r.pts[i + 1], z: r.pts[i + 2], x: m ? m.x : null, y: m ? m.y : null });
	}
	if (o.json) {
		console.log(JSON.stringify({ ...r, pts, cls: [...r.cls], profile, ms }, null, '\t'));
		return r.ok ? 0 : 1;
	}
	if (!r.ok) {
		console.log(`no route: ${r.reason}`);
		return 1;
	}
	const by = Object.entries(r.byClass).filter(([, s]) => s > 0).map(([k, s]) => `${k} ${fmt(s)}`).join(', ');
	console.log(`${Math.round(r.yards)} yd, ${fmt(r.seconds)} (${profile.name}, ${profile.mode} ${profile.outdoor.toFixed(1)} yd/s): ${by}`);
	if (r.falls.length) console.log(`falls: ${r.falls.map((f) => `${f.h.toFixed(1)} yd${f.damage ? ` (${Math.round(f.damage * 100)}% health)` : ''}`).join(', ')}`);
	console.log(`${pts.length} points (map ${a.map}), ${r.cells} cells, ${r.tiles} tiles, ${ms.toFixed(0)} ms:`);
	const { CLS_NAMES } = require('../lib/nav/grid/format');
	pts.forEach((q, i) => {
		const where = q.x === null ? `${q.wx.toFixed(1)} ${q.wy.toFixed(1)}` : `${q.x.toFixed(2)},${q.y.toFixed(2)}`;
		console.log(`  ${where} z ${q.z.toFixed(1)}${i < r.cls.length ? `  -> ${CLS_NAMES[r.cls[i]]}` : ''}`);
	});
	return 0;
}

// The aids as a Crossings.lua (Polestar_Travel's format) for a local test.
function aidsLua(set, frames, build) {
	const { crossingsLua } = require('../lib/travel/crossings');
	const { header } = require('../lib/generated');
	return [
		header('lua', 'nav aids --lua <file>', `the navigation grid (data/local/nav, client build ${build})`),
		`-- ${set.crossings.length} crossing(s), ${set.open.length} open-ground pair(s), ${set.chains.length} approach chain(s). Local test only: never committed or packaged.`,
		'',
		'local N = Polestar and Polestar.Nav',
		'if not (N and N.RegisterCrossings) then return end',
		'',
		...crossingsLua(set, frames, { complete: true }),
		'',
	].join('\n');
}

async function aids(argv) {
	const { opts: o, positional, error } = parseArgs(argv, { flags: ['--report'], options: ['--out', '--lua', '--continents', '--workers', '--reference', '--dir'] });
	if (error || positional.length) throw usageError(error || `unexpected argument "${positional[0]}"`);
	const workers = o.workers === undefined ? Math.max(0, Math.min(6, require('node:os').availableParallelism() - 2)) : Number(o.workers);
	if (!Number.isInteger(workers) || workers < 0) throw usageError('--workers needs a number (0: no threads)');
	let continents = null;
	if (o.continents !== undefined) {
		continents = String(o.continents).split(',').map((s) => Number(s.trim()));
		if (continents.some((c) => !Number.isInteger(c) || c < 0)) throw usageError('--continents needs map ids, e.g. 0,1');
	}
	const { TRAVEL_ADDON, readCrossingsFile } = require('../lib/travel/crossings');
	const travelAddon = path.join(ROOT, 'addon', TRAVEL_ADDON);
	const luaOut = o.lua ? path.resolve(o.lua) : null;
	if (luaOut && (luaOut === travelAddon || luaOut.startsWith(travelAddon + path.sep))) throw usageError(`--lua must not write into ${path.relative(ROOT, travelAddon)} (the owner's local data addon)`);
	const out = path.resolve(o.out || path.join(DEFAULT_DIR, 'aids.json'));
	const t0 = Date.now();
	const log = (m) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0)} s] ${m}`);
	const { openNav } = require('../lib/nav/path');
	const nav = openNav({ dir: o.dir ? path.resolve(o.dir) : DEFAULT_DIR, cacheTiles: 160 });
	if (!nav.available) throw Object.assign(new Error('no navigation grid: run `node tools/polestar.js nav build`'), { exit: 1 });
	const { Frames } = require('../lib/travel/geo');
	const { Geo } = require('../lib/planner/geo');
	const mapFrames = readJson(path.join(DATA, 'map-frames.json'));
	const zonesJson = readJson(path.join(DATA, 'zones.json'));
	const frames = new Frames(mapFrames.era, zonesJson);
	const geo = new Geo(mapFrames, zonesJson);
	const { generateAids, loadZoneResolver, collectTargets } = require('../lib/nav/aids');
	const zoneOfArea = loadZoneResolver({ dataDir: DATA, sourcesDir: SOURCES, build: nav.index.build, frames });
	const { compileProject } = require('../lib/dsl/project');
	const compiled = compileProject({ packDir: path.join(ROOT, 'guides'), dataDir: DATA });
	log(`${compiled.guides.length} guides compiled; areas from ${zoneOfArea.areaTable}`);
	const data = {
		quests: readJson(path.join(DATA, 'quests.json')),
		npcs: readJson(path.join(DATA, 'npcs.json')),
		objects: readJson(path.join(DATA, 'objects.json')),
		trainers: readJson(path.join(DATA, 'trainers.json')),
	};
	const travel = readJson(path.join(DATA, 'travel.json'));
	const entrances = readJson(path.join(ROOT, 'tools', 'lib', 'codex', 'entrances.json'));
	const list = continents || Object.keys(nav.index.continents).map(Number);
	const targets = collectTargets({ guides: compiled.guides, data, geo, travel, entrances, continents: list });
	log(`${targets.length} targets`);
	const { doc, stats, set } = await generateAids({ nav, frames, zoneOfArea, targets, continents: list, log, workers });
	if (stats.errors.length) throw Object.assign(new Error(`the generated aids fail validation: ${stats.errors.length} error(s)\n  ${stats.errors.join('\n  ')}`), { exit: 1 });
	fs.mkdirSync(path.dirname(out), { recursive: true });
	fs.writeFileSync(out, `${JSON.stringify(doc, null, '\t')}\n`);
	const genSeconds = (Date.now() - t0) / 1000;
	console.log(`nav aids ${nav.index.build}: ${doc.open.length} open pairs, ${doc.crossings.length} crossings, ${doc.chains.length} chains -> ${path.relative(process.cwd(), out)} (${genSeconds.toFixed(0)} s)`);
	const lua = aidsLua(set, frames, nav.index.build);
	if (luaOut) {
		fs.mkdirSync(path.dirname(luaOut), { recursive: true });
		fs.writeFileSync(luaOut, lua);
		console.log(`wrote ${path.relative(process.cwd(), luaOut)} (local test only)`);
	}
	if (!o.report) return 0;
	const os = require('node:os');
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polestar-aids-'));
	try {
		const crossingsLuaFile = luaOut || path.join(tmp, 'Crossings.lua');
		if (!luaOut) fs.writeFileSync(crossingsLuaFile, lua);
		const { planRoutes, guidePairs, jobOf, arrowReport } = require('../lib/nav/arrow');
		const pairs = guidePairs({ guides: compiled.guides, geo, frames, continents: list });
		const jobs = pairs.map(jobOf);
		log(`${pairs.length} guide pairs: planning without the aids`);
		const before = planRoutes(jobs, { log });
		log('planning with the aids');
		const after = planRoutes(jobs, { crossingsLua: crossingsLuaFile, log });
		let reference = null;
		const refFile = path.resolve(o.reference || path.join(ROOT, 'data', 'local', 'crossings.json'));
		try {
			reference = readCrossingsFile(refFile, frames);
		} catch (err) {
			console.error(`warning: reference ${refFile}: ${err.message.split('\n')[0]}`);
		}
		const report = arrowReport({ nav, frames, pairs, before, after, set, reference, stats, build: `${nav.index.build} (grid built ${nav.index.builtAt})`, seconds: null, log });
		report.json.seconds = (Date.now() - t0) / 1000;
		report.json.generateSeconds = genSeconds;
		const { renderReport } = require('../lib/nav/arrow');
		const base = path.join(path.dirname(out), `${path.basename(out, '.json')}-report`);
		fs.writeFileSync(`${base}.json`, `${JSON.stringify(report.json, null, '\t')}\n`);
		fs.writeFileSync(`${base}.md`, renderReport(report.json));
		const b = report.json.legs.before;
		const a = report.json.legs.after;
		console.log(`guide legs crossing impassable ground: ${b.blocked} of ${b.withWalk} (${b.blockedShare}%) without the aids, ${a.blocked} of ${a.withWalk} (${a.blockedShare}%) with them; ${a.failed} not planned with them`);
		console.log(`wrote ${path.relative(process.cwd(), base)}.json and .md (${((Date.now() - t0) / 1000).toFixed(0)} s in all)`);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
	return 0;
}

const SUBCOMMANDS = { build, path: route, aids };

async function run(argv) {
	const [sub, ...rest] = argv;
	try {
		if (!sub || sub === '--help' || sub === '-h') {
			console.log(usage);
			return sub ? 0 : 2;
		}
		const fn = SUBCOMMANDS[sub];
		if (!fn) throw usageError(`unknown nav command "${sub}"`);
		return await fn(rest);
	} catch (err) {
		if (err.exit === 2) {
			console.error(`${err.message}\n\n${usage}`);
			return 2;
		}
		if (err.exit === 1) {
			console.error(`nav: ${err.message}`);
			return 1;
		}
		throw err;
	}
}

module.exports = { name: 'nav', summary: 'Terrain navigation from the client geometry: build the grid, route between map points', usage, run };
