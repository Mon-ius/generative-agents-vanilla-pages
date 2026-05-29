# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A dependency-free, **static** browser simulation of *generative agents* (inspired by
Park et al., 2023). **24 residents** of "Willow Creek" — a **24×24, ~126-location**
multi-district town — observe, store/retrieve memories, plan their day, reflect, hold
**group conversations**, walk **A*-pathed routes**, and form relationships. Pure
ES-module JavaScript — **no build step, no bundler, no transpiler, no backend, no LLM
API keys**. The town is rendered with vendored PixiJS (WebGL) and an automatic canvas-2D
fallback, both **high-DPI**, **chunk-baked + viewport-culled**, with a shared
**draggable/zoomable Camera** and animated **CharacterFactory** avatars.

## Deploy snapshot + dev tooling

This directory is the published GitHub Pages copy, but it now carries a small **dev-only**
toolchain (not served, harmless on Pages):

- `package.json` — `{"type":"module"}` so Node can import the ES-module core; provides `npm run smoke` / `npm run check`.
- `test/smoke.node.mjs` — headless harness for the DOM-free core (world integrity, **determinism**, save/load, pathfinding, group-conversation invariants). 21 checks.
- `tools/check-all.mjs` — runs `node --check` over every `js/**/*.js` except `js/vendor`.
- Still **no** ESLint/Prettier/CI, and **no** `tools/gen_assets.mjs` (the town-tile PNGs in `assets/sprites/` are pre-baked; character art is procedural — see Rendering).

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
`__app.map.camera` exposes the pan/zoom Camera (`fit()`, `zoomIn/Out`, `toJSON/applyState`).

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
  full sim state under `CONFIG.storageKey` (`…:state:v1`) via `sim.save()/load()`; UI
  settings (speed/debug/seed) under `CONFIG.settingsKey` (`…:settings:v1`).
- **Two save paths**: localStorage (`sim.save()/sim.load()`) vs. file export/import
  (`sim.getState()` → JSON download; `sim.loadState(state)` ← imported file).

## Rendering (`js/ui/`)

`main.js setupMap()` tries **PixiMapView (WebGL)** first via dynamic `import()` (gated on
`requestAnimationFrame` + a WebGL probe), and falls back to **MapView (canvas-2D)**; it sets
`host.dataset.renderer` and logs which won. PixiJS v8 is vendored at `js/vendor/pixi.min.mjs`
(no CDN). Both renderers share geometry/art from **`js/ui/townArt.js`** and four shared
modules, so they stay in lockstep:

- **`townArt.js`** — `CELL = CONFIG.world.cellPixels` (176). `computeLayout(sim)` returns a
  **superset** `{cols,rows,W,H,CELL,rects, collisionGrid, chunkCells/chunkPx/chunkCols/chunkRows}`.
  `drawTownInto(g, layout, sprites, worldRect, opts)` draws only what intersects `worldRect`
  (so a chunk can be baked); `drawTown`/`makeTownCanvas` are thin full-rect wrappers.
- **`townChunks.js`** — the 24×24 world is too big for one texture (~8448px > WebGL limits), so
  it's **baked per chunk** (4×4 cells) **lazily and viewport-culled**. `makeChunkCanvas`,
  `visibleChunks`, `chunkDims`, `chunkWorldRect`, `chunkKey`. Pixi LRU-caches chunk textures
  (`CONFIG.rendering.chunkCacheMax`); off-screen chunks/agents are hidden.
- **`camera.js`** (`Camera`) — shared **drag-pan + wheel/pinch-zoom + inertia + fit + clamp**,
  `worldToScreen`/`screenToWorld`, `visibleWorldRect()` (the culling source), `toJSON/applyState`
  (persisted to `settings.camera`). Pixi applies it to the world container; canvas via
  `ctx.setTransform`. Each renderer's `defaultView()` opens centered on the selected agent at a
  game zoom (~7 cells); the **Fit** toolbar button / zoom-out shows the whole town.
- **`characters.js`** (`createCharacterFactory`) — **one avatar source for both renderers**:
  loads the spritesheet manifest (`assets/characters.json`) + sheets, runtime-slices
  4-direction walk frames, and **always** has an enhanced **procedural** fallback (varied
  skin/hair/outfit/body **deterministic from `agent.id`**, never the sim RNG). **12 original
  CC0 character spritesheets** (16×24, 4 dirs × 4 walk frames) ship in `assets/characters/`,
  generated by `tools/gen_characters.mjs` (zero-dep PNG encoder via `node:zlib`) — so avatars
  render as **animated sprites** by default and fall back to procedural only if assets are
  missing. Re-run `node tools/gen_characters.mjs` after editing `VARIANTS`.

High-DPI: Pixi `resolution = CONFIG.rendering.resolutionScale` (devicePixelRatio, capped 2) +
`autoDensity`; canvas backs the store at `cssPx*dpr`. Town terrain/furniture still come from the
Kenney CC0 tiles in `assets/manifest.json` (`assets.js` → `{}` headless, procedural fallback).

## Configuration & extending

- **`js/config.js` is the single source of tunable truth** — now also `CONFIG.world`
  (`gridWidth/Height`, `cellPixels`), `CONFIG.rendering` (`resolutionScale`, `chunkCells`,
  `chunkCacheMax`, `maxBakePx`), `CONFIG.camera` (`maxZoom`, `zoomStep`, `easing`),
  `CONFIG.movement` (`pathfindingEnabled`, `subdivisions`, `walkSpeedPixelsPerFrame`,
  `maxAStarNodes`), `CONFIG.characters` (`useSpritesheets`, `fps`, `frameScale`), plus
  `conversation.maxGroupSize` and `ui.timelineMax`. `js/ui/ParamControls.js` mutates retrieval/
  reflection live for in-browser ablation; the engine re-reads `CONFIG` each tick. Caveat:
  `TimeManager` **caches** `minutesPerTick`, so the Minutes/tick slider also writes
  `sim.time.minutesPerTick` — keep that dual-write.
- **Add an agent/location**: append to `js/data/seedAgents.js` / `seedLocations.js` (exact
  field names: `homeLocationId`, `workLocationId`, `currentLocationId`; every referenced id
  must exist in `seedLocations.js` or init breaks), then **Reset** to rebuild. Location
  `type`/`tags` (`cafe`, `park`, `shop`, `library`, `square`, …) drive plan-block resolution.
- **Wire a real LLM**: there is no runtime/env switch — implement `LLMGenerationProvider` and
  change the `provider:` arg in `main.js` (where `new LocalGenerationProvider()` is passed to
  `new Simulation(...)`). Route the API through a backend proxy; never embed a key client-side.

## Art direction

`ART_BIBLE.md` documents the palette, sprite grid, building-interior room layouts, and a QA
checklist. Note it describes a procedural generator/`tools/` workflow that is **not present in
this deploy repo** — treat it as design intent for the upstream source, not runnable here.
