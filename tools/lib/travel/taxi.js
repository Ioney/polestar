'use strict';
// The flight network from Blizzard's TaxiNodes / TaxiPath / TaxiPathNode.
//
// A node is a flight master when its Flags carry a faction (1 Alliance,
// 2 Horde, 3 both) and it has a CharacterBitNumber (the bit the client sets
// when a character learns it). That drops transport anchors, "Generic, World
// target" helpers, quest-only and druid-only paths (Nighthaven), battleground
// nodes and the Eastern Plaguelands tower flights, none of which a player
// can pick on a flight map.
//
// A leg is a TaxiPath between two flight masters; its length is the 3D
// length of its TaxiPathNode points (what the gryphon actually flies). Its
// track is those points on the ground plane, simplified to TRACK_TOLERANCE
// yards and rounded to the yard: what the map's route lines draw
// (Maps/FlightPaths.lua). A path with a teleport or too few points has none.

const { placePoint, round, dist2d, isJump } = require('./geo');
const { spawnPoints } = require('./entities');

const NPC_MATCH_YARDS = 60;
const TRACK_TOLERANCE = 10;

// Ramer-Douglas-Peucker on wx, wy: the points within `tolerance` yards of the
// line through the kept ones are dropped; both ends always stay.
function simplify(pts, tolerance) {
	const keep = new Array(pts.length).fill(false);
	keep[0] = keep[pts.length - 1] = true;
	const stack = [[0, pts.length - 1]];
	while (stack.length) {
		const [a, b] = stack.pop();
		const A = pts[a], B = pts[b];
		const dx = B.wx - A.wx, dy = B.wy - A.wy;
		const len = Math.hypot(dx, dy);
		let far = -1, worst = tolerance;
		for (let i = a + 1; i < b; i++) {
			const P = pts[i];
			const d = len > 0 ? Math.abs(dx * (A.wy - P.wy) - dy * (A.wx - P.wx)) / len : Math.hypot(P.wx - A.wx, P.wy - A.wy);
			if (d > worst) { worst = d; far = i; }
		}
		if (far > 0) {
			keep[far] = true;
			stack.push([a, far], [far, b]);
		}
	}
	return pts.filter((_, i) => keep[i]);
}

// A path's track: flat [wx, wy, ...] in whole yards, or null.
function track(pts) {
	if (pts.length < 2 || pathLength(pts).teleports) return null;
	const out = [];
	for (const p of simplify(pts, TRACK_TOLERANCE)) out.push(Math.round(p.wx), Math.round(p.wy));
	return out;
}

function num(v) {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

// "Lakeshire, Redridge" -> "Lakeshire"
function shortName(name) {
	const i = name.indexOf(',');
	return (i > 0 ? name.slice(0, i) : name).trim();
}

function pathLength(points) {
	let yards = 0;
	let teleports = 0;
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1];
		const b = points[i];
		if (isJump(a, b)) {
			teleports++;
			continue;
		}
		yards += Math.hypot(b.wx - a.wx, b.wy - a.wy, b.z - a.z);
	}
	return { yards, teleports };
}

// TaxiPathNode rows -> Map pathID -> points ordered by NodeIndex.
function pathPoints(rows) {
	const byPath = new Map();
	for (const r of rows) {
		const id = num(r.PathID);
		if (!id) continue;
		if (!byPath.has(id)) byPath.set(id, []);
		byPath.get(id).push({
			i: num(r.NodeIndex),
			c: num(r.ContinentID),
			wx: num(r.Loc_0),
			wy: num(r.Loc_1),
			z: num(r.Loc_2) || 0,
			flags: num(r.Flags) || 0,
			delay: num(r.Delay) || 0,
		});
	}
	for (const pts of byPath.values()) pts.sort((a, b) => a.i - b.i);
	return byPath;
}

function buildTaxi({ tables, frames, npcs, liveFrames }) {
	const warnings = [];
	const masters = Object.values(npcs || {})
		.filter((n) => (n.roles || []).includes('flightmaster'))
		.sort((a, b) => a.id - b.id)
		.map((n) => ({ npc: n, pts: spawnPoints(n, frames, liveFrames) }));

	const nodes = [];
	const byId = new Map();
	const rows = [...tables.TaxiNodes].sort((a, b) => num(a.ID) - num(b.ID));
	for (const r of rows) {
		const id = num(r.ID);
		const flags = num(r.Flags) || 0;
		const faction = flags & 3;
		if (!id || !faction || !(num(r.CharacterBitNumber) > 0)) continue;
		const c = num(r.ContinentID);
		const wx = num(r.Pos_0);
		const wy = num(r.Pos_1);
		const name = String(r.Name_lang || '').trim();
		if (!frames.continents()[c]) {
			warnings.push(`taxi node ${id} "${name}": continent ${c} has no map frame, skipped`);
			continue;
		}
		// The flight master standing at this node.
		let match = null;
		for (const m of masters) {
			const side = m.npc.faction === 'A' ? 1 : m.npc.faction === 'H' ? 2 : 3;
			if (!(side & faction)) continue;
			for (const p of m.pts) {
				if (p.c !== c) continue;
				const d = dist2d(p, { wx, wy });
				if (d <= NPC_MATCH_YARDS && (!match || d < match.d)) match = { npc: m.npc, d, maps: [] };
			}
		}
		if (match) match.maps = npcMapsAt(match.npc, frames, liveFrames, c, wx, wy);
		const place = placePoint(frames, c, wx, wy, { prefer: match ? match.maps : [], label: name });
		if (!place) {
			warnings.push(`taxi node ${id} "${name}": no zone map holds (${round(wx, 1)}, ${round(wy, 1)}), skipped`);
			continue;
		}
		if (!match) warnings.push(`taxi node ${id} "${name}": no flight master NPC within ${NPC_MATCH_YARDS} yd`);
		const node = {
			id,
			name,
			short: shortName(name),
			c,
			wx: round(wx, 1),
			wy: round(wy, 1),
			map: place.map,
			x: place.x,
			y: place.y,
			faction,
			npc: match ? match.npc.id : null,
			npcName: match ? match.npc.name : null,
		};
		nodes.push(node);
		byId.set(id, node);
	}

	const points = pathPoints(tables.TaxiPathNode);
	const legs = [];
	const paths = [...tables.TaxiPath].sort((a, b) => num(a.ID) - num(b.ID));
	for (const r of paths) {
		const from = byId.get(num(r.FromTaxiNode));
		const to = byId.get(num(r.ToTaxiNode));
		if (!from || !to || from === to) continue;
		const pts = points.get(num(r.ID)) || [];
		if (from.c !== to.c) {
			warnings.push(`taxi path ${r.ID}: ${from.name} -> ${to.name} crosses continents, skipped`);
			continue;
		}
		let { yards, teleports } = pathLength(pts);
		if (pts.length < 2 || teleports) {
			warnings.push(`taxi path ${r.ID}: ${from.name} -> ${to.name} has ${pts.length < 2 ? 'no points' : 'a teleport'}; straight line used`);
			yards = dist2d(from, to);
		}
		legs.push({ path: num(r.ID), from: from.id, to: to.id, yards: Math.round(yards), cost: num(r.Cost) || 0, track: track(pts) });
	}
	legs.sort((a, b) => a.from - b.from || a.to - b.to || a.path - b.path);
	// One leg per ordered pair: the shortest when Blizzard lists several.
	const seen = new Map();
	for (const l of legs) {
		const k = `${l.from}>${l.to}`;
		if (!seen.has(k) || seen.get(k).yards > l.yards) seen.set(k, l);
	}
	const unique = [...seen.values()].sort((a, b) => a.from - b.from || a.to - b.to);
	return { nodes, legs: unique, warnings, points };
}

// Maps on which the matched NPC spawns at the node (placePoint prefers them).
function npcMapsAt(npc, frames, liveFrames, c, wx, wy) {
	const maps = new Set();
	for (const p of spawnPoints(npc, frames, liveFrames)) {
		if (p.c === c && dist2d(p, { wx, wy }) <= NPC_MATCH_YARDS) maps.add(p.map);
	}
	return [...maps].sort((a, b) => a - b);
}

module.exports = { buildTaxi, pathPoints, pathLength, shortName, simplify, NPC_MATCH_YARDS, TRACK_TOLERANCE };
