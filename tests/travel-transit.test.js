'use strict';
// The travel planner's newer legs (addon/Polestar/Nav/Travel.lua): timetable
// waits and departure captions from Nav/Transit.lua (a fake ns.Transit here),
// class teleports, walk-in portals, a ghost's walk-only route, skipping a
// leg, and the leg fields the prompts and map lines read. Runs the real
// Core/Init.lua + Nav/Nav.xml against tests/lua/stub_nav.lua's travel world.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runAddon } = require('./helpers/lua');

const NAV = { name: 'Polestar', files: ['Core/Init.lua', 'Nav/Nav.xml'] };

const PRELUDE = `
local N = Polestar.Nav
local T = N.travel
local nav = stub.nav
local function target(wx, wy, label)
	local m, x, y = nav.mapPoint(wx, wy)
	N.SetTarget(m, x, y, label or "Target")
end
local function route()
	local legs, ci = N.GetRoute()
	local out = {}
	for i = ci or 1, legs and #legs or 0 do
		local l = legs[i]
		out[#out + 1] = l.kind .. "|" .. l.label
	end
	return out
end
local function known(...)
	local flags = Polestar.CharState().flags
	flags.taxi = {}
	for _, id in ipairs({ ... }) do flags.taxi[id] = true end
end
local function leg(kind)
	local legs = N.GetRoute()
	for _, l in ipairs(legs or {}) do if l.kind == kind then return l end end
end
`;

function run(script) {
	return runAddon({
		stubs: ['stub_nav.lua'],
		addons: [NAV],
		login: true,
		script: `${PRELUDE}
nav.faction = "Alliance"
nav.useTravelWorld()
${script}`,
	}).emitted;
}

test('a ride waits as the timetable says from when the player reaches the dock; the caption counts down to it', () => {
	const [out] = run(`
		local r, seen = {}, nil
		nav.place(0, 0, 1)
		target(-800, 100, "Docks quest")
		r.average = leg("boat").seconds
		Polestar.Transit = {
			Now = function() return 1000 end,
			NextDeparture = function(kind, id, now, side) seen = seen or { kind, id, now, side } return 500, 60 end,
			Caption = function(kind, id, now, side) return "Next " .. kind .. " in 1:20 (" .. side .. ")" end,
		}
		target(-800, 100, "Docks quest")
		r.timed = leg("boat").seconds
		r.seen = { seen[1], seen[2], seen[3] > 1000, seen[4] }
		local boat = leg("boat")
		r.fields = { boat.transport.id, boat.side }
		nav.place(400, 0, 1)                              -- at Farland Pier
		target(-800, 100, "Docks quest")
		r.label = T.CurrentLabel()
		emit(r)`);
	assert.equal(out.average, 90, 'without timetables: the average wait plus the ride');
	assert.equal(out.timed, 560);
	assert.deepEqual(out.seen, ['boat', 'boat-test', true, 'b'], 'asked for the time the player gets to the pier, boarding at b');
	assert.deepEqual(out.fields, ['boat-test', 'b']);
	assert.equal(out.label, 'Take the boat to Testshire Docks\nNext boat in 1:20 (b)');
});

test('C11: a class teleport is a leg from the start when it is faster; a ghost only walks, with no error', () => {
	const [out] = run(`
		local r = {}
		Polestar.Transit = {
			Now = function() return 0 end,
			Teleports = function() return { { spell = 3561, name = "Teleport: Testshire", cast = 10, ready = 0,
				to = { name = "Testshire", c = 0, wx = -500, wy = -500, map = 9000, x = 75, y = 75 } } } end,
		}
		nav.place(0, 0, 1)
		target(-500, -480, "Quest")
		r.teleport = route()
		r.spell = leg("teleport").spell
		r.mode = N.Sample()
		known(1, 2)
		nav.place(0, 600)
		target(0, -780, "Kobolds")
		r.alive = route()
		UnitIsGhost = function() return true end
		target(0, -780, "Kobolds")
		r.ghost = route()
		emit(r)`);
	assert.deepEqual(out.teleport, ['teleport|Cast Teleport: Testshire', 'walk|Quest']);
	assert.equal(out.spell, 3561);
	assert.equal(out.mode, 'instruction');
	assert.deepEqual(out.alive, ['walk|Walk to the flight master', 'fly|Fly to East Hold', 'walk|Kobolds']);
	assert.deepEqual(out.ghost, ['walk|Kobolds']);
});

test('a walk-in portal goes one way only', () => {
	const [out] = run(`
		local r = {}
		N.RegisterTravelData({ portals = { { id = "gate", name = "Far Gate portal", seconds = 5,
			a = { "West Portal", 0, 0, 900, 9000, 5, 50 }, b = { "Far Gate", 1, 0, -400, 9001, 90, 50 } } } })
		nav.place(0, 850)
		N.SetTarget(9001, 80, 60, "Target")               -- Farland (-100, -300)
		r.there = route()
		r.mode = (function() nav.place(0, 899) return N.Sample() end)()
		nav.place(0, -400, 1)
		local m, x, y = nav.mapPoint(-890, 0)
		N.SetTarget(m, x, y, "Docks")
		r.back = route()
		emit(r)`);
	assert.deepEqual(out.there, ['walk|Walk to the portal', 'portal|Take the portal to Far Gate', 'walk|Target']);
	assert.equal(out.mode, 'instruction');
	assert.equal(out.back[0], 'walk|Walk to the boat', 'never back through it');
});

test('11: skipping a hearth leg plans this target without the Hearthstone; another target may hearth again', () => {
	const [out] = run(`
		local r = {}
		nav.items[6948] = 1
		nav.bind = "Testshire Inn"
		nav.place(0, 0, 1)
		target(-520, -690, "Innkeeper quest")
		r.before = route()
		r.item = leg("hearth").item
		r.skipped = T.SkipLeg()
		r.after = route()
		target(-520, -680, "Other quest")
		r.other = route()[1]
		emit(r)`);
	assert.deepEqual(out.before, ['hearth|Hearth to Testshire Inn', 'walk|Innkeeper quest']);
	assert.equal(out.item, 6948);
	assert.equal(out.skipped, true);
	assert.deepEqual(out.after, ['walk|Walk to the boat', 'boat|Take the boat to Testshire Docks', 'walk|Innkeeper quest']);
	assert.equal(out.other, 'hearth|Hearth to Testshire Inn');
});

test('skipping another leg moves on to the next; flights list every node they hop', () => {
	const [out] = run(`
		local r = {}
		known(1, 2)
		nav.place(0, 600)
		target(0, -780, "Kobolds")
		local fly = leg("fly")
		r.stops = { #fly.stops, fly.stops[1].id, fly.stops[#fly.stops].id }
		T.SkipLeg()
		r.after = route()
		emit(r)`);
	assert.deepEqual(out.stops, [2, 1, 2]);
	assert.deepEqual(out.after, ['fly|Fly to East Hold', 'walk|Kobolds']);
});

test('11: after skipping the Hearthstone, a class teleport is still planned', () => {
	const [out] = run(`
		nav.items[6948] = 1
		nav.bind = "Testshire Inn"
		Polestar.Transit = {
			Now = function() return 0 end,
			Teleports = function() return { { spell = 3561, name = "Teleport: Testshire", cast = 10, ready = 200,
				to = { name = "Testshire", c = 0, wx = -480, wy = -690, map = 9000, x = 84.5, y = 74 } } } end,
		}
		nav.place(0, 0, 1)
		target(-520, -690, "Innkeeper quest")
		local before = route()[1]
		T.SkipLeg()
		emit({ before, route()[1] })`);
	assert.deepEqual(out, ['hearth|Hearth to Testshire Inn', 'teleport|Cast Teleport: Testshire']);
});

test('2, 3: no flight leg lands at or passes through an unknown flight master; the known set is read on every plan', () => {
	const [out] = run(`
		local r = {}
		N.RegisterTravelData({ build = "test", inns = {}, transports = {},
			taxi = {
				{ 1, 0, 0, 900, 9000, 5, 5, 3, "North Post, Testshire" },
				{ 2, 0, 0, 0, 9000, 50, 50, 3, "Middle Post, Testshire" },
				{ 3, 0, 0, -900, 9000, 95, 95, 3, "South Post, Testshire" },
			},
			flights = { 1, 2, 900, 2, 1, 900, 2, 3, 900, 3, 2, 900 } }, true)
		known(1, 3)
		nav.place(0, 850)
		target(0, -890, "South")
		r.unknownMiddle = route()
		Polestar.CharState().flags.taxi[2] = true      -- learned in place, as the client does
		target(0, -890, "South")
		r.known = route()
		local legs = N.GetRoute()
		local stops = {}
		for _, n in ipairs(leg("fly").stops) do stops[#stops + 1] = n.id end
		r.stops = stops
		emit(r)`);
	assert.deepEqual(out.unknownMiddle, ['walk|South'], 'Middle Post unknown: no flight through it');
	assert.deepEqual(out.known, ['walk|Walk to the flight master', 'fly|Fly to South Post', 'walk|South']);
	assert.deepEqual(out.stops, [1, 2, 3]);
});

test('C9: a flight leg carries no wait, only flying time and the stops', () => {
	const [out] = run(`
		known(1, 2)
		nav.place(0, 600)
		target(0, -780, "Kobolds")
		emit(leg("fly").seconds)`);
	assert.equal(out, Math.floor(1700 / 30 + 2 + 0.5));
});

test("C15: the other faction's transports are neither planned nor estimated", () => {
	const [out] = run(`
		local r = {}
		N.RegisterTravelData({ build = "test", taxi = {}, flights = {}, inns = {},
			transports = { { id = "tram-test", kind = "tram", faction = 1, ab = 100, ba = 100, waitA = 30, waitB = 30,
				a = { "Northgate", 0, 900, 0, 9000, 50, 5 }, b = { "Southgate", 0, -900, 0, 9000, 50, 95 } } } }, true)
		local m, x, y = nav.mapPoint(-950, 0)
		nav.place(890, 0)
		target(-950, 0, "South")
		r.alliance = route()[1]
		r.allianceEta = N.EstimateTravel(nil, { map = m, x = x, y = y })
		nav.faction = "Horde"
		stub.advance(10)                              -- past the estimate cache
		target(-950, 0, "South")
		r.horde = route()
		r.hordeEta = N.EstimateTravel(nil, { map = m, x = x, y = y })
		emit(r)`);
	assert.equal(out.alliance, 'tram|Take the tram to Southgate');
	assert.deepEqual(out.horde, ['walk|South']);
	assert.ok(out.hordeEta > out.allianceEta, `the estimate walks too (${out.hordeEta} s vs ${out.allianceEta} s)`);
});

// ---------------------------------------------------------------------------
// Review fixes (code review at agent://ReviewCode, security review at agent://ReviewSecurity).

const TELEPORT = `{ spell = 3561, name = "Teleport: Testshire", cast = 10, ready = 0,
	to = { name = "Testshire", c = 0, wx = -500, wy = -500, map = 9000, x = 75, y = 75 } }`;

test('review P0-1: a timetable that raises or answers nonsense never breaks planning; that ride waits its average', () => {
	const [out] = run(`
		local r = {}
		nav.place(0, 0, 1)
		Polestar.Transit = { Now = function() return 0 end, NextDeparture = function() error("stops[0]") end }
		target(-800, 100, "Docks quest")
		r.raises = leg("boat") and leg("boat").seconds
		Polestar.Transit = { Now = function() return 0 end, NextDeparture = function() return 0 / 0, 60 end }
		target(-800, 100, "Docks quest")
		r.nan = leg("boat") and leg("boat").seconds
		Polestar.Transit = { Now = function() return 0 end, NextDeparture = function() return -5, 60 end }
		target(-800, 100, "Docks quest")
		r.negative = leg("boat") and leg("boat").seconds
		emit(r)`);
	assert.deepEqual(out, { raises: 90, nan: 90, negative: 90 });
});

test('security M3: shared times replan only a route using the changed service, at most every 20 s; own rides at once', () => {
	const [out] = run(`
		local r, plans = {}, 0
		Polestar.On("ROUTE_CHANGED", function() plans = plans + 1 end)
		nav.place(0, 0, 1)
		target(-800, 100, "Docks quest")
		local function count(changed, own)
			local before = plans
			Polestar.Fire("NAV_TRANSIT", changed, own)
			return plans - before
		end
		stub.advance(30)
		r.other = count({ ["zeppelin-x"] = "zeppelin" })
		r.own = count({ ["zeppelin-x"] = "zeppelin" }, true)
		r.all = count(nil)
		stub.advance(30)
		r.used = count({ ["boat-test"] = "boat" })
		r.tooSoon = count({ ["boat-test"] = "boat" })
		local before = plans
		stub.advance(21)
		Polestar.Nav.Refresh()
		r.owed = plans - before
		emit(r)`);
	assert.deepEqual(out, { other: 0, used: 1, tooSoon: 0, own: 1, all: 1, owed: 1 });
});

test('review P2-4: Progress counts a ride, flight or hearth down from when it became current', () => {
	const [out] = run(`
		nav.items[6948] = 1
		nav.bind = "Testshire Inn"
		nav.place(0, 0, 1)
		target(-520, -690, "Innkeeper quest")
		local T = Polestar.Nav.travel
		local a = T.Progress()
		stub.advance(5)
		local b = T.Progress()
		stub.advance(60)
		emit({ a, b, T.Progress() })`);
	assert.deepEqual(out, [15, 10, 0]);
});

test('review P2-5: the arrow ETA adds the 1.25 detour only to straight distances, not to path yards', () => {
	const [out] = run(`
		known(1, 2)
		nav.place(0, 600)
		target(0, -780, "Kobolds")
		local T = Polestar.Nav.travel
		local legs = N.GetRoute()
		local rest = legs[1].rest
		emit({ T.Remaining(70, true) - rest, T.Remaining(70) - rest })`);
	assert.deepEqual(out, [10, 12.5]);
});

test('review P2-6: skipping a teleport, a flight or a ride plans the rest of the way without it', () => {
	const [out] = run(`
		local r = {}
		Polestar.Transit = { Now = function() return 0 end, Teleports = function() return { ${TELEPORT} } end }
		nav.place(0, 0, 1)
		target(-500, -480, "Quest")
		r.teleport = route()[1]
		T.SkipLeg()
		r.afterTeleport = route()[1]
		target(-500, -470, "Other")
		r.otherTarget = route()[1]
		Polestar.Transit = nil
		known(1, 2)
		nav.place(0, 790)
		target(0, -780, "Kobolds")
		T.SkipLeg()
		r.afterFlight = route()
		nav.place(0, 0, 1)
		target(-800, 100, "Docks quest")
		while T.CurrentLeg() and T.CurrentLeg().kind ~= "boat" do T.SkipLeg() end
		T.SkipLeg()
		r.afterBoat = #route()
		emit(r)`);
	assert.equal(out.teleport, 'teleport|Cast Teleport: Testshire');
	assert.equal(out.afterTeleport, 'walk|Walk to the boat', 'without that spell for this target');
	assert.equal(out.otherTarget, 'teleport|Cast Teleport: Testshire', 'another target may cast it again');
	assert.deepEqual(out.afterFlight, ['walk|Kobolds']);
	assert.equal(out.afterBoat, 0, 'no other way across: nothing left to follow');
});

test('security L6: estimates evict the oldest entry instead of wiping the cache, and stop planning for the frame past 25 ms', () => {
	const [out] = run(`
		local r, plans = {}, 0
		local plan = N.PlanRoute
		N.PlanRoute = function(p) plans = plans + 1 return plan(p) end
		local function at(i) local m, x, y = nav.mapPoint(-900 + i * 10, -500) return { map = m, x = x, y = y } end
		nav.place(0, 0)
		for i = 1, 65 do N.EstimateTravel(nil, at(i)) end
		local before = plans
		N.EstimateTravel(nil, at(1))
		r.oldestGone = plans - before
		before = plans
		N.EstimateTravel(nil, at(3))
		r.othersKept = plans - before
		stub.advance(10)
		local t = 0
		debugprofilestop = function() t = t + 30 return t end
		N.EstimateTravel(nil, at(1))
		local first, why = N.EstimateTravel(nil, at(2))
		r.busy = { first == nil, why }
		stub.advance(0.02)
		r.nextFrame = select(2, N.EstimateTravel(nil, at(2))) ~= "busy"
		emit(r)`);
	assert.equal(out.oldestGone, 1);
	assert.equal(out.othersKept, 0);
	assert.deepEqual(out.busy, [true, 'busy']);
	assert.equal(out.nextFrame, true);
});

test("review P3-10: the arrow dial shows the leg's own glyph for a teleport", () => {
	const [out] = run(`
		Polestar.Transit = { Now = function() return 0 end, Teleports = function() return { ${TELEPORT} } end }
		nav.place(0, 0, 1)
		target(-500, -480, "Quest")
		stub.advance(0.2)
		local A = Polestar.Nav.arrow
		emit({ A.GetMode(), (A.legIcon:GetTexture() or ""):match("[^\\\\]+$") })`);
	assert.deepEqual(out, ['instruction', 'icon-use']);
});
