// pathfinding.js — deterministic grid A* for the town sim.
//
// Pure and DOM-free: every export here works under plain Node (no canvas, no
// `document`, no rendering imports), so the Simulation can build a collision
// grid and plan routes without depending on how the world is drawn.
//
// ---------------------------------------------------------------------------
// WALKABILITY MODEL
// ---------------------------------------------------------------------------
// The world is a coarse logical grid of locations on integer (x, y) cells, each
// CELL px wide (see ui/townArt.js `CELL`). For movement we subdivide every
// logical cell into `sub × sub` sub-tiles (default sub = 8, so each cell is an
// 8×8 block). A finer grid lets agents path *around* building footprints and
// through narrow door gaps instead of teleporting — and is the resolution the
// "mostly-wall, thin-doorway" model below needs.
//
// Each building cell is modelled as a WALLED unit with door/tunnel gaps — the
// SAME wall topology the renderer draws (townArt.spriteComplex), recomputed here
// from the locations' x/y + `complex` so the grid matches the picture without
// importing the renderer. At sub = 8 a logical cell is an 8×8 block of sub-tiles:
//
//   * Interior (the centre 6×6 sub-tiles): OPEN — an agent stands inside its
//     room (computeDoorSpots → the cell centre). Walking through is dear (the
//     building movement cost) so routes still prefer the road, but the room is
//     reachable so agents genuinely enter and move between rooms.
//   * Perimeter sub-tiles: WALLS (blocked) — an agent can never cross a wall —
//     EXCEPT a NARROW centred gap on an edge that townTopology classifies as:
//       - a DOOR (1): the unit's outer wall faces the reachable street/grass
//         network (the MAIN open component); the gap is the front door.
//       - a TUNNEL (2): the wall is shared with another unit of the SAME complex;
//         the gap is the internal doorway connecting the two rooms.
//     Edges facing anything else (a different complex, an enclosed pocket) stay
//     solid wall. The gap is just the central `gapIndices(sub)` = GAP_SUBTILES
//     sub-tiles of the edge (sub-tiles {3,4} at sub = 8 → a 44px doorway), so the
//     WALL covers ~75% of every edge and door/tunnel openings line up exactly
//     with the thin doorways townArt cuts in the walls (gapSpan() — same source).
//   * Parks / squares / plazas / greens / streets: fully OPEN plots (stand
//     anywhere); streets are the cheap highway that ties the town together.
//
// The result: building interiors are reachable rooms joined to their siblings by
// tunnels and to the street by one front door, while every other wall is solid —
// agents enter through the door, move room-to-room through the tunnels, and never
// clip through a wall.
//
// ---------------------------------------------------------------------------
// COST WEIGHTING (why agents follow the road)
// ---------------------------------------------------------------------------
// Every sub-tile also carries a *movement cost* (cost to step onto it), painted
// per logical cell from the location's type: streets are the cheap highway,
// building interiors are dear, parks/plazas/greens (and bare grass) sit between.
// A* sums these costs instead of counting steps, so the cheapest route from one
// building to another runs OUT through its door to the nearest paved street,
// ALONG the avenues, then back in through the destination's door — instead of
// drifting in a straight diagonal across grass and rooftops. Because interiors
// cost the most and a building's only openings are its own door + tunnels, A*
// never threads THROUGH a building as a shortcut, yet always reaches the room.
//
// Determinism: A* uses a Manhattan heuristic, 4-neighbour movement, and breaks
// every tie by the linear cell index (gy*w + gx). No Math.random, no Date, no
// iteration over unordered structures — identical inputs yield identical paths.

// Mirror of the renderer's logical cell size; kept as a local default so this
// module never imports the DOM-touching townArt module. If a caller knows the
// real CELL (e.g. from computeLayout) it can pass it through `opts.cell`.
export const DEFAULT_CELL = 176;
// sub = 8 so a building cell (8×8 sub-tiles) has a thin perimeter wall ring + a
// roomy interior (the centre 6×6), and a door/tunnel can be a NARROW centred gap
// (2 of 8 tiles) instead of half the wall — the resolution the "walls cover
// almost the whole edge, leave a limited doorway" model needs.
export const DEFAULT_SUB = 8;
// Finer grid (≈152×152) → longer routes that explore more nodes, so the bound is
// raised to keep cross-town A* from bailing before it reaches a far door.
export const DEFAULT_MAX_ASTAR_NODES = 60000;

// Per-cell A* step cost (cost to ENTER a sub-tile of that type). Streets are the
// cheap highway; buildings are dear so routes don't cut through them; open ground
// (parks/plazas/greens/grass) sits between. Tunable via CONFIG.movement.*Cost.
export const DEFAULT_STREET_COST = 1;
export const DEFAULT_OPEN_COST = 4;
export const DEFAULT_BUILDING_COST = 12;

// SOLID buildings (default ON): the routing grid walls each building cell's
// perimeter (so agents can never walk through a wall) but leaves the interior
// open with a centred gap on every DOOR edge (facing the street) and TUNNEL edge
// (shared with a sibling unit) — see rasterizeSolid + townTopology. Agents enter
// through the door, move room-to-room through the tunnels, and stand inside (the
// cell centre, computeDoorSpots). The older weighted-only mode, where interiors
// stay walkable but expensive and nothing is walled, is kept for `opts.solid === false`.
export const DEFAULT_SOLID = true;

// Open-grass border ring (in logical cells) padded around the town on every side.
// The world is boundless (infinite grass beyond the town edge), and that exterior
// ring is what connects corner/edge complexes + the street grid into ONE walkable
// network. Without it, solid buildings would wall off the four corner complexes.
// The grid stores this as a sub-tile origin offset (grid.ox/oy) so world<->grid
// mapping stays exact; A*/BFS just see a slightly larger open-framed grid.
export const DEFAULT_PAD = 1;

// Footprint geometry — IDENTICAL to ui/townArt.js computeLayout(). Keep these
// in lockstep so the collision grid matches what is drawn.
function footprintFor(loc, cell) {
  const cx = loc.x * cell + cell / 2;
  const cy = loc.y * cell + cell / 2;
  // In SOLID mode (the sim routing grid, opts.solid) rasterize blocks each
  // building's whole cell from cx/cy, so this rect is unused there; the bw/bh
  // here only feed the legacy footprint+door-carve path (render fallback).
  const bw = 0, bh = 0;
  const bx = Math.round(cx), by = Math.round(cy);
  return { cx, cy, bx, by, bw, bh, door: { x: cx, y: cy } };
}

function isOpenType(type) {
  return type === "park" || type === "square" || type === "plaza" || type === "green" ||
    type === "street" || type === "road";
}

// "Gardens" = the planted plots that get a FENCED perimeter with centred gate
// gaps. They KEEP isOpenType (open movement cost + open render); the walling is a
// dedicated, strictly-downstream pass. NOTE: green/plaza are the connective
// courtyard mesh and are deliberately NOT walled, and the BUILDING type "garden"
// is a building (not isOpenType). park|square only — the 12 shipped plots, each
// ringed by open courtyard so every one is reachable by construction.
export function isGardenType(type) {
  return type === "park" || type === "square";
}

// Movement cost for a cell of this type — see DEFAULT_*_COST above. Streets first
// (they are also "open"), then the open plots, then everything else = building.
function costForType(type, costs) {
  if (type === "street" || type === "road") return costs.street;
  if (isOpenType(type)) return costs.open; // park / square / plaza / green
  return costs.building;                   // any building footprint (or grass override below)
}

// Resolve movement options from a caller hint or the (optional) CONFIG.movement.
function resolveOpts(opts = {}) {
  const m = opts.movement || {};
  const cell = num(opts.cell, num(m.cell, DEFAULT_CELL));
  const sub = Math.max(1, Math.floor(num(opts.sub, num(m.subdivisions, DEFAULT_SUB))));
  const maxNodes = Math.max(1, Math.floor(num(opts.maxAStarNodes, num(m.maxAStarNodes, DEFAULT_MAX_ASTAR_NODES))));
  const street = Math.max(1, Math.floor(num(opts.streetCost, num(m.streetCost, DEFAULT_STREET_COST))));
  const open = Math.max(1, Math.floor(num(opts.openCost, num(m.openCost, DEFAULT_OPEN_COST))));
  const building = Math.max(1, Math.floor(num(opts.buildingCost, num(m.buildingCost, DEFAULT_BUILDING_COST))));
  // Unmapped sub-tiles (bare grass / outside the town) default to open-ground cost.
  const costs = { street, open, building, grass: open };
  const solidHint = opts.solid !== undefined ? opts.solid : m.solidBuildings;
  const solid = solidHint === undefined ? DEFAULT_SOLID : !!solidHint;
  const pad = Math.max(0, Math.floor(num(opts.pad, num(m.gridPad, DEFAULT_PAD))));
  return { cell, sub, maxNodes, costs, solid, pad };
}

function num(v, fallback) {
  return typeof v === "number" && isFinite(v) ? v : fallback;
}

// ---------------------------------------------------------------------------
// Grid construction
// ---------------------------------------------------------------------------

// Build a grid directly from an Environment (or any object exposing
// allLocations() / a `.locations` Map / an array of locations). Needs only the
// locations' x/y + CELL — no rendering — so the Simulation can own a grid.
//
//   -> { w, h, cell, sub, blocked: Uint8Array }
// where w = cols*sub, h = rows*sub, and blocked[gy*w+gx] is 1 for obstacles.
export function buildGridFromEnvironment(environment, opts = {}) {
  return buildGridFromLocations(extractLocations(environment), opts);
}

// Build the same grid shape from a precomputed layout (layout.rects carry each
// location, or fall back to deriving from locations). computeLayout calls this
// and attaches the result as layout.collisionGrid so renderers and the sim share
// an identical grid.
export function buildGrid(layout, opts = {}) {
  if (!layout) return emptyGrid(opts);
  const merged = { ...opts, cell: num(opts.cell, num(layout.CELL, DEFAULT_CELL)) };
  const o = resolveOpts(merged);
  // SOLID (default): the wall/door/tunnel rasterization needs real locations
  // (x/y/type/complex), which layout.rects carry on each `.loc`.
  if (o.solid) {
    const locs = layout.rects && typeof layout.rects.forEach === "function"
      ? rectLocs(layout.rects) : extractLocations(layout);
    return buildGridFromLocations(locs, merged);
  }
  // LEGACY weighted/footprint path (opts.solid === false): rasterize the drawn
  // footprint rectangles directly for an exact pixel match.
  if (layout.rects && typeof layout.rects.forEach === "function") {
    const cols = num(layout.cols, deriveCols(rectLocs(layout.rects)));
    const rows = num(layout.rows, deriveRows(rectLocs(layout.rects)));
    return rasterize(rectsToFootprints(layout.rects), cols, rows, o);
  }
  return buildGridFromLocations(extractLocations(layout), merged);
}

function buildGridFromLocations(locations, opts) {
  const o = resolveOpts(opts);
  const locs = extractLocations(locations);
  // SOLID (default): walled units with door + tunnel gaps (the real sim grid).
  if (o.solid) {
    const topo = townTopology(locs, o);
    return rasterizeSolid(locs, topo, o);
  }
  // LEGACY weighted-only fallback.
  const cols = deriveCols(locs);
  const rows = deriveRows(locs);
  const footprints = locs.map((loc) => ({ type: loc.type, ...footprintFor(loc, o.cell) }));
  return rasterize(footprints, cols, rows, o);
}

// ---------------------------------------------------------------------------
// Town wall topology — the SINGLE source of truth for where walls / doors /
// tunnels sit, shared by the routing rasterizer (rasterizeSolid) and the
// renderer (townArt via computeWallTopology). Fully deterministic.
// ---------------------------------------------------------------------------
//
// Cell-level model:
//   * the town is padded by `pad` rings of open grass (the boundless exterior);
//   * the MAIN network is the largest 4-connected open component (it always
//     holds that exterior ring + the streets), so a "door" only ever faces a
//     cell an agent can actually reach;
//   * for each building cell, classify() labels its four edges {N,E,S,W}:
//       0 = WALL    (faces a different complex, an enclosed pocket, or a
//                    non-main open cell — stays solid)
//       1 = DOOR    (faces the MAIN network — the unit's front door; one per
//                    unit, preferring South then E, W, N to match the render)
//       2 = TUNNEL  (faces another unit of the SAME complex — an internal doorway)
function townTopology(locations, o) {
  const locs = extractLocations(locations);
  const CELL = o.cell;
  let cols = 0, rows = 0;
  for (const l of locs) { if (l.x + 1 > cols) cols = l.x + 1; if (l.y + 1 > rows) rows = l.y + 1; }
  const pad = Math.max(1, o.pad); // need >=1 grass ring so edge units reach the exterior

  const at = new Map();
  for (const l of locs) at.set(l.x + "," + l.y, l);
  const isBuildingCell = (cx, cy) => {
    if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return false; // exterior = grass
    const l = at.get(cx + "," + cy);
    return l ? !isOpenType(l.type) : false;                          // empty cell = grass
  };

  // Largest open component over the padded grid = the MAIN reachable network.
  const X0 = -pad, Y0 = -pad, X1 = cols - 1 + pad, Y1 = rows - 1 + pad;
  const GW = X1 - X0 + 1, GH = Y1 - Y0 + 1;
  const cidx = (cx, cy) => (cy - Y0) * GW + (cx - X0);
  const inBounds = (cx, cy) => cx >= X0 && cy >= Y0 && cx <= X1 && cy <= Y1;
  const openCell = (cx, cy) => inBounds(cx, cy) && !isBuildingCell(cx, cy);
  const NB = [[0, -1], [-1, 0], [1, 0], [0, 1]];
  const comp = new Int32Array(GW * GH).fill(-1);
  const sizes = [];
  let nc = 0;
  for (let cy = Y0; cy <= Y1; cy++) for (let cx = X0; cx <= X1; cx++) {
    if (!openCell(cx, cy) || comp[cidx(cx, cy)] !== -1) continue;
    let size = 0; const stack = [[cx, cy]]; comp[cidx(cx, cy)] = nc;
    while (stack.length) {
      const [ax, ay] = stack.pop(); size++;
      for (const [dx, dy] of NB) {
        const nx = ax + dx, ny = ay + dy;
        if (!openCell(nx, ny) || comp[cidx(nx, ny)] !== -1) continue;
        comp[cidx(nx, ny)] = nc; stack.push([nx, ny]);
      }
    }
    sizes[nc] = size; nc++;
  }
  let main = 0; for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[main]) main = i;
  const onMain = (cx, cy) => openCell(cx, cy) && comp[cidx(cx, cy)] === main;

  const byComplex = new Map();
  for (const l of locs) {
    if (isOpenType(l.type)) continue;
    const k = l.complex || ("solo_" + l.id);
    if (!byComplex.has(k)) byComplex.set(k, []);
    byComplex.get(k).push(l);
  }

  // South-first door preference matches the rendered south entry decks.
  const DIRS = [["N", 0, -1], ["E", 1, 0], ["S", 0, 1], ["W", -1, 0]];
  const DOOR_PREF = ["S", "E", "W", "N"];
  const classify = (l) => {
    const members = byComplex.get(l.complex || ("solo_" + l.id)) || [l];
    const mset = new Set(members.map((m) => m.x + "," + m.y));
    const cl = { N: 0, E: 0, S: 0, W: 0 };
    const mainDirs = [];
    for (const [d, dx, dy] of DIRS) {
      const nx = l.x + dx, ny = l.y + dy;
      if (mset.has(nx + "," + ny)) cl[d] = 2;          // same-complex sibling -> tunnel
      else if (onMain(nx, ny)) mainDirs.push(d);       // faces the reachable street -> door candidate
    }
    if (mainDirs.length) { const pick = DOOR_PREF.find((d) => mainDirs.includes(d)); cl[pick] = 1; }
    return cl;
  };

  // Garden-walling topology ("narrow, don't close"). Per garden cell, classify its
  // four edges on the PRE-walling open grid:
  //   2 OPEN  — neighbour is a SAME-complex garden cell (interiors merge; no fence)
  //   1 GATE  — neighbour had an open passage pre-walling: an open cell (street /
  //             green / plaza / another garden / exterior pad) OR a BUILDING whose
  //             classify()-assigned DOOR faces this shared edge (centred gap aligns
  //             with the door — both from gapSpan, so they overlap exactly)
  //   0 FENCE — neighbour is a building WALL (no door here) or non-reachable
  // STRICTLY DOWNSTREAM of onMain/classify: gardens stay isOpenType (open cells in
  // the flood-fill), so building doors are UNCHANGED and connectivity is preserved
  // by construction. Must run AFTER classify — never feed back into onMain/classify.
  const OPP = { N: "S", S: "N", E: "W", W: "E" };
  const gardenKey = (l) => l.complex || ("solo_" + l.id);
  const gardenEdges = (l) => {
    const ge = { N: 0, E: 0, S: 0, W: 0 };
    const myKey = gardenKey(l);
    for (const [d, dx, dy] of DIRS) {
      const nx = l.x + dx, ny = l.y + dy;
      const nl = at.get(nx + "," + ny);
      if (nl && isGardenType(nl.type) && gardenKey(nl) === myKey) { ge[d] = 2; continue; }
      if (openCell(nx, ny)) { ge[d] = 1; continue; }
      if (nl && isBuildingCell(nx, ny) && classify(nl)[OPP[d]] === 1) { ge[d] = 1; continue; }
      ge[d] = 0;
    }
    return ge;
  };

  return { cols, rows, cell: CELL, pad, at, isBuildingCell, onMain, classify, byComplex, gardenEdges };
}

// Door/tunnel opening width, in sub-tiles. Kept NARROW — a real doorway, not
// half the wall — so a building's walls cover almost the whole edge. At sub = 8
// a 2-tile gap is a 44px doorway through the 176px wall (≈25% open / 75% wall).
export const GAP_SUBTILES = 2;

// Centre sub-tile indices of an edge that form a door/tunnel GAP: a NARROW,
// centred opening of GAP_SUBTILES tiles (the rest of the edge stays solid wall).
// Clamped to leave ≥1 wall tile at each end. sub=8 -> {3,4} (px 66–110, a 44px
// doorway); sub=4 -> {1,2}; sub<3 -> {} (no interior, so the cell is fully walled).
function gapIndices(sub) {
  const g = new Set();
  const width = Math.min(GAP_SUBTILES, sub - 2); // keep at least one wall tile each end
  if (width < 1) return g;
  const start = Math.floor((sub - width) / 2);   // centre the opening on the edge
  for (let i = 0; i < width; i++) g.add(start + i);
  return g;
}

// Fraction span [lo, hi] (0..1) of the centred door/tunnel gap along an edge —
// exactly the opening rasterizeSolid punches. Exported so the renderer (townArt
// wallEdge) cuts its doorway at the IDENTICAL cell-fractions and the picture stays
// in lockstep with the routing grid. Returns null when sub < 3 (no gap modelled).
export function gapSpan(sub) {
  const idx = [...gapIndices(Math.max(1, Math.floor(sub)))];
  if (!idx.length) return null;
  let lo = idx[0], hi = idx[0];
  for (const i of idx) { if (i < lo) lo = i; if (i > hi) hi = i; }
  return { lo: lo / sub, hi: (hi + 1) / sub };
}

// Garden perimeter sub-tile openness for a gardenEdges code (idx = the sub-tile
// index along the edge, gap = gapIndices(sub)):
//   2 open  -> whole edge open (same-complex sibling seam)
//   1 gate  -> only the centred gapIndices sub-tiles (IDENTICAL to a building door)
//   0 fence -> solid.
function gardenEdgeOpen(code, idx, gap) {
  if (code === 2) return true;
  if (code === 1) return gap.has(idx);
  return false;
}

// Rasterize the SOLID wall/door/tunnel grid (the real sim routing grid). Each
// building cell becomes a sub×sub block: a blocked perimeter ring with centred
// gaps on its door/tunnel edges, and an OPEN interior; outdoor plots stay fully
// open. Movement cost is painted per whole cell by type (streets cheap, buildings
// dear) so routes prefer the road even though interiors are reachable. Framed by
// `pad` grass cells, stored as the sub-tile origin offset (ox/oy) like rasterize.
function rasterizeSolid(locations, topo, o) {
  const locs = extractLocations(locations);
  const { cell, sub, maxNodes, costs, pad } = o;
  const cols = topo.cols, rows = topo.rows;
  const ox = pad * sub, oy = pad * sub;
  const w = Math.max(1, (cols + 2 * pad) * sub);
  const h = Math.max(1, (rows + 2 * pad) * sub);
  const blocked = new Uint8Array(w * h);
  const cost = new Uint16Array(w * h).fill(costs.grass);
  const gap = gapIndices(sub);
  const wallModel = sub >= 3 && gap.size > 0; // need an interior ring to model walls

  // Deterministic build order (result is order-independent; cheap to guarantee).
  const sorted = locs.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
  for (const l of sorted) {
    const sx0 = l.x * sub + ox, sy0 = l.y * sub + oy;
    const c = costForType(l.type, costs);
    for (let j = 0; j < sub; j++) for (let i = 0; i < sub; i++) {
      const gx = sx0 + i, gy = sy0 + j;
      if (gx < w && gy < h) cost[gy * w + gx] = c;
    }
    const garden = isGardenType(l.type);
    // Streets/greens/plazas stay fully open; gardens (park|square) are walled below.
    if (isOpenType(l.type) && !garden) continue;

    const cl = garden ? topo.gardenEdges(l) : topo.classify(l);
    for (let j = 0; j < sub; j++) for (let i = 0; i < sub; i++) {
      const gx = sx0 + i, gy = sy0 + j;
      if (gx >= w || gy >= h) continue;
      let open;
      if (!wallModel) {
        // sub<3: no interior ring to model a gap. Buildings seal solid (Phase-1
        // behaviour); a sealed garden would be a disconnected pocket, so leave
        // gardens FULLY OPEN (matches today's isOpenType behaviour) — never let a
        // chokepoint garden flip to a solid block (both critics' sub<3 attack).
        open = garden;
      } else {
        const perim = i === 0 || i === sub - 1 || j === 0 || j === sub - 1;
        if (!perim) {
          open = true; // interior room / open lawn
        } else if (garden) {
          // Garden perimeter: fence runs (0) solid, gate runs (1) open only at the
          // centred gap, same-complex seams (2) fully open.
          open = false;
          if (j === 0)       open = open || gardenEdgeOpen(cl.N, i, gap);
          if (j === sub - 1) open = open || gardenEdgeOpen(cl.S, i, gap);
          if (i === 0)       open = open || gardenEdgeOpen(cl.W, j, gap);
          if (i === sub - 1) open = open || gardenEdgeOpen(cl.E, j, gap);
        } else {
          open = false;
          if (j === 0 && cl.N !== 0 && gap.has(i)) open = true;        // North door/tunnel gap
          if (j === sub - 1 && cl.S !== 0 && gap.has(i)) open = true;  // South
          if (i === 0 && cl.W !== 0 && gap.has(j)) open = true;        // West
          if (i === sub - 1 && cl.E !== 0 && gap.has(j)) open = true;  // East
        }
      }
      if (!open) blocked[gy * w + gx] = 1;
    }
  }

  return { w, h, cell, sub, maxNodes, blocked, cost, ox, oy, pad };
}

// Turn a list of {type, bx, by, bw, bh, door} footprints into a blocked grid
// plus a per-sub-tile movement-cost grid (see COST WEIGHTING above).
//
// The grid is framed by `pad` logical cells of open grass on every side (the
// boundless world's exterior). That padding is stored as the sub-tile origin
// offset (ox/oy): world px (x, y) maps to grid sub-tile (floor(x/subPx)+ox, …),
// so callers keep passing plain world coordinates and never see the offset.
function rasterize(footprints, cols, rows, o) {
  const { cell, sub, maxNodes, costs, solid, pad } = o;
  const ox = pad * sub, oy = pad * sub;                 // sub-tile origin offset
  const w = Math.max(1, (cols + 2 * pad) * sub);
  const h = Math.max(1, (rows + 2 * pad) * sub);
  const subPx = cell / sub;
  const blocked = new Uint8Array(w * h);
  // Default = open ground (the grass border inherits this); each location
  // overwrites its own cell below so the road network reads cheap.
  const cost = new Uint16Array(w * h).fill(costs.grass);

  // Sort footprints by location index for a deterministic build order
  // (the result is order-independent, but determinism is cheap to guarantee).
  const fps = footprints.slice().sort((a, b) => fpKey(a) - fpKey(b));

  for (const fp of fps) {
    // Paint the location's whole logical cell with its type's movement cost.
    // Keyed off the cell CENTRE so it works even when the footprint rect is
    // zero-size (the sim's routing grid leaves interiors unblocked but weighted).
    paintCellCost(cost, w, h, cols, rows, cell, sub, ox, oy, fp, costForType(fp.type, costs));

    if (isOpenType(fp.type)) continue; // parks/squares/streets stay walkable

    if (solid) {
      // SOLID: block the building's WHOLE logical cell (all sub × sub tiles).
      // No door is carved — agents stop OUTSIDE at a computeDoorSpots() spot, so
      // they never need an interior tile, and walls are genuinely impassable.
      const cellX = clamp(Math.floor(fp.cx / cell), 0, cols - 1);
      const cellY = clamp(Math.floor(fp.cy / cell), 0, rows - 1);
      const sx0 = cellX * sub + ox, sy0 = cellY * sub + oy;
      for (let sy = sy0; sy < sy0 + sub && sy < h; sy++) {
        for (let sx = sx0; sx < sx0 + sub && sx < w; sx++) blocked[sy * w + sx] = 1;
      }
      continue;
    }

    // LEGACY (solid === false): footprint rect is an obstacle with a door tile +
    // a carved channel down to the open road. Kept for the weighted-only mode.
    const gx0 = clamp(Math.floor(fp.bx / subPx) + ox, 0, w - 1);
    const gy0 = clamp(Math.floor(fp.by / subPx) + oy, 0, h - 1);
    const gx1 = clamp(Math.floor((fp.bx + fp.bw - 1) / subPx) + ox, 0, w - 1);
    const gy1 = clamp(Math.floor((fp.by + fp.bh - 1) / subPx) + oy, 0, h - 1);
    const doorGx = clamp(Math.floor(fp.door.x / subPx) + ox, 0, w - 1);
    const doorGy = clamp(Math.floor(fp.door.y / subPx) + oy, 0, h - 1);
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        if (gx === doorGx && gy === doorGy) continue;     // door stays walkable
        if (sub >= 3 && onStreetMidline(gx - ox, gy - oy, sub)) continue; // keep the road open
        blocked[gy * w + gx] = 1;
      }
    }
    blocked[doorGy * w + doorGx] = 0;
    if (gy1 + 1 <= h - 1) {
      for (let gy = doorGy; gy <= gy1 + 1; gy++) blocked[gy * w + doorGx] = 0;
    } else {
      for (let gy = doorGy; gy >= gy0 - 1 && gy >= 0; gy--) blocked[gy * w + doorGx] = 0;
    }
  }

  return { w, h, cell, sub, maxNodes, blocked, cost, ox, oy, pad };
}

// Fill every sub-tile of a footprint's logical cell with cost `c`. Keyed off the
// cell CENTRE (cx, cy) so it works for zero-size footprints (the routing grid),
// not just rectangles. Honours the grass-border offset (ox/oy); clamped, never
// overflows.
function paintCellCost(cost, w, h, cols, rows, cell, sub, ox, oy, fp, c) {
  const cellX = clamp(Math.floor(fp.cx / cell), 0, cols - 1);
  const cellY = clamp(Math.floor(fp.cy / cell), 0, rows - 1);
  const sx0 = cellX * sub + ox, sy0 = cellY * sub + oy;
  for (let sy = sy0; sy < sy0 + sub && sy < h; sy++) {
    for (let sx = sx0; sx < sx0 + sub && sx < w; sx++) {
      cost[sy * w + sx] = c;
    }
  }
}

// A sub-tile lies on a street stripe when its sub-index within the logical cell
// is the centre one (the column/row centre stripe townArt paints as a path).
// Only meaningful for sub >= 3, where a footprint can straddle the midline;
// for sub <= 2 a footprint is self-contained per cell and this is unused.
function onStreetMidline(gx, gy, sub) {
  const mid = Math.floor(sub / 2); // centre sub-index within a logical cell
  return gx % sub === mid || gy % sub === mid;
}

function emptyGrid(opts) {
  const o = resolveOpts(opts);
  return { w: 1, h: 1, cell: o.cell, sub: o.sub, maxNodes: o.maxNodes, blocked: new Uint8Array(1), cost: new Uint16Array(1).fill(1), ox: 0, oy: 0, pad: 0 };
}

// ---------------------------------------------------------------------------
// Coordinate helpers
// ---------------------------------------------------------------------------

// World px -> grid sub-tile (clamped into range). Adds the grass-border origin
// offset (grid.ox/oy) so the padded exterior maps correctly.
export function worldToGrid(grid, x, y) {
  const subPx = grid.cell / grid.sub;
  const ox = grid.ox || 0, oy = grid.oy || 0;
  const gx = clamp(Math.floor(x / subPx) + ox, 0, grid.w - 1);
  const gy = clamp(Math.floor(y / subPx) + oy, 0, grid.h - 1);
  return { gx, gy };
}

// Grid sub-tile -> world px at the sub-tile CENTER (inverse of worldToGrid,
// removing the grass-border origin offset).
export function gridToWorld(grid, gx, gy) {
  const subPx = grid.cell / grid.sub;
  const ox = grid.ox || 0, oy = grid.oy || 0;
  return { x: (gx - ox + 0.5) * subPx, y: (gy - oy + 0.5) * subPx };
}

// A small helper to get a sub-tile cell from a location (its door approach,
// which is the spot agents actually stand on — see townArt.spotFor).
export function cellForLocation(grid, loc) {
  if (!loc) return { gx: 0, gy: 0 };
  const fp = footprintFor(loc, grid.cell);
  return worldToGrid(grid, fp.door.x, fp.door.y);
}

// ---------------------------------------------------------------------------
// Stand spots — where agents actually stand (THE single source of truth)
// ---------------------------------------------------------------------------
//
// Buildings now have walkable interiors (rasterizeSolid), so an agent stands
// INSIDE its room: the spot is simply the cell CENTRE — an open interior sub-tile
// (the centre 6×6), reachable through the unit's door + the complex's tunnels.
// Outdoor plots stand in the plot centre likewise. dx/dy = 0 marks "no outward
// direction" so townArt.spotFor fans the crowd in a tight circle inside the room
// rather than out across a threshold. Both Simulation (route target) and
// townArt.spotFor consume this, so the picture and the cognition agree on one
// spot. Kept named computeDoorSpots for its many call sites. Fully deterministic.
export function computeDoorSpots(locations, opts = {}) {
  const out = new Map();
  const locs = extractLocations(locations);
  if (!locs.length) return out;
  const CELL = resolveOpts(opts).cell;
  for (const l of locs) {
    out.set(l.id, { x: l.x * CELL + CELL / 2, y: l.y * CELL + CELL / 2, dx: 0, dy: 0 });
  }
  return out;
}

// Wall topology for the RENDERER: locationCellKey "x,y" -> { N, E, S, W } with
// each edge in {0 wall, 1 door, 2 tunnel}. townArt cuts a centred gap in every
// door/tunnel edge so the drawn walls line up exactly with the walkable gaps the
// routing grid (rasterizeSolid) punches from the SAME townTopology — keeping the
// render and the pathing in lockstep. Only building cells appear in the map.
export function computeWallTopology(locations, opts = {}) {
  const out = new Map();
  const locs = extractLocations(locations);
  if (!locs.length) return out;
  const topo = townTopology(locs, resolveOpts(opts));
  for (const l of locs) {
    if (isOpenType(l.type)) continue;
    out.set(l.x + "," + l.y, topo.classify(l));
  }
  return out;
}

// Garden topology for the RENDERER: garden cellKey "x,y" -> { N, E, S, W } in
// {0 fence, 1 gate, 2 open seam} (townTopology.gardenEdges). The SAME source
// rasterizeSolid walls from, so the drawn fence/gate == the routed gate (no
// re-derivation in the renderer). Only park|square cells appear in the map.
export function computeGardenTopology(locations, opts = {}) {
  const out = new Map();
  const locs = extractLocations(locations);
  if (!locs.length) return out;
  const topo = townTopology(locs, resolveOpts(opts));
  for (const l of locs) {
    if (!isGardenType(l.type)) continue;
    out.set(l.x + "," + l.y, topo.gardenEdges(l));
  }
  return out;
}

// ---------------------------------------------------------------------------
// A*
// ---------------------------------------------------------------------------

// 4-connected A* with a Manhattan heuristic and deterministic tie-breaking.
//   start/goal: { gx, gy }
//   returns: [{ gx, gy }, ...] inclusive of both endpoints, or null when no
//            path exists or the search exceeds grid.maxAStarNodes nodes.
//
// If a start or goal cell is itself blocked, we snap it to the nearest open
// sub-tile (deterministically) so a destination tucked behind a wall still
// resolves to its door rather than failing outright.
export function aStar(grid, start, goal) {
  if (!grid || !grid.blocked) return null;
  const w = grid.w;
  const h = grid.h;
  const maxNodes = num(grid.maxNodes, DEFAULT_MAX_ASTAR_NODES);

  const s = snapToOpen(grid, start.gx, start.gy);
  const t = snapToOpen(grid, goal.gx, goal.gy);
  if (!s || !t) return null;

  const startIdx = s.gy * w + s.gx;
  const goalIdx = t.gy * w + t.gx;
  if (startIdx === goalIdx) return [{ gx: s.gx, gy: s.gy }];

  const size = w * h;
  const gScore = new Float64Array(size).fill(Infinity);
  const cameFrom = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);

  gScore[startIdx] = 0;
  const open = new MinHeap();
  open.push(startIdx, heuristic(s.gx, s.gy, t.gx, t.gy), startIdx);

  // Neighbour order is fixed (up, left, right, down) for determinism; the
  // heap's secondary key (cell index) finalises ties regardless.
  const DX = [0, -1, 1, 0];
  const DY = [-1, 0, 0, 1];

  let explored = 0;
  while (open.size > 0) {
    const current = open.pop();
    if (closed[current]) continue;
    closed[current] = 1;
    explored++;
    if (current === goalIdx) return reconstruct(cameFrom, current, w);
    if (explored > maxNodes) return null; // bounded: caller falls back to straight line

    const cx = current % w;
    const cy = (current - cx) / w;
    const baseG = gScore[current];

    for (let i = 0; i < 4; i++) {
      const nx = cx + DX[i];
      const ny = cy + DY[i];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nIdx = ny * w + nx;
      if (grid.blocked[nIdx]) continue;
      if (closed[nIdx]) continue;
      // Weighted step: cost to ENTER the neighbour (streets cheap, buildings dear).
      // Falls back to uniform cost for grids built before cost weighting existed.
      const stepCost = grid.cost ? grid.cost[nIdx] : 1;
      const tentative = baseG + stepCost;
      if (tentative < gScore[nIdx]) {
        gScore[nIdx] = tentative;
        cameFrom[nIdx] = current;
        const f = tentative + heuristic(nx, ny, t.gx, t.gy);
        open.push(nIdx, f, nIdx);
      }
    }
  }
  return null;
}

function heuristic(ax, ay, bx, by) {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

function reconstruct(cameFrom, current, w) {
  const path = [];
  let c = current;
  while (c !== -1) {
    const x = c % w;
    const y = (c - x) / w;
    path.push({ gx: x, gy: y });
    c = cameFrom[c];
  }
  path.reverse();
  return path;
}

// Snap a (possibly blocked) cell to the nearest open sub-tile via a
// deterministic breadth-first ring search (ties resolved by linear index).
function snapToOpen(grid, gx, gy) {
  const w = grid.w;
  const h = grid.h;
  gx = clamp(gx, 0, w - 1);
  gy = clamp(gy, 0, h - 1);
  if (!grid.blocked[gy * w + gx]) return { gx, gy };
  const maxR = w + h;
  for (let r = 1; r <= maxR; r++) {
    let best = -1;
    for (let dy = -r; dy <= r; dy++) {
      const ny = gy + dy;
      if (ny < 0 || ny >= h) continue;
      const dx = r - Math.abs(dy);
      for (const nx of dx === 0 ? [gx] : [gx - dx, gx + dx]) {
        if (nx < 0 || nx >= w) continue;
        const idx = ny * w + nx;
        if (!grid.blocked[idx] && (best === -1 || idx < best)) best = idx;
      }
    }
    if (best !== -1) {
      const bx = best % w;
      const by = (best - bx) / w;
      return { gx: bx, gy: by };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// World-space pathing
// ---------------------------------------------------------------------------

// Plan a route between two WORLD positions and return world waypoints at
// sub-tile centers, with collinear points removed so straight corridors yield
// only their corner waypoints. Endpoints are preserved exactly:
//   * the first waypoint is the real start position (fromWorld),
//   * the last waypoint is the real goal position (toWorld),
// so a caller can hand the array straight to a walk-tween without snapping.
//
//   -> [{ x, y }, ...]  (>= the two endpoints), or null if no path.
export function pathWorldPoints(grid, fromWorld, toWorld) {
  if (!grid) return null;
  const start = worldToGrid(grid, fromWorld.x, fromWorld.y);
  const goal = worldToGrid(grid, toWorld.x, toWorld.y);
  const cells = aStar(grid, start, goal);
  if (!cells) return null;

  const pts = cells.map((c) => gridToWorld(grid, c.gx, c.gy));
  // Replace the snapped grid-center endpoints with the true world endpoints.
  pts[0] = { x: fromWorld.x, y: fromWorld.y };
  pts[pts.length - 1] = { x: toWorld.x, y: toWorld.y };
  return simplifyCollinear(pts);
}

// Drop interior points that lie on the straight line between their neighbours.
function simplifyCollinear(points) {
  if (points.length <= 2) return points.slice();
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1];
    const b = points[i];
    const c = points[i + 1];
    // cross product of (b-a) x (c-a); zero => collinear, so skip b.
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(cross) > 1e-6) out.push(b);
  }
  out.push(points[points.length - 1]);
  return out;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractLocations(source) {
  if (!source) return [];
  if (typeof source.allLocations === "function") return source.allLocations();
  if (source.locations instanceof Map) return Array.from(source.locations.values());
  if (Array.isArray(source.locations)) return source.locations;
  if (Array.isArray(source)) return source;
  return [];
}

function rectLocs(rectsMap) {
  const out = [];
  rectsMap.forEach((r) => { if (r && r.loc) out.push(r.loc); });
  return out;
}

function rectsToFootprints(rectsMap) {
  const out = [];
  rectsMap.forEach((r) => {
    if (!r) return;
    out.push({
      type: r.loc ? r.loc.type : undefined,
      bx: r.bx, by: r.by, bw: r.bw, bh: r.bh,
      cx: r.cx, cy: r.cy,
      door: r.door || { x: r.cx, y: r.by + r.bh + 12 },
      _ix: r.loc ? r.loc.x : 0,
      _iy: r.loc ? r.loc.y : 0,
    });
  });
  return out;
}

function deriveCols(locs) {
  let max = -1;
  for (const l of locs) if (typeof l.x === "number" && l.x > max) max = l.x;
  return max + 1 > 0 ? max + 1 : 1;
}

function deriveRows(locs) {
  let max = -1;
  for (const l of locs) if (typeof l.y === "number" && l.y > max) max = l.y;
  return max + 1 > 0 ? max + 1 : 1;
}

// Deterministic sort key for a footprint (top-left corner, then index hint).
function fpKey(fp) {
  const by = typeof fp.by === "number" ? fp.by : 0;
  const bx = typeof fp.bx === "number" ? fp.bx : 0;
  return by * 100000 + bx;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Binary min-heap keyed on f-score with a deterministic tie-break.
// Entries are { idx, f, tie }; pops the lowest f, then the lowest tie key
// (the linear cell index gy*w+gx), so the search is fully deterministic and
// independent of insertion order.
// ---------------------------------------------------------------------------
class MinHeap {
  constructor() {
    this.items = []; // {idx, f, tie}
  }
  get size() {
    return this.items.length;
  }
  push(idx, f, tie) {
    const items = this.items;
    items.push({ idx, f, tie });
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (less(items[i], items[parent])) {
        swap(items, i, parent);
        i = parent;
      } else break;
    }
  }
  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      const n = items.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < n && less(items[l], items[smallest])) smallest = l;
        if (r < n && less(items[r], items[smallest])) smallest = r;
        if (smallest === i) break;
        swap(items, i, smallest);
        i = smallest;
      }
    }
    return top.idx;
  }
}

function less(a, b) {
  if (a.f !== b.f) return a.f < b.f;
  return a.tie < b.tie; // deterministic tie-break by linear cell index
}

function swap(arr, i, j) {
  const t = arr[i];
  arr[i] = arr[j];
  arr[j] = t;
}
