'use strict';
// Shortest Path Forever's walking router, vendored into addon/Polestar_Nav
// (docs/ARCHITECTURE.md, "In-game walking routes (Polestar_Nav)"). Cillian
// Berragan wrote it (https://github.com/cjber/shortest-path-forever,
// GPL-3.0-or-later) and agreed to Polestar using it. Copies his
// Routing/PathGrid.lua, Path.lua, PathJobs.lua and the Nav/ walking maps with
// one mechanical change: the data global ShortestPathForeverPathData becomes
// PolestarPathData, so Polestar always reads its own copy of the maps and
// never Shortest Path Forever's (whose engine evicts decoded entries from its
// tables mid-search). Each file gains one header line naming its upstream
// file, commit, copyright and licence and the date of the change (the dated
// notice of GPLv3 section 5a). Writes UPSTREAM.json ({ repo, commit, version,
// vendored: date, files: { path: sha256 } } of the vendored files).
//
// Map file names come from upstream's Nav.xml; only Nav<id>[_<part>].lua
// names are accepted, so a checkout cannot make the tool read or write
// outside Nav/.
//
//   const { vendor, checkVendored } = require('./vendor');
//   vendor('/path/to/shortest-path-forever', 'addon/Polestar_Nav');
//   checkVendored('addon/Polestar_Nav');   // -> [problem, ...], [] when it matches UPSTREAM.json

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = 'https://github.com/cjber/shortest-path-forever';
const OLD_GLOBAL = 'ShortestPathForeverPathData';
const NEW_GLOBAL = 'PolestarPathData';
const ROUTING = ['Routing/PathGrid.lua', 'Routing/Path.lua', 'Routing/PathJobs.lua'];
const NAV_XML = 'Nav/Nav.xml';
const HEADER = '-- Polestar_Nav: ';
const MAP_NAME = /^Nav\w*\.lua$/;
const DATE = /^\d{4}-\d\d-\d\d$/;
const XML_HEADER = '\t<!-- Polestar_Nav: ';

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// The upstream files, in load order: the routing code, then Nav.xml and the
// map files it lists.
function upstreamFiles(srcDir) {
	const xml = path.join(srcDir, ...NAV_XML.split('/'));
	if (!fs.existsSync(xml)) throw new Error(`${srcDir} has no ${NAV_XML}: not a Shortest Path Forever checkout`);
	const names = [...fs.readFileSync(xml, 'utf8').matchAll(/<Script\s+file="([^"]+)"/g)].map((m) => m[1]);
	const bad = names.filter((n) => !MAP_NAME.test(n));
	if (bad.length) throw new Error(`${NAV_XML} lists files that are not map files (Nav<name>.lua in Nav/): ${bad.map((n) => JSON.stringify(n)).join(', ')}`);
	const maps = names.map((n) => `Nav/${n}`);
	if (!maps.length) throw new Error(`${NAV_XML} lists no map files`);
	const files = [...ROUTING, NAV_XML, ...maps];
	for (const rel of files) {
		if (!fs.existsSync(path.join(srcDir, ...rel.split('/')))) throw new Error(`${srcDir} has no ${rel}`);
	}
	return files;
}

// A vendored file's path is Routing/<one of ours>, Nav/Nav.xml or a map file.
function vendoredPath(rel) {
	return ROUTING.includes(rel) || rel === NAV_XML || (rel.startsWith('Nav/') && MAP_NAME.test(rel.slice(4)));
}

function describe(rel, commit, date) {
	const what = rel === NAV_XML ? 'unchanged but for this comment' : `the data global is ${NEW_GLOBAL}`;
	return `${rel} from Shortest Path Forever (${REPO}) at ${commit}, Copyright (C) 2026 Cillian Berragan, GPL-3.0-or-later. Modified for Polestar on ${date} by \`node tools/polestar.js nav vendor\`: ${what}.`;
}

// Upstream text (or an already vendored file) -> the vendored file, its
// header dated `date` (YYYY-MM-DD). Applying it again gives the same text.
function transform(rel, text, commit, date) {
	if (!DATE.test(String(date))) throw new Error(`transform: date must be YYYY-MM-DD, got ${date}`);
	const line = describe(rel, commit, date);
	if (rel === NAV_XML) {
		const bare = text.replace(/^\t<!-- Polestar_Nav: .* -->\n/m, '');
		const open = /^<Ui\b[^\n]*>\n/m.exec(bare);
		if (!open) throw new Error(`${rel}: no <Ui> element`);
		const at = open.index + open[0].length;
		return `${bare.slice(0, at)}${XML_HEADER}${line.replace(/--/g, '-')} -->\n${bare.slice(at)}`;
	}
	let body = text;
	if (body.startsWith(HEADER)) body = body.slice(body.indexOf('\n') + 1);
	body = body.split(OLD_GLOBAL).join(NEW_GLOBAL);
	return `${HEADER}${line}\n${body}`;
}

// The upstream commit and released version of a checkout.
function upstreamMeta(srcDir) {
	const git = spawnSync('git', ['-C', srcDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
	if (git.status !== 0) throw new Error(`${srcDir} is not a git checkout (git rev-parse HEAD failed)`);
	const commit = git.stdout.trim();
	let version = null;
	const changelog = path.join(srcDir, 'CHANGELOG.md');
	if (fs.existsSync(changelog)) {
		const m = /^## \[(\d+\.\d+\.\d+[^\]]*)\]/m.exec(fs.readFileSync(changelog, 'utf8'));
		if (m) version = m[1];
	}
	return { commit, version };
}

// Copies srcDir's router into addonDir. `meta` ({ commit, version }) defaults
// to the checkout's (upstreamMeta); `date` (YYYY-MM-DD, the notices' date) to
// today. -> { commit, version, date, files, removed }.
function vendor(srcDir, addonDir, meta = upstreamMeta(srcDir), date = new Date().toISOString().slice(0, 10)) {
	const { commit, version } = meta;
	const rels = upstreamFiles(srcDir);
	const out = {};
	for (const rel of rels) out[rel] = transform(rel, fs.readFileSync(path.join(srcDir, ...rel.split('/')), 'utf8'), commit, date);
	const removed = [];
	for (const dir of ['Routing', 'Nav']) {
		const abs = path.join(addonDir, dir);
		if (!fs.existsSync(abs)) continue;
		for (const name of fs.readdirSync(abs)) {
			const rel = `${dir}/${name}`;
			if (!(rel in out)) {
				fs.rmSync(path.join(abs, name), { force: true });
				removed.push(rel);
			}
		}
	}
	const files = {};
	for (const rel of rels) {
		const target = path.join(addonDir, ...rel.split('/'));
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, out[rel]);
		files[rel] = sha256(out[rel]);
	}
	fs.writeFileSync(path.join(addonDir, 'UPSTREAM.json'), `${JSON.stringify({ repo: REPO, commit, version, vendored: date, files }, null, '\t')}\n`);
	return { commit, version, date, files, removed };
}

// What differs between addonDir and its UPSTREAM.json: changed, missing and
// unlisted files under Routing/ and Nav/, and a vendored file the transform
// would change. [] when it matches. A missing or unreadable UPSTREAM.json is
// the one problem reported.
function checkVendored(addonDir) {
	const problems = [];
	const file = path.join(addonDir, 'UPSTREAM.json');
	if (!fs.existsSync(file)) return [`${file} is missing: run \`node tools/polestar.js nav vendor <checkout>\``];
	let manifest;
	try {
		manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (e) {
		return [`${file} is not valid JSON (${e.message})`];
	}
	if (!manifest || typeof manifest.files !== 'object' || !manifest.files || typeof manifest.commit !== 'string' || !DATE.test(String(manifest.vendored))) {
		return [`${file} lacks commit, vendored (YYYY-MM-DD) or files`];
	}
	for (const [rel, want] of Object.entries(manifest.files)) {
		if (!vendoredPath(rel)) {
			problems.push(`${rel} in UPSTREAM.json is not a vendored path`);
			continue;
		}
		const target = path.join(addonDir, ...rel.split('/'));
		if (!fs.existsSync(target)) {
			problems.push(`${rel} is missing`);
			continue;
		}
		const text = fs.readFileSync(target, 'utf8');
		if (sha256(text) !== want) problems.push(`${rel} differs from UPSTREAM.json`);
		else if (transform(rel, text, manifest.commit, manifest.vendored) !== text) problems.push(`${rel} is not what the transform gives`);
	}
	for (const dir of ['Routing', 'Nav']) {
		const abs = path.join(addonDir, dir);
		for (const name of fs.existsSync(abs) ? fs.readdirSync(abs) : []) {
			if (!(`${dir}/${name}` in manifest.files)) problems.push(`${dir}/${name} is not listed in UPSTREAM.json`);
		}
	}
	return problems;
}

module.exports = { REPO, OLD_GLOBAL, NEW_GLOBAL, ROUTING, upstreamFiles, transform, upstreamMeta, vendor, checkVendored };
