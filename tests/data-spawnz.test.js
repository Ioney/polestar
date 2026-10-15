'use strict';
// `data build`'s spawnz.json (tools/lib/travel/cmangos.js loadSpawnHeights):
// every creature and gameobject spawn's height on maps 0 and 1 from CMaNGOS
// classic-db, for the compiler's goal `z` (tools/lib/dsl/heights.js). A small
// fixture dump stands in for the pinned one (its own hash).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { buildData } = require('../tools/lib/data/build');
const { extractSpawnHeights, DB_REV } = require('../tools/lib/travel/cmangos');
const { tmpdir } = require('./helpers/tmp');

const FIX = path.join(__dirname, 'fixtures', 'data');

// creature/gameobject rows: guid, id, map, spawnMask, x, y, z, orientation, ...
const DUMP = [
	'INSERT INTO `creature` VALUES ' + [
		'(1,6522,0,1,1389.34,347.315,-65.9567,0,300,300,0,0)', // Andron Gant, the Rogues' Quarter
		'(2,3,1,1,-10.04,20.06,30.04,0,300,300,0,0)',
		'(3,3,0,1,5,6,7.26,0,300,300,0,0)',
		'(4,3,530,1,5,6,7,0,300,300,0,0)', // Outland: not kept
		'(5,0,1,1,100,200,-0.04,0,300,300,0,0)', // its entry comes from creature_spawn_entry
		'(6,3,1,1,-10.04,20.06,30.04,0,300,300,0,0)', // the same place again: one entry
	].join(',') + ';',
	"INSERT INTO `creature_spawn_entry` VALUES (5,7),(5,8),(99,9);",
	'INSERT INTO `gameobject` VALUES (10,176080,0,1,1.25,2.25,3.25,0,0,0,0,0,0,0),(11,1617,369,1,1,1,1,0,0,0,0,0,0,0);',
	"INSERT INTO `quest_template` VALUES (1,'(not a spawn)');",
];

test('classic-db spawns: maps 0 and 1 only, to a tenth of a yard, pooled entries, sorted ids and spawns', async () => {
	const db = await extractSpawnHeights(DUMP);
	assert.deepEqual(db, {
		npc: {
			3: [[0, 5, 6, 7.3], [1, -10, 20.1, 30]],
			6522: [[0, 1389.3, 347.3, -66]],
			7: [[1, 100, 200, 0]],
			8: [[1, 100, 200, 0]],
		},
		object: { 176080: [[0, 1.3, 2.3, 3.3]] },
	});
	assert.deepEqual(Object.keys(db.npc), ['3', '7', '8', '6522']);
});

// A copy of the data fixtures' source cache, with the fixture dump cached as the pinned one (its hash given).
function sources(withDump) {
	const dir = tmpdir('polestar-spawnz-');
	fs.cpSync(path.join(FIX, 'sources'), dir, { recursive: true });
	const gz = zlib.gzipSync(Buffer.from(DUMP.join('\n')));
	if (withDump) {
		const cache = path.join(dir, 'cmangos', DB_REV.slice(0, 12));
		fs.mkdirSync(cache, { recursive: true });
		fs.writeFileSync(path.join(cache, 'classicdb.sql.gz'), gz);
	}
	return { dir, hash: crypto.createHash('sha256').update(gz).digest('hex') };
}

function build(src, outDir) {
	return buildData({
		offline: true,
		pfquestDir: path.join(FIX, 'pfquest'),
		sourcesDir: src.dir,
		recordingsDir: path.join(FIX, 'recordings'),
		outDir,
		builtAt: '2026-01-01T00:00:00Z',
		classicDb: { hash: src.hash },
	});
}

test('data build writes spawnz.json from the cached dump, deterministically, and credits classic-db', async () => {
	const src = sources(true);
	const a = tmpdir('polestar-spawnz-out-');
	const b = tmpdir('polestar-spawnz-out-');
	const { meta } = await build(src, a);
	await build(src, b);
	const text = fs.readFileSync(path.join(a, 'spawnz.json'), 'utf8');
	assert.equal(text, fs.readFileSync(path.join(b, 'spawnz.json'), 'utf8'), 'byte-identical across builds');
	assert.equal(text, '{"npc":{\n"3":[[0,5,6,7.3],[1,-10,20.1,30]],\n"7":[[1,100,200,0]],\n"8":[[1,100,200,0]],\n"6522":[[0,1389.3,347.3,-66]]\n},"object":{\n"176080":[[0,1.3,2.3,3.3]]\n}}\n');
	assert.ok(fs.existsSync(path.join(src.dir, 'cmangos', DB_REV.slice(0, 12), 'spawnz.json')), 'the extract is cached beside the dump');
	const credit = meta.sources.find((s) => /classic-db/.test(s.name));
	assert.match(credit.license, /^GPL-3\.0; spawn heights \(z\) only, used as facts/);
	assert.equal(credit.revision, DB_REV);
	assert.equal(meta.counts.spawnHeightNpcs, 4);
	assert.equal(meta.counts.spawnHeightObjects, 1);
	assert.equal(meta.files['spawnz.json'], Buffer.byteLength(text));
	assert.ok(!meta.warnings.some((w) => /spawn heights/.test(w)));
});

test('data build --offline without the cached dump: no spawnz.json, one warning, the build still succeeds', async () => {
	const out = tmpdir('polestar-spawnz-out-');
	fs.writeFileSync(path.join(out, 'spawnz.json'), '{"npc":{},"object":{}}\n'); // from an older build
	const { meta } = await build(sources(false), out);
	assert.equal(fs.existsSync(path.join(out, 'spawnz.json')), false, 'an older spawnz.json goes with it');
	assert.ok(fs.existsSync(path.join(out, 'quests.json')));
	const w = meta.warnings.filter((x) => /spawn heights/.test(x));
	assert.equal(w.length, 1);
	assert.match(w[0], /CMaNGOS classic-db spawn heights unavailable \(--offline: missing cached .*spawnz\.json\); spawnz\.json not written/);
	assert.equal(meta.sources.some((s) => /classic-db/.test(s.name)), false);
});
