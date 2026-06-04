# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A dependency-free, **static** browser simulation of *generative agents* (inspired by
Park et al., 2023). **24 residents** of "Willow Creek" — a **~270-location town laid out
like a real community**: homes, work, and community buildings (cafés, shops, a chapel,
cinema, bank, salon, florist, pharmacy, museum, post office, diner) packed into a **~3×3
grid of city blocks** separated by a connected network of **paved streets** the residents
walk, with landscaped green/plaza courtyards filling every leftover cell (so no cell is bare
grass), all in a ~17×17 footprint — observe,
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
- `test/smoke.node.mjs` — headless harness for the DOM-free core (world integrity, **determinism**, save/load, pathfinding, group-conversation invariants). 21 checks.
- `tools/check-all.mjs` — runs `node --check` over every `js/**/*.js` except `js/vendor`.
- Still **no** ESLint/Prettier/CI. **All art is original, self-generated SVG → PNG atlases** (no third-party/Kenney assets): town tiles in `assets/sprites/atlas.png`, characters in `assets/characters/atlas.png`. Asset tools live in `tools/` (`gen_chars_svg.mjs`, `assemble_atlas.mjs`, `pack_tiles.mjs`, `svg2png.mjs`, `pack_locations.mjs` — assigns the packed grid x/y + `complex` ids in `seedLocations.js`, `screenshot.mjs` — headless-Chrome capture of the live app for the art verify loop).

The README is inherited from the upstream source repo (`Mon-ius/generative-agents-vanilla-pages`)
and is **stale** re: world size, art, and the renderer — trust this file over it.

## Commands

**Run locally** (required — ES `import` is blocked from `file://`, so opening `index.html` directly won't work):
```bash
python3 -m http.server 8000   # any static server works; then open http://localhost:8000/
```

**Test** — headless core (fast, gates determinism/pathfinding/groups), and in-browser:
```bash
node test/smoke.node.mjs    # or: npm run smoke   — 21 checks, exits non-zero on failure
node tools/check-all.mjs    # or: npm run check   — node --check every js/**/*.js (skips js/vendor)
```
```js
window.runSmokeTest()       // in the browser console; MUTATES the live sim (steps/selects/saves/resets)
```
`window.__app` (`{ app, sim, renderer, controls, map }`) is exposed for live inspection;
`__app.map.camera` exposes the pan/zoom Camera (`fit()`, `zoomIn/Out`, `centerOn(wx,wy)`, `toJSON/applyState`).

**Deploy** — GitHub Pages branch publishing. The current branch is **`master`** (the
README's deploy script says `main` — that is stale; the repo was renamed to `master`).
`.nojekyll` serves files as-is; `CNAME` pins the custom domain **`town.m0nius.com`** (this
overrides the `*.github.io` URL the README advertises). All asset paths are relative so
the site also works from a project subpath.

## Architecture: strict core ↔ UI split via an EventBus

The single most important invariant: **the simulation core never touches the DOM, and the
UI never contains simulation logic.** They communicate only through `sim.bus` (EventBus).
This keeps the core runnable headless (it's why `test/smoke.node.mjs` can boot and step it).

- **Core** (DOM-free): `js/config.js`, `js/utils/*`, `js/simulation/*`, `js/agents/*`, `js/data/*`.
- **UI** (DOM/canvas/WebGL): `js/ui/*`, `js/main.js`.
- `js/utils/dom.js` is the *only* util the core must never import (it's UI-coupled).

**`js/main.js` is the single composition root** — the only place that wires `Simulation`
↔ `Renderer` ↔ `Controls`, owns the `setInterval` playback loop and all "running" state,
mounts the research panels (each guarded by `getElementById` so a headless import is safe),
and selects the map renderer.

**EventBus contract** — the cross-cutting glue. `sim.bus.emit(type, payload)` /
`sim.bus.on(type, cb)`. The complete closed set of event types is:
`init`, `tick`, `timeline`, `select`, `reset`, `load`. Every UI module subscribes to these;
the map views additionally watch `timeline` entries with `type === "conversation"` to pop 💬
speech bubbles. `Renderer.renderAll()` rebuilds **all** panels from scratch on every event
(no diffing — fine at 24 agents / ~5 panels). Tab visibility is pure HTML/CSS; hidden panels
are still re-rendered.

## The simulation tick (`Simulation.step()`)

Each `step()` advances the clock by `CONFIG.minutesPerTick` and runs a **fixed, deterministic
five-phase cycle** over `this.agents` (iteration order is stable for reproducibility):

1. **World events** due at `minutesIntoDay` fire once; present agents get an `event` memory + a generated reaction.
2. **Plan → move**: `Planner.updateStatuses()` returns the active block; if it's elsewhere the agent's `currentLocationId` is set **immediately** (`moveTo()` — cognition/co-location stays bit-deterministic) AND `agent.setDestination()` computes an A* waypoint `path` (`js/utils/pathfinding.js`) that **only the renderers animate** along. Movement is "logical-instant for cognition, animated for rendering" — a deliberate determinism choice; multi-tick travel was rejected.
3. **Observe**: each agent may record its location (gated `rng() < 0.5`) and records every co-located agent. `Environment.indexAgents()` is refreshed after the move for O(agents) co-location lookups.
4. **Converse**: per location with ≥2 co-located agents, **one group** of up to `CONFIG.conversation.maxGroupSize` (=4) forms (`ConversationEngine.checkGroupConverse`/`converseGroup`); each participant gets a `conversation` memory (`relatedAgentIds` = the others), every ordered pair's relationship updates, and **one** timeline entry carries `participantIds` + `locationId`. Size-2 behaves like the old pair path.
5. **Reflect**: agents whose accumulated importance crossed the threshold synthesize an insight.

At **day rollover** (checked at the top of `step()`): `Environment.resetEvents()` re-arms
daily events and every agent re-plans via `_planAgentDay()`. Then `bus.emit("tick", …)`.

**Two time scales — do not confuse them** (`TimeManager`): memory `timestamp` and cooldowns
use monotonic **`totalMinutes`** (so recency scoring works across days); plan blocks and
`minutesIntoDay` use **minutes-into-day (0–1439)**.

## Cognitive architecture (`js/agents/`)

`Agent` is a pure state object (identity + `MemoryStream` + `RelationshipGraph` + counters);
all cognition is delegated to focused modules, and **all text generation goes through a
`GenerationProvider`**:

- **Memory retrieval is fully deterministic** (`js/utils/scoring.js`): `score =
  recencyWeight·recency + importanceWeight·importance + relevanceWeight·relevance`, where
  recency is exponential decay (`0.5^(age/halfLife)`), importance is `importance/10`, and
  relevance is keyword overlap (memory `keywords[]` + tokenized description vs. query).
  `MemoryStream.retrieve(query, currentTime, n)` sorts by score then newest-first.
- **Reflection accumulation gotcha**: only *lived* memory types (`observation`, `action`,
  `conversation`, `event`) add to `reflection.accumulatedImportance`; `reflection` memories
  are deliberately excluded to avoid a feedback loop. `Reflector.shouldReflect()` gates on
  both the importance threshold **and** `minIntervalMinutes`.
- **Relationships**: `RelationshipGraph.update(id, deltas)` **adds** clamped deltas (it does
  not set) — `affinity`/`trust` ∈ [-100,100], `familiarity` ∈ [0,100]. Conversation tone
  (warm/neutral/tense, derived from existing affinity) drives the deltas.
- **`GenerationProvider`** has four methods: `generatePlan`, `generateReflection`,
  `generateConversation`, `generateReaction`. `LocalGenerationProvider` (the only one wired
  in) is deterministic and template-based. `LLMGenerationProvider` is a stub that **throws on
  purpose** to prevent shipping an API key in client code.

## Determinism & persistence

- **Seeded RNG** (`js/utils/random.js`, mulberry32 via xfnv1a hash). One RNG per run,
  threaded through everything via `_context().rng`. `getState()/setState()` let save/load
  resume the *exact* stream position, so the same seed reproduces the same run bit-for-bit.
  **Renderer/art/character randomness uses `seededRandom(stableId)`, never the sim RNG** — so
  the camera, avatars, and pathfinding can't desync a save. The smoke test asserts two fresh
  same-seed runs are byte-identical after 150 steps. (Gotcha fixed: `Planner` plan ids are now
  `plan_<agentId>_d<day>_<i>` — a former module-global counter leaked state across `Simulation`
  instances and broke fresh-run reproducibility. Don't reintroduce module-global mutable state.)
- **Seeds to keep straight**: `CONFIG.defaultSeed = "smallville-2024"` (the sim seed, also
  overridable via the `#seed=…` URL hash for shareable runs) is **different** from the
  procedural-art seed `"willow-creek-art-v2"` and from the town name "Willow Creek".
- **Two separate persistence stores** (both `localStorage`, version-suffixed keys):
  full sim state under `CONFIG.storageKey` (`generative-agents-vanilla:state:v1`) via
  `sim.save()/load()`; UI settings (speed/debug/seed) under `CONFIG.settingsKey`
  (`generative-agents-vanilla:settings:v1`).
- **Two save paths**: localStorage (`sim.save()/sim.load()`) vs. file export/import
  (`sim.getState()` → JSON download; `sim.loadState(state)` ← imported file).

## Rendering (`js/ui/`)

`main.js setupMap()` tries **PixiMapView (WebGL)** first via dynamic `import()` (gated on
`requestAnimationFrame` + a WebGL probe), and falls back to **MapView (canvas-2D)**; it sets
`host.dataset.renderer` and logs which won. PixiJS v8 is vendored at `js/vendor/pixi.min.mjs`
(no CDN). Both renderers share geometry/art from **`js/ui/townArt.js`** and four shared
modules, so they stay in lockstep:

- **`townArt.js`** — `CELL = CONFIG.world.cellPixels` (176). `computeLayout(sim)` returns a
  **superset** `{cols,rows,W,H,CELL,rects, collisionGrid, complexes, chunkCells/chunkPx/chunkCols/chunkRows}`.
  `drawTownInto(g, layout, sprites, worldRect, opts)` draws only what intersects `worldRect`
  (so a chunk can be baked); `drawTown`/`makeTownCanvas` are thin full-rect wrappers.
- **Building art — top-down cutaway (no roofs).** Buildings render as **apartment complexes**:
  `groupComplexes(layout)` buckets `rects` by each location's **`complex` id** (assigned by
  `tools/pack_locations.mjs`, preserved through `Location` — *if that field is ever dropped again,
  the renderer falls back to a coarse grid key and lumps unrelated buildings into giant sparse
  pseudo-complexes flooded with bare corridor floor*; complex-less buildings get a unique `solo_<id>`
  key → standalone). `spriteComplex` draws one shared corridor floor + each member's walled unit
  (`spriteBuilding`, `noRoof`) + one outer shell wall with an entry gap; empty cells in the bounding
  box get a rug+plant landing. **`wallCap()` caps every shell with a flat light-grey wall top
  (the cutaway look) — there is NO colored shingle roof in the sprite path** (`shingleRoof`/`ROOF`
  survive only in the procedural `drawBuilding` fallback). Each unit's interior comes from a per-type
  **`BLUEPRINTS`** floor plan (`drawRooms` lays out rooms + one doorway per adjacent pair); `furnish`
  fills each room by `kind` — baths get the **salmon diamond** floor (`floor_pink`), private rooms
  the **cream carpet** (`floor_tile`), common rooms **warm orange planks** (`floor_wood`). The
  reference's signature **`diningSet()`** (a table ringed by red/yellow chairs on a rug) anchors
  every common room.
- **Streets & outdoor plots.** The packer emits real `street`-type cells between the city blocks;
  `paveStreet` fills the **whole cell** edge-to-edge with the cobble tile (`S.gravel`) so a run of
  street cells reads as one seamless road, drawn **as ground** (before trees/buildings) so eaves
  and canopies overhang it. `streetFurniture` adds lamps to a deterministic subset on top.
  Parks/squares/greens/plazas still render via `spritePark`/`spritePlaza`/`spriteGreen` over their
  ~0.92-cell footprint (a grass verge shows at their edges). The procedural fallback mirrors this
  with `drawStreet`/`drawPark`/`drawPlaza` (the old global path-band grid was removed — streets are
  explicit cells now).
- **`townChunks.js`** — the world is too big for one texture (> WebGL limits), so
  it's **baked per chunk** (4×4 cells) **lazily and viewport-culled**. `makeChunkCanvas`,
  `visibleChunks`, `chunkDims`, `chunkWorldRect`, `chunkKey`. Pixi LRU-caches chunk textures
  (`CONFIG.rendering.chunkCacheMax`); off-screen chunks/agents are hidden.
- **`camera.js`** (`Camera`) — **one** renderer-agnostic controller for **both** views (Pixi
  applies it to the world container via `scale`/`position`; canvas via `ctx.setTransform`):
  **drag-pan + wheel/pinch-zoom + inertia + double-tap-zoom**, `worldToScreen`/`screenToWorld`,
  `visibleWorldRect()` (the culling source), `centerOn(wx,wy)`, `toJSON/applyState` (persisted to
  `settings.camera`). Node-safe — the pure math constructs/runs with no DOM (tests use it). The
  world is **boundless** (`CONFIG.camera.infinite`): there are **no map edges** — the town floats
  in infinite grass, so the zoom-out floor is an **absolute** `minScale` (`CONFIG.camera.minZoom`),
  **not** fit-to-world; `canPan()` is always true; and `_clampTarget()` only *soft*-limits roaming
  (a `pad` around the town keeps it reachable instead of clamping to an edge). `fit()` / the **Fit**
  toolbar button frames the town centered (not its edges); the initial view opens centered on the
  town, and **selecting or clicking a resident** (on the map or in the legend) smoothly `centerOn`s
  them.
- **`characters.js`** (`createCharacterFactory`) — **one avatar source for both renderers**:
  loads the manifest (`assets/characters.json`) + sheets, runtime-slices the walk frames,
  and **always** has an enhanced **procedural** fallback (varied skin/hair/outfit
  **deterministic from `agent.id`**, never the sim RNG). The shipped art is **one CC0 sprite
  atlas** `assets/characters/atlas.png` (480×576): 12 residents, each a 3-frame walk × 4
  directions block (32×48 frames). It's a **CSS-sprite / texture-atlas**: every variant points
  at the *same* file with a pixel offset (`ox/oy`), and `loadCharacterSheets` **fetches the
  atlas once** (deduped by file) — one HTTP request for all residents. `frameW/frameH` and
  `anchorX/Y` come from the manifest; on-screen size = `frameW × CONFIG.characters.frameScale`
  (0.7 ≈ 22px, a crisp downscale of the 32px art).
  Asset pipeline (dev-only, **no runtime SVG**): `tools/gen_chars_svg.mjs` emits the 12
  resident SVGs in `tools/char_svg/<key>.svg` with **exact, consistent geometry** (centered on
  x=16, feet on y=46, contiguous, fits the 32×48 cell — authored deterministically because
  hand-drawn-per-cell art couldn't self-align). Then `tools/assemble_atlas.mjs` tiles them into
  one atlas SVG + writes the region manifest, and `tools/svg2png.mjs` rasterizes SVG→PNG via
  **self-launched headless Chrome** (transparent, pixel-exact, zero npm deps). Redraw via those
  three tools.
- **Town tiles** (`assets.js`, `js/ui/townArt.js`) — the ~88 terrain/furniture sprites are **also
  one CC0 SVG→PNG atlas** `assets/sprites/atlas.png`, addressed by `{x,y,w,h}` regions in
  `assets/manifest.json`. `loadSprites()` fetches that atlas **once** and slices each region into
  a per-name canvas, so `townArt` draws `S.<name>` exactly as before (no townArt change). Tiles
  are hand-authored SVG in `tools/tile_svg/<name>.svg` (each a single `<svg>` sized base×SS where
  SS=4, ids prefixed by the tile name — `tools/validate_tiles.mjs` enforces this), packed by
  `tools/pack_tiles.mjs` → `svg2png.mjs`. The cutaway look lives in these tiles: light plaster
  walls (`wall`/`wall2`), salmon diamond bath floor (`floor_pink`), cream bedroom carpet
  (`floor_tile`), warm orange planks (`floor_wood`), plus the furniture (beds w/ white pillow +
  colored blanket, red/yellow chairs, toilet/sink, fridge, bookshelf, piano, bar/stool, board, …).
  If the atlas/manifest is missing (or headless), `loadSprites` → `{}` and townArt falls back to
  its **procedural** drawing.

High-DPI: Pixi `resolution = CONFIG.rendering.resolutionScale` (devicePixelRatio, capped 2) +
`autoDensity`; canvas backs the store at `cssPx*dpr`. **All art is original SVG** (no third-party
packs); the two atlases are the only image assets.

## Configuration & extending

- **`js/config.js` is the single source of tunable truth** — now also `CONFIG.world`
  (`gridWidth/Height`, `cellPixels`), `CONFIG.rendering` (`resolutionScale`, `chunkCells`,
  `chunkCacheMax`, `maxBakePx`), `CONFIG.camera` (`infinite`, `minZoom`, `maxZoom`, `zoomStep`, `easing`),
  `CONFIG.movement` (`pathfindingEnabled`, `subdivisions`, `walkSpeedPixelsPerFrame`,
  `maxAStarNodes`), `CONFIG.characters` (`useSpritesheets`, `fps`, `frameScale`), plus
  `conversation.maxGroupSize` and `ui` (`timelineVisible`/`memoryVisible`/`timelineMax`). `js/ui/ParamControls.js` mutates retrieval/
  reflection live for in-browser ablation; the engine re-reads `CONFIG` each tick. Caveat:
  `TimeManager` **caches** `minutesPerTick`, so the Minutes/tick slider also writes
  `sim.time.minutesPerTick` — keep that dual-write.
- **Add an agent/location**: append to `js/data/seedAgents.js` / `seedLocations.js` (exact
  field names: `homeLocationId`, `workLocationId`, `currentLocationId`; every referenced id
  must exist in `seedLocations.js` or init breaks), then **Reset** to rebuild. Location
  `type`/`tags` (`cafe`, `park`, `shop`, `library`, `square`, …) drive plan-block resolution.
  Each building location also carries a packed `x`/`y` and a `complex` id (grouped into one
  cutaway shell by the renderer) — both assigned by `node tools/pack_locations.mjs`; re-run it
  after adding/removing buildings so complexes stay contiguous. `Location` **must** keep copying
  `complex` through its constructor + `toJSON` (see the building-art note above).
  `pack_locations.mjs` now lays the town out as a **real community**: it skyline-packs the
  type-complexes into fixed `BW×BH` (=5×5) **city blocks**, tiles the blocks in a roughly-square
  grid with **1-cell paved streets** between them (continuous avenues both ways — emitted as real
  `street`-type cells, ids `loc_street_*`), and fills every unused block cell with a `green`/`plaza`
  courtyard (ids `loc_fill_*`). Both `loc_street_*`/`loc_fill_*` are stripped + regenerated each
  run (idempotent), so the town has **walkable streets** and **no bare-grass gaps**. `street` cells
  are tagged `["street","road","outdoor"]` with **no** park/square/cafe tag, so they are never a
  plan destination — residents just walk along them. New community building **types** each need: a
  `BLUEPRINTS` plan (or `BLUEPRINT_ALIAS`), a `furnish()` room `kind`, a `ROOF` colour, and tags for
  plan-block resolution; new **outdoor** types must be added to `OUTDOOR_TYPES`/`isOutdoorType` (so
  the complex grouper skips them) **and** `isOpenType` in `pathfinding.js` (so the movement grid
  keeps them open), then routed in both draw dispatches (`spritePark`/`spritePlaza`/`spriteGreen`/
  `paveStreet`+`streetFurniture`+`drawStreet`). New furniture **sprites** follow the
  usual pipeline: add to `SPRITES` in `pack_tiles.mjs`, author `tools/tile_svg/<name>.svg`
  (base×4, single root `<svg>`, ids prefixed), then `validate_tiles` → `pack_tiles --manifest` →
  `svg2png`.
- **Wire a real LLM**: there is no runtime/env switch — implement `LLMGenerationProvider` and
  change the `provider:` arg in `main.js` (where `new LocalGenerationProvider()` is passed to
  `new Simulation(...)`). Route the API through a backend proxy; never embed a key client-side.

## Art direction

The building art targets a **top-down RPG cutaway** look: apartment shells with the roof cut
away to reveal walled units — light-grey plaster walls (no colored roofs), salmon diamond-tile
baths, cream-carpet bedrooms, warm-orange wood-plank common rooms, detailed furniture, and a
red/yellow dining set per common room. Iterate with the verify loop: edit a tile SVG (or the
`townArt.js` placement) → `node tools/pack_tiles.mjs && node tools/svg2png.mjs` (rebuild the
atlas; tile-art changes only) → serve → `node tools/screenshot.mjs <url> <out.png> --eval <frame js>`
to capture the live town and eyeball it against the reference.

`ART_BIBLE.md` documents the older palette, sprite grid, and room layouts. Note it describes a
procedural generator/`tools/` workflow that is **not present in this deploy repo**, and it predates
the cutaway refactor — treat it as historical design intent, not runnable here.
