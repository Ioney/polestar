'use strict';
// Server-side facts the client tables lack, from the CMaNGOS classic-db
// world database (GPL-3.0; https://github.com/cmangos/classic-db), pinned to
// the commit Shortest Path Forever by Cillian Berragan reads (his
// tools/gen_transit.py, GPL-3.0-or-later, adapted with permission):
// Portions Copyright (C) 2026 Cillian Berragan (Shortest Path Forever, GPL-3.0-or-later); adapted for Polestar, 2026-10-15.
//
//   gameobject              where each lift car and tram train is spawned
//                           (its TransportAnimation is relative to the spawn)
//   areatrigger_teleport    where a walk-in portal (Darnassus <-> Rut'theran)
//                           puts you
//   spell_target_position   where a class teleport (Teleport: Orgrimmar,
//                           Teleport: Moonglade) puts you
//
// The dump (~13 MB gzip, its sha256 pinned, at most MAX_BYTES read) is
// fetched once into <sources>/cmangos/<rev>/ and only the rows above are
// kept, in transit.json beside it; a present transit.json is never rebuilt,
// so builds are offline and deterministic after the first. A cached dump
// whose hash is wrong (a broken download) is deleted and fetched again.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const readline = require('node:readline');

const DB_REV = '22b51464f1625f6ef6275771de1f5466c6f5d19e';
const DB_URL = `https://raw.githubusercontent.com/cmangos/classic-db/${DB_REV}/Full_DB/ClassicDB_1_12_1_z2815.sql.gz`;
const DB_SHA256 = '4f92db520868ab4e566726f68b5b2e380ae781209beaf22237b4f7f04600d0c0';
const MAX_BYTES = 32 * 1024 * 1024;
// Lift cars and tram trains (gameobject entries animated by TransportAnimation).
const LIFT_ENTRIES = [4170, 4171, 11898, 11899, 20649, 20652, 20655, 47296, 47297];
const TRAM_ENTRIES = [176080, 176081, 176082, 176083, 176084, 176085];
// Walk-in portals the planner uses: Darnassus <-> Rut'theran Village.
const PORTAL_TRIGGERS = [527, 542];
const SPAWN_MAPS = new Set([0, 1, 369]);

// The fields of one SQL tuple body, quoted strings unquoted.
function sqlFields(body) {
	const out = [];
	let cur = '';
	let quoted = false;
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (quoted) {
			if (ch === '\\' && i + 1 < body.length) cur += body[++i];
			else if (ch === "'") quoted = false;
			else cur += ch;
		} else if (ch === "'") quoted = true;
		else if (ch === ',') {
			out.push(cur.trim());
			cur = '';
		} else cur += ch;
	}
	out.push(cur.trim());
	return out;
}

// Tuple bodies of one `INSERT INTO ... VALUES (...),(...);` line.
const TUPLE = /\(((?:'(?:\\.|[^'\\])*'|[^()'])*)\)/g;
function* tuples(line) {
	TUPLE.lastIndex = line.indexOf(' VALUES ');
	let m;
	while ((m = TUPLE.exec(line))) yield sqlFields(m[1]);
}

// Lines of the dump -> { spawns: { entry: [{ guid, map, x, y, z, o }] },
// portals: { trigger: { map, x, y, z } }, positions: { spell: { map, x, y, z } } }.
async function extractLines(lines) {
	const wantSpawn = new Set([...LIFT_ENTRIES, ...TRAM_ENTRIES]);
	const wantPortal = new Set(PORTAL_TRIGGERS);
	const spawns = {};
	const portals = {};
	const positions = {};
	const point = (map, f) => ({ map: Number(map), x: Number(f[0]), y: Number(f[1]), z: Number(f[2]) });
	for await (const line of lines) {
		if (line.startsWith('INSERT INTO `gameobject` VALUES')) {
			for (const r of tuples(line)) {
				const entry = Number(r[1]);
				const map = Number(r[2]);
				if (!wantSpawn.has(entry) || !SPAWN_MAPS.has(map)) continue;
				(spawns[entry] = spawns[entry] || []).push({ guid: Number(r[0]), ...point(map, r.slice(4, 7)), o: Number(r[7]) });
			}
		} else if (line.startsWith('INSERT INTO `areatrigger_teleport` VALUES')) {
			for (const r of tuples(line)) if (wantPortal.has(Number(r[0]))) portals[r[0]] = point(r[6], r.slice(7, 10));
		} else if (line.startsWith('INSERT INTO `spell_target_position` VALUES')) {
			for (const r of tuples(line)) positions[r[0]] = point(r[1], r.slice(2, 5));
		}
	}
	for (const list of Object.values(spawns)) list.sort((a, b) => a.guid - b.guid);
	const missing = [...wantSpawn].filter((e) => !spawns[e]).concat(PORTAL_TRIGGERS.filter((t) => !portals[t]).map((t) => `trigger ${t}`));
	if (missing.length || !Object.keys(positions).length) throw new Error(`classic-db ${DB_REV.slice(0, 8)}: missing ${missing.join(', ') || 'spell_target_position'}`);
	return { spawns, portals, positions };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// The pinned dump, read up to maxBytes, checked against its hash, written atomically.
async function fetchDump({ fetchImpl, file, log, url, hash, maxBytes }) {
	log(`fetching ${url}`);
	const res = await fetchImpl(url, { headers: { 'user-agent': 'polestar-travel-build' } });
	if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
	const declared = Number(res.headers && res.headers.get && res.headers.get('content-length'));
	if (declared > maxBytes) throw new Error(`GET ${url}: ${declared} bytes, over the ${maxBytes}-byte limit`);
	const chunks = [];
	let size = 0;
	if (res.body && res.body.getReader) {
		const reader = res.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > maxBytes) {
				await reader.cancel();
				throw new Error(`GET ${url}: over the ${maxBytes}-byte limit`);
			}
			chunks.push(Buffer.from(value));
		}
	} else {
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length > maxBytes) throw new Error(`GET ${url}: over the ${maxBytes}-byte limit`);
		chunks.push(buf);
	}
	const buf = Buffer.concat(chunks);
	const got = sha256(buf);
	if (got !== hash) throw new Error(`GET ${url}: sha256 ${got}, expected ${hash}`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(`${file}.tmp`, buf);
	fs.renameSync(`${file}.tmp`, file);
}

// -> { rev, url, spawns, portals, positions }. url, hash and maxBytes are
// the pinned dump's unless a test passes its own.
async function loadClassicDb({ sourcesDir, offline = false, fetchImpl = globalThis.fetch, log = () => {}, url = DB_URL, hash = DB_SHA256, maxBytes = MAX_BYTES }) {
	const dir = path.join(sourcesDir, 'cmangos', DB_REV.slice(0, 12));
	const extract = path.join(dir, 'transit.json');
	if (!fs.existsSync(extract)) {
		const dump = path.join(dir, 'classicdb.sql.gz');
		if (fs.existsSync(dump) && sha256(fs.readFileSync(dump)) !== hash) {
			log(`${dump}: wrong sha256, deleted`);
			fs.rmSync(dump);
		}
		if (!fs.existsSync(dump)) {
			if (offline) throw new Error(`--offline: missing cached ${extract}`);
			await fetchDump({ fetchImpl, file: dump, log, url, hash, maxBytes });
		}
		const lines = readline.createInterface({ input: fs.createReadStream(dump).pipe(zlib.createGunzip()), crlfDelay: Infinity });
		const data = await extractLines(lines);
		fs.writeFileSync(`${extract}.tmp`, `${JSON.stringify(data, null, '\t')}\n`);
		fs.renameSync(`${extract}.tmp`, extract);
	}
	return { rev: DB_REV, url: DB_URL, ...JSON.parse(fs.readFileSync(extract, 'utf8')) };
}

module.exports = { loadClassicDb, extractLines, sqlFields, DB_REV, DB_URL, DB_SHA256, MAX_BYTES, LIFT_ENTRIES, TRAM_ENTRIES, PORTAL_TRIGGERS };
