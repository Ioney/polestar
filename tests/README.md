# tests/

Polestar's tests use Node's built-in runner (`node:test`) and no npm
packages. The addon's tests run the real addon Lua under a real Lua 5.1
against a fake game client written in Lua.

```sh
node --test "tests/**/*.test.js"                                   # everything (npm test does the same)
node --test tests/engine.test.js                                   # one file
node --test --test-name-pattern="hand-over" tests/playtest.test.js # the tests in a file whose name matches
```

Needs: Node 24 or newer; `lua5.1` (or LuaJIT, or a `lua` that is 5.1; `$LUA`
picks one) for every addon test; `luac5.1` for `syntax.test.js`; `python3`
for the zip checks in `pack.test.js`. `node tools/polestar.js doctor` checks
Node and Lua.

CI (`.github/workflows/ci.yml`, on pushes to main and on pull requests)
installs Lua 5.1 and runs `npm test`, then rebuilds the textures with
`node tools/polestar.js media` and the UI renders with
`node tools/polestar.js preview`, and fails when either differs from the
committed files in `addon/Polestar/Media` and `docs/preview`.

## Layers

The test files sit side by side in this folder; the name says the subject,
not the layer. They fall into these layers:

| Layer | What runs | Examples |
|---|---|---|
| Tool library | Plain Node: a `tools/lib` module called on fixtures | `dsl*.test.js`, `data*.test.js`, `codex*.test.js`, `route.test.js`, `sim*.test.js`, `travel-build.test.js`, `consume*.test.js`, `find.test.js`, `pack-manifest.test.js` |
| Commands | `node tools/polestar.js <command>` run as a child process (or in-process with its output captured), its exit code and output checked | `compile.test.js`, `lint*.test.js`, `install.test.js`, `pack.test.js`, `new.test.js`, `dev.test.js`, `record.test.js`, `release.test.js` (`version`), `play.test.js`, `cli-help.test.js` (`--help` prints the usage and does no work) |
| Addon modules | The addon's own Lua under Lua 5.1, against the fake client, through `helpers/lua.js` | `core.test.js`, `engine*.test.js`, `nav*.test.js`, `quests*.test.js`, `gear*.test.js`, `maps*.test.js`, `qol.test.js`, `lookup*.test.js`, `dungeons-*.test.js`, `ui*.test.js`, `rares.test.js`, `recorder*.test.js` |
| End to end | A guide compiled by the real compiler and played in the whole addon | `e2e.test.js`, `guides.test.js` (every authored guide, every class), `playtest.test.js`, `acceptance-packs.test.js` |
| Static and docs | Checks over files rather than behaviour at run time | `syntax.test.js` (every addon file compiles, no stray globals, every file loaded by a manifest), `guides-parse.test.js` (every guide parses, and `Polestar_Guides` holds exactly those guides), `media-refs.test.js` (every texture in `Media` is named by the addon), `svg-assets.test.js` (every committed SVG is well-formed for a browser: no `--` in a comment), `wording.test.js` (the addon, the guides, every doc and the pack template name no other guide product), `docs-packs.test.js` (the pack docs name every verb and key), `docs-cheatsheet.test.js`, `packs-parity.test.js` (lint and the runtime refuse the same guides), `text-fit.test.js` (text stays inside its window) |
| Performance | CPU budgets: the whole addon with every module on, and the Recorder while it records | `perf.test.js`, `recorder-perf.test.js` |

## The fake client: tests/lua

`helpers/lua.js` loads `wow_stub.lua`, then the stubs a test asks for, then
the addon files in the order the TOC and XML manifests give, exactly as the
client loads them.

| File | What it fakes |
|---|---|
| `wow_stub.lua` | The generic client every module shares: frames, scripts, events, timers and a clock the test advances, fonts, animation groups, slash commands, settings panels. No quest, map or unit APIs. |
| `stub_world.lua` | The game world for Core tests: the player, quest log, bags, NPCs, the quest, gossip, trainer, merchant and taxi frames, and maps with simple bounds |
| `stub_nav.lua` | A world for Nav: fakes of `Compat` and `Engine`, a world map canvas, the minimap, super-tracking and an optional waypoint addon |
| `stub_quests.lua` | Quest log enumeration, completed quests, tooltip processing, nameplates, loading `Polestar_QuestDB`, and a fake of `Pins` |
| `stub_questlog.lua` | The client's quest title surfaces (quest log, tracker, gossip, greeting and quest details), for quest levels |
| `stub_gear.lua` | Items, equipment, bags, talents, tooltips and quest reward choices |
| `stub_maps.lua` | The taxi map, instances and saved lockouts, and a small travel world |
| `stub_qol.lua` | A world for Quality of Life: fakes of the Engine, Nav and Pins, and the client APIs QoL uses (XP, merchant, rewards, gossip, taxi, death, requests from other players) |
| `stub_lookup.lua` | A stand-in for Search, the Codex and the Lookup runtime, for the Lookup window's tests (global `lookupstub`) |
| `stub_lookup_runtime.lua` | The client pieces the Lookup runtime touches: tooltip post-calls, mount auras, Alt-click (global `lookuprt`) |
| `stub_rares.lua` | Units and vignettes for rare detection |
| `stub_packs.lua` | Load-on-demand data addons from real files: `LoadAddOn` runs a pack's files once and fires `ADDON_LOADED` |
| `stub_ui.lua` | A stand-in for the Engine, the guide registry, Nav and Compat, with sample guides, for the UI tests and for `preview` (global `uistub`) |
| `stub_recorder.lua` | The Recorder's slice of the world: player, maps, quest log, NPCs (classification, level), deaths, loot windows and their sources, instances, flight masters, talents |
| `profile.lua` | Not a stub: per-handler timing and a stack sampler for `helpers/profile.js` |

A module's tests fake its neighbours; `e2e.test.js` is where the real
modules meet. New client APIs go in the stub of the module that needs them;
`wow_stub.lua` keeps only what every module shares.

## Helpers

| File | What it gives |
|---|---|
| `helpers/lua.js` | `runAddon({ stubs, before, addons, saved, login, script })`: runs addons under Lua 5.1 and returns what the script `emit`ted. `POLESTAR_ADDON_DIR` loads the addons from another folder. |
| `helpers/dsl.js` | The toolchain tests' helpers: the fixture reference data (`DATA_DIR`, `fixtureData`), `compile` of guide text, `writeTestPack` |
| `helpers/cli.js` | `polestar(args, { cwd, env, input })` runs the command line as a child process; `quiet(fn)` runs a command in-process with its output captured; `fakeAddons` lays out addon folders for pack and install tests |
| `helpers/data.js` | `needs(...files)`: the one skip reason for a test that reads `data/forever` when those files are not built |
| `helpers/locale.js` | `fakeLocale(locale, strings)`: Lua for `runAddon`'s `before` that makes `GetLocale()` return `locale` and fills `Polestar.L` with `strings` right after `Core/Init.lua`, where a locale file loads |
| `helpers/tmp.js` | `tmpdir()`: a fresh temporary folder, removed when the test process exits |
| `helpers/codex.js` | `writeCodexPack`, `sampleCodex`: a loadable `Polestar_Codex` built from a Codex object such as `fixtures/codex/sample.json` |
| `helpers/packs.js` | `TEST_PACK`, `TEST_SOURCE`: the Lua lines that register the test guide pack and make it the suggestion source |
| `helpers/profile.js` | `profileGuide`: plays a guide with every handler timed. Also a command: `node tests/helpers/profile.js <guide> [race] [class] --packs [--sample=1000]` |

## Fixtures

`fixtures/` holds small, committed inputs, so the suite runs on a fresh clone:
reference data in the `data/forever` shape (`dsl/data`, `questdb`, `route`,
`find/data`), guide packs good and bad (`packs`), cached source tables
(`data/sources`, `professions/wago`, `travel/sources`), recordings,
installed-addon samples (`codex/addons`, `dungeonjournal`,
`consume/wowsims`), simulator inputs (`sim`) and six compiled guides frozen
for the guide menu scenes of `preview` and `text-fit.test.js` (`preview`).

## Tests that need local data

Some tests read what only a maintainer's machine has. Each checks for its
input at load time and, when it is missing, skips with the reason (for
`data/forever`, the one `helpers/data.js` gives). On a fresh clone, and in
CI, they skip; everything else runs.

| Local input | Built by | Tests that use it |
|---|---|---|
| `data/forever/*.json` (reference data) | `data build` and the other data commands | `guides.test.js`, `guides-caves.test.js` and `guides-reported.test.js` (player-reported guide fixes, one case per report), `lint-timed.test.js` (the old and fixed orders of timed quest items, every guide in time; needs item durations), `engine-placement.test.js`, `perf.test.js`, `acceptance-packs.test.js`, `playtest.test.js`, `play.test.js`, `play-pack.test.js`, `play-start.test.js`, `new.test.js`, `dev.test.js`, `dsl.test.js`, `maps-zonelevels.test.js`, `profession-gathering.test.js`, `questdb.test.js`, `planner-timeline.test.js` (the Dwarf chain played to level 55; needs `travel.json` too) |
| Client map tables cached in `data/sources/wago` | `exploration build` | `exploration.test.js` |
| `addon/Polestar_QuestDB` | `questdb build` | `questdb.test.js`, `quests.test.js` |
| `addon/Polestar_Codex` | `codex build` | `lookup-codex.test.js` (release-safe, and Lookup, Dungeons and Rares read it in game) |
| `data/forever/codex/*.json` | `codex build` | `dungeons-attune.test.js` (the real attunement chains) |
| `addon/Polestar_ItemDB/Items.lua` | `itemdb build` (committed, so present on a clone) | `itemdb.test.js` |
| `data/local/crossings.json`, `addon/Polestar_Travel` | the local crossings file, `travel build` | `travel-crossings.test.js`, `nav-crossings.test.js` |
| `data/local/nav/` (the navigation grid) | `nav build` | `navmesh-path.test.js` (real routes: the Frostmane Hold cave mouth, the Mesa Elevator, the South Gate tunnel) |
| The Forever client's map tiles and WMO roots cached in `data/sources/casc` | `nav build` | `navmesh-geom.test.js` (WMO bounding boxes on their placements, real tiles) |
| Installed addons in the game's AddOns folder | the game client | `consume.test.js` |

`perf.test.js` also loads the local data addons when they are built.

## Conventions

- **Behaviour, not implementation.** A test drives the addon or a command the
  way the game or a user would, and checks what comes out: emitted state,
  frames, files, exit codes, messages.
- **Deterministic.** The addon's time comes from the stub's clock, which a
  test advances; the simulator runs with a fixed seed; outputs that must be
  reproducible are compared byte for byte.
- **No network.** Downloads are replaced by fixtures or an injected fake
  fetch; the playground tests bind `127.0.0.1` on a free port.
- **Self-contained.** A test writes only under `tmpdir()`, never into the
  repository.
- **Skips say why.** A test that needs local data skips with a reason naming
  what is missing, never fails for it.
