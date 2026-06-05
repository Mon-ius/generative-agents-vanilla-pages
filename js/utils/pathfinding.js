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
// logical cell into `sub × sub` sub-tiles (default sub = 2, so a 24×24 town
// becomes a 48×48 movement grid). A finer grid lets agents path *around*
// building footprints and through door gaps instead of teleporting.
//
// Each location, by type, contributes to walkability exactly as townArt draws
// it — we recompute the SAME footprint geometry here from the location's x/y so
// the grid matches the picture without importing the renderer:
//
//   * Buildings (home/cafe/shop/library/school/health/civic/studio/anything
//     that is not a park or square): the footprint rectangle {bx,by,bw,bh} is
//     an obstacle (blocked), EXCEPT the single door sub-tile at the bottom-
//     centre `door` — that one stays walkable so an agent can reach the spot
//     `spotFor` places it on (just outside the door) and "enter".
//   * Parks and squares: their footprints stay fully walkable (open plots /
//     plazas you can stand anywhere inside).
//   * Street center lines: the row/column midlines that townArt paints as paths
//     are kept walkable. At the default sub = 2 a building footprint
//     (~0.86·CELL wide, centred) occupies exactly its own cell's 2×2 sub-tiles
//     and never reaches a neighbour, so the open grass/road between cells stays
//     connected for free — no special-casing needed. At finer subdivisions
//     (sub ≥ 3) a footprint could otherwise straddle a midline sub-tile, so we
//     explicitly keep the center stripe of each cell open to preserve the road
//     network.
//
// Anything outside a footprint is open grass — walkable. The result is a grid
// where corridors (streets + door approaches) connect all destinations, and
// building interiors are solid blocks with one walkable door cell.
//
// ---------------------------------------------------------------------------
// COST WEIGHTING (why agents follow the road)
// ---------------------------------------------------------------------------
// Every sub-tile also carries a *movement cost* (cost to step onto it), painted
// per logical cell from the location's type: streets are the cheap highway,
// building interiors are dear, parks/plazas/greens (and bare grass) sit between.
// A* sums these costs instead of counting steps, so the cheapest route from one
// building to another runs OUT to the nearest paved street, ALONG the avenues,
// then back in to the destination door — instead of drifting in a straight
// diagonal across grass and rooftops. The sim's routing grid leaves interiors
// unblocked (so packed apartment rooms stay reachable); the cost just makes
// walking through them expensive, which reads as "use the road" without ever
// trapping a destination.
//
// Determinism: A* uses a Manhattan heuristic, 4-neighbour movement, and breaks
// every tie by the linear cell index (gy*w + gx). No Math.random, no Date, no
// iteration over unordered structures — identical inputs yield identical paths.

// Mirror of the renderer's logical cell size; kept as a local default so this
// module never imports the DOM-touching townArt module. If a caller knows the
// real CELL (e.g. from computeLayout) it can pass it through `opts.cell`.
export const DEFAULT_CELL = 176;
export const DEFAULT_SUB = 2;
export const DEFAULT_MAX_ASTAR_NODES = 4000;

// Per-cell A* step cost (cost to ENTER a sub-tile of that type). Streets are the
// cheap highway; buildings are dear so routes don't cut through them; open ground
// (parks/plazas/greens/grass) sits between. Tunable via CONFIG.movement.*Cost.
export const DEFAULT_STREET_COST = 1;
export const DEFAULT_OPEN_COST = 4;
export const DEFAULT_BUILDING_COST = 12;

// SOLID buildings (default ON): the routing grid blocks each building's WHOLE
// logical cell, so agents can never walk through a wall — they route around the
// blocks on the street/grass network and stop at a door spot just outside. (The
// older weighted-only mode, where interiors stay walkable but expensive, is kept
// for `opts.solid === false`.) See computeDoorSpots for where agents actually stand.
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

// Build the same grid shape from a precomputed layout (layout.rects footprints
// + layout.cols/rows). computeLayout can call this and attach the result as
// layout.collisionGrid so renderers and the sim share an identical grid.
export function buildGrid(layout, opts = {}) {
  if (!layout) return emptyGrid(opts);
  // Prefer layout.rects (already-computed footprints) for an exact match;
  // fall back to deriving from locations if rects are absent.
  if (layout.rects && typeof layout.rects.forEach === "function") {
    const cell = num(opts.cell, num(layout.CELL, DEFAULT_CELL));
    const merged = { ...opts, cell };
    const o = resolveOpts(merged);
    const cols = num(layout.cols, deriveCols(rectLocs(layout.rects)));
    const rows = num(layout.rows, deriveRows(rectLocs(layout.rects)));
    return rasterize(rectsToFootprints(layout.rects), cols, rows, o);
  }
  return buildGridFromLocations(extractLocations(layout), { ...opts, cell: num(opts.cell, num(layout.CELL, DEFAULT_CELL)) });
}

function buildGridFromLocations(locations, opts) {
  const o = resolveOpts(opts);
  const cols = deriveCols(locations);
  const rows = deriveRows(locations);
  const footprints = locations.map((loc) => ({ type: loc.type, ...footprintFor(loc, o.cell) }));
  return rasterize(footprints, cols, rows, o);
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
// Door spots — where agents actually stand (THE single source of truth)
// ---------------------------------------------------------------------------
//
// With solid buildings, an agent can't stand inside a unit, so for every
// location we resolve a world-space "door spot" on the OPEN walkable network
// just outside the building, plus the outward direction (dx, dy) the renderer
// fans the crowd along. Both Simulation (route target) and townArt.spotFor
// (rendered standing position) consume this, so the picture and the cognition
// agree on one spot.
//
// Reachability rule (validated against the real town): block building cells, pad
// the town with one ring of open grass (the boundless exterior), and take the
// largest open component as the MAIN network. A building's door spot is:
//   * the cell just outside it on the MAIN network (preferring the south side,
//     to match the rendered south door), if it has one; else
//   * the door spot of the nearest sibling cell in its COMPLEX that does — so an
//     interior apartment's residents exit at their building's real front door.
// Every complex touches the main network, so every location resolves to a spot
// that A* can actually reach without ever crossing a wall.
//
// Outdoor plots (parks/plazas/greens/streets) are already open ground, so the
// spot is the plot centre. Fully deterministic: locations are processed in id
// order with fixed neighbour ordering and a largest-component (lowest-index) tie
// break — no RNG, no Date.
export function computeDoorSpots(locations, opts = {}) {
  const out = new Map();
  const locs = extractLocations(locations);
  if (!locs.length) return out;
  const o = resolveOpts(opts);
  const CELL = o.cell;
  const pad = Math.max(1, o.pad); // need >=1 ring so edge buildings reach the exterior

  let cols = 0, rows = 0;
  for (const l of locs) { if (l.x + 1 > cols) cols = l.x + 1; if (l.y + 1 > rows) rows = l.y + 1; }

  const at = new Map();
  for (const l of locs) at.set(l.x + "," + l.y, l);
  const X0 = -pad, Y0 = -pad, X1 = cols - 1 + pad, Y1 = rows - 1 + pad;
  const GW = X1 - X0 + 1, GH = Y1 - Y0 + 1;
  const cidx = (cx, cy) => (cy - Y0) * GW + (cx - X0);
  const inBounds = (cx, cy) => cx >= X0 && cy >= Y0 && cx <= X1 && cy <= Y1;
  const isBuildingCell = (cx, cy) => {
    if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return false; // exterior = grass
    const l = at.get(cx + "," + cy);
    return l ? !isOpenType(l.type) : false;                          // empty cell = grass
  };
  const openCell = (cx, cy) => inBounds(cx, cy) && !isBuildingCell(cx, cy);

  // 4-neighbour components of open cells; main = largest (holds the exterior ring).
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

  // Prefer the SOUTH door (matches the rendered south entry), then E, W, N.
  const DOOR_PREF = [[0, 1], [1, 0], [-1, 0], [0, -1]];
  const doorDir = (cx, cy) => {
    for (const [dx, dy] of DOOR_PREF) if (onMain(cx + dx, cy + dy)) return { dx, dy };
    return null;
  };
  const spotWorld = (bx, by, dx, dy) => {
    const bcx = bx * CELL + CELL / 2, bcy = by * CELL + CELL / 2;
    const OUT = 0.68; // cell-fraction from building centre out onto the street/grass
    return { x: bcx + dx * CELL * OUT, y: bcy + dy * CELL * OUT, dx, dy };
  };

  const buildings = locs.filter((l) => !isOpenType(l.type));
  const byComplex = new Map();
  for (const l of buildings) {
    const k = l.complex || ("solo_" + l.id);
    if (!byComplex.has(k)) byComplex.set(k, []);
    byComplex.get(k).push(l);
  }

  for (const l of buildings.slice().sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const direct = doorDir(l.x, l.y);
    if (direct) { out.set(l.id, spotWorld(l.x, l.y, direct.dx, direct.dy)); continue; }
    // Interior unit: BFS over its complex's cells to the nearest member with a door.
    const members = byComplex.get(l.complex || ("solo_" + l.id)) || [l];
    const memberSet = new Set(members.map((m) => m.x + "," + m.y));
    const seen = new Set([l.x + "," + l.y]);
    let frontier = [[l.x, l.y]];
    let chosen = null;
    while (frontier.length && !chosen) {
      frontier.sort((p, q) => (p[1] - q[1]) || (p[0] - q[0]));
      const next = [];
      for (const [mx, my] of frontier) {
        const d = doorDir(mx, my);
        if (d) { chosen = spotWorld(mx, my, d.dx, d.dy); break; }
        for (const [dx, dy] of NB) {
          const nx = mx + dx, ny = my + dy, kk = nx + "," + ny;
          if (memberSet.has(kk) && !seen.has(kk)) { seen.add(kk); next.push([nx, ny]); }
        }
      }
      frontier = next;
    }
    out.set(l.id, chosen || { x: l.x * CELL + CELL / 2, y: l.y * CELL + CELL / 2, dx: 0, dy: 1 });
  }

  // Outdoor plots: stand in the plot itself.
  for (const l of locs) {
    if (!isOpenType(l.type)) continue;
    out.set(l.id, { x: l.x * CELL + CELL / 2, y: l.y * CELL + CELL / 2, dx: 0, dy: 1 });
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
