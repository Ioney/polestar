'use strict';
// Blizzard client tables the travel planner is built from, as CSV from
// wago.tools, cached next to the map tables under
// <sources>/wago/<build>/<Table>.csv. A cached build is immutable, so a
// present file is never fetched again.
//
// Classic Era (the base network):
//   TaxiNodes      flight masters: name, continent, world position, faction flags
//   TaxiPath       one-way flight legs between two nodes (and transport loops)
//   TaxiPathNode   the points each path flies through (stops carry Flags 2 + Delay)
//   AreaTrigger    instance portals (the Deeprun Tram entrances)
// WoW Forever (1.60+ builds of the beta product):
//   TaxiPathNode   the ship loops Forever added (Stormwind Harbor, Southshore,
//                  Powderfuse Port)
// WoW Forever, for the timetables (tools/lib/travel/timetable.js):
//   TransportAnimation   lift and tram tracks (time index, offset from the spawn)
//   SpellEffect, SpellName, SpellMisc, SpellCastTimes, SpellReagents,
//   SkillLineAbility     class teleports: destination kind, name, cast time,
//                        reagents, and that a class learns the spell

const fs = require('node:fs');
const path = require('node:path');
const { parseCsv } = require('../data/csv');
const { compareVersions, tableUrl, BUILDS_URL, PRODUCTS } = require('../data/wago');

const TABLES = ['TaxiNodes', 'TaxiPath', 'TaxiPathNode', 'AreaTrigger'];
const FOREVER_TABLES = ['TaxiPathNode'];
const TRANSIT_TABLES = ['TransportAnimation', 'SpellEffect', 'SpellName', 'SpellMisc', 'SpellCastTimes', 'SpellReagents', 'SkillLineAbility'];
const SPECS = {
	era: { ...PRODUCTS.era, tables: TABLES },
	forever: { ...PRODUCTS.forever, tables: FOREVER_TABLES },
	transit: { ...PRODUCTS.forever, tables: TRANSIT_TABLES },
};

// Columns each table must have; checked so a schema change fails loudly
// instead of producing a silently empty network.
const COLUMNS = {
	TaxiNodes: ['ID', 'Name_lang', 'Pos_0', 'Pos_1', 'ContinentID', 'Flags', 'CharacterBitNumber'],
	TaxiPath: ['ID', 'FromTaxiNode', 'ToTaxiNode', 'Cost'],
	TaxiPathNode: ['PathID', 'NodeIndex', 'ContinentID', 'Loc_0', 'Loc_1', 'Loc_2', 'Flags', 'Delay'],
	AreaTrigger: ['ID', 'ContinentID', 'Pos_0', 'Pos_1', 'Pos_2'],
	TransportAnimation: ['TransportID', 'TimeIndex', 'Pos_0', 'Pos_1', 'Pos_2'],
	SpellEffect: ['SpellID', 'DifficultyID', 'Effect', 'ImplicitTarget_1'],
	SpellName: ['ID', 'Name_lang'],
	SpellMisc: ['SpellID', 'DifficultyID', 'CastingTimeIndex'],
	SpellCastTimes: ['ID', 'Base'],
	SpellReagents: ['SpellID', 'Reagent_0', 'ReagentCount_0'],
	SkillLineAbility: ['Spell', 'ClassMask'],
};

function checkColumns(table, rows, where) {
	if (!rows.length) throw new Error(`${where}: ${table} has no rows`);
	const missing = COLUMNS[table].filter((c) => !(c in rows[0]));
	if (missing.length) throw new Error(`${where}: ${table} lacks column(s) ${missing.join(', ')}`);
}

// A build is a folder name: digits and dots only, so no listed or given
// version can step outside the cache.
const BUILD_RE = /^\d+(\.\d+)+$/;

function cachedBuilds(cacheRoot, spec) {
	if (!fs.existsSync(cacheRoot)) return [];
	return fs
		.readdirSync(cacheRoot)
		.filter((b) => BUILD_RE.test(b) && spec.family.test(b) && spec.tables.every((t) => fs.existsSync(path.join(cacheRoot, b, `${t}.csv`))))
		.sort(compareVersions);
}

async function fetchText(fetchImpl, url) {
	const res = await fetchImpl(url, { headers: { 'user-agent': 'polestar-travel-build' } });
	if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
	return res.text();
}

async function latestBuild(fetchImpl, spec) {
	const builds = JSON.parse(await fetchText(fetchImpl, BUILDS_URL));
	const listed = Array.isArray(builds[spec.key]) ? builds[spec.key].map((b) => b.version).filter(Boolean) : [];
	const list = listed.filter((v) => typeof v === 'string' && BUILD_RE.test(v) && spec.family.test(v));
	if (!list.length) throw new Error(`${BUILDS_URL}: no ${spec.key} ${spec.family.source} builds listed`);
	return list.sort(compareVersions)[list.length - 1];
}

// product: "era" (TABLES), "forever" (FOREVER_TABLES) or "transit" (TRANSIT_TABLES, Forever builds).
// -> { build, tables: { TaxiNodes: rows, ... }, urls, warnings }
async function loadTravelTables({ sourcesDir, build, offline = false, fetchImpl = globalThis.fetch, log = () => {}, product = 'era' }) {
	const spec = SPECS[product];
	if (!spec) throw new Error(`travel sources: unknown product "${product}"`);
	const cacheRoot = path.join(sourcesDir, 'wago');
	const warnings = [];
	let chosen = build || null;
	if (!chosen) {
		const cached = cachedBuilds(cacheRoot, spec);
		if (offline) {
			chosen = cached[cached.length - 1];
			if (!chosen) throw new Error(`--offline: no cached ${spec.key} build with ${spec.tables.join(', ')} under ${cacheRoot}`);
		} else {
			try {
				chosen = await latestBuild(fetchImpl, spec);
			} catch (err) {
				chosen = cached[cached.length - 1];
				if (!chosen) throw err;
				warnings.push(`wago.tools: ${err.message}; using cached ${spec.key} build ${chosen}`);
			}
		}
	}
	if (!BUILD_RE.test(String(chosen))) throw new Error(`travel sources: "${chosen}" is not a build version`);
	const dir = path.join(cacheRoot, chosen);
	const tables = {};
	const urls = {};
	for (const t of spec.tables) {
		const file = path.join(dir, `${t}.csv`);
		urls[t] = tableUrl(t, chosen);
		if (!fs.existsSync(file)) {
			if (offline) throw new Error(`--offline: missing cached ${file}`);
			log(`fetching ${urls[t]}`);
			const text = await fetchText(fetchImpl, urls[t]);
			checkColumns(t, parseCsv(text), urls[t]);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(`${file}.tmp`, text);
			fs.renameSync(`${file}.tmp`, file);
		}
		tables[t] = parseCsv(fs.readFileSync(file, 'utf8'));
		checkColumns(t, tables[t], file);
	}
	return { build: chosen, tables, urls, warnings };
}

module.exports = { loadTravelTables, TABLES, FOREVER_TABLES, TRANSIT_TABLES, COLUMNS };
