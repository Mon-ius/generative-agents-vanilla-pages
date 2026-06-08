# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A dependency-free, **static** browser simulation of *generative agents* (inspired by
Park et al., 2023). **24 residents** of "Willow Creek" — a **511-location town** laid out
as a well-planned community: homes, work, and community buildings (cafés, shops, a chapel,
cinema, bank, salon, florist, pharmacy, museum, post office, diner) packed into a **3×3 grid
of 7×7 zoned city blocks** (commercial core → civic → residential → craft edge, placed
center-out; the spare central slot is the town park), separated by a connected network of
**paved streets**, with a **1-cell landscaped gap between any two building complexes** and
green/plaza courtyards filling every leftover cell, all in a 23×23 footprint. Residents
observe, store memories, plan their day, reflect, hold **group conversations**, walk
**A\*-pathed routes**, and form relationships.

Pure ES-module JavaScript — **no build step, bundler, transpiler, backend, or LLM API keys**.
Rendered with vendored PixiJS (WebGL) and an automatic canvas-2D fallback, both high-DPI,
**chunk-baked + viewport-culled**, with a shared **free-roam Camera** over a **boundless** map
and animated avatars. This directory is the published GitHub Pages copy; it also carries a
small **dev-only** toolchain (`tools/`, `test/`) that is not served. No ESLint/Prettier/CI.

## Commands

**Run locally** (required — ES `import` is blocked from `file://`):
```bash
python3 -m http.server 8000   # any static server works; then open http://localhost:8000/
```

**Test**:
```bash
node test/smoke.node.mjs    # npm run smoke — 31 checks (determinism, save/load, pathfinding,
                            # group conversations, sleep/beds); exits non-zero on failure
node tools/check-all.mjs    # npm run check — node --check every js/**/*.js (skips js/vendor)
node tools/audit_rooms.mjs  # room-furniture overlap audit; report-only (always exits 0) —
                            # read the printed "TOTAL ... spills ... bed-spot misses" line
```
`window.__app` (`{ app, sim, renderer, controls, map }`) is exposed in-browser for live
inspection; `__app.map.camera` is the pan/zoom Camera (`fit()`, `centerOn(wx,wy)`, …). Boot is
two-phase: `__app.map` is null until the async `setupMap()` resolves — `__app.map.layout` is
the readiness signal (what `tools/screenshot.mjs` polls).

**Deploy** — GitHub Pages from the **`master`** branch. `.nojekyll` serves files as-is; `CNAME`
pins the custom domain **`town.m0nius.com`**. All asset paths are relative.

## Architecture: core ↔ UI split via an EventBus

The key invariant: **the simulation core never touches the DOM, and the UI never contains
simulation logic** — so the core runs headless (that's how `test/smoke.node.mjs` boots and steps
it). The glue is one-directional: the core notifies the UI through `sim.bus` (EventBus); the UI
drives the core by calling its public methods (`sim.step()`, `sim.selectAgent(id)`,
`sim.save()/load()/reset()`) and reads sim state directly (`sim.agents`, `sim.time`, …).

- **Core** (DOM-free): `js/config.js`, `js/utils/*`, `js/simulation/*`, `js/agents/*`, `js/data/*`.
- **UI** (DOM/canvas/WebGL): `js/ui/*`, `js/main.js`. `js/utils/dom.js` is the only util the core
  must never import.
- **`js/main.js`** is the single composition root: wires Simulation ↔ Renderer ↔ Controls, owns
  the `setInterval` playback loop, mounts the research panels, selects the map renderer, and wires
  the Export/Import/Share buttons + the `#seed=` hash. `Controls.js` covers only the playback
  toolbar (start/pause/step/reset/save/load/speed/seed/debug/zoom).

**EventBus** — `sim.bus.emit(type, payload)` / `sim.bus.on(type, cb)`. Event types: `init`,
`tick`, `timeline`, `select`, `reset`, `load`. `on()` returns an unsubscribe closure; `emit()`
wraps each listener in try/catch (a throwing panel is only `console.error`'d — check the console).
`init` fires before any subscriber exists, so every panel self-renders synchronously at mount.

`Renderer` owns the DOM side panels (status/legend/agent/memory/timeline/debug) and rebuilds them
from scratch on `init`/`tick`/`select`/`reset`/`load`. The **map views run their own animation
loops** (`MapView` via `requestAnimationFrame`, `PixiMapView` via the Pixi ticker), reading sim
state every frame (so path-walking animates between ticks) and using the bus only to sync on
`tick`, rebuild on `reset`/`load`, focus on `select`, and pop 💬 bubbles on `timeline`. Panel-tab
visibility is a small WAI-ARIA controller (`js/ui/Tabs.js`).

## The simulation tick (`Simulation.step()`)

Each `step()` advances the clock by `CONFIG.minutesPerTick` and runs a **fixed, deterministic
five-phase cycle** over `this.agents` (stable iteration order for reproducibility):

1. **World events** due at `minutesIntoDay` fire once; present agents get an `event` memory + a
   generated reaction.
2. **Plan → move**: `Planner.updateStatuses()` returns the active block; if it's elsewhere the
   agent's `currentLocationId` is set immediately (cognition is logical-instant) AND
   `agent.setDestination()` computes an A\* `path` (`js/utils/pathfinding.js`) that **only the
   renderers animate** along. Buildings are **solid walled cells** on a sub-tile grid
   (`subdivisions:8`): a blocked perimeter with an open 6×6 interior and a narrow gap on the one
   **door** edge plus every **tunnel** edge shared with a same-`complex` sibling. The door edge is
   chosen by `classify` (faces the largest open component; prefers S, then E, W, N). **A\* is
   weighted-cost** (street 1, open ground 4, building interior 12), so residents follow the paved
   avenues. Routing and rendering share one `townTopology`, so walls/doors stay in lockstep. The
   renderers re-route mid-walk on `layout.collisionGrid` (a smoke check pins it byte-identical to
   the sim's own cached grid).
3. **Observe**: each agent may record its location (`rng() < 0.5`) and every co-located agent.
   `Environment.indexAgents()` refreshes co-location after the move.
4. **Converse**: per location with ≥2 co-located agents, up to `maxPerLocationPerTick` (=1)
   conversations form over id-sorted slices of up to `maxGroupSize` (=4). Gate: `baseChance`
   (0.45) + a familiarity bonus over off-cooldown pairs (90-min per-pair cooldown). Each
   participant gets a `conversation` memory, every ordered pair's relationship updates by tone
   (warm/neutral/tense), and one timeline entry carries `participantIds` + `locationId`.
5. **Reflect**: agents whose accumulated importance crossed the threshold synthesize an insight.

At **day rollover** (checked at the top of `step()`): events re-arm and every agent re-plans, then
`bus.emit("tick", …)`.

**Two time scales** (`TimeManager`): memory timestamps + cooldowns use monotonic **`totalMinutes`**;
plan blocks + `minutesIntoDay` use **minutes-into-day (0–1439)**. `CONFIG.startMinutes` is **05:50**,
inside the home sleep block, so the sim **boots with all residents asleep in bed** and they rise at
06:00.

## Cognitive architecture (`js/agents/`)

`Agent` is a near-pure state object (identity + `MemoryStream` + `RelationshipGraph` + counters);
cognition is delegated to focused modules, and all *generated* text flows through a
**`GenerationProvider`**.

- **Memory retrieval** (`js/utils/scoring.js`) is deterministic:
  `score = recency·w + importance·w + relevance·w` (recency = exponential decay, importance =
  `importance/10`, relevance = keyword overlap). `MemoryStream.retrieve()` ranks by score; its main
  consumer is the RetrievalProbe display panel (`Reflector` synthesizes from `memoryStream.recent(12)`).
- **Reflection**: only *lived* memory types (`observation`/`action`/`conversation`/`event`) add to
  `reflection.accumulatedImportance`. `Reflector.shouldReflect()` gates on the importance threshold
  **and** `minIntervalMinutes`; `reflect()` resets the counter.
- **Relationships**: `RelationshipGraph.update(id, deltas)` **adds** clamped deltas —
  `affinity`/`trust` ∈ [-100,100], `familiarity` ∈ [0,100]. Conversation tone drives the deltas
  (the numbers live in `Simulation.js` phase 4).
- **`GenerationProvider`**: a complete provider implements **five** methods — `generatePlan`,
  `generateReflection`, `generateConversation`, `generateReaction`, and
  `generateGroupConversation` (used for 3–4-person groups; size-2 reuses `generateConversation`).
  `LocalGenerationProvider` (the only one wired in) is deterministic and template-based; its
  `DAY_TEMPLATE` carries the **sleep contract** — two `/sleep/i` home blocks = 8 h/day — that
  `townArt.isSleeping` keys all bed/lying behavior on. `LLMGenerationProvider` throws on purpose
  (never ship an API key client-side); a custom one must honor the sleep contract.

## Determinism & persistence

- **Seeded RNG** (`js/utils/random.js`, mulberry32). One RNG per run; `getState()/setState()` let
  save/load resume the exact stream position, so the same seed reproduces a run bit-for-bit.
  **Renderer/art/character randomness uses `seededRandom(stableId)`, never the sim RNG**, so the
  camera, avatars, and pathfinding can't desync a save. The smoke test asserts two fresh same-seed
  runs are byte-identical.
- **Seeds**: `CONFIG.defaultSeed = "smallville-2024"` (the sim seed, overridable via the `#seed=`
  URL hash for shareable runs — the toolbar **Share** writes the hash + copies a permalink) is
  distinct from the procedural-art seed `"willow-creek-art-v2"`.
- **Persistence**: full sim state under `CONFIG.storageKey` via `sim.save()/load()` (localStorage);
  UI settings (speed/debug/seed/camera) under `CONFIG.settingsKey`. File export/import goes through
  `sim.getState()` → JSON download and `sim.loadState(state)` (wired in `main.js`). `getState()`
  returns live references, so only a JSON round-trip is safe to feed another sim — the smoke test
  `JSON.parse(JSON.stringify(...))`s first; do the same in any fork/determinism test.

## Rendering (`js/ui/`)

`setupMap()` tries **PixiMapView (WebGL)** first (dynamic import, gated on a WebGL probe) and falls
back to **MapView (canvas-2D)**. PixiJS v8 is vendored at `js/vendor/pixi.min.mjs` (no CDN). Both
renderers share geometry/art from **`js/ui/townArt.js`** and the shared modules `camera.js`,
`characters.js`, `gates.js`, `townChunks.js`, so they stay in lockstep.

- **`townArt.js`** — `CELL = CONFIG.world.cellPixels` (176). `computeLayout(sim)` returns
  `{cols,rows,W,H,CELL,rects, collisionGrid, doorSpots, wallTopology, complexes, bedSpots,
  bedAssign, chunk…}`. `drawTownInto(g, layout, sprites, worldRect, opts)` draws only what
  intersects `worldRect` (so a chunk can be baked). `routeFrom(layout, from, to)` is the grid-A\*
  wrapper the renderers use for the mid-walk re-route.
- **Building art — top-down cutaway (no roofs).** `groupComplexes` buckets `rects` by each
  location's **`complex` id** (assigned by `tools/pack_locations.mjs`, preserved through `Location`
  — keep `Location` copying `complex` through its constructor + `toJSON`). `spriteComplex` draws
  each member's walled unit + the shared shell, cutting a narrow **door** gap on the door edge and a
  **tunnel** gap on every wall shared with a sibling, aligned exactly to the openings the routing
  grid punches from the same topology. `wallCap()` gives the flat grey cutaway wall top. Each unit's
  interior is a per-type **`BLUEPRINTS`** floor plan; `furnish` fills rooms by kind (salmon
  `floor_pink` baths, cream `floor_tile` private/civic rooms, warm `floor_wood` common rooms), with
  a red/yellow `diningSet()` in common rooms and bespoke furniture for community types. **Doors** are
  per-edge directional sprites — `doorLeaf` picks `door_{s,n,e,w}` so the light and threshold read
  correctly on every wall. **Signs** are per building: one fascia-mounted `nameSign` on the south
  face, named by `buildingName()`.
- **Sleep & beds.** `townArt.isSleeping(agent)` = a sleeping activity **and** at home. A 2-resident
  home draws two horizontal beds down the left wall. `bedPlacement()` is the single source for bed
  positions, feeding both `furnish` and `computeBedAssignments` (which publishes `layout.bedSpots` +
  `layout.bedAssign`). Both renderers walk a sleeper through the bedroom doorway (via points) onto
  the assigned bed; the **lying pose** in `characters.js` rotates the body −90°, centres it on the
  bed, hides the shadow, and lays a blanket. 💬 bubbles are suppressed for sleeping participants.
- **Streets & outdoor plots.** Real `street` cells are paved edge-to-edge with the cobble tile
  (`paveStreet`) and dressed with lamps (`streetFurniture`). Parks/squares/greens/plazas render via
  `spritePark`/`spritePlaza`/`spriteGreen`. The sprite path also adds a south shoreline and a
  deterministic top-left forest (drawn before buildings so canopies overhang).
- **Walled gardens & animated gates** (`pathfinding` → `townArt` → `gates.js` → both map views).
  Only `park` + `square` plots are walled. `gardenEdges(loc)` codes each edge as open seam / gate /
  solid fence; `rasterizeSolid` punches the same centred gap building doors use, so connectivity is
  preserved by construction. `spriteGarden` + `gardenFence` draw the ring with `gate_post` piers; the
  **swinging leaf** lives in `js/ui/gates.js` (`computeGates` → descriptors, `createGateAnimator` →
  one instance per renderer), drawn per-frame on the **render clock** (never baked, never the sim
  RNG), opening as avatars approach and easing shut after they leave.
- **`townChunks.js`** — the world is baked per **4×4-cell chunk**, lazily and viewport-culled, with
  an LRU texture cache (`CONFIG.rendering.chunkCacheMax`); off-screen chunks/agents are hidden.
- **`camera.js`** — one renderer-agnostic controller for both views: drag-pan, wheel/pinch-zoom,
  inertia, double-tap-zoom, `centerOn`, and `toJSON/applyState` (persisted to `settings.camera`,
  debounced). The world is **boundless** (`CONFIG.camera.infinite`): no edges, an absolute `minZoom`
  floor; **Fit** frames the town at 90% of true fit; selecting/clicking a resident `centerOn`s them.
- **`characters.js`** — one avatar source for both renderers: loads `assets/characters.json` + the
  shared atlas, runtime-slices the walk frames, and always has a procedural fallback (skin/hair/
  outfit deterministic from `agent.id`). On-screen size = `frameW × CONFIG.characters.frameScale`.

**Art = two CC0 SVG→PNG atlases**: town tiles in `assets/sprites/atlas.png` (regions in
`assets/manifest.json`), characters in `assets/characters/atlas.png` (`assets/characters.json`).
`loadSprites()` fetches the tile atlas once and slices each region into a per-name canvas; the
sprite path needs **≥6 entries** or it falls back to procedural drawing. **Atlas/manifest cache
coherency is content-versioned**: the packers stamp `manifest.version = md5(atlasSVG)`, the loaders
fetch the manifest with `{cache:"no-cache"}` and request the atlas as `atlas.png?v=<version>`, so a
reflowed atlas can never be mis-sliced by a stale browser cache. **Re-run the packer with
`--manifest` after any sprite change** to refresh the version.

**Day/night**: both renderers tint the world with `townArt.ambient(minutesIntoDay)` (clear at
noon). A screenshot at simulated evening/night is heavily tinted — check the sim clock before
judging palette.

## Configuration & extending

- **`js/config.js` is the single source of tunable truth**: `world.cellPixels`, `rendering`,
  `camera` (`infinite`/`minZoom`/`maxZoom`/`zoomStep`/`easing`), `movement` (`pathfindingEnabled`/
  `subdivisions`/`walkSpeedPixelsPerFrame`/`maxAStarNodes` + the A\* costs `streetCost`/`openCost`/
  `buildingCost`), `characters.frameScale`, `conversation` (`baseChance`/`cooldownMinutes`/
  `maxPerLocationPerTick`/`maxGroupSize`), `reflection`, `retrieval`, `ui`, `speeds`. `Simulation`
  **caches** the collision grid + door spots, so movement/location changes need a **Reset** to take
  effect.
- **Add an agent/location/event**: append to `js/data/seedAgents.js` / `seedLocations.js` /
  `seedEvents.js` (every referenced id must exist in `seedLocations.js`; ids must be unique), then
  **Reset** to rebuild and run `npm run smoke`. Location `type`/`tags` drive plan-block resolution;
  events fire once per day when `time <= minutesIntoDay` at a tick boundary.
- **Town layout** is generated by `node tools/pack_locations.mjs`, which assigns each building a
  packed `x`/`y` + `complex` id and lays the town out as a zoned community (zone-pure 7×7 blocks,
  center-out, a 1-cell pad so no two complexes touch, paved `loc_street_*` streets and `loc_fill_*`
  courtyards between them). It **rewrites `seedLocations.js` wholesale** — the durable inputs are
  only `id`/`name`/`type`/`tags`/`description`. Re-run it after adding/removing buildings; expect
  deterministic art churn (courtyard + sign seeds shift) afterward.
- **New building type** needs: a zone in `pack_locations.mjs`'s `ZONES`, a `BLUEPRINTS` plan (or
  `BLUEPRINT_ALIAS`), a `furnish()` room kind, a `ROOF` colour, and tags for plan resolution. **New
  outdoor type** needs adding to `OUTDOOR_TYPES`/`isOutdoorType` (townArt), `isOpenType`
  (pathfinding), and `pack_locations.mjs`'s local `isOutdoor`, then routing in both draw dispatches.
- **New furniture sprite**: add to `SPRITES` in `pack_tiles.mjs`, author `tools/tile_svg/<name>.svg`
  (base×4, single root `<svg>`, ids prefixed), then `validate_tiles` → `pack_tiles --manifest` →
  `svg2png`.
- **Wire a real LLM**: implement `LLMGenerationProvider` and change the `provider:` arg in
  `main.js`. Route the API through a backend proxy; never embed a key client-side.

## Art direction

The building art targets a **top-down RPG cutaway**: apartment shells with the roof cut away to
reveal walled units — light-grey plaster walls, salmon baths, cream bedrooms, warm-orange common
rooms, detailed furniture, a red/yellow dining set per common room. **All art is original
self-generated SVG** (no third-party packs), rasterized SVG→PNG by `tools/svg2png.mjs` via a
self-launched headless Chrome.

Verify loop: edit a tile SVG (or the `townArt.js` placement) →
`node tools/pack_tiles.mjs /tmp/tile_atlas.svg --manifest && node tools/svg2png.mjs
/tmp/tile_atlas.svg assets/sprites/atlas.png` (**always pass `--manifest`** so `manifest.version`
refreshes for the cache-bust) → serve →
`node tools/screenshot.mjs <url> <out.png> --clip '#map-host' --eval '<frame js>'` to capture the
live town (mind the day/night tint). Characters redraw the same way:
`node tools/gen_chars_svg.mjs && node tools/assemble_atlas.mjs /tmp/char_atlas.svg --manifest &&
node tools/svg2png.mjs /tmp/char_atlas.svg assets/characters/atlas.png`.

`tools/audit_rooms.mjs` drives the real sprite path with mock sprites and flags furniture↔furniture
overlaps, out-of-room spills, and bed-spot misalignment — run it after any `townArt.js` furniture or
`BLUEPRINTS` change.

> The inherited `README.md` (from upstream `Mon-ius/generative-agents-vanilla-pages`) and
> `ART_BIBLE.md` are **stale/historical** re: world size, art, and the renderer — trust this file.
