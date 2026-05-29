# Willow Creek — Art Bible & Production Notes

Art direction, asset specification, and technical notes for the Willow Creek
generative-agents scene. This is the "single source of truth" for the look.

> **Art source (current).** The shipped sprites in `assets/sprites/` are sliced
> from **Kenney's CC0 packs** — *Roguelike Indoor* (furniture) + *Roguelike Modern
> City* (terrain/trees/walls) — by `tools/slice_city.mjs` (decode → magenta
> colorkey → crop named tiles). License: **CC0 / public domain** (see
> `assets/CREDITS.txt`); crediting Kenney.nl is appreciated, not required. This is
> real artist-made art, a step above the earlier procedural set.
>
> A code-generated procedural set still exists (`tools/gen_assets.mjs`) and is the
> automatic **fallback** when sprites can't load (or under headless Node tests).
> The renderer is fully asset-driven, so the art is swapped purely by replacing the
> PNGs — no engine changes. The original "Smallville" tileset (Cute RPG World) is a
> paid/licensed pack and is deliberately NOT used or redistributed.

## Style

- **Genre look:** top-down 2D pixel-art town with **cut-away building interiors**
  (you see the rooms from above), echoing the reference's clinic/dorm/lounge layout.
- **Theme:** cozy retro RPG world placed inside a dark "observatory" UI so the
  bright map is the focal point.
- **Readability first:** every room's function is legible at a glance from its
  floor type + furniture cluster.

## Palette

| Role | Hex |
|---|---|
| Grass / light / dark | `#6fae4b` / `#7cba56` / `#5b9a3e` |
| Dirt path | `#ddc89a` (edge `#c9ae79`) |
| Wood floor / plank seam | `#cba067` / `#b88d4f` |
| Clinic tile / grout | `#dad7cd` / `#c2bdaf` |
| Bathroom tile (pink) | `#e9c7cb` |
| Wall fill / divider / line | `#cfc2a6` / `#bdb094` / `#33271a` |
| Wood furniture / dark | `#9c6b3f` / `#7c5430` |
| Accent (UI/sun/selection) | `#f4b740` / `#ffd23f` |
| Fabric variants | blue `#6f93c2`, red `#c2655e`, green `#6fae66` |
| Chair variants | red `#cf5a4f`, yellow `#e7c13c`, green `#5aa05a`, wood |

UI chrome is a dark night palette (`--bg #0a0e18`, panels `#131a29`, ink `#e9edf6`,
amber accent) defined in `css/styles.css` as CSS custom properties.

## Grid, tile size & sprite scale

- **Base tile:** 16 px (terrain/floor/wall). Furniture objects are 12–32 px.
- **Cell:** 176 logical px per town cell; building footprint ≈ 0.86×0.74 of a cell.
- **Bake resolution:** the static world is rendered to a **2× offscreen canvas**
  (`makeTownCanvas`), then shown at logical size for crisp downscaled detail; Pixi
  uses it as a texture, the canvas fallback `drawImage`s it.
- **Camera:** scroll-wheel zoom (1×–3.5×) toward the cursor + drag-to-pan, clamped
  to the map — so the art reads at both gameplay zoom and close inspection.

## Material treatment

Every **object** sprite (not seamless tiles) gets layered passes in the generator:
`base color → bottom ambient-occlusion (contact darkening) → top-edge highlight →
fine grain (texture) → 1px dark outline`. Per-material specifics:

- **Wood** (floors, tables, shelves): horizontal plank seams + grain, warm tone, AO at base.
- **Clinic/bathroom tile:** grout grid lines, pale ceramic body; bathrooms use the pink tile.
- **Fabric** (beds, sofas, rugs): pillow/blanket bands, multiple colourways, soft shading.
- **Metal** (fridge, counters, stove, lamps): cool body, sharper top highlight, dark handles.
- **Ceramic** (toilet, sink): white body with a cool inner basin.
- **Foliage** (trees, plants, bushes): layered canopy blobs with highlight + cast shadow.
- **Grass/path:** hue-varied tiles with tufts, flowers, pebble speckle; tiles skip AO/highlight to stay seamless.

## Lighting

- **Day/night ambient:** a full-scene tint that interpolates over the simulated
  clock (warm dawn → clear noon → orange dusk → blue night), driven by
  `ambient(minutesIntoDay)` and applied as a tinted overlay on the world.
- **Contact shadows:** every placed object gets a soft ground ellipse for depth.

## Animation

- Character **idle bob** + **walk** interpolation between buildings.
- **Selection ring** pulse on the active agent.
- **Ambient** day/night transition.
- Floating **speech bubbles** showing `INITIALS: <activity emoji>` (and `💬` while talking).

## UI style

Dark app bar (tracked-uppercase title + live Day/time + status pill), a persistent
control toolbar (playback + speed/seed + save/load/clear/export/import/share), and a
tabbed rail (Agent · Memory · Timeline · Analysis · Tune). Speech bubbles are white
rounded pills with a tail and an amber selected state.

## Production asset list

`tools/gen_assets.mjs` → `assets/sprites/*.png` (37 sprites; `assets/manifest.json`):

- **Terrain (16):** `grass`, `grass2`, `path`, `flower`, `tree` (32×40), `bush` (20×16)
- **Surfaces (16):** `floor_wood`, `floor_tile`, `floor_pink`, `wall`
- **Furniture:** `bed` (+`bed_red`,`bed_green`), `table`, `chair` (+`chair_red`,`chair_yellow`,`chair_green`),
  `bookshelf`, `fridge`, `counter`, `stove`, `plant`, `piano`, `toilet`, `sink`, `desk`,
  `board`, `dresser`, `nightstand`, `sofa`, `lamp`, `tv`, `painting`, `rug` (+`rug_blue`,`rug_green`)

## Level design

Each building is split into a **2×2 of rooms** with interior wall dividers,
per-room floors, and a per-building randomized furniture set (`townArt.spriteRooms`
+ `furnish`). Room kinds per building type:

- **home:** bedroom · bath · kitchen · living
- **café:** counter · seating · seating · kitchen
- **shop:** shelves · shelves · counter · storage
- **library:** shelves · shelves · study · study
- **school:** board · desks · desks · study
- **clinic (health):** cot · cot · bath · storage
- **town hall (civic):** meeting · study · shelves · living
- **studio:** work · study · living · storage

Outdoor: a fenced **park** with a central tree + flower rows, a **plaza** with a
stone floor + fountain, scattered trees/bushes, flower beds, and a dirt-path grid.

## Collision & interaction data

- **Collision:** building footprints are solid; agents stand at each building's
  door spot and path between buildings (the simulation owns movement — this is an
  autonomous scene, not a free-roam player). The grid + door spots come from
  `computeLayout()` (`rects`, `spotFor`).
- **Interaction:** click any agent on the map (Pixi pointer hit-test) or a legend
  chip to select it; the rail then shows that agent's identity/plan/memory/relationships
  and the retrieval probe. Drag pans, wheel zooms (these don't trigger selection).

## Technical module map

```
js/main.js            app init, playback loop, asset load, camera/feature wiring
js/assets.js          sprite PNG loader (node-safe)
js/ui/townArt.js      tilemap composition + procedural fallback + day/night
js/ui/PixiMapView.js  WebGL renderer: scene graph, ticker, camera, animation
js/ui/MapView.js      canvas-2D fallback renderer
js/ui/Renderer.js     panels/legend/status; tabs in Tabs.js
js/ui/{Metrics,RetrievalProbe,NetworkView,ParamControls}.js
js/simulation/*       DOM-free engine (Simulation/Time/Environment/EventBus)
js/agents/*           Agent + MemoryStream/Planner/Reflector/Conversation/Relationships/GenerationProvider
tools/gen_assets.mjs  PNG sprite generator (dev only)
```

## Run locally

```bash
python3 -m http.server 8000   # then open http://localhost:8000/
node tools/gen_assets.mjs      # regenerate sprite PNGs after editing the generator
node test/smoke.node.mjs       # headless core test
node test/ui.shim.mjs          # headless UI test (canvas fallback path)
```

## QA checklist (against the production-quality bar)

- [x] No placeholder rectangles as final art — every object is a painted, layered sprite.
- [x] No raw Pixi-primitive look for content — Graphics used only for the day/night overlay + selection ring.
- [x] Floors are textured (plank/grout/grain), not flat fields; multiple terrain + furniture variants.
- [x] One consistent visual language across rooms (shared palette + generator + bake).
- [x] No empty rooms — every room is furnished; per-building randomization avoids repetition.
- [x] Readable clutter — furniture clipped to rooms; labels subtle.
- [x] Collision/door-spot data defined from the layout; correct y-sorted layering + contact shadows.
- [x] Polished UI/speech bubbles (rounded, tailed, accent-selected).
- [x] Camera (zoom/pan) for close inspection; responsive scaling.
- [x] Animated details: idle bob, walking, selection-ring pulse, day/night, floating bubbles.
- [ ] **AAA-grade hand-drawn art** — bounded by code-generated pixel art (see Upgrade path).

## Upgrade path (to close the final art gap)

1. **Drop-in art pack:** replace `assets/sprites/*.png` with a CC0 top-down RPG pack
   (e.g. Kenney) or commissioned art at the same names/sizes (`assets/manifest.json`);
   the renderer is fully asset-driven, so no code changes are needed.
2. **Bigger sprites:** raise the base tile to 32 px and re-export for finer detail.
3. **Real autotiling** (Wang/blob tiles) for grass/path/wall edges.
4. **Per-character sprite sheets** with directional walk frames (replace the drawn avatars).
