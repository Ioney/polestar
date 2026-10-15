'use strict';
// Walking paths (addon/Polestar/Nav/Walk.lua): the arrow follows the walking
// engine vendored from Shortest Path Forever (addon/Polestar_Nav) instead of a
// straight line. A fake engine with deterministic callbacks stands in for
// Polestar_NavEngine: the arrow follows the path's points, straying asks
// again, a new target cancels the stale search, nothing is searched in
// combat, hand-made crossings and guide `goto`s win, and every failure (no
// engine, no data, unreachable, an error, the option off) is today's straight
// arrow. Runs the real Core/Init.lua + Nav/Nav.xml against tests/lua/stub_nav.lua.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runAddon } = require('./helpers/lua');

const NAV = { name: 'Polestar', files: ['Core/Init.lua', 'Nav/Nav.xml'] };

// The fake engine, installed before the addon loads (Polestar_Nav's API.lua sets the same global).
const ENGINE = `
fake = { calls = {}, avail = {} }
Polestar_NavEngine = {
	Find = function(map, from, to, callback, waterWalking)
		if fake.throw then error("boom") end
		local job = { map = map, from = from, to = to, callback = callback, waterWalking = waterWalking }
		fake.calls[#fake.calls + 1] = job
		return job
	end,
	Cancel = function(job) job.cancelled = true end,
	Busy = function() return false end,
	Available = function(c) return fake.avail[c] ~= false end,
}
function fake.last() return fake.calls[#fake.calls] end
-- Answer the last search with the path x1, y1, x2, y2, ... (UnitPosition frame).
function fake.resolve(...)
	local job, xy, points = fake.last(), { ... }, {}
	for i = 1, #xy - 1, 2 do points[#points + 1] = { map = job.map, x = xy[i], y = xy[i + 1] } end
	job.callback(points, 100, job)
end
function fake.fail(reason)
	local job = fake.last()
	job.callback(nil, reason, job)
end
`;

const PRELUDE = `
local N = Polestar.Nav
local nav = stub.nav
local floor = math.floor
local function target(wx, wy, label)
	local m, x, y = nav.mapPoint(wx, wy)
	N.SetTarget(m, x, y, label or "Target")
end
-- state, yards shown, and the world point the arrow aims at (rounded).
local function aim()
	local state, dist, _, dn, dw = N.Sample()
	local p = nav.player
	if not dn then return { state } end
	return { state, floor(dist + 0.5), floor(p.wx + dn + 0.5), floor(p.wy + dw + 0.5) }
end
local function calls() return #fake.calls end
`;

function run(script, { engine = true } = {}) {
	return runAddon({
		stubs: ['stub_nav.lua'],
		before: engine ? ENGINE : 'fake = { calls = {} }',
		addons: [NAV],
		login: true,
		script: `${PRELUDE}\n${script}`,
	}).emitted;
}

test('the arrow follows the path\'s points, with the yards left along it', () => {
	const [out] = run(`
		local r = {}
		nav.place(0, 0)
		target(0, -600)
		r.before = aim()
		local job = fake.last()
		r.ask = { calls(), job.map, floor(job.from.x), floor(job.from.y), floor(job.to.x + 0.5), floor(job.to.y + 0.5) }
		fake.resolve(0, 0, 100, -100, 100, -500, 0, -600)
		r.first = aim()
		nav.place(100, -100)
		r.corner = aim()
		nav.place(100, -300)
		r.along = aim()
		nav.place(0, -598)
		r.arrived = aim()[1]
		r.calls = calls()
		emit(r)`);
	assert.deepEqual(out.before, ['travel', 600, 0, -600], 'straight until the path is in');
	assert.deepEqual(out.ask, [1, 0, 0, 0, 0, -600], 'one search on the player\'s continent, player to target');
	assert.deepEqual(out.first, ['travel', 683, 100, -100], 'the first corner, and the whole path\'s length');
	assert.deepEqual(out.corner, ['travel', 541, 100, -500], 'a passed point gives way to the next');
	assert.deepEqual(out.along, ['travel', 341, 100, -500]);
	assert.equal(out.arrived, 'arrived', 'arrival is the target\'s radius, as before');
	assert.equal(out.calls, 1, 'walking along the path asks nothing more');
});

test('straying more than 25 yards from the path asks again, at most every 2 seconds, keeping the old path meanwhile', () => {
	const [out] = run(`
		local r = {}
		nav.place(0, 0)
		target(0, -600)
		N.Sample()
		fake.resolve(0, 0, 0, -300, 0, -600)
		nav.place(20, -200)
		aim()
		r.near = calls()
		nav.place(60, -200)
		r.strayAt = aim()
		r.tooSoon = calls()
		stub.advance(3)
		aim()
		r.later = calls()
		local job = fake.last()
		r.from = { floor(job.from.x), floor(job.from.y) }
		fake.resolve(60, -200, 60, -600, 0, -600)
		r.after = aim()
		emit(r)`);
	assert.equal(out.near, 1, '20 yards off is on the path');
	assert.deepEqual(out.strayAt, ['travel', 417, 0, -300], 'the old path until a new one arrives');
	assert.equal(out.tooSoon, 1, 'not again within 2 seconds of the last search');
	assert.equal(out.later, 2, 'asked again from where the player is');
	assert.deepEqual(out.from, [60, -200]);
	assert.deepEqual(out.after, ['travel', 460, 60, -600]);
});

test('C1, C2: a new target cancels the stale search, whose late answer is dropped, never reviving the old target', () => {
	const [out] = run(`
		local r = {}
		nav.place(0, 0)
		target(0, -600)
		N.Sample()
		local stale = fake.last()
		target(500, 0)
		r.aim = aim()
		r.cancelled = stale.cancelled == true
		r.calls = calls()
		stale.callback({ { map = 0, x = 0, y = 0 }, { map = 0, x = 0, y = -300 } }, 1, stale)
		r.late = aim()
		emit(r)`);
	assert.equal(out.cancelled, true);
	assert.equal(out.calls, 2);
	assert.deepEqual(out.aim, ['travel', 500, 500, 0]);
	assert.deepEqual(out.late, ['travel', 500, 500, 0], 'the old target\'s path is never followed');
});

test('nothing is searched in combat; the search follows once combat ends', () => {
	const [out] = run(`
		local r = {}
		stub.inCombat = true
		nav.place(0, 0)
		target(0, -600)
		r.fight = aim()
		r.inCombat = calls()
		stub.inCombat = false
		aim()
		r.after = calls()
		emit(r)`);
	assert.deepEqual(out.fight, ['travel', 600, 0, -600], 'straight meanwhile');
	assert.equal(out.inCombat, 0);
	assert.equal(out.after, 1);
});

test('hand-made crossings win: the engine walks to the gate, the crossing itself is the data\'s', () => {
	const [out] = run(`
		local r = {}
		N.RegisterCrossings({ complete = true,
			zones = {
				[9002] = { name = "West Vale", c = 0, top = 1000, bottom = -1000, left = 1000, right = 0 },
				[9003] = { name = "East Vale", c = 0, top = 1000, bottom = -1000, left = 0, right = -1000 },
			},
			crossings = { { id = "gate", a = { map = 9002, c = 0, wx = 600, wy = 20, r = 15 }, b = { map = 9003, c = 0, wx = 600, wy = -20, r = 15 },
				ab = "Through the gate to East Vale" } } })
		nav.place(-500, 500)
		target(-500, -500, "Kobolds")
		aim()
		local job = fake.last()
		r.toGate = { calls(), floor(job.to.x + 0.5), floor(job.to.y + 0.5) }
		fake.resolve(-500, 500, 0, 300, 600, 20)
		r.walk = aim()
		nav.place(600, 25)
		r.crossing = aim()
		r.calls = calls()
		local leg = Polestar.Nav.travel.CurrentLeg()
		r.handmade = leg.handmade == true
		emit(r)`);
	assert.deepEqual(out.toGate, [1, 600, 20], 'searched only up to the gate');
	assert.deepEqual(out.walk, ['travel', 1201, 0, 300], 'along the path to the gate');
	assert.deepEqual(out.crossing, ['travel', 45, 600, -20], 'straight through the gate to its other side');
	assert.equal(out.calls, 1, 'no search across the crossing');
	assert.equal(out.handmade, true);
});

test('a guide goal after a guide goto keeps the straight arrow from the mouth; the goto itself is walked', () => {
	const [out] = run(`
		local r = {}
		local m, mx, my = nav.mapPoint(0, -400)     -- the mouth
		local _, ix, iy = nav.mapPoint(0, -450)     -- inside
		local _, ox, oy = nav.mapPoint(200, -450)   -- an NPC in the open
		local guide = { steps = {
			{ goals = { { t = "goto", map = m, x = mx, y = my } } },
			{ goals = { { t = "accept", quest = 1 }, { t = "collect", map = m, x = ix, y = iy } } },
			{ goals = { { t = "talk", map = m, x = ox, y = oy }, { t = "kill", map = m, x = ix, y = iy } } },
		} }
		Polestar.Engine.GetGuide = function() return guide end
		nav.place(0, 0)
		nav.setWaypoint({ map = m, x = mx, y = my, label = "Mouth", stepIndex = 1, goalIndex = 1, kind = "goto", r = 5 })
		aim()
		r.mouth = calls()
		nav.setWaypoint({ map = m, x = ix, y = iy, label = "Inside", stepIndex = 2, goalIndex = 2, kind = "collect", r = 5 })
		r.inside = aim()
		r.insideCalls = calls()
		nav.setWaypoint({ map = m, x = ix, y = iy, label = "Inside", stepIndex = 3, goalIndex = 2, kind = "kill", r = 5 })
		aim()
		r.afterTalk = calls()
		emit(r)`);
	assert.equal(out.mouth, 1, 'the goto is a goal like any other');
	assert.deepEqual(out.inside, ['travel', 450, 0, -450], 'the goal after it is straight');
	assert.equal(out.insideCalls, 1);
	assert.equal(out.afterTalk, 2, 'after a located goal that is no goto, the engine walks again');
});

test('fallbacks: no engine, no data for the continent, unreachable, an error: the straight arrow', () => {
	const [none] = run(`
		nav.place(0, 0)
		target(0, -600)
		emit({ aim(), Polestar.Nav.Path == nil })`, { engine: false });
	assert.deepEqual(none, [['travel', 600, 0, -600], true]);

	const [out] = run(`
		local r = {}
		fake.avail[0] = false
		nav.place(0, 0)
		target(0, -600)
		r.nodata = { aim(), calls() }
		fake.avail[0] = nil
		target(0, -500)
		aim()
		fake.fail("unreachable")
		r.unreachable = aim()
		nav.place(0, -40)
		stub.advance(5)
		aim()
		r.soon = calls()
		stub.advance(15)
		aim()
		r.retry = calls()
		fake.throw = true
		target(0, 400)
		r.error = aim()
		emit(r)`);
	assert.deepEqual(out.nodata, [['travel', 600, 0, -600], 0]);
	assert.deepEqual(out.unreachable, ['travel', 500, 0, -500]);
	assert.equal(out.soon, 1, 'a failed search is not repeated at once');
	assert.equal(out.retry, 2, 'but again after 15 s and 25 yards');
	assert.deepEqual(out.error, ['travel', 440, 0, 400]);
});

test('nav.navRouting off: the straight arrow, the search in flight cancelled', () => {
	const [out] = run(`
		local r = {}
		r.default = Polestar.Get("nav.navRouting")
		nav.place(0, 0)
		target(0, -600)
		N.Sample()
		local job = fake.last()
		Polestar.Set("nav.navRouting", false)
		r.aim = aim()
		r.cancelled = job.cancelled == true
		target(0, -500)
		aim()
		r.calls = calls()
		emit(r)`);
	assert.equal(out.default, true);
	assert.deepEqual(out.aim, ['travel', 600, 0, -600]);
	assert.equal(out.cancelled, true);
	assert.equal(out.calls, 1);
});

test('a ghost\'s walk is searched with water walking', () => {
	const [out] = run(`
		UnitIsGhost = function() return true end
		nav.place(0, 0)
		target(0, -600)
		N.Sample()
		emit(fake.last().waterWalking == true)`);
	assert.equal(out, true);
});

test('route geometry: the walk carries the engine\'s path once in, the straight line before; changes are announced', () => {
	const [out] = run(`
		local r, fired = {}, 0
		Polestar.On("NAV_ROUTE_GEOMETRY", function() fired = fired + 1 end)
		r.none = N.GetRouteGeometry() == nil
		nav.place(0, 0)
		target(0, -600)
		N.Sample()
		local g = N.GetRouteGeometry()
		r.straight = { #g.legs, g.legs[1].kind, #g.legs[1].pts, g.legs[1].current }
		local before = fired
		fake.resolve(0, 0, 100, -100, 100, -500, 0, -600)
		r.fired = fired > before
		g = N.GetRouteGeometry()
		local pts = {}
		for _, p in ipairs(g.legs[1].pts) do pts[#pts + 1] = { p[1], floor(p[2] + 0.5), floor(p[3] + 0.5) } end
		r.path = pts
		emit(r)`);
	assert.equal(out.none, true);
	assert.deepEqual(out.straight, [1, 'walk', 2, true]);
	assert.equal(out.fired, true);
	assert.deepEqual(out.path, [[0, 0, 0], [0, 100, -100], [0, 100, -500], [0, 0, -600]]);
});

// ---------------------------------------------------------------------------
// Chokepoint steps (docs/superpowers/specs/2026-10-15-spf-issues.md, K1-K8):
// the walk the arrow is on is split where the engine's path passes a lift,
// gate, bridge, tunnel, pass or a cave or building mouth.

// A straight path west from (0, 0) to the target at (0, -600), with a bridge,
// a nameless cave mouth, a lift (bottom then top landing) along it, and
// chokepoints the split must leave out.
const CHOKES = `
PolestarNavChokepoints = { [0] = {
	{ wx = 8, wy = -150, r = 10, kind = "bridge", name = "Bridge Hollow", zone = "Testshire",
		sides = { { wx = 0, wy = -100, area = "Westbrook" }, { wx = 0, wy = -200, area = "Lakeshire" } } },
	{ wx = 0, wy = -400, r = 10, kind = "cave", name = "", zone = "Testshire" },
	{ wx = 0, wy = -500, r = 10, kind = "lift", name = "Lift Bottom", liftEnd = "bottom", lift = "The Great Lift", pair = 4 },
	{ wx = 0, wy = -520, r = 10, kind = "lift", name = "Lift Top", liftEnd = "top", lift = "The Great Lift", pair = 3 },
	{ wx = 200, wy = -300, r = 10, kind = "gate", name = "Far Gate", zone = "Testshire" },  -- off the path
	{ wx = 0, wy = -10, r = 10, kind = "pass", name = "Start Pass", zone = "Testshire" },   -- at the start
	{ wx = 0, wy = -405, r = 10, kind = "tunnel", name = "Twin", zone = "Testshire" },      -- 5 yd past the cave
} }
`;

const SPLIT = `
nav.useTravelWorld()
${CHOKES}
local function labels()
	local legs, ci = N.GetRoute()
	local out = {}
	for i = ci or 1, legs and #legs or 0 do out[#out + 1] = legs[i].kind .. "|" .. legs[i].label end
	return out
end
nav.place(0, 0)
target(0, -600)
N.Sample()
fake.resolve(0, 0, 0, -300, 0, -600)
`;

test('K1, K5: a walk is split at the chokepoints on its path, each step named, snapped onto the path', () => {
	const [out] = run(`${SPLIT}
		local legs = N.GetRoute()
		emit({ labels = labels(), first = { legs[1].to.wx, legs[1].to.wy, legs[1].step, legs[1].choke.kind, legs[1].choke.name },
			cave = legs[2].choke.name, lift = { legs[4].kind, legs[4].side, legs[4].to.wy } })`);
	assert.deepEqual(out.labels, [
		'walk|Cross the bridge to Lakeshire',
		'walk|Walk to the cave mouth in Testshire',
		'walk|Walk to The Great Lift, Bottom',
		'lift|Take The Great Lift',
		'walk|Target',
	], 'off-path, start and doubled chokepoints left out; a nameless one is named by its zone, never "Unknown"');
	assert.deepEqual(out.first, [0, -150, 'bridge', 'bridge', 'Lakeshire'], 'K5: the step ends on the path, not at the chokepoint 8 yd off it');
	assert.equal(out.cave, 'Testshire');
	assert.deepEqual(out.lift, ['lift', 'bottom', -520], 'the ride goes to the paired landing');
});

test('K2: the steps stay the same over 10 position updates along a leg, and advance as each is reached', () => {
	const [out] = run(`${SPLIT}
		local first, legs0 = labels(), N.GetRoute()
		local same = true
		for i = 1, 10 do
			nav.place(1, -10 * i)
			N.Sample()
			stub.advance(1)
			local now = labels()
			if #now ~= #first or now[1] ~= first[1] or N.GetRoute() ~= legs0 then same = false end
		end
		nav.place(0, -148)
		N.Sample()
		emit({ same = same, calls = calls(), next = Polestar.Nav.travel.CurrentLabel() })`);
	assert.equal(out.same, true);
	assert.equal(out.calls, 1, 'no new search on the way');
	assert.equal(out.next, 'Walk to the cave mouth in Testshire');
});

test('K3, K6: walk steps carry no wait and their times sum exactly to the walk; a lift step carries its timetable wait and caption', () => {
	const [out] = run(`
		nav.useTravelWorld()
		${CHOKES}
		local asked
		Polestar.Transit = {
			Now = function() return 100 end,
			LiftNear = function() return 7, "The Great Lift" end,
			NextDeparture = function(kind, id, now, side) asked = { kind, id, side } return 40, 20 end,
			Caption = function(kind, id, now, side) return "Leaves in about 0:40" end,
		}
		nav.place(0, 0)
		target(0, -600)
		N.Sample()
		fake.resolve(0, 0, 0, -300, 0, -600)
		local legs = N.GetRoute()
		local walkSecs, walkYards, lift = 0, 0, nil
		for _, l in ipairs(legs) do
			if l.kind == "walk" then walkSecs, walkYards = walkSecs + l.seconds, walkYards + l.yards else lift = l end
		end
		for _, wy in ipairs({ -150, -400, -500 }) do
			nav.place(0, wy)
			N.Sample()
			N.Sample()
		end
		emit({ walkSecs = walkSecs, walkYards = walkYards, lift = { lift.seconds, lift.lift }, asked = asked,
			total = legs[1].seconds + legs[1].rest, caption = Polestar.Nav.travel.CurrentLabel() })`);
	assert.equal(out.walkSecs, Math.round(600 / 7), 'the pieces add up to the path at run speed');
	assert.equal(out.walkYards, 600);
	assert.deepEqual(out.lift, [60, 7]);
	assert.deepEqual(out.asked, ['lift', 7, 'bottom']);
	assert.equal(out.total, Math.round(600 / 7) + 60);
	assert.equal(out.caption, 'Take The Great Lift\nLeaves in about 0:40');
});

test('K4: a lift\'s side comes from the path\'s direction, not the player\'s height', () => {
	const [out] = run(`
		nav.useTravelWorld()
		${CHOKES}
		nav.place(0, -600)
		target(0, 0)
		N.Sample()
		fake.resolve(0, -600, 0, -300, 0, 0)
		local legs = N.GetRoute()
		local lift
		for _, l in ipairs(legs) do if l.kind == "lift" then lift = l end end
		emit({ legs[1].label, lift.side, lift.to.wy })`);
	assert.deepEqual(out, ['Walk to The Great Lift, Top', 'top', -500]);
});

test('K7: legs under a few yards are dropped and every ETA stays finite', () => {
	const [out] = run(`${SPLIT}
		local T = Polestar.Nav.travel
		local finite = true
		local legs = N.GetRoute()
		for i = 1, #legs do
			local s, y = T.Progress()
			if s ~= s or s == math.huge or (y and (y ~= y or y == math.huge)) then finite = false end
			if legs[i].seconds ~= legs[i].seconds or legs[i].yards ~= legs[i].yards then finite = false end
			T.SkipLeg()
		end
		local short = 0
		for _, l in ipairs(legs) do if l.kind == "walk" and l.yards < 20 then short = short + 1 end end
		emit({ finite = finite, short = short })`);
	assert.equal(out.finite, true);
	assert.equal(out.short, 0);
});

test('K8: a hand-made crossing, chain node or guide goto at the same spot keeps its own caption', () => {
	const [out] = run(`
		nav.useTravelWorld()
		PolestarNavChokepoints = { [0] = {
			{ wx = 0, wy = -575, r = 10, kind = "cave", name = "Goto Cave", zone = "Testshire" },
			{ wx = 0, wy = -300, r = 10, kind = "gate", name = "Chain Gate", zone = "Testshire" },
			{ wx = 0, wy = -150, r = 10, kind = "bridge", name = "Kept Bridge", zone = "Testshire" },
		} }
		N.RegisterCrossings({ complete = false, chains = { { id = "c", name = "C", nodes = {
			{ map = 9000, c = 0, wx = 0, wy = -310, r = 10, caption = "Enter" }, { map = 9000, c = 0, wx = 50, wy = -310, r = 10 } } } } })
		local m, x, y = nav.mapPoint(0, -600)
		nav.place(0, 0)
		nav.setWaypoint({ map = m, x = x, y = y, label = "The mouth", stepIndex = 1, goalIndex = 1, kind = "goto", r = 5 })
		N.Sample()
		fake.resolve(0, 0, 0, -300, 0, -600)
		local legs, ci = N.GetRoute()
		local out = {}
		for i = ci, #legs do out[#out + 1] = legs[i].label end
		emit(out)`);
	assert.deepEqual(out, ['Cross the bridge to Kept Bridge', 'The mouth']);
});
