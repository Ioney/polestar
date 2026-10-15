-- Polestar_Nav: Routing/PathJobs.lua from Shortest Path Forever (https://github.com/cjber/shortest-path-forever) at ba60bceec93ed48f7706d0f5b3023e5072ed3f8b, Copyright (C) 2026 Cillian Berragan, GPL-3.0-or-later. Modified for Polestar on 2026-10-15 by `node tools/polestar.js nav vendor`: the data global is PolestarPathData.
---@class SPFNamespace
local ns = select(2, ...)

-- Coroutine-sliced walking searches: Path.lua's searches share one frame budget. Cancelled and released jobs give up
-- their scratch; a paused job keeps it.
---@class SPFPath
local Path = ns.Path
local Grid, Search = ns.PathGrid, ns.PathSearch
local clock, Deadline, Expansions = Grid.clock, Grid.Deadline, Grid.Expansions
local start, scratch, Spare = Search.start, Search.scratch, Search.Spare

-- Round-robin slices share one frame budget, including callbacks that replan from newly settled costs.
local queue = {}
local scheduled, pumped = false, false
local pump, combatWait

local function notify(job, callback, points, cost)
	if callback then
		table.insert(queue, 1, {
			co = coroutine.create(start),
			notify = callback,
			owner = job,
			points = points,
			cost = cost,
			frames = 0,
			cpu = 0,
		})
	end
end

local function schedule()
	if not scheduled and #queue > 0 then
		scheduled = true
		Path.after(pump)
	end
end

pump = function()
	scheduled, pumped = false, true
	if InCombatLockdown and InCombatLockdown() then
		if not combatWait then
			combatWait = CreateFrame("Frame")
			combatWait:SetScript("OnEvent", function(self)
				self:UnregisterEvent("PLAYER_REGEN_ENABLED")
				schedule()
			end)
		end
		combatWait:RegisterEvent("PLAYER_REGEN_ENABLED")
		return
	end
	local finish = clock() + Path.budget
	repeat
		local job = table.remove(queue, 1)
		if not job then
			break
		end
		local t0 = clock()
		Deadline(math.min(finish, t0 + (not job.notify and #queue > 0 and Path.budget / 2 or Path.budget)))
		Expansions(job.expansions or 0)
		local saved = scratch(job.scratch)
		local ok, points, cost = coroutine.resume(job.co, job)
		job.scratch = scratch(saved)
		job.expansions = Expansions()
		job.frames = job.frames + 1
		job.cpu = job.cpu + clock() - t0
		Deadline(math.huge)
		if not ok or coroutine.status(job.co) == "dead" then
			if not job.targets and not job.notify then
				Spare(job.scratch)
			end
			job.done, job.scratch, job.co = true, nil, nil
			if not ok then
				geterrorhandler()(points)
				points, cost = nil, "error"
			end
			if not job.cancelled then
				notify(job, job.callback, points, cost)
			end
		else
			if points == "load" then
				finish = 0
			end
			if job.notify then
				table.insert(queue, 1, job)
			else
				queue[#queue + 1] = job
			end
			if job.progress then
				notify(job, job.progress, job.costs)
			end
		end
	until clock() >= finish
	if #queue == 0 then
		-- Exact endpoint costs survive; decoded grids and local trees are only useful during active work.
		Grid.Idle()
		Spare(nil)
	end
	schedule()
end

-- Idle work skips frames a queued search holds or one since the last call spent, so they never share a budget.
function Path.Busy()
	local busy = pumped or #queue > 0
	pumped = false
	return busy
end

-- Next-frame scheduling; tests replace it.
---@param fn fun()
function Path.after(fn)
	C_Timer.After(0, fn)
end

local function enqueue(job)
	job.co, job.frames, job.cpu = coroutine.create(start), 0, 0
	queue[#queue + 1] = job
	schedule()
	return job
end

-- Search coroutine-sliced over frames between two { x, y, z } points (z optional: it picks the floor to start or end
-- on). callback(points, cost, job) or callback(nil, reason, job): points are { map, x, y, z } from the start to the
-- goal, with points.wet the drawn yards over water. Cost is the abstract route in running yards, not the smoothed
-- polyline length; a swum grid yard counts as the data's swim (so routes keep out of water) unless waterWalking, when
-- water is ground. reason is "nodata", "outside", "offmesh", "unreachable" or "error". Returns a Cancel handle.
---@param map number
---@param from SPFPoint
---@param to SPFPoint
---@param callback fun(points: SPFWalkPoints?, cost: number|string, job: SPFPathJob)
---@param waterWalking? boolean
---@return SPFPathJob
function Path.Find(map, from, to, callback, waterWalking)
	return enqueue({
		map = map,
		from = from,
		to = to,
		waterWalking = waterWalking,
		callback = callback,
	})
end

-- A candidate can be ruled in or out without refining all its intermediate clusters into drawing points.
-- callback(cost, reason, job) uses the same exact graph cost as Find and FindMany.
---@param map number
---@param from SPFPoint
---@param to SPFPoint
---@param callback fun(cost: number?, reason: string?, job: SPFPathJob)
---@param waterWalking? boolean
---@return SPFPathJob
function Path.FindCost(map, from, to, callback, waterWalking)
	local job = Path.Find(map, from, to, callback, waterWalking)
	job.costOnly = true
	return job
end

-- callback(costs, reason, job) completes once; optional progress(costs, nil, job) runs after each slice.
-- costs[i] is nil until settled, an exact running-yard cost afterwards, or false when unreachable. job.radius
-- bounds every unsettled target, including a popped entrance whose expansion has not finished. Pause/Resume
-- retain the frontier. Missing data or an invalid source completes with all false plus a reason.
---@param map number
---@param from SPFPoint
---@param targets SPFPoint[]
---@param callback fun(costs: (number|false)[], reason: string?, job: SPFPathJob)
---@param waterWalking? boolean
---@param reverse? boolean
---@param progress? fun(costs: (number|false)[], reason: nil, job: SPFPathJob)
---@return SPFPathJob
function Path.FindMany(map, from, targets, callback, waterWalking, reverse, progress)
	return enqueue({
		map = map,
		from = from,
		targets = targets,
		waterWalking = waterWalking,
		reverse = reverse,
		progress = progress,
		costs = {},
		radius = 0,
		revision = 0,
		callback = callback,
	})
end

-- Paused batches retain their settled costs and frontier for later replans, without consuming frames.
---@param job SPFPathJob
function Path.Pause(job)
	job.paused = true
	for i = #queue, 1, -1 do
		local queued = queue[i]
		if queued == job or queued.owner == job then
			table.remove(queue, i)
		end
	end
end

---@param job SPFPathJob
function Path.Resume(job)
	if job.paused and not job.done and not job.cancelled then
		job.paused = false
		job.co = job.co or coroutine.create(start)
		queue[#queue + 1] = job
		schedule()
	end
end

-- A proved journey needs the exact costs and validity/bounds, not a suspended Dijkstra stack.
-- If a later timetable exposes another alternative, Resume rebuilds only the missing frontier.
---@param job SPFPathJob
function Path.ReleaseMany(job)
	Path.Pause(job)
	job.co, job.scratch, job.callback, job.progress = nil, nil, nil, nil
end

function Path.ClearCaches()
	-- Cancellation removes a journey's jobs first; never invalidate another active search's grids.
	if #queue > 0 then
		return
	end
	Grid.Reset()
	Spare(nil)
end

---@param job SPFPathJob
function Path.Cancel(job)
	Path.Pause(job)
	job.cancelled, job.scratch, job.co = true, nil, nil
end
