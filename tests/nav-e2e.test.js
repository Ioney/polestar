'use strict';
// End to end: the arrow on Shortest Path Forever's real walking engine. The
// real Polestar (with TravelData, the guides' Era map frames, and the local
// crossings when built) loads the real Polestar_Nav on demand at login, its
// maps decoded by tests/lua/stub_encoding.lua the way the client decodes them;
// the stub world's maps are data/forever/map-frames.json's, and UnitPosition
// answers from the same place (x north, y west, z, the instance map id). A
// character in Goldshire is guided to the Fargodeep Mine; the engine's path
// must come back through Nav/Walk.lua, Nav/Travel.lua and Nav.Sample to the
// arrow. Every other arrow test fakes the engine (tests/nav-spf.test.js) and
// the other real-engine tests call it directly (tests/nav-vendor.test.js): a
// frame mismatch between the two (north/west swapped, a uiMapID for the
// instance id, a dropped height) passes those and fails only here. Checks
// name their docs/NAV_QA.md rows.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runAddon, tocFiles, ADDONS, ROOT } = require('./helpers/lua');
const { needs, DATA } = require('./helpers/data');
const { tmpdir } = require('./helpers/tmp');
const { findLua } = require('../tools/lib/lua');

function skipReason() {
	try {
		findLua();
	} catch (err) {
		return err.message;
	}
	const data = needs('map-frames.json', 'zones.json');
	if (data) return data;
	if (!fs.existsSync(path.join(ADDONS, 'Polestar_Nav', 'Nav', 'Nav.xml'))) return 'addon/Polestar_Nav has no walking maps (node tools/polestar.js nav vendor)';
	if (!fs.existsSync(path.join(ADDONS, 'Polestar_Guides', 'MapFrames.lua'))) return 'addon/Polestar_Guides/MapFrames.lua not built (node tools/polestar.js compile)';
	return false;
}
const skip = skipReason();

// The stub world's maps: the live (Forever) frame where it differs, else Era's.
function mapsLua() {
	const frames = JSON.parse(fs.readFileSync(path.join(DATA, 'map-frames.json'), 'utf8'));
	const zones = JSON.parse(fs.readFileSync(path.join(DATA, 'zones.json'), 'utf8'));
	const all = { ...frames.era, ...frames.forever };
	return Object.entries(all).map(([id, f]) => {
		const z = zones[id] || {};
		return `w.addMap(${id}, { name = ${JSON.stringify(z.name || '')}, c = ${f.c}, left = ${f.left}, right = ${f.right}, top = ${f.top}, bottom = ${f.bottom}, parent = ${z.parent || 0}, mapType = ${z.type || 3} })`;
	}).join('\n');
}

let nsFile;
function before() {
	if (!nsFile) {
		// Appended to Polestar_Nav's files: keeps its namespace, for the snapped-node check.
		nsFile = path.join(tmpdir('polestar-nav-e2e-'), 'keep-ns.lua');
		fs.writeFileSync(nsFile, 'local _, ns = ...\nstub.navNs = ns\n');
	}
	return `local w = stub.world
${mapsLua()}
stub.packs.Polestar_Nav = { ${[...tocFiles('Polestar_Nav'), nsFile].map((f) => JSON.stringify(f)).join(', ')} }
-- UnitPosition: the world position the live map frame gives, z as set, the instance map id.
function UnitPosition(unit)
	if unit ~= "player" or not w.map or w.inInstance then return nil end
	local c, pos = C_Map.GetWorldPosFromMapPos(w.map, CreateVector2D(w.x / 100, w.y / 100))
	if not c then return nil end
	return pos.x, pos.y, w.z, c
end`;
}

const PRELUDE = `
local w, N, C = stub.world, Polestar.Nav, Polestar.Compat
local E = Polestar_NavEngine
local floor, sqrt = math.floor, math.sqrt
local function r1(v) return v and floor(v * 10 + 0.5) / 10 end
-- Every search the arrow asks for, with what it was asked and what came back.
local finds = {}
local realFind = E.Find
E.Find = function(map, from, to, callback, water)
	local rec = { map = map, from = { from.x, from.y, from.z }, to = { to.x, to.y, to.z }, at = GetTime(), combat = InCombatLockdown() and true or false }
	finds[#finds + 1] = rec
	return realFind(map, from, to, function(points, cost, job)
		rec.points, rec.cost, rec.done = points, cost, true
		callback(points, cost, job)
	end, water)
end
-- Stand at world (wx, wy) on map, through the live frame, as the client reports it.
local function place(map, wx, wy, z)
	local c = C_Map.GetWorldPosFromMapPos(map, CreateVector2D(0.5, 0.5))
	local x, y = C.WorldToMap(c, wx, wy, map)
	w.moveTo(map, x, y)
	w.z = z
end
-- The arrow's sample: state, yards shown, the world point it aims at, measured along a path.
local function aim()
	local state, dist, _, dn, dw, measured = N.Sample()
	local _, px, py = C.GetPlayerWorldPosition()
	if not dn then return { state = state } end
	return { state = state, dist = dist, x = px + dn, y = py + dw, measured = measured == true }
end
-- The index of path point (x, y) in a search's answer, or nil.
local function indexOf(rec, x, y)
	for i, p in ipairs(rec and rec.points or {}) do
		if math.abs(p.x - x) < 1e-6 and math.abs(p.y - y) < 1e-6 then return i end
	end
end
local function length(points)
	local len = 0
	for i = 2, #points do len = len + sqrt((points[i].x - points[i - 1].x) ^ 2 + (points[i].y - points[i - 1].y) ^ 2) end
	return len
end
local function dist(ax, ay, bx, by) return sqrt((ax - bx) ^ 2 + (ay - by) ^ 2) end
-- Nearest distance from (x, y) to the polyline.
local function offPath(points, x, y)
	local best = math.huge
	for i = 2, #points do
		local a, b = points[i - 1], points[i]
		local dx, dy = b.x - a.x, b.y - a.y
		local l2 = dx * dx + dy * dy
		local t = l2 > 0 and math.max(0, math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) or 0
		best = math.min(best, dist(a.x + dx * t, a.y + dy * t, x, y))
	end
	return best
end
local GOLDSHIRE = { -9444.062, 77.667, 57.353 } -- UnitPosition in front of the Lion's Pride Inn (tests/nav-vendor.test.js)
local LOWER_MOUTH = { -9791.249, 164.438, 27.373 } -- the Fargodeep Mine's lower mouth, likewise
-- Goldshire, guided to the Fargodeep Mine (Elwynn, Era 39.5,82.4); frames run until the path is in.
local function guide(map, x, y, label)
	N.SetTarget(map or 1429, x or 39.5, y or 82.4, label or "Fargodeep Mine", "e")
	aim()
	local n = 0
	while not (finds[#finds] and finds[#finds].done) and n < 100 do stub.advance(0.05); n = n + 1 end
	return finds[#finds]
end
`;

// Runs the scenario; its emitted record goes to the test's diagnostics (the numbers behind each check).
function run(t, script) {
	const addons = ['Polestar', { name: 'Polestar_Guides', files: ['MapFrames.lua'] }];
	if (fs.existsSync(path.join(ADDONS, 'Polestar_Travel', 'Polestar_Travel.toc'))) addons.push('Polestar_Travel');
	const [out] = runAddon({
		stubs: ['stub_world.lua', 'stub_encoding.lua', 'stub_packs.lua'],
		before: before(),
		addons,
		login: true,
		script: `${PRELUDE}\n${script}`,
	}).emitted;
	t.diagnostic(JSON.stringify(out));
	return out;
}

test('a: Polestar\'s world frame is the engine\'s: known UnitPosition spots and guide coordinates land on the engine\'s nodes, at their height, on instance map 0', { skip }, (t) => {
	const out = run(t, `
		local r = { loads = stub.packLoads.Polestar_Nav, engine = N.Path == E }
		r.cs = stub.navNs.PathGrid.State(0).cs
		local ns = stub.navNs
		local G = ns.PathGrid
		local st = G.State(0)
		-- The engine's node a point snaps to: its centre and height.
		local function node(x, y, z)
			local k, lc = G.locate(st, x, y)
			if not k then return { outside = true } end
			local n = G.snap(st, k, lc, x, y, z)
			if not n then return { offmesh = true } end
			local cell = G.cellOf(st, k, n)
			local cx = st.x0 + (floor(k / st.ny) * st.C + floor(cell / st.C) + 0.5) * st.cs
			local cy = st.y0 + ((k % st.ny) * st.C + cell % st.C + 0.5) * st.cs
			return { d = dist(cx, cy, x, y), z = st.z[k][n + 1] }
		end
		local function spot(map, ux, uy, uz)
			-- UnitPosition -> Polestar's map coordinates -> Polestar's world point -> the engine's node there.
			local x, y = C.WorldToMap(0, ux, uy, map)
			local c, wx, wy = C.MapToWorld(map, x, y, "e")
			local n = node(wx, wy, uz)
			return { map = { r1(x), r1(y) }, c = c, back = dist(wx, wy, ux, uy), node = n.d, dz = n.z and math.abs(n.z - uz), swapped = node(wy, wx, uz).outside == true }
		end
		r.goldshire = spot(1429, GOLDSHIRE[1], GOLDSHIRE[2], GOLDSHIRE[3])
		r.lowerMouth = spot(1429, LOWER_MOUTH[1], LOWER_MOUTH[2], LOWER_MOUTH[3])
		local c, mx, my = C.MapToWorld(1429, 39.5, 82.4, "e")
		r.mine = { c = c, node = node(mx, my).d }
		r.available = { E.Available(c), E.Available(1429), E.Available(1415) }
		-- What the arrow asks: the player's UnitPosition (with its height) on instance 0, to Polestar's target point.
		place(1429, GOLDSHIRE[1], GOLDSHIRE[2], GOLDSHIRE[3])
		local pc, px, py = C.GetPlayerWorldPosition()
		r.player = { pc, dist(px, py, GOLDSHIRE[1], GOLDSHIRE[2]) }
		local f = guide()
		r.ask = { n = #finds, map = f.map, from = dist(f.from[1], f.from[2], GOLDSHIRE[1], GOLDSHIRE[2]), z = f.from[3], to = dist(f.to[1], f.to[2], mx, my), toZ = f.to[3] }
		r.points = #f.points
		r.secondZ = f.points[2].z
		emit(r)`);
	assert.equal(out.loads, 1, 'Data.Pack loaded Polestar_Nav once at login');
	assert.equal(out.engine, true);
	// Goldshire: Elwynn 42.0,65.0; the mine's lower mouth 39.5,80.0.
	assert.deepEqual(out.goldshire.map, [42, 65]);
	assert.deepEqual(out.lowerMouth.map, [39.5, 80]);
	for (const [name, s] of Object.entries({ goldshire: out.goldshire, lowerMouth: out.lowerMouth })) {
		assert.equal(s.c, 0, `${name}: Polestar's continent is UnitPosition's instance map id`);
		assert.ok(s.back < 0.01, `${name}: map -> world gives the UnitPosition back (${s.back})`);
		assert.ok(s.node < out.cs, `${name}: the engine's node is ${s.node.toFixed(2)} yd from Polestar's point (cells are ${out.cs.toFixed(2)} yd)`);
		assert.ok(s.dz < 3, `${name}: and at the height UnitPosition reads there (off by ${s.dz.toFixed(2)})`);
		assert.equal(s.swapped, true, `${name}: north and west swapped would be off the engine's map`);
	}
	assert.equal(out.mine.c, 0);
	assert.ok(out.mine.node < out.cs, `the guide's 39.5,82.4 snaps ${out.mine.node.toFixed(2)} yd away, within a cell`);
	assert.deepEqual(out.available, [true, false, false], 'the engine knows instance 0, not the uiMapIDs 1429/1415');
	assert.deepEqual(out.player, [0, out.player[1]]);
	assert.ok(out.player[1] < 0.01);
	assert.equal(out.ask.n, 1);
	assert.equal(out.ask.map, 0);
	assert.ok(out.ask.from < 0.01 && out.ask.to < 0.01, 'from the player, to the target, in the same yards');
	assert.equal(out.ask.z, 57.353, 'the player\'s height goes with the search');
	assert.equal(out.ask.toZ, undefined, 'a map target has no height');
	assert.ok(out.points >= 3 && Math.abs(out.secondZ - 57) < 15, `a ${out.points}-point path on the ground (z ${out.secondZ})`);
});

test('b, e, f: the arrow aims at the engine path\'s next point; the route lines and the journey carry the same path', { skip }, (t) => {
	const out = run(t, `
		local r = {}
		place(1429, GOLDSHIRE[1], GOLDSHIRE[2], GOLDSHIRE[3])
		local f = guide()
		stub.advance(0.2) -- the arrow's own samples (20 Hz)
		local a = aim()
		local pts = f.points
		local _, tx, ty = N.GetTargetWorld()
		r.aim = { state = a.state, index = indexOf(f, a.x, a.y), n = #pts, measured = a.measured, dist = a.dist, off = offPath(pts, a.x, a.y), toTarget = dist(a.x, a.y, tx, ty) }
		r.path = { length = length(pts), straight = dist(GOLDSHIRE[1], GOLDSHIRE[2], tx, ty), endGap = dist(pts[#pts].x, pts[#pts].y, tx, ty) }
		r.left = { walk = N.walk.Left(0, tx, ty), along = length(pts) }
		r.shown = { text = N.arrow.distText:GetText(), want = Polestar.FormatDistance(floor(a.dist + 0.5)), visible = PolestarNavArrow:IsShown() }
		-- e: the route lines' walk leg is the engine's path, the player first.
		local g = N.GetRouteGeometry()
		local walk
		for _, leg in ipairs(g.legs) do if leg.kind == "walk" and leg.current then walk = leg end end
		local same = #walk.pts == #pts
		for i, p in ipairs(walk.pts) do
			if not pts[i] or p[1] ~= 0 or p[2] ~= pts[i].x or p[3] ~= pts[i].y then same = false end
		end
		r.geometry = { legs = #g.legs, n = #walk.pts, same = same, first = dist(walk.pts[1][2], walk.pts[1][3], GOLDSHIRE[1], GOLDSHIRE[2]) }
		-- f: the journey's legs.
		local legs, ci = N.GetRoute()
		local T = N.travel
		local list, finite, sum = {}, true, 0
		for i = ci, #legs do
			local l = legs[i]
			list[#list + 1] = { l.kind, l.label, l.seconds, l.yards }
			if l.seconds ~= l.seconds or l.seconds == math.huge or l.yards ~= l.yards then finite = false end
			sum = sum + l.seconds
		end
		local ps, py = T.Progress()
		r.journey = { legs = list, finite = finite, sum = sum, total = legs[ci].seconds + legs[ci].rest, progress = { ps, py }, remaining = T.Remaining(a.dist, true), speed = py and ps and py / ps,
			yards = legs[ci].yards, seconds = legs[ci].seconds, straight = { legs[ci].straightYards, legs[ci].straightSeconds } }
		r.finds = #finds
		emit(r)`);
	// b
	assert.equal(out.aim.state, 'travel');
	assert.equal(out.aim.measured, true, 'the distance is along the path');
	assert.equal(out.aim.index, 2, `the arrow aims at the path's second point (of ${out.aim.n}), not the target`);
	assert.ok(out.aim.toTarget > 50, `the aimed point is ${out.aim.toTarget.toFixed(0)} yd short of the target`);
	assert.ok(out.aim.off < 1e-6, 'and on the path');
	assert.ok(out.path.endGap < 10, `the path ends ${out.path.endGap.toFixed(1)} yd from the target`);
	assert.ok(Math.abs(out.aim.dist - out.path.length) < 0.5, `the arrow shows the path's length (${out.aim.dist.toFixed(1)} vs ${out.path.length.toFixed(1)})`);
	assert.ok(out.path.length >= out.path.straight, `path ${out.path.length.toFixed(0)} yd, straight ${out.path.straight.toFixed(0)} yd`);
	assert.ok(Math.abs(out.left.walk - out.path.length) < 0.5, 'Walk.Left is the path left');
	assert.equal(out.shown.text, out.shown.want, 'the arrow\'s distance text is that path length');
	// e
	assert.equal(out.geometry.same, true, 'the walk leg\'s points are the engine\'s path, point for point');
	assert.ok(out.geometry.first < 0.01, 'starting where the player stands');
	// f (K1, K6, K7)
	assert.equal(out.finds, 1);
	assert.ok(out.journey.legs.length >= 1);
	for (const [kind, label, seconds, yards] of out.journey.legs) {
		assert.ok(typeof label === 'string' && label !== '' && label !== 'Unknown', `K1: the ${kind} leg is named (${label})`);
		assert.ok(Number.isFinite(seconds) && Number.isFinite(yards), `K7: finite (${seconds} s, ${yards} yd)`);
	}
	assert.equal(out.journey.finite, true);
	assert.equal(out.journey.sum, out.journey.total, 'K6: the legs\' times add up to the walk\'s');
	assert.ok(out.journey.progress.every(Number.isFinite), 'K7: the walk\'s progress is finite');
	assert.ok(Math.abs(out.journey.progress[1] - out.path.length) < 0.5, 'and measured along the engine\'s path');
	assert.ok(Number.isFinite(out.journey.remaining));
	// f: once the path is in, the walk leg is measured along it, at the planner's 7 yd/s.
	assert.ok(Math.abs(out.journey.yards - out.path.length) <= 1, `the walk leg is ${out.journey.yards} yd, the path ${out.path.length.toFixed(1)} yd`);
	assert.ok(Math.abs(out.journey.seconds - out.journey.yards / 7) <= 1, `${out.journey.seconds} s for ${out.journey.yards} yd`);
	assert.ok(out.journey.straight[0] > out.journey.yards, `its straight estimate (${out.journey.straight[0]} yd) is kept for when the path goes`);
});

test('second review: after the path arrives the arrow, the panel\'s leg time and the header total agree', { skip }, (t) => {
	const out = run(t, `
		place(1429, GOLDSHIRE[1], GOLDSHIRE[2], GOLDSHIRE[3])
		guide()
		stub.advance(0.2)
		local a = aim()
		local legs, ci = N.GetRoute()
		local T = N.travel
		local view = Polestar.UI.JourneyPanel.Compute(legs, ci)
		emit({ arrow = T.Remaining(a.dist, true), leg = view.secs[1], header = view.total, planned = legs[ci].seconds + legs[ci].rest })`);
	assert.ok(Math.abs(out.arrow - out.header) <= 1, `arrow ${out.arrow} s, header ${out.header} s`);
	assert.ok(Math.abs(out.leg - out.header) <= 1, `leg ${out.leg} s, header ${out.header} s`);
	assert.ok(Math.abs(out.planned - out.header) <= 1, `the legs' planned times (${out.planned} s) and the header (${out.header} s)`);
});

test('b: where the straight line is blocked (Thelsamar to the Stonewrought Dam) the arrow follows the detour', { skip }, (t) => {
	const out = run(t, `
		local c, sx, sy = C.MapToWorld(1432, 35.5, 47, "e")
		place(1432, sx, sy)
		local f = guide(1432, 48, 15, "Stonewrought Dam")
		local a = aim()
		local _, tx, ty = N.GetTargetWorld()
		emit({ map = f.map, n = #f.points, length = length(f.points), straight = dist(sx, sy, tx, ty), index = indexOf(f, a.x, a.y),
			toTarget = dist(a.x, a.y, tx, ty), endGap = dist(f.points[#f.points].x, f.points[#f.points].y, tx, ty), dist = a.dist })`);
	assert.equal(out.map, 0);
	assert.ok(out.length > out.straight * 1.2, `path ${out.length.toFixed(0)} yd against ${out.straight.toFixed(0)} yd straight`);
	assert.equal(out.index, 2, `the arrow aims at the detour's first corner (of ${out.n} points)`);
	assert.ok(out.toTarget > 100);
	assert.ok(out.endGap < 10);
	assert.ok(Math.abs(out.dist - out.length) < 0.5, 'the yards shown are the detour\'s');
});

test('c: walking the path point by point advances the aim, never asks the engine again, and arrives', { skip }, (t) => {
	const out = run(t, `
		place(1429, GOLDSHIRE[1], GOLDSHIRE[2], GOLDSHIRE[3])
		local f = guide()
		local pts = f.points
		local seen, backwards, last, steps, states = {}, 0, 1, 0, {}
		local function look()
			local a = aim()
			states[a.state] = (states[a.state] or 0) + 1
			if a.x then
				local i = indexOf(f, a.x, a.y)
				if i then
					if i < last then backwards = backwards + 1 end
					last = i
					seen[#seen + 1] = i
				end
			end
			return a
		end
		for i = 2, #pts do
			local a, b = pts[i - 1], pts[i]
			local n = math.max(1, math.ceil(dist(a.x, a.y, b.x, b.y) / 4))
			for s = 1, n do
				local t = s / n
				place(1429, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z and b.z and a.z + (b.z - a.z) * t or nil)
				stub.advance(0.5) -- 8 yd/s: the arrow samples on its own meanwhile
				look()
				steps = steps + 1
			end
		end
		local distinct = {}
		for _, i in ipairs(seen) do if distinct[#distinct] ~= i then distinct[#distinct + 1] = i end end
		emit({ n = #pts, distinct = distinct, backwards = backwards, finds = #finds, steps = steps, final = aim().state, states = states })`);
	assert.equal(out.backwards, 0, 'the aimed point never goes back');
	assert.deepEqual(out.distinct, Array.from({ length: out.n - 1 }, (_, i) => i + 2), `the aim went through every point after the first, in order, to the last (of ${out.n})`);
	assert.equal(out.finds, 1, `${out.steps} steps along the path, no new search`);
	assert.equal(out.final, 'arrived');
});

test('d: 30+ yards off the path asks once, after the 2 s throttle, keeping the old path meanwhile; the arrow follows the new path', { skip }, (t) => {
	const out = run(t, `
		local r = {}
		place(1429, GOLDSHIRE[1], GOLDSHIRE[2], GOLDSHIRE[3])
		local f = guide()
		local a, b = f.points[1], f.points[2]
		-- 40 yd along the first segment, then 35 yd off it, square to it.
		local L = dist(a.x, a.y, b.x, b.y)
		local ux, uy = (b.x - a.x) / L, (b.y - a.y) / L
		local ox, oy = a.x + ux * 40 - uy * 35, a.y + uy * 40 + ux * 35
		place(1429, ox, oy)
		r.off = offPath(f.points, ox, oy)
		local s = aim()
		r.soon = { finds = #finds, index = indexOf(f, s.x, s.y), since = GetTime() - f.at }
		stub.advance(1)
		aim()
		r.stillSoon = #finds
		stub.advance(1.5)
		aim()
		r.after = #finds
		local g = finds[#finds]
		local n = 0
		while not g.done and n < 100 do stub.advance(0.05); n = n + 1 end
		s = aim()
		r.new = { from = dist(g.from[1], g.from[2], ox, oy), index = indexOf(g, s.x, s.y), oldIndex = indexOf(f, s.x, s.y), n = #g.points, gap = GetTime() - f.at }
		stub.advance(5)
		aim()
		r.settled = #finds
		emit(r)`);
	assert.ok(out.off > 30, `${out.off.toFixed(1)} yd off the path`);
	assert.equal(out.soon.finds, 1, `not within 2 s of the last search (${out.soon.since.toFixed(2)} s)`);
	assert.ok(out.soon.index >= 2, 'the old path is kept meanwhile');
	assert.equal(out.stillSoon, 1);
	assert.equal(out.after, 2, 'one new search once 2 s have passed');
	assert.ok(out.new.from < 0.01, 'from where the player stands');
	assert.equal(out.new.index, 2, 'the arrow aims at the new path\'s next point');
	assert.equal(out.settled, 2, 'on the new path nothing more is asked');
});

test('g (row 6, C17): no search starts in combat, the old path is kept, and one runs after combat', { skip }, (t) => {
	const out = run(t, `
		local r = {}
		place(1429, GOLDSHIRE[1], GOLDSHIRE[2], GOLDSHIRE[3])
		local f = guide()
		stub.advance(3)
		stub.inCombat = true
		stub.fire("PLAYER_REGEN_DISABLED")
		local a, b = f.points[1], f.points[2]
		local L = dist(a.x, a.y, b.x, b.y)
		local ux, uy = (b.x - a.x) / L, (b.y - a.y) / L
		local ox, oy = a.x + ux * 60 - uy * 40, a.y + uy * 60 + ux * 40
		place(1429, ox, oy)
		stub.advance(5)
		local s = aim()
		r.fight = { finds = #finds, index = indexOf(f, s.x, s.y), state = s.state }
		-- A new target in combat: the straight arrow, no search either.
		N.SetTarget(1429, 39.5, 80.0, "Lower mouth", "e")
		stub.advance(2)
		s = aim()
		local _, tx, ty = N.GetTargetWorld()
		r.newTarget = { finds = #finds, straight = dist(s.x, s.y, tx, ty) < 0.01 }
		stub.inCombat = false
		stub.fire("PLAYER_REGEN_ENABLED")
		aim()
		r.after = #finds
		local g = finds[#finds]
		local n = 0
		while not g.done and n < 100 do stub.advance(0.05); n = n + 1 end
		s = aim()
		r.follow = { combat = g.combat, from = dist(g.from[1], g.from[2], ox, oy), index = indexOf(g, s.x, s.y) }
		emit(r)`);
	assert.equal(out.fight.finds, 1, 'nothing asked in combat');
	assert.ok(out.fight.index >= 2, 'the old path is kept');
	assert.deepEqual(out.newTarget, { finds: 1, straight: true });
	assert.equal(out.after, 2, 'one search once combat ends');
	assert.equal(out.follow.combat, false);
	assert.ok(out.follow.from < 0.01);
	assert.equal(out.follow.index, 2, 'the arrow follows it');
});
