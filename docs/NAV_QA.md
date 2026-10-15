# Pathing quality checks

Polestar's in-game walking routes, route lines, transport timetables and
travel prompts build on [Shortest Path Forever](https://github.com/cjber/shortest-path-forever)
by Cillian Berragan (GPL-3.0-or-later, used with his permission; see
`addon/Polestar_Nav/CREDITS.md`). Before integrating it, every problem
reported against it was gathered (its CurseForge comments, its GitHub issues
and pull requests #1 to #143, and its changelog up to v1.15.0, the version
`addon/Polestar_Nav` carries) so that Polestar does not inherit them. This
file lists the ones that touch what Polestar uses, the check Polestar holds
itself to, and where that check lives. Test names cite these ids ("C5",
"K3", "row 7"); keep them stable.

"Upstream" is the problem's state in Shortest Path Forever. "Polestar" says
where the check is enforced: a test file, an in-game check (see the end), or
why it does not apply.

## Reported problems (rows 1-16)

| # | Problem | Upstream | Polestar |
|---|---|---|---|
| 1 | Replanning a walk measured at zero cost raised "Division by zero" | Fixed 1.15.0 (#139) | Zero-length legs keep every time finite (K7): `tests/ui-journey.test.js`, `tests/nav-spf.test.js` |
| 2 | Flights planned through flight points the character does not know (Everlook, Bloodvenom Post from Moonglade) | Fixed 1.15.0 | No flight leg lands at or connects through an unknown node; walking to one is fine: `tests/travel-transit.test.js` |
| 3 | A learned flight point (Camp Taurajo) not counted as known | Manual toggle added 1.14.0; detection unclear | The known set is read again for every plan: `tests/travel-transit.test.js`; in game, see below |
| 4 | The journey tracker overlapped the quest tracker | Fixed 1.15.0 (#142) | Not taken: Polestar's journey lives in its own guide window |
| 5 | The tracker's title stayed on screen with nothing tracked | Fixed 1.15.0 | The journey panel leaves nothing on screen without a route: `tests/ui-journey.test.js` |
| 6 | Crashes or blocked actions with a game controller (`SetPreferredGamepadInteractTarget()`), also with other addons | **Open** upstream, cause unknown | No protected calls or secure frame changes in combat (`tests/nav-prompts.test.js`); in game, see below |
| 7 | TomTom waypoints ignored; `/way` missing; then Remove all not hooked, the corpse arrow replacing the journey, `/reload` out of step, a disabled TomTom counted as installed | Fixed 1.15.0 | `tests/nav-journey.test.js` |
| 8 | Shift-click on a map pin planned a journey instead of linking it into an open chat box | Fixed 1.14.1 (#136) | `tests/nav-journey.test.js` |
| 9 | Map icons swallowed the click, so nothing could be planned onto one | Fixed 1.14.0 (Alt-click) | Alt-click plans over icons and leaves their own clicks alone: `tests/nav-journey.test.js` |
| 10 | A flight point that does not exist (Powderfuse Port) | Fixed 1.7.0 (data) | Not taken: Polestar's flight network comes from its own `travel build` |
| 11 | The Hearthstone used too eagerly; skipping it did not stick | Fixed 1.7.0, 1.14.0 | A skipped hearth, teleport, flight or ride stays out of the plans for that target: `tests/travel-transit.test.js`, `tests/nav-prompts.test.js` |
| 12 | A long walk chosen over new boats | Changed 1.8.0 (#86) | Polestar's planner costs every leg in seconds, the timetabled waits included, and takes the fastest: `tests/travel.test.js` ("crosses continents by boat"), `tests/travel-transit.test.js` |
| 13 | Moving the tracker and compass | Done 1.8.0 | Not taken (no compass; the guide window already moves) |
| 14 | The compass hard to read over bright ground | Background added 1.15.0 | Not taken |
| 15 | A stop pin without its step text | Added 1.15.0 | Polestar's route stops carry their caption in the tooltip |
| 16 | Requests: UI scale, metres, hide the journey or the arrow | Added 1.12-1.14 | Metres follow Polestar's distance option: `tests/ui-journey.test.js`; the journey and the route lines each have a switch |

## Bugs from his changelog (C1-C17)

| # | Bug | Upstream | Polestar |
|---|---|---|---|
| C1 | An arrow update queued before a cancel read a cleared path | Fixed 1.4.7 (#73) | Cancelling or replacing guidance between queued updates revives nothing: `tests/nav-prompts.test.js`, `tests/nav-spf.test.js` |
| C2 | A cancelled search read cleared walking batches | Fixed 1.12.1 (#125) | A cancelled search never calls back: `tests/nav-spf.test.js`, `tests/nav-vendor.test.js` |
| C3 | Opening the world map from addon code tainted it: no map in combat, quest pins lost until a reload | Fixed 1.8.0 (#92) | `Compat.OpenWorldMap` only, never in combat, and a lint rejecting any other opener: `tests/compat.test.js` |
| C4 | Map and minimap pins refreshed in combat | Fixed 1.4.6 (#71) | Route-line refreshes wait for the end of combat: `tests/nav-route-lines.test.js` |
| C5 | Errors when the position or facing could not be read | Fixed 1.2.0 (#21), 1.15.0 | `Compat.GetPlayerUnitPosition()` is the one reader; unreadable values hide or skip with no error: `tests/nav-prompts.test.js`, `tests/nav-route-lines.test.js`, `tests/nav-transit.test.js` |
| C6 | Stormwind walks started on the canal bed below the street and doubled back | Fixed 1.2.0 (#29, #41) | Stormwind's flight master to the Mage Quarter never reverses on a level street: `tests/nav-vendor.test.js` |
| C7 | Walks to a boat crossed the water at Auberdine | Fixed 1.11.1 (#120) | Polestar walks to its own dock points (`travel build`); in game, see below |
| C8 | Walks to a zeppelin ended on the ground below the tower | Fixed 1.2.0 | Polestar walks to its own dock points; in game, see below |
| C9 | Tram steps said "Walk to Unknown"; flight steps showed a wait; untimed boats said nothing useful | Fixed 1.2.0, #43 | Flights carry no wait; an untimed loop shows the expected wait as "about": `tests/nav-transit.test.js`, `tests/travel-transit.test.js`, `tests/ui-journey.test.js` |
| C10 | A dock tooltip errored on an empty departure group | Fixed 1.5.0 | Not taken (no dock tooltips) |
| C11 | A route asked for while a ghost errored | Fixed 1.3.0 | Ghost routes walk only, with no error: `tests/nav-journey.test.js`, `tests/travel-transit.test.js` |
| C12 | A pooled texture kept another icon's texture coordinates | Fixed 1.10.0 | Pooled lines reset theirs: `tests/nav-route-lines.test.js` |
| C13 | Clicks on the sea, a continent or the minimap's corner planned to nowhere, silently | Fixed 1.8.1, 1.8.2 | No zone under the click prints a message and plans nothing: `tests/nav-journey.test.js` |
| C14 | Nearby services: a missing or unreadable database looked like "nothing here" | Fixed 1.8.2 (#96) | Each Codex failure has its own message: `tests/nav-journey.test.js` |
| C15 | The other faction's boats and zeppelins still planned | Fixed 1.6.0 | Never planned: `tests/travel-transit.test.js` |
| C16 | A speed change rebuilt the whole route graph in one frame | Fixed (#102) | Polestar's planner costs legs during each search, with the speed read for that plan, so a speed change rebuilds nothing; a plan is capped at 40 ms and 20,000 steps (`Nav/Travel.lua`, `MAX_MS`, `MAX_POPS`) |
| C17 | The walking maps loaded at once, at startup (~11 MB, ~64 ms of work) | Fixed 1.9.0, 1.10.0 (#110) | `Polestar_Nav` loads on demand, out of combat; searches are sliced over frames within `Path.budget` (2 ms): `tests/nav-vendor.test.js`; load time and memory in game, see below |

Also noted while reading v1.15.0, none reported by players:

- His search queue waits out combat, so the arrow keeps its last path during
  a fight (`Nav/Walk.lua` keeps it; nothing is searched in combat).
- His TomTom stand-in has four methods only; Polestar's answers any other
  method harmlessly (`tests/nav-journey.test.js`).
- His route-stroke bridging could wrap to the wrong point on a boat with more
  than two points (`UI/Strokes.lua:298`); Polestar's never does
  (`tests/nav-route-lines.test.js`).

## Found while integrating (H1-H2)

| # | Hazard | Polestar |
|---|---|---|
| H1 | Sharing an installed Shortest Path Forever's map tables: his engine trims and resets them while ours may be searching, which ends in a Lua error | Polestar always reads its own `PolestarPathData`: `tests/nav-vendor.test.js` |
| H2 | Polestar's own "Show on map" (Dungeons) used the global world map opener that C3 describes | Fixed through `Compat.OpenWorldMap`: `tests/compat.test.js`, `tests/ui-dungeons.test.js` |

## Chokepoint steps (K1-K8)

A walk is split into named, timed steps at the places it passes (lifts,
crossings, approach chains, guide gotos; gates, bridges, caves and passes
once the walking maps carry them).

| # | Check | Polestar |
|---|---|---|
| K1 | Every step has a name; without a subzone, the kind and the zone ("the bridge in Loch Modan"), never "Unknown" | `tests/nav-spf.test.js`, `tests/ui-journey.test.js` |
| K2 | The walk is split once per plan, never per frame: ten position updates along a leg change only the times | `tests/nav-spf.test.js`, `tests/ui-journey.test.js` |
| K3 | A lift says "leaves in about M:SS" until a ride has timed it, then "leaves in M:SS"; walks, gates, bridges, caves and passes carry no wait | `tests/nav-spf.test.js`, `tests/nav-transit.test.js`, `tests/ui-journey.test.js` |
| K4 | A lift's top or bottom comes from the path's direction, not the player's height | `tests/nav-spf.test.js` |
| K5 | A chokepoint snaps to the nearest point on the path and splits only there, so no leg runs out and back | `tests/nav-spf.test.js` |
| K6 | The steps of a split walk add up exactly to the walk's time | `tests/nav-spf.test.js` |
| K7 | Legs under a few yards are merged or dropped; every time stays finite | `tests/nav-spf.test.js`, `tests/nav-route-lines.test.js`, `tests/ui-journey.test.js` |
| K8 | A hand-made chain node or guide goto at the same spot keeps its own caption | `tests/nav-spf.test.js`, `tests/nav-route-lines.test.js` |

## In game

What tests cannot prove, checked in the client before a release:

1. **Controller and taint (row 6):** Gamepad interface style and
   `/console taintLog 1`; follow a route through the arrow, the travel
   button, map clicks and a fight; no `ADDON_ACTION_BLOCKED` naming
   Polestar, with the Blizzard waypoint option on and off.
2. **Flight points (row 3):** learn a new one (Camp Taurajo), `/reload`, and
   the next route may use it.
3. **Docks (C7, C8):** the walk to Auberdine's boats stays on land; the walks
   to Grom'gol's, Tirisfal's and Orgrimmar's zeppelins end on the tower's
   platform.
4. **Loading (C17):** `Polestar_Nav` loads after login without a hitch;
   note its memory with `/run UpdateAddOnMemoryUsage() print(GetAddOnMemoryUsage("Polestar_Nav"))`.
