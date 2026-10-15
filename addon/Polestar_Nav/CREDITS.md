# Polestar Nav: credits

Polestar's arrow walks real paths because of
[Shortest Path Forever](https://github.com/cjber/shortest-path-forever) by
**Cillian Berragan** ([cjber](https://github.com/cjber),
[cillian.dev](https://cillian.dev)). He baked walking maps of the continents
from the game client and wrote a router that finds a walking route over them
in a couple of milliseconds a frame, so the game never stutters: round
mountains, through the right gate, down into the mine and not over the
cliff. It is excellent work, and he said yes when we asked to use it:
"Definitely feel free to use my pathing logic, really appreciate you asking
me as well! Feel free to contribute" (2026-10-15). Thank you, Cillian.

If you like walking routes, try his addon too:
[Shortest Path Forever on CurseForge](https://www.curseforge.com/wow/addons/shortest-path-forever)
plans whole journeys with flights, boats, zeppelins, portals and live
departure times.

## What came from Shortest Path Forever

Version 1.15.0, commit
[ba60bce](https://github.com/cjber/shortest-path-forever/commit/ba60bceec93ed48f7706d0f5b3023e5072ed3f8b),
GPL-3.0-or-later, Copyright (C) 2026 Cillian Berragan:

| Here | Upstream | Changed |
|---|---|---|
| `Routing/PathGrid.lua` | `Routing/PathGrid.lua` | the data global is `PolestarPathData`; one header line |
| `Routing/Path.lua` | `Routing/Path.lua` | the same |
| `Routing/PathJobs.lua` | `Routing/PathJobs.lua` | one header line |
| `Nav/Nav.xml` | `Nav/Nav.xml` | one header comment |
| `Nav/Nav*.lua` (the walking maps of map 0 Eastern Kingdoms, 1 Kalimdor and 2991 Zephras Isle) | `Nav/Nav*.lua` | the data global is `PolestarPathData`; one header line |

Each file's header line names its upstream file and commit, his copyright and
licence, and the date it was modified for Polestar (2026-10-15).
`UPSTREAM.json` records the commit, that date and the sha256 of every file as
vendored; `node tools/polestar.js nav vendor <checkout>` redoes the copy from
a newer commit with the same mechanical change, and `nav check` (and
`tests/nav-vendor.test.js`) checks it. Polestar's own files here are
`API.lua` and `Polestar_Nav.toc`.

Polestar does not copy his journey planner or tracker: its own travel planner
(flights, boats, hearth) asks this router only for the walking legs
(`addon/Polestar/Nav/Walk.lua`, which also carries his copyright notice).

Also adapted from his work (v1.15.0, GPL-3.0-or-later, with the same
permission), outside this folder, each file saying so at its top:

- `addon/Polestar/Maps/RouteStrokes.lua`: the route-line geometry of his
  `UI/Strokes.lua` and `UI/FlightLines.lua`.
- `addon/Polestar/Maps/RouteLines.lua`: the map and minimap painters of his
  `UI/Route.lua`.
- `addon/Polestar/Nav/Prompts.lua`: his cast prompt (`UI/Arrow.lua`) and
  "complete this step" (`SkipJourneyStep`, `Journey/Journey.lua`).
- `addon/Polestar/Nav/Alerts.lua`: his transport alerts (`UI/Alert.lua`).
- `addon/Polestar/QoL/Flight.lua`: the flight-route line and choosing a
  flight master's node by ID (`Transport/Taxi.lua`).
- `addon/Polestar/Nav/Journey.lua`: journey input and the way commands
  (`Journey/JourneyInput.lua`, `Core/API.lua`, `Core/TomTom.lua`,
  `Core/Way.lua`).
- `addon/Polestar/Nav/Nearby.lua`: nearby places (`UI/Nearby.lua`).
- `addon/Polestar/UI/JourneyPanel.lua`: the journey tracker's step wording,
  "leaves in about" and a header summing whole-second step times
  (`UI/Tracker.lua`, `Journey/JourneySteps.lua`).
- `addon/Polestar/Nav/Transit.lua`: boat, zeppelin and tram timing and
  teleports (`Transport/Model.lua`, `Timetable.lua`, `Observer.lua`,
  `Sync.lua`, `Teleports.lua`).
- `tools/lib/travel/timetable.js` and `tools/lib/travel/cmangos.js`: his
  transit generators (`tools/gen_routes.py`, `tools/gen_transit.py`).

## With Shortest Path Forever installed too

Polestar Nav always reads its own maps (`PolestarPathData`), never his
`ShortestPathForeverPathData`: his engine evicts decoded entries from its
tables while it works, which would pull them from under a search of ours. So
with both addons installed, each holds its own copy of the maps.

## Licence

Everything in this folder is GPL-3.0-or-later (`LICENSE`). Polestar's
guide-pack exception does not apply here, and nothing from this folder goes
into a guide pack.
