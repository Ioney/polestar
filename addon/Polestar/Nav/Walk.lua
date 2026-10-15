-- Walking paths: the arrow follows real paths on the ground instead of a
-- straight line, from the walking engine of Shortest Path Forever by Cillian
-- Berragan (https://github.com/cjber/shortest-path-forever, GPL-3.0-or-later),
-- vendored in the load-on-demand addon Polestar_Nav.
-- Portions Copyright (C) 2026 Cillian Berragan (Shortest Path Forever, GPL-3.0-or-later); adapted for Polestar, 2026-10-15.
--
-- The travel planner (Travel.lua) stays as it is: it picks flights, rides,
-- the Hearthstone and teleports with straight-line walk estimates. Here the
-- walk the arrow is on right now (the player to the current walk leg's end,
-- or to the target) is searched asynchronously with Path.Find on the
-- player's continent; once the path arrives the arrow aims at its next point.
-- Straying more than STRAY yards from it, or a new goal, asks again (a stale
-- search is cancelled); nothing is asked for in combat. Hand-made walks win:
-- a crossing, an approach chain past its mouth (Travel's leg.handmade), and a
-- guide goal after a guide `goto` (the author's way in, a cave mouth) keep
-- the straight arrow. No engine, nav.navRouting off, no walking data for the
-- continent, or a failed search: the straight arrow, as without this file.
--
-- Steps: the walk is split at the lifts Nav/Transit.lua knows, and keeps the
-- crossings, approach chains and guide gotos the planner already makes legs
-- of. Gates, bridges, tunnels, passes and cave or building mouths become
-- steps too once Polestar_Nav carries PolestarNavChokepoints (it does not
-- yet; the code reads it when present).
--
--   Walk.Aim(pc, px, py, gc, gx, gy, handmade) -> c, wx, wy, left | nil
--     where to point for walking from the player to (gc, gx, gy): the path's
--     next point and the yards left along it; nil = straight at the goal.
--     Allocation-free once the path is in.
--   Walk.Left(c, x, y) -> yards left along the path to that goal at the last Aim | nil
--   Walk.Passed(c, x, y, seg) -> the player is past segment `seg` of that goal's path
--   Walk.Stops(pc, px, py) -> stops, total: the chokepoints along the path
--   Walk.Split(): Travel.SplitWalk at them (on each path, and after a fresh plan);
--     with none, the walk leg takes the path's yards and time, and goes back
--     to its straight estimate when the path fails or is cleared (Travel.RestoreWalk)
--   Walk.FollowsGoto(target) -> true when the guide's last located goal before
--     this target is a `goto`
--   Walk.Clear()
--   Nav.GetRouteGeometry() -> { legs = { { kind, pts = { { c, wx, wy }, ... },
--     current, choke }, ... } } or nil without a target; NAV_ROUTE_GEOMETRY on change.
--     kind: walk | flight | boat | zeppelin | tram | portal | hearth | teleport | lift.

local ADDON, ns = ...
local Nav = ns.Nav

local type, ipairs, pcall = type, ipairs, pcall
local sqrt, huge = math.sqrt, math.huge

local Walk = {}
Nav.walk = Walk

ns.RegisterDefaults("nav", { navRouting = true })

local PACK = "Polestar_Nav"
local STRAY = 25            -- yards off the path: ask again
local ASK_EVERY = 2         -- seconds between asks for the same goal
local POINT_REACH = 5       -- yards: a path point is passed
local LOOKAHEAD = 12        -- path segments looked at ahead of the current one
local GOAL_MOVED = 1        -- yards: the goal is another one
local FAIL_RETRY, FAIL_MOVED = 15, 25 -- a failed search is asked again this late, this far away

---------------------------------------------------------------------------
-- The engine (Polestar_Nav's API.lua hands it over as Polestar_NavEngine)
---------------------------------------------------------------------------

local loadTried = false

local function inCombat()
	local C = ns.Compat
	if C and C.InCombat then return C.InCombat() end
	return InCombatLockdown ~= nil and InCombatLockdown() and true or false
end

-- Load Polestar_Nav once (at login or later, never in combat: loading builds
-- about 12 MB of packed map strings).
local function load()
	if Nav.Path or loadTried then return end
	if inCombat() then return end
	loadTried = true
	if ns.Data and ns.Data.Pack then pcall(ns.Data.Pack, PACK) end
	local P = _G.Polestar_NavEngine
	if type(P) == "table" and type(P.Find) == "function" and type(P.Cancel) == "function" then
		Nav.Path = P
	end
end

local function engine()
	if not ns.Get("nav.navRouting") then return nil end
	return Nav.Path
end

---------------------------------------------------------------------------
-- The current walk
---------------------------------------------------------------------------

local gc, gx, gy             -- the goal searched for (nil: none)
local token                  -- the live search's identity
local job                    -- its Cancel handle
local ptsX, ptsY, ptsZ = {}, {}, {} -- the path, reused (z false where unknown)
local left = {}              -- left[i] = yards from point i to the end of the path
local lastLeft               -- yards left along the path at the last Aim
local count = 0              -- points in the path (0: none yet)
local idx = 1                -- the point aimed at
local wanted = false         -- a search is owed (deferred in combat)
local askedAt = -huge
local failed = false
local failAt, failX, failY = 0, 0, 0
local geomVersion = 0

local function changed()
	geomVersion = geomVersion + 1
	ns.Fire("NAV_ROUTE_GEOMETRY")
end

local function cancel()
	token = nil
	if job then
		local P = Nav.Path
		if P then pcall(P.Cancel, job) end
		job = nil
	end
end

-- The walk the path measured goes back to its straight estimate (Travel.RestoreWalk).
local function restore(c, x, y)
	local T = Nav.travel
	if c and T and T.RestoreWalk then T.RestoreWalk(c, x, y) end
end

function Walk.Clear()
	local had, c, x, y = gc ~= nil, gc, gx, gy
	cancel()
	gc, gx, gy, count, idx, wanted, failed = nil, nil, nil, 0, 1, false, false
	if had then
		restore(c, x, y)
		changed()
	end
end

local function took(points)
	local n = 0
	for i = 1, #points do
		local p = points[i]
		if type(p) == "table" and p.x and p.y then
			n = n + 1
			ptsX[n], ptsY[n], ptsZ[n] = p.x, p.y, type(p.z) == "number" and p.z or false
		end
	end
	for i = n + 1, count do ptsX[i], ptsY[i], ptsZ[i] = nil, nil, nil end
	count = n
	left[n + 1] = nil
	if n > 0 then
		local dx, dy = gx - ptsX[n], gy - ptsY[n]
		left[n] = sqrt(dx * dx + dy * dy)
		for i = n - 1, 1, -1 do
			dx, dy = ptsX[i + 1] - ptsX[i], ptsY[i + 1] - ptsY[i]
			left[i] = left[i + 1] + sqrt(dx * dx + dy * dy)
		end
	end
	idx = 1
end

-- The player's height, when the client gives it on this continent (picks the
-- floor), through Compat's one player-position gate.
local function playerZ(pc)
	local C = ns.Compat
	if not (C and C.GetPlayerUnitPosition) then return nil end
	local ok, _, _, z, instance = pcall(C.GetPlayerUnitPosition)
	if ok and instance == pc and type(z) == "number" then return z end
	return nil
end

local function ask(P, pc, px, py)
	wanted = true
	if inCombat() then return end -- after combat, on the next sample
	wanted = false
	askedAt, failed = GetTime(), false
	cancel()
	if P.Available and not P.Available(pc) then
		failed, failAt, failX, failY = true, askedAt, px, py
		return
	end
	local mine = {}
	token = mine
	local ghost = Nav.travel and Nav.travel.IsGhost and Nav.travel.IsGhost() or nil
	local ok, handle = pcall(P.Find, pc, { x = px, y = py, z = playerZ(pc) }, { x = gx, y = gy }, function(points)
		if token ~= mine then return end
		token, job = nil, nil
		if type(points) == "table" and #points > 0 then
			failed = false
			took(points)
			if Walk.Split then Walk.Split() end
		else
			failed, failAt, failX, failY = true, GetTime(), px, py
			count = 0
			restore(gc, gx, gy)
		end
		changed()
	end, ghost) -- a ghost walks on water
	if not ok then
		token = nil
		failed, failAt, failX, failY = true, askedAt, px, py
		return
	end
	if token == mine then job = handle end
end

-- Distance from (px, py) to segment a -> b of the path.
local function segment(px, py, a, b)
	local ax, ay = ptsX[a], ptsY[a]
	local dx, dy = ptsX[b] - ax, ptsY[b] - ay
	local len2 = dx * dx + dy * dy
	local t = 0
	if len2 > 0 then
		t = ((px - ax) * dx + (py - ay) * dy) / len2
		if t < 0 then t = 0 elseif t > 1 then t = 1 end
	end
	local ex, ey = ax + dx * t - px, ay + dy * t - py
	return sqrt(ex * ex + ey * ey)
end

function Walk.Aim(pc, px, py, goalC, goalX, goalY, handmade)
	local P = engine()
	if handmade or not P or pc ~= goalC then
		if gc then Walk.Clear() end
		return nil
	end
	if gc ~= goalC or gx == nil or (goalX - gx) * (goalX - gx) + (goalY - gy) * (goalY - gy) > GOAL_MOVED * GOAL_MOVED then
		local had = count > 0
		cancel()
		gc, gx, gy, count, idx, failed = goalC, goalX, goalY, 0, 1, false
		askedAt = -huge
		if had then changed() end
		ask(P, pc, px, py)
	elseif failed then
		local dx, dy = px - failX, py - failY
		if GetTime() - failAt >= FAIL_RETRY and dx * dx + dy * dy > FAIL_MOVED * FAIL_MOVED then ask(P, pc, px, py) end
	elseif wanted then
		ask(P, pc, px, py)
	end
	if count == 0 then return nil end

	-- The nearest segment from just behind the aimed point to a little ahead.
	local first = idx > 1 and idx - 1 or 1
	local last = idx + LOOKAHEAD
	if last > count then last = count end
	local off, best = huge, idx
	if count == 1 then
		local dx, dy = ptsX[1] - px, ptsY[1] - py
		off = sqrt(dx * dx + dy * dy)
	else
		for a = first, last - 1 do
			local d = segment(px, py, a, a + 1)
			if d < off then off, best = d, a + 1 end
		end
	end
	if best > idx then idx = best end
	while idx <= count do
		local dx, dy = ptsX[idx] - px, ptsY[idx] - py
		if dx * dx + dy * dy > POINT_REACH * POINT_REACH then break end
		idx = idx + 1
	end
	-- Strayed: keep this path until the new one is in.
	if off > STRAY and token == nil and not wanted and GetTime() - askedAt >= ASK_EVERY then ask(P, pc, px, py) end
	if idx > count then
		lastLeft = nil
		return nil
	end
	local dx, dy = ptsX[idx] - px, ptsY[idx] - py
	lastLeft = sqrt(dx * dx + dy * dy) + left[idx]
	return pc, ptsX[idx], ptsY[idx], lastLeft
end

local function isGoal(c, x, y)
	return count > 0 and gc == c and (x - gx) * (x - gx) + (y - gy) * (y - gy) <= GOAL_MOVED * GOAL_MOVED
end

-- Yards left along the path to (c, x, y) at the last Aim, or nil (no path for it).
function Walk.Left(c, x, y)
	if not isGoal(c, x, y) then return nil end
	return lastLeft
end

-- Has the player gone past segment `seg` of the path to (c, x, y)?
function Walk.Passed(c, x, y, seg)
	return seg ~= nil and isGoal(c, x, y) and idx > seg + 1
end

---------------------------------------------------------------------------
-- Chokepoints: the walk is split where its path passes a lift, gate,
-- bridge, tunnel, pass, or a cave or building mouth (Polestar_Nav's
-- PolestarNavChokepoints[map], else the lifts Nav/Transit.lua knows).
-- Travel.SplitWalk turns them into legs with captions; this finds them.
--   stop = { kind, name, zone, to (passages: the area beyond), wx, wy (on the
--     path), r, along (yards from here), seg, lift (Transit id), side
--     ("top"|"bottom": the landing boarded), endX, endY (the other landing) }
---------------------------------------------------------------------------

local SNAP = 15        -- yards: a chokepoint without a radius counts within this of the path
local MIN_STEP = 20    -- yards: closer stops, or this close to either end, are dropped
local LOOK = 25        -- yards past a passage that tell which side is ahead

-- Nearest point on the path to (x, y): distance, segment, point, yards from the path's start.
local function project(x, y)
	local bestD, bestA, bestT = huge, 1, 0
	for a = 1, count - 1 do
		local ax, ay = ptsX[a], ptsY[a]
		local dx, dy = ptsX[a + 1] - ax, ptsY[a + 1] - ay
		local len2 = dx * dx + dy * dy
		local t = 0
		if len2 > 0 then
			t = ((x - ax) * dx + (y - ay) * dy) / len2
			if t < 0 then t = 0 elseif t > 1 then t = 1 end
		end
		local ex, ey = ax + dx * t - x, ay + dy * t - y
		local d = ex * ex + ey * ey
		if d < bestD then bestD, bestA, bestT = d, a, t end
	end
	local a = bestA
	local dx, dy = ptsX[a + 1] - ptsX[a], ptsY[a + 1] - ptsY[a]
	return sqrt(bestD), a, ptsX[a] + dx * bestT, ptsY[a] + dy * bestT, left[1] - left[a] + sqrt(dx * dx + dy * dy) * bestT
end

-- The point `along` yards from the path's start.
local function pointAt(along)
	local total = left[1] - left[count]
	if along >= total then return ptsX[count], ptsY[count] end
	for a = 1, count - 1 do
		local s, e = left[1] - left[a], left[1] - left[a + 1]
		if along <= e then
			local t = e > s and (along - s) / (e - s) or 0
			return ptsX[a] + (ptsX[a + 1] - ptsX[a]) * t, ptsY[a] + (ptsY[a + 1] - ptsY[a]) * t
		end
	end
	return ptsX[count], ptsY[count]
end

-- The path's height a little before and after segment a: which way a lift goes.
local function climbs(a)
	local before, after = ptsZ[a > 1 and a - 1 or 1], ptsZ[a + 2 <= count and a + 2 or count]
	if not (before and after) or before == after then return nil end
	return after > before
end

local function liftId(c, wx, wy)
	local X = ns.Transit
	if not (X and X.LiftNear) then return nil end
	local ok, id, name = pcall(X.LiftNear, c, wx, wy)
	if ok then return id, name end
	return nil
end

-- The stops along the current path from where the player is, in order.
-- -> stops, total (yards along the path from the player to the goal)
function Walk.Stops(pc, px, py)
	if count < 2 or not gc then return nil end
	local _, _, _, _, here = project(px, py)
	local total = left[1] - here
	local minX, maxX, minY, maxY = huge, -huge, huge, -huge
	for i = 1, count do
		local x, y = ptsX[i], ptsY[i]
		if x < minX then minX = x end
		if x > maxX then maxX = x end
		if y < minY then minY = y end
		if y > maxY then maxY = y end
	end
	local found = {}
	local function consider(e, kind)
		local r = tonumber(e.r) or SNAP
		if e.wx + r < minX or e.wx - r > maxX or e.wy + r < minY or e.wy - r > maxY then return end
		local d, a, sx, sy, along = project(e.wx, e.wy)
		along = along - here
		if d > r or along < MIN_STEP or along > total - MIN_STEP then return end
		found[#found + 1] = { kind = kind, entry = e, wx = sx, wy = sy, r = r < 5 and 5 or r > 20 and 20 or r, along = along, seg = a }
	end
	local packed = type(_G.PolestarNavChokepoints) == "table" and _G.PolestarNavChokepoints[gc]
	if type(packed) == "table" then
		for _, e in ipairs(packed) do
			if type(e) == "table" and e.wx and e.wy and e.kind then consider(e, e.kind) end
		end
	else
		local X = ns.Transit
		local ok, lifts = false, nil
		if X and X.Lifts then ok, lifts = pcall(X.Lifts) end
		if ok and type(lifts) == "table" then
			for _, e in ipairs(lifts) do
				if e.c == gc and e.wx and e.wy then consider(e, "lift") end
			end
		end
	end
	table.sort(found, function(a, b) return a.along < b.along end)

	local stops, lastAlong, used = {}, -huge, {}
	for _, f in ipairs(found) do
		local e = f.entry
		if not used[e] and f.along - lastAlong >= MIN_STEP then
			local s = { kind = f.kind, name = e.name, zone = e.zone, wx = f.wx, wy = f.wy, r = f.r, along = f.along, seg = f.seg }
			if f.kind == "lift" then
				-- The landing boarded and the ride to its pair. The side comes from
				-- the path's height when it has one (K4): a packed lift's two
				-- landings lie a few yards apart, too close for the order along
				-- the path to tell them apart; else the landing reached first.
				local other = packed and e.pair and packed[e.pair]
				local up = climbs(f.seg)
				local side = up ~= nil and (up and "bottom" or "top") or e.liftEnd
				if other and side and e.liftEnd and other.liftEnd == side and e.liftEnd ~= side then
					e, other = other, e
					s.name, s.zone = e.name, e.zone
				end
				if other then
					used[other] = true
					s.endX, s.endY = other.wx, other.wy
				end
				s.side = side
				local id, name = liftId(gc, e.wx, e.wy)
				if packed then
					s.lift, s.name = id or e.id, e.lift or name or e.name
				else
					s.lift, s.name = e.id or id, e.name or name
				end
			elseif type(e.sides) == "table" then
				-- A passage: the side the path reaches after it is where it leads.
				local ax, ay = pointAt(f.along + here + LOOK)
				local best, bestD = nil, huge
				for _, side in ipairs(e.sides) do
					if type(side) == "table" and side.wx and side.wy then
						local dx, dy = side.wx - ax, side.wy - ay
						local d = dx * dx + dy * dy
						if d < bestD then best, bestD = side, d end
					end
				end
				s.to = best and best.area or nil
			end
			stops[#stops + 1] = s
			lastAlong = f.along
		end
	end
	return stops, total
end

-- Split the walk the arrow is on at its chokepoints (Travel.SplitWalk), once
-- per path and once per plan.
function Walk.Split()
	local T = Nav.travel
	if not (T and T.SplitWalk and gc) or count < 2 then return end
	local C = ns.Compat
	local pc, px, py
	if C and C.GetPlayerWorldPosition then pc, px, py = C.GetPlayerWorldPosition() end
	if pc ~= gc then return end
	local stops, total = Walk.Stops(pc, px, py)
	if stops then T.SplitWalk(gc, gx, gy, stops, total) end
end

---------------------------------------------------------------------------
-- Hand-made guide waypoints
---------------------------------------------------------------------------

local gotoTarget, gotoAnswer

-- The guide's last located goal before this target is a `goto`: the
-- author's way in (a cave's mouth), so the arrow goes straight from there.
function Walk.FollowsGoto(target)
	if target == gotoTarget then return gotoAnswer end
	gotoTarget, gotoAnswer = target, false
	if type(target) ~= "table" or not (target.stepIndex and target.goalIndex) then return false end
	local E = ns.Engine
	local guide = E and E.GetGuide and E.GetGuide()
	local steps = type(guide) == "table" and guide.steps
	if type(steps) ~= "table" then return false end
	local s, g = target.stepIndex, target.goalIndex - 1
	while s >= 1 do
		local goals = steps[s] and steps[s].goals
		if type(goals) == "table" then
			if g == nil then g = #goals end
			for k = g, 1, -1 do
				local goal = goals[k]
				if type(goal) == "table" and goal.map ~= nil and goal.x ~= nil then
					gotoAnswer = goal.t == "goto"
					return gotoAnswer
				end
			end
		end
		s, g = s - 1, nil
	end
	return false
end

---------------------------------------------------------------------------
-- Route geometry for the map lines
---------------------------------------------------------------------------

local KIND = { fly = "flight" }
local geom, geomBuilt, geomRoute = nil, -1, -1

local function pt(list, c, wx, wy)
	if c and wx and wy then list[#list + 1] = { c, wx, wy } end
end

-- The engine's path points a..b into `pts` when the path is for the goal (c, wx, wy).
local function walkPoints(pts, c, wx, wy, a, b)
	if not isGoal(c, wx, wy) then return false end
	for i = a or 1, b or count do pt(pts, c, ptsX[i], ptsY[i]) end
	return true
end

local function build()
	local out = {}
	local T = Nav.travel
	local legs, ci = Nav.GetRoute()
	local C = ns.Compat
	local pc, px, py
	if C and C.GetPlayerWorldPosition then pc, px, py = C.GetPlayerWorldPosition() end
	if legs and ci and T and T.Active() then
		local lastParent, prevSeg = nil, 0
		for i = ci, #legs do
			local leg = legs[i]
			local from, to = leg.from, leg.to
			local pts = {}
			local P = leg.parent
			if P ~= lastParent then
				lastParent, prevSeg = P, 0
				for k = i - 1, 1, -1 do
					local before = legs[k]
					if not P or before.parent ~= P then break end
					if before.seg then
						prevSeg = before.seg
						break
					end
				end
			end
			if leg.kind == "walk" and P then
				-- A piece of a split walk: its stretch of the path.
				pt(pts, from.c, from.wx, from.wy)
				walkPoints(pts, P.c, P.wx, P.wy, prevSeg + 1, leg.seg)
				if leg.seg then
					pt(pts, to.c, to.wx, to.wy)
					prevSeg = leg.seg
				end
			elseif leg.kind == "walk" then
				if not walkPoints(pts, to.c, to.wx, to.wy) then
					if i == ci and pc == from.c then pt(pts, pc, px, py) else pt(pts, from.c, from.wx, from.wy) end
					pt(pts, to.c, to.wx, to.wy)
				end
			elseif leg.kind == "fly" and leg.stops then
				for _, node in ipairs(leg.stops) do pt(pts, node.c, node.wx, node.wy) end
			elseif leg.kind == "hearth" or leg.kind == "teleport" then
				if i == ci and pc then pt(pts, pc, px, py) else pt(pts, from.c, from.wx, from.wy) end
				pt(pts, to.c, to.wx, to.wy)
			else
				pt(pts, from.c, from.wx, from.wy)
				pt(pts, to.c, to.wx, to.wy)
			end
			out[#out + 1] = { kind = KIND[leg.kind] or leg.kind, pts = pts, current = i == ci, choke = leg.choke }
		end
	else
		local tc, tx, ty = Nav.GetTargetWorld()
		if tc then
			local pts = {}
			if not walkPoints(pts, tc, tx, ty) and pc == tc then
				pt(pts, pc, px, py)
				pt(pts, tc, tx, ty)
			end
			if #pts > 0 then out[1] = { kind = "walk", pts = pts, current = true } end
		end
	end
	return { legs = out }
end

function Nav.GetRouteGeometry()
	if not Nav.GetTarget() then return nil end
	local T = Nav.travel
	local route = T and T.version or 0
	if not geom or geomBuilt ~= geomVersion or geomRoute ~= route then
		geom, geomBuilt, geomRoute = build(), geomVersion, route
	end
	return geom
end

-- A fresh plan of the same walk (a zone change, a re-plan on the way) is
-- split again from the path already in: the steps stay the same.
ns.On("ROUTE_CHANGED", function(legs)
	local _, ci = Nav.GetRoute()
	local leg = legs and ci and legs[ci]
	if leg and leg.kind == "walk" and not leg.parent and not leg.handmade and count > 1 then Walk.Split() end
	changed()
end)
ns.On("ROUTE_ADVANCED", changed)

---------------------------------------------------------------------------
-- Module
---------------------------------------------------------------------------

function Walk:OnTarget(target)
	if not target then Walk.Clear() end
	changed()
end

function Walk:OnSettings()
	if ns.Get("nav.navRouting") then load() elseif gc then Walk.Clear() end
end

function Walk:Refresh()
	if ns.Get("nav.navRouting") and not Nav.Path and not loadTried then load() end
end

ns.OnLogin(function()
	if ns.Get("nav.navRouting") then load() end
end)

Nav.RegisterModule(Walk)
