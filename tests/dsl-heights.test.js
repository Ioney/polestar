'use strict';
// Goal heights (tools/lib/dsl/heights.js, docs/GUIDE_FORMAT.md "Heights";
// docs/NAV_QA.md Z3): a goal whose point stands for an NPC or object gets the
// z of that entity's nearest CMaNGOS spawn (spawnz.json) on the same instance
// map within 15 yards of the goal's world point; nothing else gets one.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compile, guideText, DATA_DIR, GUIDES_DIR } = require('./helpers/dsl');
const { loadData } = require('../tools/lib/dsl/data');
const { worldPoint } = require('../tools/lib/dsl/heights');
const { emitGuides } = require('../tools/lib/dsl/emit');
const { polestar } = require('./helpers/cli');
const { tmpdir } = require('./helpers/tmp');

// Fixture data (Elwynn Forest, uiMap 1429, Era frame on instance map 1415):
// Marshal McBride (197) at 48.92,41.61, Eagan Peltskinner (196) at
// 48.94,40.17, Brother Danil (152) at 47.5,41.6, Kobold Vermin (6) around 48,31.
function heightData() {
	const data = loadData(DATA_DIR);
	const at = (x, y) => worldPoint(data, { map: 1429, x, y, f: 'e' });
	const mcbride = at(48.92, 41.61);
	const eagan = at(48.94, 40.17);
	const danil = at(47.5, 41.6);
	data.spawnz = {
		npc: {
			// 3 yd off the point, and a farther spawn that loses.
			197: [[1415, mcbride.wx + 3, mcbride.wy, 12.3], [1415, mcbride.wx + 14, mcbride.wy, 99]],
			196: [[1415, eagan.wx + 20, eagan.wy, 5]], // 20 yd: none
			152: [[0, danil.wx, danil.wy, 7]], // another map: none
			6: [[47.6, 31.2], [49, 32.4], [52.3, 26.8], [45.1, 33.9]].map(([x, y]) => [1415, at(x, y).wx, at(x, y).wy, 1]),
			// Timber Wolf, the meat's top source: at both its spawns, so a collect could find one.
			69: [[1415, at(45, 40).wx, at(45, 40).wy, 2], [1415, at(44, 45).wx, at(44, 45).wy, 2]],
		},
		object: {},
	};
	return data;
}

const SRC = guideText([
	'step Heights',
	'  accept 7',
	'  accept 33',
	'  talk 197',
	'  talk 196',
	'  talk 152',
	'  goto 48.92,41.61 "The marshal"',
	'  kill 6 x10 quest 7.1',
	'  collect 750 x8 quest 33.1 optional',
]);

test('Z3: an NPC goal with a spawn on its map within 15 yards gets that z; 20 yards, another map, a goto, a collect: none', () => {
	const r = compile(SRC, heightData());
	assert.deepEqual(r.errors, []);
	const goals = r.guides[0].steps[0].goals;
	const z = (t, id) => goals.find((g) => g.t === t && (id === undefined || g.npc === id)).z;
	assert.equal(z('accept'), 12.3, 'the quest giver Marshal McBride: his nearest spawn, 3 yd off');
	assert.equal(z('talk', 197), 12.3);
	assert.equal(z('talk', 196), undefined, 'a spawn 20 yd away is another one');
	assert.equal(z('talk', 152), undefined, 'a spawn on another map says nothing');
	assert.equal(z('goto'), undefined, 'a goto is a place, never an NPC');
	assert.equal(z('collect'), undefined, 'a collect spot is no single NPC');
	assert.equal(goals.find((g) => g.t === 'kill').z, 1, 'a kill at its spawn');
});

test('Z3: without spawnz.json no goal gets z', () => {
	const r = compile(SRC);
	assert.deepEqual(r.errors, []);
	assert.ok(r.guides[0].steps[0].goals.every((g) => g.z === undefined));
});

test('z is emitted right after y, deterministically', () => {
	const a = emitGuides(compile(SRC, heightData()).guides.map((guide) => ({ guide })));
	const b = emitGuides(compile(SRC, heightData()).guides.map((guide) => ({ guide })));
	assert.equal(a, b);
	assert.match(a, /\{ t = "talk", npc = 197, npcName = "Marshal McBride", map = 1429, x = 48\.92, y = 41\.61, z = 12\.3, f = "e"/);
});

test('compile reports how many NPC and object goals got z; LICENSE-DATA.txt then names classic-db', () => {
	const data = tmpdir('polestar-heights-data-');
	fs.cpSync(DATA_DIR, data, { recursive: true });
	const outNone = tmpdir();
	const none = polestar(['compile', '--guides', GUIDES_DIR, '--data', data, '--out', outNone]);
	assert.equal(none.status, 0, none.stderr);
	assert.match(none.stdout, /\nheights: none \(no spawnz\.json in the reference data; `data build` writes it\)\n$/);
	assert.doesNotMatch(fs.readFileSync(path.join(outNone, 'LICENSE-DATA.txt'), 'utf8'), /classic-db/);
	const mcbride = worldPoint(loadData(DATA_DIR), { map: 1429, x: 48.92, y: 41.61, f: 'e' });
	fs.writeFileSync(path.join(data, 'spawnz.json'), JSON.stringify({ npc: { 197: [[1415, mcbride.wx, mcbride.wy, 12.3]] }, object: {} }));
	const outZ = tmpdir();
	const some = polestar(['compile', '--guides', GUIDES_DIR, '--data', data, '--out', outZ]);
	assert.equal(some.status, 0, some.stderr);
	const m = /\nheights: (\d+) of (\d+) NPC or object goals got z \(spawnz\.json\)\n$/.exec(some.stdout);
	assert.ok(m, some.stdout);
	assert.ok(Number(m[1]) > 0 && Number(m[1]) < Number(m[2]), `${m[1]} of ${m[2]}`);
	const notice = fs.readFileSync(path.join(outZ, 'LICENSE-DATA.txt'), 'utf8');
	assert.match(notice, /CMaNGOS classic-db: creature and gameobject spawn heights\n-+\nURL: https:\/\/raw\.githubusercontent\.com\/cmangos\/classic-db\/[\s\S]*License: GPL-3\.0; spawn heights \(z\) only, used as facts/);
	assert.equal(notice.match(/CMaNGOS classic-db/g).length, 1, 'named once');
});
