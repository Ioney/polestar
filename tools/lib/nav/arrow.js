'use strict';
// The arrow measured on the navigation grid
// (docs/superpowers/specs/2026-10-15-terrain-navigation-design.md, part 3):
// the addon's own planner (Nav/Travel.lua PlanRoute, loaded as
// tools/lib/travel/route.js does) run for many routes in one Lua process,
// and the report `nav aids --report` writes from it.
//
//   planRoutes(jobs, { travelLua, crossingsLua, batch }) -> [{ legs } | { reason }]
//     jobs: PlanRoute parameters ({ c, wx, wy, map, target: { c, wx, wy, map, label, x, y, f }, faction, known, speed })
//   guidePairs({ guides, geo, frames, continents }) -> [{ guide, faction, from, to }]
//     consecutive located goals of every guide (and across `next`), MIN_PAIR yd apart or more
//   arrowReport({ nav, frames, pairs, aidsLua, set, reference, stats, log }) -> { json, md }
//
// Every pair is planned twice, without and with the aids (Polestar_Travel's
// Crossings.lua), by an Alliance or Horde character (the guide's faction;
// neutral guides: Alliance) that knows no flight master and has no
// Hearthstone, so the routes measure walking (decided here). A walk leg
// crosses impassable ground when its straight line is not walkable on the
// grid (nav.los).

const { luaToJson } = require('../lua');
const { plannerLua, luaLiteral, FACTIONS } = require('../travel/route');
const { crossingCounts } = require('../travel/crossings');
const { profileFor } = require('./move');

const BATCH = 250; // routes per Lua process
const MIN_PAIR = 20; // yd: consecutive goals closer than this are one place
const WORST = 30;
const WORST_ROUTED = 400; // blocked legs (the longest) routed on the grid for the worst list
const MATCH = 60; // yd: a reference crossing end or chain mouth this close to a generated one has a counterpart

// --- planner --------------------------------------------------------------------------

function planRoutes(jobs, { travelLua, crossingsLua, batch = BATCH, log = () => {} } = {}) {
	const out = [];
	for (let i = 0; i < jobs.length; i += batch) {
		const part = jobs.slice(i, i + batch);
		const expr = `
${plannerLua({ ...(travelLua ? { travelLua } : {}), crossingsLua })}
local jobs = ${luaLiteral(part)}
local out = {}
for i, p in ipairs(jobs) do
	local legs, why = ns.Nav.PlanRoute(p)
	if legs then
		for _, leg in ipairs(legs) do leg.rest = nil end
		out[i] = { legs = legs }
	else
		out[i] = { reason = why or "no route" }
	end
end
return out`;
		const r = luaToJson({ expr, timeout: 600000 });
		for (let k = 0; k < part.length; k++) out.push((r && r[k]) || { reason: 'no result' });
		log(`planned ${Math.min(i + batch, jobs.length)} of ${jobs.length}`);
	}
	return out;
}

// --- guide pairs -------------------------------------------------------------------------

// A located goal -> { c, wx, wy, map, x, y (Era percent on its map, or null), label } or null.
function goalPoint(goal, geo, frames) {
	const w = geo.toWorld(goal.map, goal.x, goal.y, goal.f === 'e' ? 'e' : 'l');
	if (!w) return null;
	const m = frames.toMap(goal.map, w.c, w.wx, w.wy);
	const label = goal.npcName || goal.objName || goal.location || goal.target || goal.title || goal.t;
	return { c: w.c, wx: w.wx, wy: w.wy, map: goal.map, x: m ? Math.round(m.x * 100) / 100 : null, y: m ? Math.round(m.y * 100) / 100 : null, label: String(label || '') };
}

function guidePairs({ guides, geo, frames, continents = null }) {
	const byId = new Map(guides.map((g) => [g.id, g]));
	const located = new Map();
	for (const g of guides) {
		const pts = [];
		for (const step of g.steps || []) {
			for (const goal of step.goals || []) {
				if (goal.map == null || goal.x == null) continue;
				const p = goalPoint(goal, geo, frames);
				if (p && (!continents || continents.includes(p.c))) pts.push(p);
			}
		}
		located.set(g.id, pts);
	}
	const out = [];
	const seen = new Set();
	const add = (g, a, b) => {
		if (a.c === b.c && Math.hypot(a.wx - b.wx, a.wy - b.wy) < MIN_PAIR) return;
		const faction = g.faction === 'Horde' ? 'Horde' : 'Alliance';
		const key = `${faction}:${a.c}:${Math.round(a.wx)}:${Math.round(a.wy)}:${b.c}:${Math.round(b.wx)}:${Math.round(b.wy)}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ guide: g.id, faction, from: a, to: b });
	};
	for (const g of guides) {
		const pts = located.get(g.id);
		for (let i = 1; i < pts.length; i++) add(g, pts[i - 1], pts[i]);
		const next = g.next && byId.get(g.next);
		const after = next && located.get(next.id);
		if (pts.length && after && after.length) add(g, pts[pts.length - 1], after[0]);
	}
	return out;
}

function jobOf(pair) {
	const { from, to } = pair;
	return {
		c: from.c,
		wx: from.wx,
		wy: from.wy,
		map: from.map,
		target: { c: to.c, wx: to.wx, wy: to.wy, label: to.label || 'target', map: to.map, x: to.x, y: to.y, f: 'e' },
		faction: FACTIONS[pair.faction.toLowerCase()],
		known: {},
	};
}

// --- report ---------------------------------------------------------------------------------

const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : 0);
const r1 = (v) => Math.round(v * 10) / 10;

// Walk legs of a plan: [{ from, to, yards, ok (straight line walkable), key }].
function walkLegs(plan, los) {
	if (!plan.legs) return [];
	const out = [];
	for (const leg of plan.legs) {
		if (leg.kind !== 'walk' || !leg.from || !leg.to || leg.from.c !== leg.to.c) continue;
		const a = leg.from;
		const b = leg.to;
		const yards = Math.hypot(a.wx - b.wx, a.wy - b.wy);
		if (yards < 1) continue;
		const key = `${a.c}:${Math.round(a.wx)}:${Math.round(a.wy)}:${Math.round(b.wx)}:${Math.round(b.wy)}`;
		out.push({ from: a, to: b, yards, ok: los(a, b, key), key, caption: leg.label });
	}
	return out;
}

function zoneLabel(frames, map) {
	return frames.name(map) || String(map);
}

// pairs: guidePairs; set: the validated aids (validateCrossings); reference: the
// validated reference file or null; stats: generateAids stats.
function arrowReport({ nav, frames, pairs, before, after, set, reference = null, stats = null, build = null, seconds = null, log = () => {} }) {
	const losCache = new Map();
	const los = (a, b, key) => {
		if (losCache.has(key)) return losCache.get(key);
		const v = nav.los({ c: a.c, wx: a.wx, wy: a.wy }, { c: b.c, wx: b.wx, wy: b.wy });
		losCache.set(key, v);
		return v;
	};
	const total = { pairs: pairs.length, before: tally(), after: tally() };
	const zones = new Map();
	const remaining = new Map();
	let done = 0;
	pairs.forEach((pair, i) => {
		const zone = zoneLabel(frames, pair.from.map);
		if (!zones.has(zone)) zones.set(zone, { zone, pairs: 0, before: tally(), after: tally() });
		const z = zones.get(zone);
		z.pairs++;
		for (const [mode, plan] of [['before', before[i]], ['after', after[i]]]) {
			const legs = walkLegs(plan, los);
			count(total[mode], plan, legs);
			count(z[mode], plan, legs);
			if (mode === 'after') {
				for (const l of legs) {
					if (l.ok) continue;
					if (!remaining.has(l.key)) remaining.set(l.key, { ...l, pairs: 0, guide: pair.guide, zone });
					remaining.get(l.key).pairs++;
				}
			}
		}
		if (++done % 1000 === 0) log(`checked ${done} of ${pairs.length} pairs`);
	});
	for (const t of [total.before, total.after, ...[...zones.values()].flatMap((z) => [z.before, z.after])]) finish(t);
	// The worst remaining legs: the longest blocked ones, by how much longer the grid's way is.
	const foot = profileFor({});
	const worst = [...remaining.values()].sort((a, b) => b.yards - a.yards).slice(0, WORST_ROUTED);
	for (const w of worst) {
		const r = nav.route({ c: w.from.c, wx: w.from.wx, wy: w.from.wy }, { c: w.to.c, wx: w.to.wx, wy: w.to.wy }, foot);
		w.grid = r.ok ? { yards: Math.round(r.yards), seconds: Math.round(r.seconds) } : { reason: r.reason };
		w.extra = r.ok ? r.yards - w.yards : Infinity;
	}
	worst.sort((a, b) => b.extra - a.extra || b.yards - a.yards);
	const where = (p) => {
		const z = frames.containing(p.c, p.wx, p.wy)[0];
		return { c: p.c, wx: r1(p.wx), wy: r1(p.wy), ...(z ? { map: z.map, zone: zoneLabel(frames, z.map), x: r1(z.x), y: r1(z.y) } : {}) };
	};
	const worstOut = worst.slice(0, WORST).map((w) => ({
		zone: w.zone, guide: w.guide, pairs: w.pairs, yards: Math.round(w.yards), caption: w.caption || null,
		from: where(w.from), to: where(w.to), grid: w.grid,
	}));
	const json = {
		build,
		seconds,
		settings: { faction: 'the guide\'s (neutral guides: Alliance)', flightMasters: 'none known', hearth: 'none', minPair: MIN_PAIR, match: MATCH },
		counts: { aids: crossingCounts(set), continents: stats ? stats.continents : null },
		legs: total,
		zones: [...zones.values()].sort((a, b) => b.after.blocked - a.after.blocked || a.zone.localeCompare(b.zone)),
		worst: worstOut,
		reference: reference ? compareReference(set, reference, frames) : null,
	};
	return { json, md: renderMd(json) };
}

function tally() {
	return { planned: 0, failed: 0, reasons: {}, withWalk: 0, blocked: 0, walkLegs: 0, blockedLegs: 0, walkYards: 0, blockedYards: 0 };
}

function count(t, plan, legs) {
	if (!plan.legs) {
		t.failed++;
		t.reasons[plan.reason] = (t.reasons[plan.reason] || 0) + 1;
		return;
	}
	t.planned++;
	if (!legs.length) return;
	t.withWalk++;
	let blocked = false;
	for (const l of legs) {
		t.walkLegs++;
		t.walkYards += l.yards;
		if (!l.ok) {
			t.blockedLegs++;
			t.blockedYards += l.yards;
			blocked = true;
		}
	}
	if (blocked) t.blocked++;
}

function finish(t) {
	t.blockedShare = pct(t.blocked, t.withWalk);
	t.blockedYardShare = pct(t.blockedYards, t.walkYards);
	t.walkYards = Math.round(t.walkYards);
	t.blockedYards = Math.round(t.blockedYards);
}

// How many reference entries have a generated counterpart.
function compareReference(set, ref, frames) {
	const d = (a, b) => (a.c === b.c ? Math.hypot(a.wx - b.wx, a.wy - b.wy) : Infinity);
	const pairKey = (a, b) => `${Math.min(a, b)}-${Math.max(a, b)}`;
	const out = { crossings: { total: ref.crossings.length, matched: 0, misses: [] }, open: { total: ref.open.length, matched: 0, misses: [] }, chains: { total: ref.chains.length, matched: 0, misses: [] } };
	for (const e of ref.crossings) {
		const same = set.crossings.filter((g) => pairKey(g.a.map, g.b.map) === pairKey(e.a.map, e.b.map));
		let best = Infinity;
		for (const g of same) {
			const [ga, gb] = g.a.map === e.a.map ? [g.a, g.b] : [g.b, g.a];
			best = Math.min(best, Math.max(d(ga, e.a), d(gb, e.b)));
		}
		if (best <= MATCH) out.crossings.matched++;
		else {
			const open = set.open.some((o) => pairKey(o.a, o.b) === pairKey(e.a.map, e.b.map));
			out.crossings.misses.push({
				id: e.id, a: { map: e.a.map, x: e.a.x, y: e.a.y }, b: { map: e.b.map, x: e.b.x, y: e.b.y },
				nearest: Number.isFinite(best) ? Math.round(best) : null, generatedForPair: same.length, openPair: open,
			});
		}
	}
	for (const o of ref.open) {
		if (set.open.some((g) => pairKey(g.a, g.b) === pairKey(o.a, o.b))) out.open.matched++;
		else out.open.misses.push({ a: o.a, b: o.b, zones: `${frames.name(o.a)} / ${frames.name(o.b)}`, crossings: set.crossings.filter((g) => pairKey(g.a.map, g.b.map) === pairKey(o.a, o.b)).length });
	}
	for (const ch of ref.chains) {
		const m = ch.nodes[0];
		let best = Infinity;
		for (const g of set.chains) best = Math.min(best, d(g.nodes[0], m));
		if (best <= MATCH) out.chains.matched++;
		else out.chains.misses.push({ id: ch.id, mouth: { map: m.map, x: m.x, y: m.y }, nearest: Number.isFinite(best) ? Math.round(best) : null });
	}
	return out;
}

function renderMd(j) {
	const L = [];
	const names = { 0: 'Eastern Kingdoms', 1: 'Kalimdor' };
	L.push('# Arrow aids from the navigation grid');
	L.push('');
	L.push(`Nav build ${j.build}${j.seconds !== null ? `; generated and measured in ${Math.round(j.seconds)} s` : ''}. Written by \`node tools/polestar.js nav aids --report\` (tools/lib/nav/aids.js, arrow.js).`);
	L.push('');
	L.push('## Counts');
	L.push('');
	L.push('| Continent | Open pairs | Crossings | One way | Chains | Chain nodes | Targets tested | In pockets |');
	L.push('|---|---:|---:|---:|---:|---:|---:|---:|');
	for (const [c, n] of Object.entries(j.counts.aids)) {
		const s = j.counts.continents && j.counts.continents[c];
		L.push(`| ${names[c] || c} | ${n.open} | ${n.crossings} | ${s ? s.oneWay : ''} | ${n.chains} | ${n.chainNodes} | ${s ? s.targets : ''} | ${s ? s.pockets : ''} |`);
	}
	if (j.counts.continents) {
		L.push('');
		for (const [c, s] of Object.entries(j.counts.continents)) {
			L.push(`- ${names[c] || c}: crossing kinds ${JSON.stringify(s.crossingKinds)}, chain kinds ${JSON.stringify(s.chainKinds)}; targets not in pockets: ${JSON.stringify(s.notPockets)}.`);
		}
	}
	L.push('');
	L.push('## Guide legs: the arrow before and after');
	L.push('');
	L.push(`Every consecutive pair of located goals in our guides (${j.legs.pairs} pairs, at least ${j.settings.minPair} yd apart), planned by the addon (Nav/Travel.lua) for the guide's faction (neutral guides: Alliance) with no flight master known and no Hearthstone, without the aids and with them. A pair is blocked when a walk leg of its route has a straight line the grid cannot walk (nav.los).`);
	L.push('');
	L.push('| | Planned | Failed | With a walk | Blocked pairs | Share | Walk legs | Blocked legs | Blocked walk yards |');
	L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
	for (const mode of ['before', 'after']) {
		const t = j.legs[mode];
		L.push(`| ${mode === 'before' ? 'Without aids' : 'With aids'} | ${t.planned} | ${t.failed} | ${t.withWalk} | ${t.blocked} | ${t.blockedShare}% | ${t.walkLegs} | ${t.blockedLegs} | ${t.blockedYardShare}% |`);
	}
	const reasons = j.legs.after.reasons;
	if (Object.keys(reasons).length) L.push('', `With aids, planner failures: ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
	L.push('');
	L.push('### Per zone (zone of the leg\'s first goal)');
	L.push('');
	L.push('| Zone | Pairs | Blocked before | After | Share before | After | Failed after |');
	L.push('|---|---:|---:|---:|---:|---:|---:|');
	for (const z of j.zones) L.push(`| ${z.zone} | ${z.pairs} | ${z.before.blocked} | ${z.after.blocked} | ${z.before.blockedShare}% | ${z.after.blockedShare}% | ${z.after.failed} |`);
	L.push('');
	L.push(`### The ${j.worst.length} worst remaining legs`);
	L.push('');
	L.push('Walk legs with aids whose straight line the grid cannot walk, the longest first by how much longer the grid\'s own route on foot is (Era map percent; "pairs": guide pairs using the leg).');
	L.push('');
	L.push('| Zone | From | To | Straight yd | Grid route | Pairs | Guide |');
	L.push('|---|---|---|---:|---|---:|---|');
	const at = (p) => (p.zone ? `${p.zone} ${p.x}, ${p.y}` : `${p.wx}, ${p.wy}`);
	for (const w of j.worst) L.push(`| ${w.zone} | ${at(w.from)} | ${at(w.to)} | ${w.yards} | ${w.grid.yards !== undefined ? `${w.grid.yards} yd, ${w.grid.seconds} s` : w.grid.reason} | ${w.pairs} | ${w.guide} |`);
	if (j.reference) {
		const r = j.reference;
		L.push('');
		L.push('## Against the reference crossings file (report only)');
		L.push('');
		L.push(`Counterparts: crossings ${r.crossings.matched} of ${r.crossings.total} (both ends within ${j.settings.match} yd), open pairs ${r.open.matched} of ${r.open.total} (same zone pair), chains ${r.chains.matched} of ${r.chains.total} (mouth within ${j.settings.match} yd).`);
		if (r.crossings.misses.length) {
			L.push('', 'Crossings without a counterpart:', '');
			for (const m of r.crossings.misses) L.push(`- ${m.id}: ${m.a.map} ${m.a.x}, ${m.a.y} -> ${m.b.map} ${m.b.x}, ${m.b.y}; nearest generated for the pair ${m.nearest === null ? 'none' : `${m.nearest} yd`} (${m.generatedForPair} generated${m.openPair ? ', the pair is open' : ''})`);
		}
		if (r.open.misses.length) {
			L.push('', 'Open pairs not open here:', '');
			for (const m of r.open.misses) L.push(`- ${m.zones} (${m.crossings} crossings generated)`);
		}
		if (r.chains.misses.length) {
			L.push('', 'Chains without a counterpart:', '');
			for (const m of r.chains.misses) L.push(`- ${m.id}: mouth ${m.mouth.map} ${m.mouth.x}, ${m.mouth.y}; nearest generated mouth ${m.nearest === null ? 'none' : `${m.nearest} yd`}`);
		}
	}
	L.push('');
	return L.join('\n');
}

module.exports = { planRoutes, guidePairs, jobOf, arrowReport, compareReference, renderReport: renderMd, MIN_PAIR, MATCH };
