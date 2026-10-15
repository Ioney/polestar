-- Polestar.Dungeons: a journal page per dungeon and raid:
-- every quest with where it starts and ends,
-- its objective, chain and rewards, the bosses in kill order with the quests
-- tied to them, and the entrance. No loot tables. Scope: docs/SUITE.md,
-- "Modules"; data and runtime: docs/ARCHITECTURE.md, "Reference data"
-- (`dungeons.json` and the journal pages).
--
-- The data rides in the load-on-demand Codex pack (Dungeons1.lua, written by
-- `codex build` through tools/lib/codex/journal.js): per dungeon a summary
-- table and its page as Lua source, compiled only when that page is asked
-- for. One page is kept decoded at a time.
--
--   Dungeons.Load() -> ok, reason   -- "off" (dungeons.enabled false), Data.Pack's reasons
--                                     ("missing", "disabled", "combat", ...), "nodata" (pack built without Dungeons)
--   Dungeons.IsEnabled() ; Dungeons.Meta()
--   Dungeons.List() -> { { key, name, kind, forever, minLevel, maxLevel, players, zone, zoneName,
--       entrance = { map, x, y, f } | nil, quests = { A = n, H = n }, bosses = n,
--       attune = { A = n, H = n } } }   -- level order, no page decoded
--   Dungeons.Get(key) -> { key, name, kind, forever, minLevel, maxLevel, players, zone, zoneName, entrance } | nil
--   Dungeons.Entrance(key) -> map, x, y, f | nil
--   Dungeons.Quests(key, faction) -> { quest, ... }   -- faction "A" | "H" | nil (all); level order
--   Dungeons.Quest(key, id) -> quest | nil           -- page and chain quests
--       quest = { id, title, level, minLevel, faction, classes, inside, shareable, objective,
--         start, finish (= { kind, id, name, map, x, y, f, inside }), startItem = { id, name },
--         chain = { ids }, rewards = { items = { { id, name, quality, choice } }, xp, money, rep = { { faction, name, value } } },
--         bosses = { names } }
--   Dungeons.Bosses(key) -> { { order, name, npc, level, object, role, quests = { { id, how, item, itemName } } } }
--       object: a chest boss's object id (npc nil); role: "rare" | "event" | "optional" for the
--       bosses after the encounters, nil for an encounter (and on pages built before roles)
--       how: "kill" (an objective), "item" (drops an objective item), "starts" (drops the item
--       that starts it), "involved" (DungeonJournal names it for the quest)
--   Dungeons.Open(key|nil)   -- fires SHOW_DUNGEON(key); the hub section listens
--   Dungeons.GuideTo(key) -> ok ; Dungeons.GuideToPoint(point, label) -> ok   (Nav)
--   Dungeons.ShowOnMap(key) -> ok   -- the world map on the entrance's zone
--   Dungeons.Find(text) -> key | nil
--   Dungeons.Register(group, a, b)  -- pack files only
--   Dungeons.Attunements(key, faction) -> { attunement, ... }   -- faction "A" | "H" | nil (all)
--       attunement = { id, name, kind = "attunement"|"key"|"item", need = "each"|"one", faction,
--         item = { id, name, quality }, note, level, any, goal = { questIds }, steps = { step, ... },
--         inside = { { kind = "npc"|"object", id, instance }, ... } | nil }   -- spawnless NPCs and objects it meets, placed
--       step: { kind = "quest", id, title, level, minLevel, faction, classes, start, finish,
--         startItem, after = { ids }, afterAny = { ids }, goal, rep = { faction, name, standing } }
--         | { kind = "drop", item, npc = point, chance, instance } | { kind = "object", item, object = point, chance }
--         | { kind = "rep", faction, name, standing } | { kind = "gift", item, npc = point }
--       (tools/lib/codex/attunements.js; their state and guide: Dungeons/Attune.lua)
--   Picking up a page's quests (PickupPlan, PickupGuide, PickUp, GiverTarget,
--   PlanStops, OrderStops): Dungeons/Pickup.lua. Handing them in after the
--   run (HandinPlan, HandinFollowUps, HandinGuide, HandIn, HandinText):
--   Dungeons/Handin.lua. Attunements and keys (AttunementState, AttuneGuide,
--   Attune): Dungeons/Attune.lua.
-- Settings: dungeons.enabled. Command: /polestar dungeons [name].

local ADDON, ns = ...
local L = ns.L

local Dungeons = {}
ns.Dungeons = Dungeons

local type, pairs, ipairs, pcall, tostring = type, pairs, ipairs, pcall, tostring
local find, lower = string.find, string.lower
local sort = table.sort

ns.RegisterDefaults("dungeons", { enabled = true })

local function enabled() return ns.Get("dungeons.enabled") and true or false end
Dungeons.IsEnabled = enabled

local meta
local summaries = {} -- key -> summary table
local sources = {} -- key -> page source (string)
local openKey, openPage -- the one decoded page

---------------------------------------------------------------------------
-- Registration and loading
---------------------------------------------------------------------------

function Dungeons.Register(group, a, b)
	if group == "meta" then
		if type(a) == "table" then meta = a end
	elseif group == "dungeon" then
		if type(a) == "table" then for k, v in pairs(a) do summaries[k] = v end end
		if type(b) == "table" then for k, v in pairs(b) do sources[k] = v end end
		openKey, openPage = nil, nil
	end
end

function Dungeons.Meta() return meta end

function Dungeons.Load()
	if not enabled() then return false, "off" end
	if meta then return true end
	local C = ns.Codex
	if not (C and C.Load) then return false, "missing" end
	local loaded, reason = C.Load()
	if not loaded then return false, reason end
	if not meta then return false, "nodata" end
	return true
end

local function ready()
	if meta then return enabled() end
	return (Dungeons.Load())
end

-- key -> page | nil, compiled from its source in an empty environment.
local function page(key)
	if key == nil or not ready() then return nil end
	if key == openKey then return openPage end
	local src = sources[key]
	if type(src) ~= "string" then return nil end
	local fn = loadstring(src, "=Dungeons:" .. tostring(key))
	if not fn then return nil end
	setfenv(fn, {})
	local ok, p = pcall(fn)
	if not ok or type(p) ~= "table" then return nil end
	p.quests = p.quests or {}
	p.chain = p.chain or {}
	p.bosses = p.bosses or {}
	p.attunement = p.attunement or {}
	openKey, openPage = key, p
	return p
end

---------------------------------------------------------------------------
-- Reading
---------------------------------------------------------------------------

local function summary(key, s)
	return {
		key = key, name = s.name or key, kind = s.kind or "dungeon", forever = s.forever and true or false,
		minLevel = s.minLevel, maxLevel = s.maxLevel, players = s.players, zone = s.zone, zoneName = s.zoneName,
		entrance = s.entrance,
		quests = { A = s.quests and s.quests.A or 0, H = s.quests and s.quests.H or 0 }, bosses = s.bosses or 0,
		attune = { A = s.attune and s.attune.A or 0, H = s.attune and s.attune.H or 0 },
	}
end

function Dungeons.List()
	if not ready() then return {} end
	local out = {}
	for key, s in pairs(summaries) do out[#out + 1] = summary(key, s) end
	sort(out, function(a, b)
		local la, lb = a.minLevel or 99, b.minLevel or 99
		if la ~= lb then return la < lb end
		if a.name ~= b.name then return a.name < b.name end
		return a.key < b.key
	end)
	return out
end

function Dungeons.Get(key)
	local s = key ~= nil and ready() and summaries[key]
	if not s then return nil end
	return summary(key, s)
end

function Dungeons.Entrance(key)
	local s = key ~= nil and ready() and summaries[key]
	local e = s and s.entrance
	if not e then return nil end
	return e.map, e.x, e.y, e.f
end

function Dungeons.Quests(key, faction)
	local p = page(key)
	if not p then return {} end
	local out = {}
	for _, q in ipairs(p.quests) do
		if faction == nil or q.faction == nil or q.faction == faction then out[#out + 1] = q end
	end
	return out
end

function Dungeons.Quest(key, id)
	local p = page(key)
	if not (p and id) then return nil end
	for _, q in ipairs(p.quests) do if q.id == id then return q end end
	return p.chain[id]
end

function Dungeons.Bosses(key)
	local p = page(key)
	return p and p.bosses or {}
end

function Dungeons.Attunements(key, faction)
	local p = page(key)
	if not p then return {} end
	local out = {}
	for _, a in ipairs(p.attunement) do
		if not faction or not a.faction or a.faction == faction then out[#out + 1] = a end
	end
	return out
end

function Dungeons.Find(text)
	if type(text) ~= "string" or text == "" then return nil end
	local want, hit = lower(text), nil
	for _, d in ipairs(Dungeons.List()) do
		local n = lower(d.name)
		if n == want or d.key == want then return d.key end
		if not hit and find(n, want, 1, true) then hit = d.key end
	end
	return hit
end

---------------------------------------------------------------------------
-- Acting
---------------------------------------------------------------------------

function Dungeons.Open(key)
	if not enabled() then
		ns.Print(L["Dungeons are turned off (Options > Discovery > Dungeons)."])
		return false
	end
	ns.Fire("SHOW_DUNGEON", key)
	return true
end

function Dungeons.GuideToPoint(point, label)
	local Nav = ns.Nav
	if not (type(point) == "table" and point.map and point.x and point.y and Nav and Nav.SetTarget) then return false end
	return Nav.SetTarget(point.map, point.x, point.y, label or point.name, point.f) and true or false
end

function Dungeons.GuideTo(key)
	local d = Dungeons.Get(key)
	if not (d and d.entrance) then return false end
	return Dungeons.GuideToPoint(d.entrance, d.name)
end

-- Through Compat.OpenWorldMap: the client's C_Map opener, never in combat
-- (the global OpenWorldMap taints the map: NAV_QA C3).
function Dungeons.ShowOnMap(key)
	local map = Dungeons.Entrance(key)
	if not map then return false end
	return ns.Compat.OpenWorldMap(map)
end

ns.RegisterCommand("dungeons", function(rest)
	Dungeons.Open(rest ~= "" and Dungeons.Find(rest) or nil)
end, L["Dungeon quests, bosses and entrances"])

if ns.RegisterOptions then
	local ok, err = ns.RegisterOptions({
		page = L["Discovery"], tab = L["Dungeons"], section = L["Dungeon journal"],
		controls = {
			{ kind = "toggle", key = "dungeons.enabled", label = L["Dungeons"],
				help = L["A page per dungeon and raid: every quest with where to get it, its chain and rewards, the bosses and the entrance."] },
		},
	})
	if not ok and geterrorhandler then geterrorhandler()(err) end
end
