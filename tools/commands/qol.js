'use strict';
// node tools/polestar.js qol build
//
// The Quality of Life module's reference data, from data/forever: Spirit
// Healer spawns (the NPC named exactly "Spirit Healer", so test and
// battleground variants stay out) with their world positions, the NPC IDs
// of every flight master (recognising a flight master's gossip without
// reading its localized option text), and the NPC IDs of every reagent
// vendor (a vendor whose subtitle names reagents; Nav/Nearby.lua's
// `/polestar near reagents`). Writes addon/Polestar/QoL/Data.lua.

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { header } = require('../lib/generated');

const { ROOT, DATA } = require('../lib/paths');
const HEALER_NAME = 'Spirit Healer';
const REAGENT = /\breagents?\b/i; // "Reagent Vendor", "Reagents & Poisons", "Reagent Supplies"...
const NOT_LIVE = /\bPTR\b/; // test-realm turn-in NPCs
const MERGE_YARDS = 25; // two spawn points this close are one healer

const usage = `usage: node tools/polestar.js qol build [--data <dir>] [--lua <file>]

  --data <dir>   data/forever (npcs.json, map-frames.json)
  --lua <file>   output (default: addon/Polestar/QoL/Data.lua)`;

const round = (v, d) => {
	const k = 10 ** d;
	return Math.round(v * k) / k;
};

// Era map percent -> world yards (docs/ARCHITECTURE.md, "Map frames").
function eraToWorld(frame, x, y) {
	return { c: frame.c, wx: frame.top + ((frame.bottom - frame.top) * y) / 100, wy: frame.left + ((frame.right - frame.left) * x) / 100 };
}

function buildQolData({ npcs, frames }) {
	const healers = [];
	const skipped = [];
	for (const npc of Object.values(npcs)) {
		if (npc.name !== HEALER_NAME) continue;
		for (const [mapKey, spawn] of Object.entries(npc.spawns || {})) {
			const map = Number(mapKey);
			const frame = spawn.f === 'e' ? frames.era[mapKey] : null;
			for (const [x, y] of spawn.pts || []) {
				if (!frame) {
					// Live-frame points cannot be placed offline; the addon converts them.
					if (spawn.f === 'l') healers.push({ map, x, y, f: 'l' });
					else skipped.push(`${map}:${x},${y}`);
					continue;
				}
				const w = eraToWorld(frame, x, y);
				const dup = healers.find((h) => h.c === w.c && Math.hypot(h.wx - w.wx, h.wy - w.wy) < MERGE_YARDS);
				if (!dup) healers.push({ ...w, map, x, y, f: 'e' });
			}
		}
	}
	healers.sort((a, b) => (a.c ?? 99) - (b.c ?? 99) || a.map - b.map || a.x - b.x || a.y - b.y);
	const ids = (keep) =>
		Object.values(npcs)
			.filter(keep)
			.map((n) => n.id)
			.sort((a, b) => a - b);
	const flightMasters = ids((n) => (n.roles || []).includes('flightmaster'));
	const reagentVendors = ids((n) => (n.roles || []).includes('vendor') && REAGENT.test(n.subName || '') && !NOT_LIVE.test(n.subName));
	return { healers, flightMasters, reagentVendors, skipped };
}

// Twelve ids per line, each line tab-indented twice.
function idRows(list) {
	const rows = [];
	for (let i = 0; i < list.length; i += 12) rows.push('\t\t' + list.slice(i, i + 12).join(', ') + ',');
	return rows;
}

function toLua({ healers, flightMasters, reagentVendors }) {
	const rows = healers.map((h) =>
		h.f === 'e'
			? `\t\t{${h.c},${round(h.wx, 1)},${round(h.wy, 1)},${h.map},${round(h.x, 2)},${round(h.y, 2)}},`
			: `\t\t{false,false,false,${h.map},${round(h.x, 2)},${round(h.y, 2)}},`,
	);
	return [
		header('lua', 'qol build', 'data/forever (pfQuest, MIT; Blizzard Classic Era map frames)'),
		`-- The NPC named "${HEALER_NAME}", every NPC with the flightmaster role and every reagent vendor.`,
		'',
		'local ADDON, ns = ...',
		'local QoL = ns.QoL',
		'if not (QoL and QoL.SetData) then return end',
		'',
		'QoL.SetData({',
		'\t-- continent, wx, wy, uiMapID, x, y (Era frame); false world fields: live-frame point',
		'\tspiritHealers = {',
		...rows,
		'\t},',
		'\t-- NPC IDs',
		'\tflightMasters = {',
		...idRows(flightMasters),
		'\t},',
		'\t-- NPC IDs: vendors whose subtitle names reagents',
		'\treagentVendors = {',
		...idRows(reagentVendors),
		'\t},',
		'})',
		'',
	].join('\n');
}

module.exports = {
	name: 'qol',
	summary: 'Build the Quality of Life module data (spirit healers, flight masters, reagent vendors)',
	usage,
	buildQolData,
	toLua,
	async run(argv) {
		const [sub, ...rest] = argv;
		if (sub !== 'build') {
			console.error(usage);
			return 2;
		}
		const { values } = parseArgs({ args: rest, options: { data: { type: 'string' }, lua: { type: 'string' } } });
		const dataDir = path.resolve(values.data || DATA);
		const npcs = JSON.parse(fs.readFileSync(path.join(dataDir, 'npcs.json'), 'utf8'));
		const frames = JSON.parse(fs.readFileSync(path.join(dataDir, 'map-frames.json'), 'utf8'));
		const data = buildQolData({ npcs, frames });
		const out = path.resolve(values.lua || path.join(ROOT, 'addon', 'Polestar', 'QoL', 'Data.lua'));
		fs.mkdirSync(path.dirname(out), { recursive: true });
		fs.writeFileSync(out, toLua(data));
		console.log(`qol: ${data.healers.length} spirit healer(s), ${data.flightMasters.length} flight master(s), ${data.reagentVendors.length} reagent vendor(s) -> ${path.relative(ROOT, out)}`);
		if (data.skipped.length) console.log(`qol: ${data.skipped.length} point(s) without a map frame skipped`);
		return 0;
	},
};
