# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A dependency-free, **static** browser simulation of *generative agents* (inspired by
Park et al., 2023). **24 residents** of "Willow Creek" — a **511-location town laid out
like a well-planned community** (149 hand-authored + 88 generated street + 274 courtyard cells):
homes, work, and community buildings (cafés, shops, a chapel,
cinema, bank, salon, florist, pharmacy, museum, post office, diner) packed into a **3×3
grid of 7×7 ZONED city blocks** (commercial core → civic → residential → craft edge,
placed center-out; the spare central slot is the town park) separated by a connected network
of **paved streets** the residents walk, with a **1-cell landscaped gap between any two
building complexes** (no two buildings ever touch) and green/plaza courtyards filling every
leftover cell (so no cell is bare grass), all in a 23×23 footprint — observe,
store/retrieve memories, plan their day, reflect, hold
**group conversations**, walk **A*-pathed routes**, and form relationships. Pure
ES-module JavaScript — **no build step, no bundler, no transpiler, no backend, no LLM
API keys**. The town is rendered with vendored PixiJS (WebGL) and an automatic canvas-2D
fallback, both **high-DPI**, **chunk-baked + viewport-culled**, with a shared
**free-roam Camera** over a **boundless** map (the town floats in an infinite field of
grass) and animated **CharacterFactory** avatars.

## Deploy snapshot + dev tooling

This directory is the published GitHub Pages copy, but it now carries a small **dev-only**
toolchain (not served, harmless on Pages):

- `package.json` — `{"type":"module"}` so Node can import the ES-module core; provides `npm run smoke` / `npm run check`.
- `test/smoke.node.mjs` — headless harness for the DOM-free core (world integrity, **determinism**, save/load, pathfinding, renderer re-route wall-legality, group-conversation invariants, sleep/bed invariants). 29 checks.
- `tools/check-all.mjs` — runs `node --check` over every `js/**/*.js` except `js/vendor`.
- Still **no** ESLint/Prettier/CI. **All art is original, self-generated SVG → PNG atlases** (no third-party/Kenney assets): town tiles in `assets/sprites/atlas.png`, characters in `assets/characters/atlas.png`. Asset tools live in `tools/` (`gen_chars_svg.mjs`, `assemble_atlas.mjs`, `pack_tiles.mjs`, `validate_tiles.mjs`, `svg2png.mjs`, `pack_locations.mjs` — assigns the packed grid x/y + `complex` ids in `seedLocations.js`, `screenshot.mjs` — headless-Chrome capture of the live app for the art verify loop). `tools/audit_rooms.mjs` is a **dev-only, DOM-free overlap auditor**: it drives the real `townArt.drawTownInto` sprite path with a mock canvas + manifest-sized mock sprites, records every furniture sprite's rectangle tagged by its room clip, and deterministically flags furniture↔furniture overlaps (excluding intended rug/mat underlays + dining-set tucks) and out-of-room spills per building type — catches the pixel-level room-furniture collisions that thumbnail screenshots hide. It also pins **bed-spot alignment**: every `layout.bedAssign` sleeper spot must land on a distinct drawn bed sprite rect of the expected `BED` dims (see *Rendering → Sleep & beds*).

The README is inherited from the upstream source repo (`Mon-ius/generative-agents-vanilla-pages`)
and is **stale** re: world size, art, and the renderer — trust this file over it.

## Commands

**Run locally** (required — ES `import` is blocked from `file://`, so opening `index.html` directly won't work):
```bash
python3 -m http.server 8000   # any static server works; then open http://localhost:8000/
```

**Test** — headless core (fast, gates determinism/pathfinding/groups), and in-browser:
```bash
node test/smoke.node.mjs    # or: npm run smoke   — 29 checks, exits non-zero on failure
node tools/check-all.mjs    # or: npm run check   — node --check every js/**/*.js (skips js/vendor)
node tools/audit_rooms.mjs  # room-furniture overlap audit; per-type table. Report-only — ALWAYS exits 0:
                            # read the printed "TOTAL unintended furniture overlaps / out-of-room spills /
                            # bed-spot misses (+ size drift)" line, not the exit code (unlike smoke/check,
                            # which exit non-zero on failure)
```
The smoke harness is a **single fast file with no per-test filter** — it runs all 29 checks and
prints a labeled `✓`/`✗` line each; to isolate one, read its label in the output (or temporarily
comment the others). No npm script for the room auditor — run it directly (add `--verbose` for a per-type detail
list of *unique* flagged pairs/spills — overlaps deduped by sprite-name pair, spills by sprite
name, each showing only the worst fraction, so verbose lines can total fewer than the TOTAL
counts; note "TOTAL 0/0" is thresholded — overlaps
< 12 %/< 6 px² pass silently, and a spill is flagged only when it is **both** > 2 px **and** > 18 %
of the sprite's smaller drawn dimension, so a visible few-px spill on a typical 20–60 px sprite
can still report 0) after any `townArt.js`
furniture/`BLUEPRINTS` change. Three more test-interpretation gotchas: the smoke suite has one
**wall-clock gate** — "200 steps under 4s" — that can fail spuriously on a loaded machine with no
code change; its world-integrity counts are **loose floors** (`locations ≥ 60`, `agents ≥ 20` —
losing all 88 streets or all 274 courtyards still passes 29/29; only the duplicate-coord and
agent-location-ref checks are exact, and location-**id** uniqueness is never checked at all — see
*Configuration & extending*); `npm run check` walks **only the `js/` tree**, so a syntax error in
`test/*.mjs`/`tools/*.mjs` itself surfaces only when that tool runs; and `audit_rooms.mjs` hardcodes
the 176px cell in its room-type labeler (`typeOfClip`), not `CONFIG.world.cellPixels` — change
`cellPixels` and the audit still exits 0 while labeling rooms `?` (a garbage per-type table).
```js
window.runSmokeTest()       // browser console; a SEPARATE smaller suite defined in main.js (NOT the
                            // 29-check node harness); MUTATES the live sim (steps/selects/saves/resets);
                            // returns JSON-serializable { passed, total, results } — doubles as a
                            // headless probe via screenshot.mjs --eval
```
`window.__app` (`{ app, sim, renderer, controls, map }`) is exposed for live inspection;
`__app.map.camera` exposes the pan/zoom Camera (`fit()`, `zoomIn/Out`, `centerOn(wx,wy)`, `toJSON/applyState`).
Boot is two-phase: `__app.map` is **null** until the async `setupMap()` resolves — the readiness
contract for console snippets/automation is `__app.map.layout` (what `tools/screenshot.mjs` polls);
the toolbar zoom buttons silently no-op until then.

**Deploy** — GitHub Pages branch publishing. The current branch is **`master`** (the
README's deploy script says `main` — that is stale; the deploy branch is `master`).
`.nojekyll` serves files as-is; `CNAME` pins the custom domain **`town.m0nius.com`** (this
overrides the `*.github.io` URL the README advertises). All asset paths are relative so
the site also works from a project subpath.

## Architecture: strict core ↔ UI split via an EventBus

The single most important invariant: **the simulation core never touches the DOM, and the
UI never contains simulation logic.** This keeps the core runnable headless (it's why
`test/smoke.node.mjs` can boot and step it). The glue is **one-directional**: the core
notifies the UI through `sim.bus` (EventBus) — all six emits originate inside `Simulation`;
no UI module ever calls `bus.emit`. The UI drives the core by calling its public methods
(`sim.step()`, `sim.selectAgent(id)`, `sim.save()/load()/reset()`) — which then emit (except
`sim.save()`, which emits nothing; `reset()` emits `init` **then** `reset`, so subscribers repaint
twice per Reset; `loadState()` emits only `load`) — and
reads sim state directly (`sim.agents`, `sim.time`, …) rather than from event payloads.

- **Core** (DOM-free): `js/config.js`, `js/utils/*`, `js/simulation/*`, `js/agents/*`, `js/data/*`.
- **UI** (DOM/canvas/WebGL): `js/ui/*`, `js/main.js`.
- `js/utils/dom.js` is the *only* util the core must never import (it's UI-coupled).

**`js/main.js` is the single composition root** — the only place that wires `Simulation`
↔ `Renderer` ↔ `Controls`, owns the `setInterval` playback loop and all "running" state,
mounts the research panels (each mount guarded by a `getElementById` null-check — that protects a
page *missing those mounts*, **not** a DOM-free import: importing `main.js` under Node throws at
`new Renderer(sim)`; headless boot constructs `Simulation` directly, as `test/smoke.node.mjs` does),
and selects the map renderer. It also wires the **Export/Import/Share** buttons, the one-shot
`#seed=` hash parse, and camera persistence inline — `Controls.js` covers only the playback toolbar
(start/pause/step/reset/save/load/clear/speed/seed/debug/zoom — the Reset button's wiring, which
reads the seed input, lives there too), so don't grep there for the rest.

**EventBus contract** — `sim.bus.emit(type, payload)` / `sim.bus.on(type, cb)`. The complete
closed set of event types is: `init`, `tick`, `timeline`, `select`, `reset`, `load`. `on()` returns
an unsubscribe closure, and `emit()` wraps every listener in try/catch — a throwing panel callback
is only `console.error`'d (the step and all other listeners continue), so "one panel stopped
updating" means check the console, not the sim. The constructor's `init` fires **before any
subscriber exists** — every panel therefore self-renders synchronously at mount; copy that pattern
when adding one.
`Renderer` owns **only the DOM side panels** (status/legend/agent/memory/timeline/debug):
`renderAll()` rebuilds them all from scratch on `init`/`tick`/`select`/`reset`/`load` (no
diffing — fine at 24 agents / ~5 panels). It does **not** subscribe to `timeline` — a
mid-step `timeline` emit repaints nothing until the `tick` at the end of the same step; only
the map views watch `timeline` (entries with `type === "conversation"` pop 💬 speech
bubbles). The **map views live outside that cycle**: `MapView` runs its own
`requestAnimationFrame` loop and `PixiMapView` its own Pixi ticker, each reading sim state
directly **every frame** (that's how path-walking animates between ticks); they use the bus
only to sync on `tick`, rebuild on `reset`/`load`, focus on `select`, and pop bubbles on
`timeline`. Panel-tab visibility is a small WAI-ARIA controller (`js/ui/Tabs.js`) toggling
each panel's `hidden` attribute — purely presentational. Two Tabs caveats: it wires only the
**first** `[role=tablist]` in the document (its header comment claims "any" — stale), and it never
normalizes initial state — the boot-time selected tab/hidden panels are entirely the hand-authored
`aria-selected`/`tabindex`/`hidden` attributes in `index.html`, so keep those consistent when
adding a tab. Naming trap: the Timeline tab/panel ids are `tab-feed`/`panel-feed` (only the inner
list is `#timeline-list`) — grep "feed" for tab wiring. Hidden panels are still
re-rendered, **except the debug panel**: `renderAll()` skips `_renderDebug()` while it's hidden,
and `#debug-panel` is nested *inside* the hidden-by-default Tune tab, so the "Show debug" toolbar
button appears to do nothing until you also switch to the Tune tab — not a bug. Separately,
**`main.js` auto-pauses the playback loop when the browser tab is
hidden** (`visibilitychange`, stashing `app._wasRunning`) and resumes on return — long
background runs silently stop. Step, Reset, a successful localStorage Load, and a successful file
Import each pause the loop too (`app.step()` calls `pause()` first) — stepping or loading mid-run
silently stops the run, independent of the tab-visibility pause.

UI-panel fine print: a new memory/timeline `type` needs triple wiring — a `TYPE_ICON` entry in
`MemoryPanel.js`/`TimelinePanel.js` (fallback is a bare •) plus `mem-type--<type>`/`tl-type--<type>`
background **and** `mem-item--<type>`/`tl-item--<type>` accent rules in `css/components.css`; the
type pill's text color is hardcoded dark on the assumption of a bright per-type background, so a
missing background rule renders a near-invisible dark-on-dark label. And `js/utils/dom.js el()`'s
`html:` escape hatch is used **nowhere** — every agent-generated string flows through `textContent`
(no HTML-injection path); keep it that way.

## The simulation tick (`Simulation.step()`)

Each `step()` advances the clock by `CONFIG.minutesPerTick` and runs a **fixed, deterministic
five-phase cycle** over `this.agents` (iteration order is stable for reproducibility):

1. **World events** due at `minutesIntoDay` fire once; present agents get an `event` memory + a generated reaction.
2. **Plan → move**: `Planner.updateStatuses()` returns the active block; if it's elsewhere the agent's `currentLocationId` is set **immediately** (`moveTo()` — cognition/co-location stays bit-deterministic) AND `agent.setDestination()` computes an A* waypoint `path` (`js/utils/pathfinding.js`) that **only the renderers animate** along. Movement is "logical-instant for cognition, animated for rendering" — a deliberate determinism choice; multi-tick travel was rejected. **Solid buildings + tunnels** (`CONFIG.movement.solidBuildings`, `subdivisions:8`): each building cell is a walled unit on the sub-tile grid — a thin blocked perimeter ring with an **open interior** (the centre 6×6) and a **narrow** centred gap on its one **door** edge and on every **tunnel** edge (shared with a sibling unit of the same `complex`). The gap is only `GAP_SUBTILES` (=2 of 8) wide, so **walls cover ~75% of every edge** and rooms read as real rooms with limited doorways. The **door edge is chosen by `townTopology`'s `classify`**: the edge facing the largest 4-connected open component (exterior `gridPad` grass + streets + courtyards), preferring S, then E, W, N — so a door can legitimately open onto a courtyard green/plaza rather than a street, and a building cut off from that main network gets **no door at all**. Agents route the street network, **enter through the door**, move **room-to-room through the tunnels**, and **stand inside** (`computeDoorSpots` → the cell centre) — never crossing a wall. **A\* is weighted-cost, not step-count**: every sub-tile carries a cost painted from its location type — street 1, open ground 4, building interior 12 (`CONFIG.movement.streetCost`/`openCost`/`buildingCost`, applied via `costForType`) — which is what actually makes residents follow the paved avenues instead of cutting across parks; walls only enforce door-only entry. The wall/door/tunnel layout is one shared `townTopology`: the routing grid (`rasterizeSolid`) and the renderer (`computeWallTopology` → `townArt.spriteComplex`, which cuts the gaps at the identical cell-fraction from `gapSpan()`, ≈0.375–0.625) are driven from it, so picture and pathing stay in lockstep. A `gridPad` ring of open grass frames the town so corner complexes stay reachable. Two routing gotchas: `Simulation` **caches** the collision grid + door spots (`_grid`/`_doorSpots` — lazily built, cleared only on `init()`/`reset()`/`loadState()`), so runtime `CONFIG.movement.*`/location changes don't affect routing until a Reset ("the engine re-reads CONFIG each tick" does **not** apply here); and the comments around `_getDoorSpots`/`_doorWorld` in `Simulation.js` still describe the **old stand-OUTSIDE-the-building model** — trust `pathfinding.js` (and this file) over them. More movement fine print: **the renderers re-plan mid-walk location changes** — walks routinely outlast plan blocks (cross-town ≈ 20 s at `walkSpeedPixelsPerFrame` 2.4 vs. a new destination every 3–12 ticks), and the sim's fresh `path` starts at the *old* location's room centre, so adopting it blindly made avatars glide straight from wherever they were to that first waypoint, through walls (~70% of all movements at 1×). Both `_syncTargets` therefore adopt `agent.path` only when the avatar is within `0.24·CELL` of `path[0]` (settled in the previous room — that hop stays inside the open interior at `sub ≥ 4`; the threshold is hardcoded, so at `sub = 3` the interior shrinks to ±CELL/6 and the kept hop can clip — academic alongside `spotFor`'s own sub=3 breakage); otherwise they call `townArt.routeFrom(layout, <avatar's displayed position>, finalSpot)` — grid A\* on `layout.collisionGrid`, which a smoke check pins identical (cell/sub/origin + every blocked/cost byte) to the sim's own cached `_getGrid()` — and walk that instead (display-only; sim RNG/state untouched; skipped when `pathfindingEnabled` is off). Perf shape worth knowing: location changes are **bimodal** — plan blocks are town-synchronized, so ~95% of ticks re-route nobody and burst ticks re-route nearly all 24 agents at once (~0.5–3 ms of synchronous A\* each, inside the `tick` bus callback) — a tens-of-ms hitch on burst ticks at 8× on slow hardware is expected, not a leak. **A null route is still silent**: `Agent.setDestination` falls back to `path = [toWorld]` (one waypoint), `routeFrom` nulls for the same unreachable goals, and the renderer then glides the avatar straight there, *through walls*, with no log anywhere in the chain — so an avatar visibly crossing a wall still means an unreachable destination (doorless building per `classify`, a lost `complex` field, `gridPad` mischief), not a renderer bug; the smoke test routes only three fixed pairs, so a sealed building can still pass all 29 checks. `maxAStarNodes` (60 000) cannot trip on the shipped 200×200 sub-grid (40 000 cells) — a null route means *genuinely no path*, so don't bump the budget. And "no path" is rarer than it looks: **A\* snaps a blocked start/goal to the nearest open sub-tile before searching** (`snapToOpen` — deterministic Manhattan ring, lowest-linear-index tie-break, *blind to wall topology*), so a destination painted inside a wall reroutes from whichever open tile is geometrically nearest (possibly the wrong side of the wall), and `pathWorldPoints` restores the raw world endpoints, so the first/last segment of a snapped path can legitimately cross a wall on screen; null happens only when the goal's open pocket is *disconnected* from the start — e.g. the `subdivisions < 3` sealed cells below do **not** null-route, they just terminate outside the wall. The three costs are `Math.floor`ed and clamped ≥ 1 (fractional tuning silently no-ops; the ≥ 1 clamp keeps the Manhattan heuristic admissible — don't relax it). `gridPad` has an effective floor of 1: `townTopology` forces `pad ≥ 1` while `rasterizeSolid` uses the raw value, so `gridPad: 0` classifies perimeter doors onto a phantom grass ring the grid doesn't have — edge buildings become unreachable. The render↔routing lockstep is **load-time only** on the render side: `townArt`'s `WALL_GAP` is a module-load constant, so a runtime `subdivisions` change + Reset re-rasterizes routing but keeps drawing the old doorways until a full page reload (`subdivisions < 3` is worse: `gapSpan` → null seals every building cell fully solid while the renderer falls back to a wide fake doorway). Finally, both renderers replace the **final** waypoint with `spotFor()`'s crowd-fan position; its `maxRadius = 0.22·CELL` cap is what keeps fanned avatars inside the 6×6 open interior (±0.375·CELL) — raise it and crowded rooms draw avatars inside walls with no routing involved (`spotFor`'s other branch — the directional half-arc with `maxRadius = 0.42·CELL` — is unreachable: `computeDoorSpots` emits `dx/dy = 0` for every location, so the full-circle interior branch is the only live one; a lone occupant bypasses both).
3. **Observe**: each agent may record its location (gated `rng() < 0.5` — and short-circuited for a phantom `currentLocationId`: `if (loc && rng() < 0.5)` skips the draw entirely, so a bad location id **shifts the whole run's RNG stream** from that tick on, not just that agent's observations) and records every co-located agent. `Environment.indexAgents()` is refreshed after the move for O(agents) co-location lookups — its freshness check is identity+length only (it can't see `currentLocationId` changes), so the hidden invariant is **agents may only move in phase 2**: the index's only readers are phase 1's `agentsAt` event delivery (which deliberately reads the *previous* tick's index) and phase 3's `coLocated` observations, and code that relocates an agent anywhere but phase 2 silently serves them stale co-location (until the next post-phase-2 rebuild) with no error. Phase 4 is immune — conversation grouping builds its own location map from `currentLocationId` each tick, bypassing the index.
4. **Converse**: per location with ≥2 co-located agents, up to `CONFIG.conversation.maxPerLocationPerTick` (=1) conversations form over consecutive **id-sorted slices** of up to `maxGroupSize` (=4) (`ConversationEngine.checkGroupConverse`/`converseGroup`). The gate per slice: `baseChance` (0.45) + min(0.3, max familiarity over **off-cooldown** ordered pairs/300) — a pair still inside the 90-min per-pair `cooldownMinutes` (on monotonic `totalMinutes`) contributes nothing to the bonus, even if it is the group's most familiar pair; all-pairs-on-cooldown returns false **without consuming an RNG draw**, and a failed gate falls through to the next disjoint slice. Composition is positional, not social: adding an agent whose id sorts early shifts every group boundary town-wide (different RNG draws — the classic "unrelated change altered the run" trap), and a trailing remainder slice of 1 stays mute. Each participant gets a `conversation` memory (`relatedAgentIds` = the others), every ordered pair's relationship updates — the tone→delta numbers are **hardcoded in `Simulation.js _applyGroupConversation`, not in CONFIG or `RelationshipGraph`** (warm +3 affinity/+2 trust, tense −3/−1, neutral +1/+1, familiarity always +4; warm/tense = anchor's average affinity ≥ 20/≤ −20) — and **one** timeline entry carries `participantIds` + `locationId`. Size-2 behaves like the old pair path — via `converseGroup`'s delegation to `converse()`; `ConversationEngine.canConverse` is **dead code with a different, one-directional cooldown gate** (nothing calls it — don't read it as the gate spec).
5. **Reflect**: agents whose accumulated importance crossed the threshold synthesize an insight.

At **day rollover** (checked at the top of `step()`): `Environment.resetEvents()` re-arms
daily events and every agent re-plans via `_planAgentDay()`. Then `bus.emit("tick", …)`.

**Two time scales — do not confuse them** (`TimeManager`): memory `timestamp` and cooldowns
use monotonic **`totalMinutes`** (so recency scoring works across days); plan blocks and
`minutesIntoDay` use **minutes-into-day (0–1439)**.

## Cognitive architecture (`js/agents/`)

`Agent` is a near-pure state object (identity + `MemoryStream` + `RelationshipGraph` + counters;
its one behavior, `setDestination`, runs grid A*); all cognition is delegated to focused modules,
and all *generated* text goes through a **`GenerationProvider`** (observation/timeline strings are
templated inline in `Simulation.js`):

- **Memory retrieval is fully deterministic** (`js/utils/scoring.js`): `score =
  recencyWeight·recency + importanceWeight·importance + relevanceWeight·relevance`, where
  recency is exponential decay (`0.5^(age/halfLife)`), importance is `importance/10`, and
  relevance is keyword overlap (memory `keywords[]` + tokenized description vs. query).
  `MemoryStream.retrieve(query, currentTime, n)` sorts by score then newest-first and returns
  scored wrappers `{memory, score, recency, importance, relevance}` — unwrap `.memory`. **But the
  sim never calls it**: no tick phase or cognition module invokes `retrieve` — `Reflector`
  synthesizes from `memoryStream.recent(12)` (plain newest-N, unscored), `Agent.retrieveMemories`
  has zero callers, and the only runtime caller is the RetrievalProbe panel — so the scoring
  pipeline and the `CONFIG.retrieval` weights shape a *display*, never a run.
- **Reflection accumulation gotcha**: only *lived* memory types (`observation`, `action`,
  `conversation`, `event`) add to `reflection.accumulatedImportance`; `reflection` memories
  are deliberately excluded to avoid a feedback loop — the type gate lives in `Agent.addMemory`,
  and `Reflector.reflect()` is what resets the counter. `Reflector.shouldReflect()` gates on
  both the importance threshold **and** `minIntervalMinutes`. Trap for custom providers:
  `reflect()` zeroes the counter and stamps `lastReflectionTime` **before** `Simulation` checks
  the insight (`if (insight)` gates the memory + timeline entry) — a falsy `generateReflection`
  return silently burns the accumulated importance *and* re-arms the interval gate with nothing
  recorded (invisible today: `LocalGenerationProvider` always returns a non-empty string).
- **Relationships**: `RelationshipGraph.update(id, deltas)` **adds** clamped deltas (it does
  not set) — `affinity`/`trust` ∈ [-100,100], `familiarity` ∈ [0,100]. Conversation tone
  (warm/neutral/tense, derived from existing affinity) drives the deltas — the actual numbers
  live in `Simulation.js`, not here (see the tick's phase 4). `RelationshipGraph.get()` is a
  **mutating getter** — it auto-vivifies and stores a zero-value record for unknown ids, and the
  conversation gate calls it for every off-cooldown ordered pair, so merely sharing a location
  writes zeroed relationship rows into saves (and flips the `relationships.has()` branch in
  `generateReflection`) even when no conversation ever fires; "read-only" debug code calling
  `.get()` changes `getState()` bytes — the UI panels deliberately use `.all()`.
- **Planner edge cases / dead fields**: plan-item `priority` is written but never read —
  overlapping blocks resolve to the **last** one in array order; a plan gap (`active = null`)
  makes the agent freeze in place as `"Resting"` (it does not go home). `Location.capacity`
  (default 8) is never enforced — co-location is unbounded — and `district`/`distanceTo()`/
  `agent.planDay` are stored or serialized but never consulted, as are `agent.pathIndex`/
  `arrived`/`destLocationId` (write-only render-state: both renderers `slice()` `agent.path` and
  track walk progress privately, and nothing ever sets `arrived` back to `true` — the constructor
  comment describing that is wrong) and `archetype`/`relationshipPrefs`/`activityPrefs` (the last
  reaches the Planner's provider context but the shipped provider ignores it; of the appearance
  block only `spriteVariant`/`palette` are consumed). Don't design around any of them.
- **`GenerationProvider`** — the abstract base declares four throwing stubs (`generatePlan`,
  `generateReflection`, `generateConversation`, `generateReaction`), but a complete provider
  needs a **fifth method the base class does not declare**:
  `generateGroupConversation(agents, context)`, which `ConversationEngine.converseGroup`
  calls for every 3–4-person group (size 2 reuses `generateConversation`). With
  `maxGroupSize` = 4 this path fires routinely — a custom provider implementing only the
  four stubs throws a `TypeError` mid-run. `LocalGenerationProvider` (the only one wired in)
  is deterministic, template-based, and implements all five. Its `DAY_TEMPLATE` also carries the
  **sleep contract** — two `/sleep/i` blocks at home (0–360 + 1320–1440 = 8 h/day; the
  `home`/`work` template kinds resolve to the agent's own ids with **no RNG draw**, so this split
  is determinism-neutral). The renderers key all bed/lying behavior on that **activity text** via
  `townArt.isSleeping` (see *Rendering → Sleep & beds*) — reword a sleep block without the word
  "sleep" and residents stand at the crowd-fan spot all night with no error. `LLMGenerationProvider` is a
  stub that **throws on purpose** to prevent shipping an API key in client code (a custom one
  must also honor the sleep contract in its `generatePlan`, or `isSleeping` never fires).

## Determinism & persistence

- **Seeded RNG** (`js/utils/random.js`, mulberry32 via xfnv1a hash). One RNG per run,
  threaded through everything via `_context().rng`. `getState()/setState()` let save/load
  resume the *exact* stream position, so the same seed reproduces the same run bit-for-bit.
  **Renderer/art/character randomness uses `seededRandom(stableId)`, never the sim RNG** — so
  the camera, avatars, and pathfinding can't desync a save. The smoke test asserts two fresh
  same-seed runs are byte-identical after 150 steps. (Gotcha fixed: `Planner` plan ids are now
  `plan_<agentId>_d<day>_<ii>` (zero-padded index) — a former module-global counter leaked state across `Simulation`
  instances and broke fresh-run reproducibility. Don't reintroduce module-global mutable state.)
- **Seeds to keep straight**: `CONFIG.defaultSeed = "smallville-2024"` (the sim seed, also
  overridable via the `#seed=…` URL hash for shareable runs — the toolbar **Share** button writes
  that hash + copies the permalink) is **different** from the
  procedural-art seed `"willow-creek-art-v2"` (which only feeds the *procedural fallback* — as does
  the fallback's per-building `bld-<id>` seed; the sprite path seeds per-feature `seededRandom` ids
  like `furn-<id>`/`park-<id>`/`streetf-<id>`/`gap-<x>-<y>`) and from the town name
  "Willow Creek". Seed-hijack gotcha: the hash is parsed **once at module load** into in-memory
  settings, and the *next* `persistSettings()` — a speed/debug change, a Reset, even a debounced
  camera pan — writes that shared seed into localStorage permanently. Relatedly, an **empty** seed
  box on Reset falls through to the previously persisted `settings.seed`, **not** back to
  `CONFIG.defaultSeed` (escape: type the default seed, use a `#seed=` hash, or clear localStorage).
  And Reset never clears the hash itself — `location.hash` is written only by Share and read once
  at boot (no `hashchange` listener), so after arriving via `#seed=X`, a Reset to seed Y runs Y
  while the URL keeps `#seed=X`, and the **next reload silently re-hijacks back to X** (escape:
  clear the hash manually or hit Share to overwrite it with the current seed).
- **Two separate persistence stores** (both `localStorage`, version-suffixed keys):
  full sim state under `CONFIG.storageKey` (`generative-agents-vanilla:state:v1`) via
  `sim.save()/load()`; UI settings (speed/debug/seed) under `CONFIG.settingsKey`
  (`generative-agents-vanilla:settings:v1`).
- **Two save paths**: localStorage (`sim.save()/sim.load()`) vs. file export/import
  (`sim.getState()` → JSON download; `sim.loadState(state)` ← imported file — both wired in
  `main.js`, not `Controls.js`). **`getState()` returns live references** (the `timeline` array;
  each agent's `currentPlan`/`conversationLog`/`reflection`/`path`/`traits`/`goals`/`dailyRoutine`;
  each location's `tags`; the memory arrays; and `RelationshipGraph.toJSON` returns the **live
  relationships map itself** — on load the constructor only shallow-spreads it, so the per-pair
  record objects and their `notes` arrays stay shared and `update()` mutates them in place) and
  `loadState()` adopts them directly (one exception: `MemoryStream`'s constructor `slice()`s its
  memories array, so the two sims share the memory *objects* but not the array — an append in one
  never shows up in the other) — `simB.loadState(simA.getState())` cross-wires two sims into
  mutating shared objects. Only a JSON round-trip is safe; the smoke test deliberately
  `JSON.parse(JSON.stringify(...))`s first — do the same in any fork/determinism test. Also:
  `TimeManager.fromJSON` restores the **saved** `minutesPerTick`, so loading a save made at a
  different tick rate desyncs `sim.time` from `CONFIG`/the Minutes-per-tick slider until the
  slider is touched (its `set()` dual-writes both). More `loadState` asymmetries: it hard-rejects
  `version !== 1` by returning `false` without touching the sim or logging (the file-import path
  surfaces that only as its "unrecognised state file" message — bump/handle the version gate when
  evolving the save shape); a missing or non-numeric `rngState` silently restarts the RNG from the
  seed's beginning; and `_seedData` is never replaced — `reset()` always rebuilds the
  constructor-time seed world, so **Reset after importing a save from a modified seed set silently
  discards the imported world**. Finally, `MemoryStream` is append-only and uncapped
  (`memoryVisible` caps display, not storage), so state grows without bound; on localStorage quota
  exhaustion `storage.save` just `console.warn`s and returns `false` — the manual Save button
  flashes "Save unavailable", but the settings/camera `persistSettings` path fails with zero UI
  feedback.

## Rendering (`js/ui/`)

`main.js setupMap()` tries **PixiMapView (WebGL)** first via dynamic `import()` (gated on
`requestAnimationFrame` + a WebGL probe), and falls back to **MapView (canvas-2D)**; it sets
`host.dataset.renderer` and logs which won. PixiJS v8 is vendored at `js/vendor/pixi.min.mjs`
(no CDN). Both renderers share geometry/art from **`js/ui/townArt.js`** and four shared
modules, so they stay in lockstep:

- **`townArt.js`** — `CELL = CONFIG.world.cellPixels` (176). `computeLayout(sim)` returns a
  **superset** `{cols,rows,W,H,CELL,rects, collisionGrid, doorSpots, wallTopology, complexes, bedSpots, bedAssign, chunkCells/chunkPx/chunkCols/chunkRows}`.
  `layout.collisionGrid` is built with `CONFIG.movement` (like `doorSpots`/`wallTopology`) and a
  smoke check asserts it identical (cell/sub/origin + every blocked/cost byte) to the sim's own
  cached `_getGrid()` — it has to be, because **both renderers route avatars on it**: `townArt.routeFrom(layout, from, to)` (a thin
  `pathWorldPoints` wrapper over that grid) is what `_syncTargets` calls for the **mid-walk
  re-route** (see the tick's *Plan → move*). `drawTownInto(g, layout, sprites, worldRect, opts)`
  draws only what intersects `worldRect`
  (so a chunk can be baked); `drawTown`/`makeTownCanvas` are thin full-rect wrappers.
- **Building art — top-down cutaway (no roofs).** Buildings render as **apartment complexes**:
  `groupComplexes(layout)` buckets `rects` by each location's **`complex` id** (assigned by
  `tools/pack_locations.mjs`, preserved through `Location` — *if that field is ever dropped again,
  every building silently falls back to a unique `solo_<id>` key and renders standalone: complex
  grouping is lost with no error — and **routing breaks too**: `townTopology` keys on the same
  field, so former siblings lose their tunnels and an interior unit ringed by other buildings gets
  **no door at all** → sealed rooms + the silent straight-line wall-clipping fallback, town-wide,
  with no test to catch it. Stale comments in `townArt.js`/`Location.js` still describe an
  old coarse-grid fallback that lumped unrelated buildings into sparse pseudo-complexes — that
  fallback was removed; don't believe them, nor `spriteComplex`'s "per-unit nameplates are drawn
  LAST" comment: no per-unit nameplate code exists, the fascia plank is the only sign*). `spriteComplex` draws each member's walled unit and
  the shared shell, cutting a narrow centred **door** gap in each unit's door-edge shell wall (the
  edge `classify` picks — see the tick section) and a **tunnel** gap in every wall
  shared with a sibling unit — gaps positioned at the narrow cell-fraction from the shared
  `pathfinding.gapSpan()` (≈0.375–0.625 at `sub=8` → a ~44px doorway, so the **wall covers ~75% of every
  edge**) to line up *exactly* with the walkable openings the routing grid punches from the same
  `townTopology` (`rasterizeSolid` on the routing side; `computeWallTopology` is the
  renderer-facing wrapper — render ↔ routing lockstep, see the tick's *Plan → move* note:
  `wallEdge` reads `gapSpan`, which is derived from the same `gapIndices`/`GAP_SUBTILES` that
  `rasterizeSolid` punches its openings from — **change the gap via `GAP_SUBTILES`, never by editing
  `gapSpan` alone** — and note door and tunnel gaps are **pixel-identical**: `wallEdge` receives
  only open/closed, not the door=1/tunnel=2 distinction; only the routing semantics differ). That exact alignment holds for **multi-unit complexes only**: a 1-member
  complex takes the old `spriteBuilding` path, whose sub-cell footprint draws walls/door ~14px
  inside the full-cell collision walls (today only `loc_river_studio`/cx17, plus any building
  added without re-running `pack_locations`) — don't chase that offset as a regression. Empty
  cells in the bounding box are furnished as the block's shared lounge (`gapLounge`: a back-wall
  sofa/plant/bookshelf reading nook, a central dining set on a rug, side greenery, a front bench —
  clipped to the cell, deterministic via `seededRandom("gap-<px>-<py>")` keyed on the cell's
  world-**pixel** origin, e.g. `gap-3520-1760`, not grid coords), so a complex that doesn't
  tile its bounding box never reads as a bare/broken room — 18 such bbox-hole cells exist in the
  shipped town, and they have **no `Location` record at all** (don't assume every 23×23 footprint
  cell resolves to a location). There is no entry doormat in the sprite path —
  doormats drew unclipped over door-adjacent furniture and were removed (a dark-wood doormat strip
  survives only in the procedural `drawBuilding` fallback, like the shingle roof); only **south**
  doors get deck+stairs. **Signs are per BUILDING, not per room**: a multi-unit complex draws exactly ONE
  `nameSign` (fascia-mounted — no hanger peg/links — fully inside the bottom wall band
  `[y+h−16, y+h]`, so it can never cover furniture or courtyard decor) on its south face, named
  by `buildingName()` (type → `SIGN_LABELS` + a deterministic `SIGN_PREFIXES` prefix keyed on the
  complex id — prefixes deliberately avoid the `The/Town/Community/Corner/Willow/Cedar` strip-regex
  in `nameSign`); the mount dodges door gaps with widths derived from `WALL_GAP` (a no-S-door
  bottom unit, else the boundary between two adjacent bottom units — a ≤2·lo·CELL plank (132px
  at sub=8) just clears both gaps at ±lo·CELL — else the strip **right** of a lone unit's door:
  the left strip would collide with the complex mailbox at `x+6` whenever the lone unit is in
  the leftmost column, true of all 7 shipped lone-branch complexes). Per-unit names survive only
  in the side panels/legend; a 1-member
  complex keeps its member's own name via `spriteBuilding`'s top-hung sign (`spriteBuilding` also
  rolls its deck 50/50 — seeded `deck-<id>` — always at the **south** face regardless of which
  edge `classify` gave the door; today's sole standalone, `loc_river_studio`, happens to have a
  south door and a passing roll).
  **`wallCap()` caps every shell with a flat light-grey wall top
  (the cutaway look) — there is NO colored shingle roof in the sprite path** (`shingleRoof`/`ROOF`
  survive only in the procedural `drawBuilding` fallback). Each unit's interior comes from a per-type
  **`BLUEPRINTS`** floor plan (`drawRooms` lays out rooms + one doorway per adjacent pair); `furnish`
  fills each room by `kind` — baths get the **salmon diamond** floor (`floor_pink`); the
  `TILED_ROOMS` kinds — private/utility rooms (bedroom, study, storage, ward, kitchen, vaultroom)
  **plus the bank/pharmacy/post/museum public rooms** ("cool civic tile") — the **cream carpet**
  (`floor_tile`); all remaining common rooms **warm orange planks** (`floor_wood`). The
  reference's signature **`diningSet()`** (a table ringed by red/yellow chairs on a rug) anchors
  the `living`/`library`/`meeting`/`studio`/`diner` rooms (and unknown kinds); community public
  rooms (cafe, chapel, theater, bank, salon, florist, pharmacy, museum, post, …) get bespoke
  furniture instead — bar + stools, pews, seat rows, teller line, display cases.
- **Sleep & beds (cross-cutting: planner → `townArt` → `characters` → both map views).**
  `townArt.isSleeping(agent)` = `/sleep/i.test(currentActivity) && currentLocationId ===
  homeLocationId` — deliberately false for "Wind down…"/"Resting" (those stand, not lie).
  `computeLayout` counts each home's residents into `rect.residents`; `drawRooms`/`furnish` take
  `{beds}` and a 2-resident home draws **two HORIZONTAL beds stacked down the left wall** (both
  pillows on that wall) — bed #2 reuses the SAME `pick(beds, rng)` draw (one draw either way, so
  1- vs 2-bed rooms stay art-stream-identical). Beds lie **sideways — pillow on the LEFT, foot on
  the right** (the `bed`/`bed_red`/`bed_green` tile SVGs are authored vertically then wrapped in a
  `translate(0,96) rotate(-90)` group, so the manifest region is **112×96** and `put()` draws them
  horizontal with no canvas transform — keeping the room auditor's mock, which ignores transforms,
  truthful). Bed positions come from the exported **`bedPlacement(roomX, roomY, i)`** helper (and
  its `BED = {w:28, h:24, dy:28}` dims — the 112×96 sprite / `ART_SS`; **`i` now offsets `y` by
  `dy`, stacking vertically**), the ONE source consumed by both `furnish`'s `put()` calls and
  `computeBedAssignments`, which publishes `layout.bedSpots` (locId → the **bed-CENTRE** point
  `{x+BED.w/2, y+BED.h/2}` — the lying avatar centres its rotated body there) and `layout.bedAssign`
  (agentId → `{x,y,locId,via}`; residents id-sorted, max 2 beds, a 3rd+ housemate falls back to the
  crowd fan). Only `home`/`studio` bedrooms ever hold 2 residents (always the **wide** plan, so two
  stacked beds fit); cafe-type decorative bedrooms draw 1. The room-origin chain feeding the helper is still
  **mirrored, not shared** — complex unit insets (16 perimeter / 8 shared edge; standalone
  `bx+16,by+16`), `drawRooms`' wall=3 → `+1.5` track origin — so an inset change in
  `spriteComplex`/`drawRooms` must be applied to `computeBedAssignments` in lockstep or sleepers
  lie *beside* their beds. Two gates pin that: the smoke checks (bed spots in-cell + on open
  routing tiles — **loose**, they tolerate ~90+ px of drift) and `audit_rooms.mjs`'s **bed-spot
  counters** (every `bedAssign` spot must land on a *distinct drawn bed sprite rect* of `BED`
  size in the real draw path — read "bed-spot misses/size drift" in its TOTAL line; that's also
  what catches a re-authored bed tile whose manifest dims drift from `BED.w/h`). Both
  `_syncTargets` override the final waypoint with the assigned bed while `isSleeping`, and both
  have a **settled-rewalk**: a same-location final spot that moved > 2 px after the avatar settled
  re-activates a short walk (onto the bed at 22:00, off it at 06:00, crowd re-fans). The bed hop is
  **not** a straight line: the fan spot sits in the living room and the bed in the bedroom, and the
  drawn interior room walls are art-only (NOT in the collision grid), so a straight hop ghosts
  through the plaster on screen (verified 24/24 pre-fix). Each `bedAssign` entry therefore carries
  **`via` = [fan-side, bed-side]** — two points straddling the drawn bedroom doorway, ±5 px along
  the wall normal so the crossing leg is perpendicular (a single on-the-wall point is NOT enough:
  shallow diagonal approaches clip the 3 px wall band just outside the 15 px gap) — mirroring
  `drawRooms`' doorway scan (first shared wall segment per room pair, columns then rows); the
  renderers walk fan → via[0] → via[1] → bed and the reverse getting up. The **lying pose** lives
  in `characters.js` (shared `BaseAvatar.drawCanvas` + `_buildPixiScaffold`/`_applyPixiPose`, so
  both avatar subclasses and both renderers stay in lockstep): `av.update({…, lying})` forces
  `dir = "down"` + `moving = false`, then the draw path **rotates the body `-90°` (`LIE_ROTATION`)
  and centres it on the bed** (head → left pillow, face up), shrunk by `LIE_SCALE` (0.85) so the
  ~28 px body tucks inside the 28 px-wide horizontal bed. It hides the ground shadow and lays a
  terracotta **blanket** over the lower body (`_lyingBlanketRect`, in body-centred coords so it
  rotates with the sprite — Pixi rotates a `buildPixiBlanket` Graphics the same `-90°`); the
  renderers zero `bob` and gate `lying` on settled && !moving && `isSleeping`. Both `_onTimeline`
  handlers also **suppress 💬 bubbles for sleeping participants** — the sim's phase 4 has no sleep
  gate (long-standing: co-homed pairs converse ~4–5×/night and still grow relationships; that is
  deliberate, core-untouched), so the filter is display-only and a night conversation between two
  sleepers pops nothing. Culling caveat: off-screen avatars skip `av.update`, so the lying flag is
  stale until the camera sees them — a headless-probe artifact, not a bug (centre the camera on
  the bedroom first, then read).
- **Streets & outdoor plots.** The packer emits real `street`-type cells between the city blocks;
  `paveStreet` fills the **whole cell** edge-to-edge with the cobble tile (`S.gravel`) so a run of
  street cells reads as one seamless road, drawn **as ground** (before trees/buildings) so eaves
  and canopies overhang it. `streetFurniture` adds lamps to a deterministic subset on top.
  Parks/squares/greens/plazas still render via `spritePark`/`spritePlaza`/`spriteGreen` over a
  ~0.84×0.74-cell footprint (the `DEFAULT_BLUEPRINT` `foot` — outdoor types have no blueprint of
  their own; a grass verge shows at their edges). The procedural fallback mirrors this
  with `drawStreet`/`drawPark`/`drawPlaza` (the old global path-band grid was removed — streets are
  explicit cells now). The sprite path also dresses the map with a sandy **shoreline** across the
  south ~1.4 cells (dithered grass→sand transition) and a deterministic **forest** — a dense grove
  over open cells in the top-left ~30%×34% of the grid, ~4.5% sparse elsewhere, seeded
  `forest-<cx>-<cy>`, drawn *before* buildings so canopies overhang — sand at the bottom / woods
  at the top-left of a capture are by design, not artifacts.
- **`townChunks.js`** — the world is too big for one texture (> WebGL limits), so
  it's **baked per chunk** (4×4 cells) **lazily and viewport-culled**. `makeChunkCanvas`,
  `visibleChunks`, `chunkDims`, `chunkWorldRect`, `chunkKey`. Pixi LRU-caches chunk textures
  (`CONFIG.rendering.chunkCacheMax`); off-screen chunks/agents are hidden. Eviction differs by
  renderer: Pixi's true LRU never evicts a *visible* chunk (the cache can exceed the cap), while
  MapView's is insertion-order FIFO with no touch-on-use and **can** drop a still-visible chunk —
  at far zoom-out (more visible chunks than the cap) MapView silently re-bakes evicted chunks
  every frame (perf churn, not a bug). The 2× bake supersample `TEXTURE_SCALE` lives in **three
  places**: `townArt.js` exports it (the `makeChunkCanvas` default), but each renderer defines its
  own local `const TEXTURE_SCALE = 2` and passes it explicitly — editing only townArt's export
  changes nothing the live renderers bake.
- **`camera.js`** (`Camera`) — **one** renderer-agnostic controller for **both** views (Pixi
  applies it to the world container via `scale`/`position`; canvas via `ctx.setTransform`):
  **drag-pan + wheel/pinch-zoom + inertia + double-tap-zoom**, `worldToScreen`/`screenToWorld`,
  `visibleWorldRect()` (the culling source), `centerOn(wx,wy)`, `toJSON/applyState` (persisted to
  `settings.camera`, debounced 300 ms — `main.js` does this by **wrapping** `camera.onChange`, so
  reassigning `onChange` after `setupMap()` silently kills persistence; ignore the stale
  `_persist` comment in `PixiMapView` — main.js never assigns it, both views' constructor
  `onChange` is a no-op, the wrap is the only persistence path). Node-safe — the pure math
  constructs/runs with no DOM (though no test
  currently imports it). The
  world is **boundless** (`CONFIG.camera.infinite`): there are **no map edges** — the town floats
  in infinite grass, so the zoom-out floor is an **absolute** `minScale` (`CONFIG.camera.minZoom`),
  **not** fit-to-world; `canPan()` is always true; and `_clampTarget()` only *soft*-limits roaming
  (a `pad` around the town keeps it reachable instead of clamping to an edge). `CONFIG.camera`
  passes exactly five keys (`infinite`/`minZoom`/`maxZoom`/`zoomStep`/`easing`) — the feel knobs
  `inertia`/`friction`/`minVelocity`/`doubleTapZoom` exist only in `camera.js`'s own
  `CAMERA_CONFIG` defaults, so tune them there, not in config.js. `fit()` / the **Fit**
  toolbar button frames the town centered at **90% of true fit** (an extra 0.9 margin in infinite
  mode, so the town never touches the viewport edges); the initial view opens centered on the
  town (a zoomed-in `defaultView`, ~12 cells across) **unless a numeric `settings.camera.scale`
  was persisted — a stale camera in localStorage overrides the default view, so clear it (or hit
  Fit) before judging view/centering changes**; and **selecting or clicking a resident** (on the
  map or in the legend) smoothly `centerOn`s
  them.
- **`characters.js`** (`createCharacterFactory`) — **one avatar source for both renderers**:
  loads the manifest (`assets/characters.json`) + sheets, runtime-slices the walk frames,
  and **always** has an enhanced **procedural** fallback (varied skin/hair/outfit
  **deterministic from `agent.id`**, never the sim RNG). The shipped art is **one CC0 sprite
  atlas** `assets/characters/atlas.png` (480×576): 12 residents, each a 3-frame (idle + 2-step
  walk) × 4
  directions block (32×48 frames). The walk rate comes from the manifest's top-level `fps` (=6),
  **not** `CONFIG.characters.fps` — that key and `useSpritesheets` are dead config nothing reads;
  `frameScale` is the only live `CONFIG.characters` knob. It's a **CSS-sprite / texture-atlas**: every variant points
  at the *same* file with a pixel offset (`ox/oy`), and `loadCharacterSheets` **fetches the
  atlas once** (deduped by file) — one HTTP request for all residents. `frameW/frameH` and
  `anchorX/Y` come from the manifest; on-screen size = `frameW × CONFIG.characters.frameScale`
  (0.7 ≈ 22px, a crisp downscale of the 32px art).
  Asset pipeline (dev-only, **no runtime SVG**): `tools/gen_chars_svg.mjs` emits the 12
  resident SVGs in `tools/char_svg/<key>.svg` with **exact, consistent geometry** (centered on
  x=16, feet on y=46, contiguous, fits the 32×48 cell — authored deterministically because
  hand-drawn-per-cell art couldn't self-align). Then `tools/assemble_atlas.mjs` tiles them into
  one atlas SVG (+ the region manifest **only with `--manifest`**), and `tools/svg2png.mjs`
  rasterizes SVG→PNG via
  **self-launched headless Chrome** (transparent, pixel-exact, zero npm deps). Redraw via
  `node tools/gen_chars_svg.mjs && node tools/assemble_atlas.mjs /tmp/char_atlas.svg --manifest
  && node tools/svg2png.mjs /tmp/char_atlas.svg assets/characters/atlas.png` — omit `--manifest`
  after a variant change and `characters.json` keeps stale `ox/oy` offsets, so every avatar
  silently slices the wrong atlas cells. `assemble_atlas` packs the **sorted directory listing**
  of `tools/char_svg/` while `gen_chars_svg` only overwrites its own 12 files — `rm` stale SVGs
  after removing/renaming a variant or they stay in the atlas and shift later blocks' offsets.
- **Town tiles** (`js/assets.js` — note: one level *above* `js/ui/` — and `js/ui/townArt.js`) — the 88 terrain/furniture sprites are **also
  one CC0 SVG→PNG atlas** `assets/sprites/atlas.png`, addressed by `{x,y,w,h}` regions in
  `assets/manifest.json`. `loadSprites()` fetches that atlas **once** and slices each region into
  a per-name canvas, so `townArt` draws `S.<name>` exactly as before (no townArt change). Tiles
  are hand-authored SVG in `tools/tile_svg/<name>.svg` (each a single `<svg>` sized base×SS where
  SS=4, ids prefixed by the tile name — `tools/validate_tiles.mjs` enforces this), packed by
  `tools/pack_tiles.mjs` → `svg2png.mjs`. The cutaway look lives in these tiles: light plaster
  walls (`wall`/`wall2`), salmon diamond bath floor (`floor_pink`), cream bedroom carpet
  (`floor_tile`), warm orange planks (`floor_wood`), plus the furniture (beds w/ white pillow +
  colored blanket, red/yellow chairs, toilet/sink, fridge, bookshelf, piano, bar/stool, board, …).
  Furniture sprites are authored at **`ART_SS` = 4×** their on-screen size: `townArt`'s `put()`
  helper draws them at `img.width/ART_SS` (plus a contact shadow), while ground/wall tiles draw
  into fixed 16px boxes — `ART_SS` must stay in sync with `SS` in `pack_tiles.mjs`, and **all
  furniture placement must go through `put()`** (a raw `drawImage` renders 4× too big). The
  sprite path also needs a critical mass: `drawTownInto` takes the tilemap path only when the
  sprites map has **≥6 entries** — a missing atlas (`loadSprites` → `{}`) *or any partial/mock
  sprite map* silently renders the full **procedural** fallback instead. And `loadSprites()`
  caches its promise module-wide with no retry or reset hook, so one transient manifest/atlas
  fetch failure locks the procedural fallback in for the entire page lifetime (hard reload to
  recover).

High-DPI: Pixi `resolution = CONFIG.rendering.resolutionScale` (devicePixelRatio, capped 2) +
`autoDensity`; canvas backs the store at `cssPx*dpr` — with **raw, uncapped** `devicePixelRatio`,
so on a 3× display the two renderers rasterize at different densities (don't pixel-compare
screenshots across renderers there). **All art is original SVG** (no third-party
packs); the two atlases are the only image assets.

Day/night: both renderers tint the world with `townArt.ambient(minutesIntoDay)` — a keyframed
dawn/dusk/night overlay (clear at noon; MapView fills a world rect, PixiMapView tints an overlay
quad). Chunk bakes themselves are always daytime (`lightsOn` is plumbed through `townChunks` but
no renderer passes it). A screenshot at simulated evening/night is heavily orange/blue-tinted —
check the sim clock before judging palette.

## Configuration & extending

- **`js/config.js` is the single source of tunable truth** — now also `CONFIG.world`
  (**only `cellPixels` is live** — `gridWidth/Height` are dead keys nothing reads; the town
  footprint derives from the packed location `x`/`y` maxima in `seedLocations.js` via
  `computeLayout`, so resize the world by re-running `tools/pack_locations.mjs`, not by editing
  these), `CONFIG.rendering` (`resolutionScale`, `chunkCells`,
  `chunkCacheMax`, `maxBakePx`), `CONFIG.camera` (`infinite`, `minZoom`, `maxZoom`, `zoomStep`, `easing`),
  `CONFIG.movement` (`pathfindingEnabled`, `subdivisions`, `walkSpeedPixelsPerFrame`,
  `maxAStarNodes`, plus the A* route-preference costs `streetCost`/`openCost`/`buildingCost` —
  see the tick section), `CONFIG.characters` (**only `frameScale` is live** — `useSpritesheets`/
  `fps` are dead keys nothing reads; walk fps lives in `assets/characters.json`), plus
  `CONFIG.conversation` (`baseChance`, `cooldownMinutes`, `maxPerLocationPerTick`,
  `maxGroupSize` — the chat-frequency knobs, see the tick's phase 4) and `ui`, where
  `timelineVisible` (60) / `memoryVisible` (50) are **numeric most-recent-N caps despite the
  boolean-sounding names** (a `false` becomes `slice(0)` → the whole list renders, a silent perf
  hit) and `timelineMax` (500) is the timeline **ring-buffer** cap — which also makes the Metrics
  panel's Conversations stat a window count on long runs, not a cumulative total. One more
  persisted-index trap: the speed `<select>` stores the *index* into `CONFIG.speeds` in
  localStorage (`settings.speedIndex`) and `_schedule()` dereferences it unguarded — reordering or
  removing `CONFIG.speeds` entries breaks returning sessions only (fresh profiles are fine).
  `js/ui/ParamControls.js` mutates retrieval/reflection `CONFIG` live for in-browser ablation —
  but only the **reflection** knobs change the run (the engine re-reads `CONFIG.reflection` each
  tick); the retrieval weights re-rank only the RetrievalProbe panel's display, because no core
  cognition path ever calls `MemoryStream.retrieve` (see the retrieval note under *Cognitive
  architecture*). ParamControls tuning is also **never persisted** — the settings store holds only
  speed/debug/seed/camera, so ablation changes revert on reload — and its "Reset defaults" button
  restores the **mount-time snapshot** of CONFIG, not the `config.js` literals. Caveat:
  `TimeManager` **caches** `minutesPerTick`, so the Minutes/tick slider also writes
  `sim.time.minutesPerTick` — keep that dual-write. (Same pattern: `Simulation` caches
  `_grid`/`_doorSpots`, so movement/location changes need a Reset — see the tick section.)
- **Add an agent/location/event**: append to `js/data/seedAgents.js` / `seedLocations.js` (exact
  field names: `homeLocationId`, `workLocationId`, `currentLocationId`; every referenced id
  must exist in `seedLocations.js` — a missing id does **not** break init, the sim silently
  degrades: `currentLocationId` still updates to the phantom id, observations stop (and the
  skipped `rng()` draw shifts the whole run's RNG stream — see the tick's phase 3), and
  `setDestination` is never called, so the agent's *previous* `path` is left stale; the renderers
  see the location change, find the avatar far from that stale path's start, and re-plan a
  **wall-legal** walk from the avatar's position to `spotFor`'s no-rect fallback at the town
  centre — an avatar calmly walking to mid-town is the symptom (the stale-route *replay* happens
  only if that re-plan fails, or with `pathfindingEnabled` toggled off mid-session after paths
  exist — off-from-boot leaves `agent.path` null and the avatar hops straight to mid-town); only
  the smoke
  test's world-integrity check catches it, so run `npm run smoke` after editing seeds. Ids must
  also be **unique**: `Environment.addLocation` is a plain `Map.set`, so a copy-pasted location id
  silently drops the earlier location — and the smoke test checks duplicate *coords* and agent
  *refs*, not id uniqueness, so it passes), then
  **Reset** to rebuild. **World events**
  are the third seed file, `js/data/seedEvents.js`: fields `id`, `time` (minutes-into-day,
  0–1439), `locationId` (must exist in `seedLocations.js`), `title`, `description`,
  `importance`, `tags`; each fires once per day **when `time <= minutesIntoDay` at a tick
  boundary** — at the default 10-min ticks an event in the final window (time 1431–1439) can
  **never** fire (rollover re-arms *before* the due-check, so there is no cross-midnight
  catch-up), and on day 1 everything scheduled before the 08:00 start fires in one first-tick
  burst in seed-array order. `Environment.resetEvents()` re-arms them at
  rollover, and `Environment.addEvent()` injects more at runtime (a past `time` fires on the very
  next tick; injections survive save/load — events + `fired` flags are serialized, so a loaded
  mid-day save does not re-fire that morning — but **Reset wipes them**, rebuilding from the
  pristine constructor-time `_seedData` clone). Event ids must be unique: `markFired` flags the
  **first** event with a matching id, so a duplicated id makes the second copy re-fire **every
  tick** (re-armed daily), with no error. Location
  `type`/`tags` (`cafe`, `park`, `shop`, `library`, `square`, …) drive plan-block resolution.
  Each building location also carries a packed `x`/`y` and a `complex` id (grouped into one
  cutaway shell by the renderer) — both assigned by `node tools/pack_locations.mjs`; re-run it
  after adding/removing buildings so complexes stay contiguous, knowing it **rewrites
  `seedLocations.js` wholesale** (a generated header + `JSON.stringify` of the array): comments
  and hand-tuned `x`/`y`/`complex` values are destroyed on every run — the durable inputs are only
  `id`/`name`/`type`/`tags`/`description`. `Location` **must** keep copying
  `complex` through its constructor + `toJSON` (see the building-art note above).
  `pack_locations.mjs` now lays the town out as a **well-planned, zoned community**: every
  building type maps to a zone (`ZONES`: commercial/civic/residential/craft) and blocks are
  **zone-pure**; it skyline-packs each zone's type-complexes into fixed `BW×BH` (=7×7) **city
  blocks** with each complex **inflated by a 1-cell pad** (right+bottom, in a virtual 8×8 grid
  whose overhang lands on the street) so **no two complexes' actual cells ever touch** — a
  no-touch invariant (4-adjacent + diagonal) throws at pack time if violated. Blocks tile a
  roughly-square grid **center-out in zone order** (commercial core → craft edge); spare central
  slots get no block and render as all-courtyard **town-park** blocks. Streets are the **1-cell
  paved gaps** between blocks (continuous avenues both ways — emitted as real `street`-type
  cells, ids `loc_street_*`); every unused block cell (including every pad cell between
  complexes) becomes a `green`/`plaza` courtyard (ids `loc_fill_*`). Both `loc_street_*`/
  `loc_fill_*` are stripped + regenerated each run (idempotent), so the town has **walkable
  streets** and **no bare-grass gaps**. The 3×3-blocks/23×23/511 figures are **derived, not
  configured** (`BLOCKS_COLS = round(√blocksN)`, 8 zone-pure blocks today): a 9th complex-bearing
  block silently consumes the central park slot (still 3×3), a 10th reshapes the town to 3×4 →
  23×31 — re-verify this file's numbers after a repack that adds complexes. Two more pack-time
  throws exist besides no-touch: "dup coord" and "complex too big for a block" (complex widths are
  clamped to ≤ 5 columns, so an over-grown type group trips the latter). Hand-authored parks/squares are dealt **round-robin
  across the zones** (uninflated 1×1 — flush against a building is fine; they ARE breathing
  room). **Every** location carries a `complex` field — generated streets/courtyards get
  `out_street_*`/`out_fill_*` and hand-authored parks/squares `out_<id>` pseudo-ids; building
  complexes are exactly the `cx<N>` ids (cx0–cx31 shipped), and the renderer's grouper skips
  outdoor plots by `isOutdoorType(loc.type)`, not by the field. Expect deterministic-art churn
  after any repack: courtyard/gap-lounge decor is seeded by the cell's **pixel position** (moved
  cells redraw differently), and `cx` ids come from one global counter over type-groups (split at
  8 members) — a change that alters how many complexes are emitted earlier in type order shifts
  every later `cx` id and with it the `sign-<complex>`-seeded name prefixes; town-wide
  signage/decor churn after a repack is expected, **not an art regression**. **Both generated filler kinds are scenery, never plan destinations**: `street` cells
  are tagged `["street","road","outdoor"]` and courtyards `["green"|"plaza","courtyard","outdoor"]` —
  deliberately **no** park/square/cafe tag on either (the planner matches blocks by
  `type`-or-tag, and 274 park-tagged courtyards once swamped the real cafés/parks so badly that
  lunch/leisure gatherings halved) — residents just walk through them. Re-tagging is also a
  town-wide RNG butterfly (same class as the conversation-slice trap): `_resolveLocation` picks
  plan destinations via `choice(candidates, rng)` over every location matching a template's
  type/tags, at init and every rollover — adding, removing, or re-tagging any
  cafe/park/shop/library/square changes the candidate arrays and diverges all 24 agents' plans
  from day 1. New community building **types** each need: a zone in `pack_locations.mjs`'s `ZONES` map (the
  fallback is silent — `ZONES[type] || "commercial"` packs an unknown type into the commercial
  core with no warning), a
  `BLUEPRINTS` plan (or `BLUEPRINT_ALIAS`), a `furnish()` room `kind`, a `ROOF` colour, and tags for
  plan-block resolution; new **outdoor** types must be added to `OUTDOOR_TYPES`/`isOutdoorType` (so
  the complex grouper skips them), `isOpenType` in `pathfinding.js` (so the movement grid
  keeps them open), **and `pack_locations.mjs`'s own local `isOutdoor`** (it only knows
  `park`/`square` — a hand-authored `green`/`plaza`/`street` with a non-generated id gets repacked
  as a *building* into a city block), then routed in both draw dispatches (`spritePark`/`spritePlaza`/`spriteGreen`/
  `paveStreet`+`streetFurniture`+`drawStreet`). New furniture **sprites** follow the
  usual pipeline: add to `SPRITES` in `pack_tiles.mjs`, author `tools/tile_svg/<name>.svg`
  (base×4, single root `<svg>`, ids prefixed), then `validate_tiles` → `pack_tiles --manifest` →
  `svg2png` (exact command lines under *Art direction*; note `validate_tiles` is repo-safe **only
  when run bare**: it imports `pack_tiles.mjs`, which reads `process.argv` at import time and
  writes the atlas SVG as a top-level side effect — `node tools/validate_tiles.mjs --manifest`
  would overwrite `assets/manifest.json`, and a positional arg redirects the atlas-SVG write).
- **Wire a real LLM**: there is no runtime/env switch — implement `LLMGenerationProvider` and
  change the `provider:` arg in `main.js` (where `new LocalGenerationProvider()` is passed to
  `new Simulation(...)`). Route the API through a backend proxy; never embed a key client-side.

## Art direction

The building art targets a **top-down RPG cutaway** look: apartment shells with the roof cut
away to reveal walled units — light-grey plaster walls (no colored roofs), salmon diamond-tile
baths, cream-carpet bedrooms, warm-orange wood-plank common rooms, detailed furniture, and a
red/yellow dining set per common room. Iterate with the verify loop: edit a tile SVG (or the
`townArt.js` placement) → `node tools/pack_tiles.mjs /tmp/tile_atlas.svg && node tools/svg2png.mjs
/tmp/tile_atlas.svg assets/sprites/atlas.png` (rebuild the atlas — tile-art changes only; add
`--manifest` to `pack_tiles` when sprite regions/sizes change) → serve →
`node tools/screenshot.mjs <url> <out.png> --eval <frame js>` to capture the live town and eyeball
it against the reference (mind the day/night ambient tint — see *Rendering*).

CLI fine print for that loop: `svg2png` and `screenshot.mjs` both hard-require their two
positional args (bare → usage error, exit 2); only `pack_tiles` runs bare, defaulting its
out-path to `/tmp/tile_atlas.svg` — but **never run
`pack_tiles --manifest` without the positional**, since `argv[2]` becomes the literal `--manifest`
and the atlas SVG lands in a junk `./--manifest` file while still exiting 0 (`assemble_atlas.mjs`
has the **identical trap** — bare `--manifest` writes the char-atlas SVG to `./--manifest` while
still writing `assets/characters.json` and exiting 0). A tile SVG missing
from `tools/tile_svg/` still writes atlas + manifest (blank region → that sprite silently renders
as nothing) with only `process.exitCode = 1` and a `MISSING:` suffix on the log line — chain with
`&&` and watch for it. `screenshot.mjs` extras: `--clip '#map-host'` captures just the map (a selector that matches
**nothing** silently falls back to a full-viewport capture with exit 0 — the only tell is the
final log line missing its `clip` suffix),
`--w/--h` set the viewport (default 1500×800), `--wait` ms after eval, `--dpr` scale; the `--eval`
result is awaited (promises OK) and printed to **stderr**, so it doubles as a headless state probe
(sim clock, agent positions). Its ~20 s boot wait (polling `window.__app.map.layout`) is
**non-fatal** — on timeout it warns and captures the half-loaded page anyway with exit 0, so check
stderr, not the exit code. Both Chrome-driving tools (`svg2png`, `screenshot`) honor
`CHROME_PATH`/`CDP_PORT` (no Google Chrome at the default macOS path → set `CHROME_PATH`) and will
**reuse/commandeer** a Chrome already listening on their port (defaults differ — svg2png 9388,
screenshot 9389 — so they never collide with each other, but one `CDP_PORT` overrides **both**;
they only kill a Chrome they spawned themselves).

`ART_BIBLE.md` documents the older palette, sprite grid, and room layouts. Note it describes a
procedural generator/`tools/` workflow that is **not present in this deploy repo**, it predates
the cutaway refactor, and its headline "art source" note — sprites sliced from Kenney CC0 packs by
`tools/slice_city.mjs` — is **false here** (no such tool exists; all art is original
self-generated SVG, per `assets/CREDITS.txt`, whose own "37 tiles" count is *also* stale vs. the
88 in `assets/manifest.json`) — treat it as historical design intent, not runnable here.
