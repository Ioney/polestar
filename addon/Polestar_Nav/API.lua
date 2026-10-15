-- Polestar_Nav's handoff to Polestar: the global Polestar_NavEngine is Shortest
-- Path Forever's Path table (Routing/), which Polestar's Nav keeps as
-- ns.Nav.Path. Its calls are upstream's: Find(map, from, to, callback,
-- waterWalking), FindCost, FindMany, Cancel(job), Busy(), with points in
-- UnitPosition's frame (x north, y west, z optional) and map the instance map
-- ID (0 Eastern Kingdoms, 1 Kalimdor, 2991 Zephras Isle). The engine reads
-- only PolestarPathData, our own copy of the maps, never an installed Shortest
-- Path Forever's tables (its engine evicts decoded entries while ours may be
-- searching them). Added here:
--
--   Path.Available(map) -> true when walking routes can be found on that map
local _, ns = ...
local Path = ns.Path

function Path.Available(map)
	return map ~= nil and Path.HasData(map)
end

Polestar_NavEngine = Path
