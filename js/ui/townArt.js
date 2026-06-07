// townArt.js — shared town geometry + detailed procedural pixel art.
//
// Renders the world as a top-down RPG town with CUT-AWAY building interiors
// (plank/tiled floors, walls with a door gap, and type-specific furniture), a
// fenced park, a plaza with a fountain, layered trees, flower beds, textured
// grass and dirt paths — all drawn procedurally (no external/licensed assets) to
// echo the original "Smallville" look. The static world is baked once into a 2×
// canvas (makeTownCanvas) used by both the PixiJS renderer (as a texture) and the
// canvas-2D fallback, so they share identical geometry and art.

import { seededRandom } from "../utils/random.js";
import { CONFIG } from "../config.js";
import { buildGrid, computeDoorSpots, computeWallTopology, gapSpan, pathWorldPoints } from "../utils/pathfinding.js";

// Logical px per grid cell, sourced from CONFIG so the world size is tunable in
// one place. A defensive fallback keeps headless/standalone use working even if
// the CONFIG.world block has not been merged yet.
export const CELL = (CONFIG.world && CONFIG.world.cellPixels) || 176;
export const TEXTURE_SCALE = 2; // bake the static world at 2× for crisp detail

// Atlas supersample factor. Tile/furniture sprites in the PNG atlas are authored
// ART_SS× their on-screen reference size so they carry rich gradient/texture/material
// detail and stay crisp when zoomed in. Ground/tree/wall tiles draw to a fixed box
// (drawImage scales them down automatically), so only the object `put()` helper —
// which draws furniture at the sprite's *native* size — divides by ART_SS to keep
// on-screen footprints identical. Keep in sync with SS in tools/pack_tiles.mjs.
const ART_SS = 4;

// Warm, cozy Stardew-style shingle-roof colours per building type (a few extra
// types covered; anything else falls back to a warm terracotta).
export const ROOF = {
  home: "#b5563f", cafe: "#c2703a", library: "#4f6f9c", school: "#b08a3a",
  shop: "#b0596a", civic: "#3f7d7a", health: "#b04a4a", clinic: "#b04a4a",
  studio: "#9c4f6a", gallery: "#8c5f9c", bakery: "#c98a4a", market: "#b0723a",
  bar: "#8a5238", office: "#5a6f8c", gym: "#4f8c7a", workshop: "#9c6b3f",
  garden: "#5a9a4a", dock: "#6a8ca0", park: "#4fa05a", square: "#9aa0ad",
  chapel: "#8c7a9c", theater: "#6a4a6a", bank: "#7a8a6a", salon: "#c2607a",
  florist: "#5aa06a", pharmacy: "#4f8c8c", museum: "#9c8a5a", post: "#9c5a4a",
  diner: "#c2703a", plaza: "#9aa0ad", green: "#5a9a4a", street: "#a9a298", road: "#a9a298",
};
export const ROOF_DEFAULT = "#b06a4a";

// Outdoor plots are NOT buildings: they never join an apartment complex shell and
// render as open ground (parks, paved plazas, leafy greens). Kept in one place so
// the complex grouper, the sprite path and the procedural fallback all agree.
const OUTDOOR_TYPES = new Set(["park", "square", "plaza", "green", "street", "road"]);
export function isOutdoorType(t) { return OUTDOOR_TYPES.has(t); }

// ---- palette ----------------------------------------------------------------
const C = {
  grass: "#6fae4b", grassCheck: "#77b552", grassDark: "#62a043", tuft: "#4f8c39",
  path: "#dcc79a", pathMid: "#e7d4a9", pathEdge: "#c9ae79", pathSpeck: "#ccb486",
  wallLine: "#33271a", wallBack: "#d9ccb1", wallSide: "#c8b994",
  floorWood: "#cba067", plank: "#b88d4f", floorTile: "#dad7cd", grout: "#c2bdaf",
  wood: "#9c6b3f", woodDark: "#7c5430",
  white: "#eef0f2", mattress: "#efe7d7", blanket: "#6c8fc0",
  stove: "#3c3a40", fridge: "#e7ebef",
  potA: "#a4673a", leaf: "#4f9a4e",
  fence: "#9c7a4c", fenceDark: "#7c5e36",
  stone: "#cfc6b2", stoneGrout: "#b6ac95", water: "#7fb6d8",
};
const BOOKS = ["#b4534b", "#4f7bb0", "#5aa05a", "#c79a3b", "#8a5fb0", "#cf7d3c"];
const PRODUCE = ["#e0673c", "#e7b73c", "#cf4f4f", "#6fae4b", "#b05fb0", "#e09a3c"];
const RUGS = ["#c2655e", "#5f86b3", "#6fae66", "#c79a3b"];
const FLOWERS = ["#e0673c", "#e7c13c", "#d24f6f", "#b05fd0", "#e8894a"];

// ---- geometry ---------------------------------------------------------------
export function computeLayout(sim) {
  const locs = sim.environment.allLocations();
  const cols = Math.max(0, ...locs.map((l) => l.x)) + 1;
  const rows = Math.max(0, ...locs.map((l) => l.y)) + 1;
  const W = cols * CELL;
  const H = rows * CELL;
  const rects = new Map();
  for (const l of locs) {
    const cx = l.x * CELL + CELL / 2;
    const cy = l.y * CELL + CELL / 2;
    // Footprint comes from the building TYPE's blueprint, so houses differ in size
    // (capped < 1 cell so neighbours never overlap on the packed grid).
    const foot = blueprintFor(l.type).foot || [0.86, 0.74];
    const bw = Math.round(CELL * Math.min(0.94, foot[0]));
    const bh = Math.round(CELL * Math.min(0.84, foot[1]));
    const bx = Math.round(cx - bw / 2);
    const by = Math.round(cy - bh / 2 - 8);
    rects.set(l.id, { loc: l, cx, cy, bx, by, bw, bh, door: { x: cx, y: by + bh + 12 } });
  }

  // Resident count per location (by homeLocationId) — drives how many beds the
  // bedroom furnisher draws (double-occupancy homes get two) and bed assignment.
  for (const a of (sim.agents || [])) {
    const rc = a && rects.get(a.homeLocationId);
    if (rc) rc.residents = (rc.residents || 0) + 1;
  }

  // Chunk dimensions, computed INLINE (do NOT import townChunks here — that would
  // create an import cycle, since townChunks imports this module). townChunks
  // re-derives the same values via chunkDims(layout) from these fields.
  const chunkCells = (CONFIG.rendering && CONFIG.rendering.chunkCells) || 4;
  const chunkPx = chunkCells * CELL;
  const chunkCols = Math.max(1, Math.ceil(cols / chunkCells));
  const chunkRows = Math.max(1, Math.ceil(rows / chunkCells));

  const layout = {
    cols, rows, W, H, CELL, rects,
    chunkCells, chunkPx, chunkCols, chunkRows,
  };

  // Collision grid for pathfinding — built AFTER rects so it matches the drawn
  // footprints exactly. buildGrid is DOM-free, so this stays headless-safe.
  // Built with CONFIG.movement (like doorSpots/wallTopology below) so it is
  // byte-identical to the sim's routing grid — the renderers re-route avatars
  // on it (routeFrom), so it MUST match what agents actually walk.
  layout.collisionGrid = buildGrid(layout, { movement: CONFIG.movement });
  layout.complexes = groupComplexes(layout);
  // Stand spots: where agents stand — now INSIDE their room (the cell centre).
  // THE single source of truth shared with the sim — see spotFor.
  layout.doorSpots = computeDoorSpots(locs, { cell: CELL, movement: CONFIG.movement });
  // Wall topology: per building cell, which edges are wall / door / tunnel. Drives
  // the doorway gaps spriteComplex/spriteBuilding cut so the drawn walls match the
  // routing grid's gaps exactly (render ↔ routing lockstep). See pathfinding.js.
  layout.wallTopology = computeWallTopology(locs, { cell: CELL, movement: CONFIG.movement });
  // Bed spots + per-resident bed assignment (sleeping avatars lie ON their bed).
  const beds = computeBedAssignments(layout, sim.agents || []);
  layout.bedSpots = beds.bedSpots;
  layout.bedAssign = beds.bedAssign;

  return layout;
}

// True while `agent` is in a sleep plan block AT home (the DAY_TEMPLATE sleep
// activities both contain "sleep"; "wind down"/"rest" deliberately do NOT lie the
// avatar down). The renderers swap the crowd fan-spot for the agent's assigned
// bed (layout.bedAssign) and lay the avatar down while this is true.
export function isSleeping(agent) {
  return !!(agent && typeof agent.currentActivity === "string" &&
    /sleep/i.test(agent.currentActivity) &&
    agent.currentLocationId === agent.homeLocationId);
}

// Drawn bed footprint (112×96 HORIZONTAL sprite / ART_SS) + the second bed's
// y offset. Beds lie SIDEWAYS — pillow on the LEFT, foot on the right — so a
// sleeping avatar, rotated 90° (head→left), reads unmistakably as lying flat
// rather than standing front-on. ONE source of truth shared by furnish (which
// draws the beds), bedPlacement below (which positions sleepers on them) and
// tools/audit_rooms.mjs (which asserts the drawn rects still match these dims).
export const BED = { w: 28, h: 24, dy: 28 };

// Bed `i`'s top-left within a furnish room rect (roomX/Y = the room origin,
// i.e. furnish's c.x/c.y) plus the avatar lie spot on it: the bed CENTRE. The
// avatar's lying pose centres its (rotated) body on this point, so the ~28px
// body fills the 28px-wide horizontal bed with the head on the left pillow.
// Two-resident homes stack their beds vertically (i·dy down the left wall, both
// pillows on the same wall). Consumed by BOTH furnish's put() calls and
// computeBedAssignments, so draw and lie-spot cannot drift.
export function bedPlacement(roomX, roomY, i) {
  const x = roomX + 2, y = roomY + 2 + i * BED.dy; // +2 = furnish fixture inset
  return { x, y, spot: { x: x + BED.w / 2, y: y + BED.h / 2 } };
}

// Where each occupied home's residents LIE when asleep (world-px feet-anchor
// points on their beds) and which resident sleeps in which bed. Mirrors the
// EXACT geometry chain the renderer draws rooms through — spriteComplex's
// per-edge unit insets (16 perimeter / 8 shared) or spriteBuilding's sub-cell
// interior, then drawRooms' track layout (wall = 3 → room origin +1.5) — and
// places beds via the SHARED bedPlacement helper above (the part furnish also
// uses), so a sleeping avatar lies ON the drawn bed.
// Each entry also carries `via`: TWO points straddling the DRAWN doorway
// between the bedroom and the room holding the crowd-fan spot (mirrors
// drawRooms' doorway scan — first shared wall segment per room pair, 15px gap
// at the segment midpoint), ordered [fan-side, bed-side] and offset ±5px along
// the wall's normal so the crossing leg is PERPENDICULAR to the wall. The
// renderers hop fan-spot → via[0] → via[1] → bed (reversed when getting up) so
// the nightly walk passes through the doorway instead of ghosting through the
// art-only interior wall (those walls are not in the collision grid — a single
// on-the-wall via point is NOT enough: a shallow diagonal approach spends a
// long x-range inside the 3px wall band and clips it just outside the gap).
// via is null when the fan spot already sits in the bedroom (straight hop ok).
// Residents take beds in sorted-id order (deterministic, visitor-independent);
// a 3rd+ resident gets no bed and falls back to the crowd fan.
function computeBedAssignments(layout, agents) {
  const byHome = new Map();
  for (const a of agents) {
    if (!a || !a.homeLocationId) continue;
    if (!byHome.has(a.homeLocationId)) byHome.set(a.homeLocationId, []);
    byHome.get(a.homeLocationId).push(a.id);
  }
  // multi-unit complex per member loc id (lone members take the spriteBuilding path)
  const complexOf = new Map();
  for (const cx of layout.complexes) {
    if (cx.members.length > 1) for (const m of cx.members) complexOf.set(m.loc.id, cx);
  }
  const bedSpots = new Map();  // locId   -> [{x,y}, ...]
  const bedAssign = new Map(); // agentId -> {x, y, locId}
  for (const [locId, ids] of byHome) {
    const rc = layout.rects.get(locId);
    if (!rc) continue;
    // interior rect — the same branch the renderer takes for this building
    let ix, iy, iw, ih;
    const comp = complexOf.get(locId);
    if (comp) {
      const ux = rc.loc.x * CELL, uy = rc.loc.y * CELL;
      const cols = Math.round(comp.w / CELL), rows = Math.round(comp.h / CELL);
      const gx0 = Math.round(comp.x / CELL), gy0 = Math.round(comp.y / CELL);
      const cI = rc.loc.x - gx0, rI = rc.loc.y - gy0;
      const iL = cI === 0 ? 16 : 8, iT = rI === 0 ? 16 : 8;
      const iR = cI === cols - 1 ? 16 : 8, iB = rI === rows - 1 ? 16 : 8;
      ix = ux + iL; iy = uy + iT; iw = CELL - iL - iR; ih = CELL - iT - iB;
    } else {
      ix = rc.bx + 16; iy = rc.by + 16; iw = rc.bw - 32; ih = rc.bh - 30;
    }
    // the bedroom's furnish rect, exactly as drawRooms lays it out
    const bp = blueprintFor(rc.loc.type);
    const cell = bp.cells.find((c) => c.kind === "bedroom" || c.kind === "ward") || bp.cells[0];
    const nc = bp.cols.length, nr = bp.rows.length;
    const colX = [ix]; for (let i = 0; i < nc; i++) colX.push(colX[i] + bp.cols[i] * iw); colX[nc] = ix + iw;
    const rowY = [iy]; for (let i = 0; i < nr; i++) rowY.push(rowY[i] + bp.rows[i] * ih); rowY[nr] = iy + ih;
    const rx = colX[cell.c] + 1.5, ry = rowY[cell.r] + 1.5;   // wall/2
    // doorway between the bedroom and the fan-spot room — drawRooms' scan, mirrored
    const occ = Array.from({ length: nr }, () => new Array(nc).fill(-1));
    bp.cells.forEach((cl, i2) => {
      for (let r = cl.r; r < cl.r + (cl.rspan || 1) && r < nr; r++)
        for (let c2 = cl.c; c2 < cl.c + (cl.cspan || 1) && c2 < nc; c2++) occ[r][c2] = i2;
    });
    const bedIdx = bp.cells.indexOf(cell);
    const ds = layout.doorSpots && layout.doorSpots.get(locId);
    let fanIdx = bedIdx;
    if (ds) { // room track holding the fan/door spot (the cell centre)
      let fc = nc - 1; while (fc > 0 && ds.x < colX[fc]) fc--;
      let fr = nr - 1; while (fr > 0 && ds.y < rowY[fr]) fr--;
      fanIdx = occ[fr][fc];
    }
    let via = null;
    if (fanIdx >= 0 && fanIdx !== bedIdx) {
      const OFF = 5; // wall/2 (1.5) + clearance — each via point sits clear of the wall band
      // first shared wall segment per pair carries the doorway, columns then rows
      const doored = new Set();
      const pairKey = (a2, b2) => (a2 < b2 ? a2 + ":" + b2 : b2 + ":" + a2);
      const want = pairKey(bedIdx, fanIdx);
      for (let c2 = 1; c2 < nc && !via; c2++) for (let r = 0; r < nr; r++) {
        const a2 = occ[r][c2 - 1], b2 = occ[r][c2];   // a2 = LEFT room, b2 = RIGHT room
        if (a2 === b2) continue;
        const k = pairKey(a2, b2);
        if (doored.has(k)) continue;
        doored.add(k);
        if (k === want) {
          const m = (rowY[r] + rowY[r + 1]) / 2;
          const bedSide = { x: colX[c2] + (bedIdx === a2 ? -OFF : OFF), y: m };
          const fanSide = { x: colX[c2] + (bedIdx === a2 ? OFF : -OFF), y: m };
          via = [fanSide, bedSide];
          break;
        }
      }
      for (let r = 1; r < nr && !via; r++) for (let c2 = 0; c2 < nc; c2++) {
        const a2 = occ[r - 1][c2], b2 = occ[r][c2];   // a2 = room ABOVE, b2 = room BELOW
        if (a2 === b2) continue;
        const k = pairKey(a2, b2);
        if (doored.has(k)) continue;
        doored.add(k);
        if (k === want) {
          const m = (colX[c2] + colX[c2 + 1]) / 2;
          const bedSide = { x: m, y: rowY[r] + (bedIdx === a2 ? -OFF : OFF) };
          const fanSide = { x: m, y: rowY[r] + (bedIdx === a2 ? OFF : -OFF) };
          via = [fanSide, bedSide];
          break;
        }
      }
    }
    const sorted = ids.slice().sort();
    const spots = [];
    for (let i = 0; i < Math.min(2, sorted.length); i++) {
      spots.push(bedPlacement(rx, ry, i).spot);
    }
    bedSpots.set(locId, spots);
    sorted.forEach((id, i) => {
      if (i < spots.length) bedAssign.set(id, { x: spots[i].x, y: spots[i].y, locId, via });
    });
  }
  return { bedSpots, bedAssign };
}

// Wall-legal route between two WORLD points on the layout's collision grid —
// the SAME grid the sim routes agents on (both built from CONFIG.movement).
// The renderers use this when a location change arrives while an avatar is
// still mid-walk: the new sim path starts at the OLD location's room centre,
// so walking straight from the avatar's current position to that first
// waypoint would cut through walls (~70% of all movements at 1× speed).
// Re-planning from the avatar's actual position keeps every rendered step on
// open tiles — through doors, never through walls. Returns [{x,y}, ...] or
// null (caller falls back). Deterministic; never touches the sim RNG.
export function routeFrom(layout, from, to) {
  if (!layout || !layout.collisionGrid || !from || !to) return null;
  return pathWorldPoints(layout.collisionGrid, from, to);
}

// Place agent `index` of `count` standing at a location's door spot — the world
// point just OUTSIDE the building on the walkable network (shared with the sim
// via layout.doorSpots, so the route's end and the rendered crowd coincide). For
// small crowds we fan out along a single arc facing AWAY from the building (the
// door spot's outward direction); larger crowds stack concentric rings so 20+
// agents never pile onto one pixel. Deterministic: depends only on (index, count).
export function spotFor(layout, locId, index, count) {
  const ds = layout.doorSpots && layout.doorSpots.get(locId);
  const r = layout.rects.get(locId);
  // Anchor + outward direction: prefer the shared door spot, fall back to the
  // rendered door (outward = straight down) for anything without one.
  const cx = ds ? ds.x : (r ? r.door.x : layout.W / 2);
  const cy = ds ? ds.y : (r ? r.door.y : layout.H / 2);
  if (count <= 1) return { x: cx, y: cy };

  const odx = ds ? ds.dx : 0, ody = ds ? ds.dy : 0;
  // Interior spot (dx/dy = 0): agents stand INSIDE the room, so cluster them in a
  // tight FULL circle within the open interior (the centre 6×6 sub-tiles ≈ 132px,
  // so keep the radius < ~0.24·CELL to stay off the walls). A spot with an outward
  // direction instead fans a half-arc that way (kept for any directional caller).
  const interior = !odx && !ody;
  const minSpacing = 14;               // target arc spacing between neighbours (~sprite width)

  if (interior) {
    // Concentric FULL rings inside the room: ring 0 = the centre occupant, then
    // evenly-spaced rings out to ~0.22·CELL so the crowd never reaches the walls.
    const ringGap = 13, maxRadius = CELL * 0.22;
    const cap = (ringIdx) => ringIdx === 0 ? 1 : Math.max(4, Math.round(2 * Math.PI * ringIdx * ringGap / minSpacing));
    let i = index, ring = 0;
    while (i >= cap(ring)) { i -= cap(ring); ring += 1; }
    if (ring === 0) return { x: cx, y: cy };
    const radius = Math.min(maxRadius, ring * ringGap);
    const slots = cap(ring);
    const angle = (i / slots) * 2 * Math.PI;       // even, no endpoint overlap
    return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius * 0.7 };
  }

  // Directional spot: fan a half-arc outward (kept for any caller that supplies dx/dy).
  const outAngle = Math.atan2(ody, odx);
  const maxRadius = CELL * 0.42, ringGap = 15, baseRadius = 14;
  const fanHalfFor = (ringIdx) => Math.min(Math.PI * 0.85, 0.9 + ringIdx * 0.35);
  const ringCapacity = (ringIdx) => {
    const radius = baseRadius + ringIdx * ringGap;
    const arcLen = 2 * fanHalfFor(ringIdx) * radius;
    return Math.max(ringIdx === 0 ? 3 : 5, Math.round(arcLen / minSpacing) + 1);
  };
  let i = index, ring = 0, cap = ringCapacity(0);
  while (i >= cap) { i -= cap; ring += 1; cap = ringCapacity(ring); }
  const radius = Math.min(maxRadius, baseRadius + ring * ringGap);
  const slots = cap;
  const fanHalf = fanHalfFor(ring);
  const t = slots <= 1 ? 0.5 : i / (slots - 1);
  const angle = outAngle - fanHalf + t * (2 * fanHalf);
  return {
    x: cx + Math.cos(angle) * radius,
    y: cy + Math.sin(angle) * radius * 0.7, // slight vertical squash for top-down feel
  };
}

// Create the baked static-world canvas at TEXTURE_SCALE (caller draws agents on top).
export function makeTownCanvas(layout, sprites, scale = TEXTURE_SCALE) {
  const cv = document.createElement("canvas");
  cv.width = Math.round(layout.W * scale);
  cv.height = Math.round(layout.H * scale);
  const g = cv.getContext && cv.getContext("2d");
  if (g) {
    g.scale(scale, scale);
    drawTownInto(g, layout, sprites, { x: 0, y: 0, w: layout.W, h: layout.H });
  }
  return cv;
}

// ---- world ------------------------------------------------------------------
// Thin wrapper kept for existing callers / headless tests: draw the whole world.
export function drawTown(g, layout, sprites) {
  drawTownInto(g, layout, sprites, { x: 0, y: 0, w: layout.W, h: layout.H });
}

// Draw the static world (grass/paths/buildings/park/plaza) restricted to the
// logical-px sub-rectangle `worldRect = {x,y,w,h}`. Tile loops iterate only over
// the worldRect span and footprints are filtered to those whose (eave-expanded)
// bounds intersect worldRect, so a single chunk can be baked cheaply. Objects
// straddling a chunk seam are drawn in both adjacent chunks (the caller clips).
//
// opts.lightsOn (default false) gates the warm window-light pass on eaves.
export function drawTownInto(g, layout, sprites, worldRect, opts = {}) {
  const wr = worldRect || { x: 0, y: 0, w: layout.W, h: layout.H };
  const lightsOn = !!opts.lightsOn;

  // Sprite (tilemap) mode when the generated PNG assets are loaded; otherwise the
  // procedural fallback (also used headlessly in Node tests).
  if (sprites && Object.keys(sprites).length >= 6) {
    drawTownSprites(g, layout, sprites, wr, lightsOn);
    return;
  }
  const { W, H, rects } = layout;
  const rnd = seededRandom("willow-creek-art-v2");

  drawGrass(g, W, H, rnd, wr);
  // Paved streets (explicit 'street' cells) are the road network now — drawn as
  // ground here so building eaves / trees overhang them. (The old per-cell path
  // bands are gone; the packer emits real street cells between the city blocks.)
  for (const r of rects.values()) {
    if (r.loc.type !== "street" && r.loc.type !== "road") continue;
    const ux = r.loc.x * CELL, uy = r.loc.y * CELL;
    if (rectsIntersect(wr, ux, uy, CELL, CELL)) drawStreet(g, r);
  }

  // NO per-building edge trees/flower-beds: in the dense city-block layout they
  // overhung the roofless cutaway interiors. Greenery lives only in the park/green
  // courtyards (drawPark/drawPlaza) where it can't overlap a building.
  const MARGIN = 40; // eaves overhang allowance for the visibility filter

  // buildings / park / plaza, back-to-front for correct overlap (only those whose
  // eave-expanded footprint intersects this rect).
  const visible = [...rects.values()]
    .filter((r) => footprintNearRect(wr, r, MARGIN))
    .sort((a, b) => a.cy - b.cy);
  for (const r of visible) {
    const t = r.loc.type;
    if (t === "street" || t === "road") continue;           // already paved as ground above
    const rng = seededRandom("bld-" + r.loc.id);
    if (t === "park" || t === "green") drawPark(g, r, rng);
    else if (t === "square" || t === "plaza") drawPlaza(g, r, rng);
    else drawBuilding(g, r, rng, lightsOn);
  }
}

// ---- worldRect helpers ------------------------------------------------------
function rectsIntersect(wr, x, y, w, h) {
  return x < wr.x + wr.w && x + w > wr.x && y < wr.y + wr.h && y + h > wr.y;
}
// Does a building footprint (expanded by `margin` for eaves/trees) intersect wr?
function footprintNearRect(wr, r, margin) {
  return rectsIntersect(wr, r.bx - margin, r.by - margin, r.bw + margin * 2, r.bh + margin * 2);
}
// Tile-loop bounds clamped to a worldRect, snapped to the tile grid `t` and to
// [0, W/H]. Returns inclusive-exclusive [x0,x1) / [y0,y1) aligned to multiples of t.
function tileRange(start, span, max, t, wr, axis) {
  const lo = axis === "x" ? wr.x : wr.y;
  const hi = axis === "x" ? wr.x + wr.w : wr.y + wr.h;
  const a = Math.max(0, Math.floor(Math.max(0, lo) / t) * t);
  const b = Math.min(max, Math.ceil(Math.min(max, hi) / t) * t);
  return { a, b };
}

function drawGrass(g, W, H, rnd, wr) {
  const t = 24;
  // Base fill only over the visible rect.
  const fx = Math.max(0, wr.x), fy = Math.max(0, wr.y);
  const fw = Math.min(W, wr.x + wr.w) - fx, fh = Math.min(H, wr.y + wr.h) - fy;
  if (fw <= 0 || fh <= 0) return;
  g.fillStyle = C.grass;
  g.fillRect(fx, fy, fw, fh);
  const xr = tileRange(0, W, W, t, wr, "x");
  const yr = tileRange(0, H, H, t, wr, "y");
  for (let y = yr.a; y < yr.b; y += t) {
    for (let x = xr.a; x < xr.b; x += t) {
      if ((x / t + y / t) % 2 === 0) { g.fillStyle = C.grassCheck; g.fillRect(x, y, t, t); }
    }
  }
  // grass tufts + tiny flowers/pebbles — deterministic over the whole world,
  // drawn only where they land inside wr (keeps placement chunk-independent).
  for (let i = 0; i < W * H * 0.0016; i++) {
    const x = Math.floor(rnd() * W);
    const y = Math.floor(rnd() * H);
    const k = rnd();
    if (x < wr.x - 4 || x > wr.x + wr.w + 4 || y < wr.y - 4 || y > wr.y + wr.h + 4) continue;
    if (k < 0.7) {
      g.strokeStyle = C.tuft; g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, y); g.lineTo(x - 2, y - 3);
      g.moveTo(x, y); g.lineTo(x, y - 4);
      g.moveTo(x, y); g.lineTo(x + 2, y - 3);
      g.stroke();
    } else if (k < 0.85) {
      g.fillStyle = C.grassDark; g.fillRect(x, y, 2, 2);
    } else {
      g.fillStyle = FLOWERS[(x + y) % FLOWERS.length]; g.fillRect(x, y, 2, 2);
    }
  }
}

// ---- buildings (cut-away interiors) -----------------------------------------
function drawBuilding(g, r, rnd, lightsOn) {
  const roof = ROOF[r.loc.type] || ROOF_DEFAULT;
  const wt = 5; // wall thickness
  const ix = r.bx + wt, iy = r.by + wt + 4, iw = r.bw - wt * 2, ih = r.bh - wt * 2 - 4;

  // ground shadow
  g.fillStyle = "rgba(20,28,16,0.22)";
  g.fillRect(r.bx + 3, r.by + r.bh - 1, r.bw, 9);

  // floor
  const tiled = r.loc.type === "health";
  if (tiled) floorTile(g, ix, iy, iw, ih);
  else floorWood(g, ix, iy, iw, ih);

  // walls: back (top) thicker, sides + bottom thin, with a door gap
  g.fillStyle = C.wallBack; g.fillRect(r.bx, r.by + 4, r.bw, wt + 3);
  g.fillStyle = C.wallSide;
  g.fillRect(r.bx, r.by + 4, wt, r.bh - 4);              // left
  g.fillRect(r.bx + r.bw - wt, r.by + 4, wt, r.bh - 4);  // right
  const doorW = 16, doorX = r.cx - doorW / 2;
  g.fillRect(r.bx, r.by + r.bh - wt, doorX - r.bx, wt);                       // bottom-left
  g.fillRect(doorX + doorW, r.by + r.bh - wt, r.bx + r.bw - (doorX + doorW), wt); // bottom-right
  // doormat
  g.fillStyle = C.woodDark; g.fillRect(doorX, r.by + r.bh - 3, doorW, 3);

  // dark outline + cozy shingled roof eave on top
  g.strokeStyle = C.wallLine; g.lineWidth = 1.5;
  g.strokeRect(r.bx + 0.5, r.by + 4.5, r.bw - 1, r.bh - 4);
  shingleRoof(g, r, roof);

  composeInterior(g, r.loc.type, ix, iy, iw, ih, roof, rnd);

  // optional cheap, deterministic material polish: a soft AO gradient hugging
  // the south/east interior walls grounds the furniture without a per-pixel cost.
  interiorAO(g, ix, iy, iw, ih);
  // warm window-light wash on the eave, only when lightsOn (e.g. night bakes).
  if (lightsOn) eaveLight(g, r);

  // hanging wood shop-sign mounted over the wall band (rests on the interior top)
  nameSign(g, r.loc.name, r.cx, r.by + 9, Math.min(150, r.bw - 6));
}

function composeInterior(g, type, x, y, w, h, roof, rnd) {
  const cx = x + w / 2, cy = y + h / 2;
  switch (type) {
    case "home": {
      bed(g, x + 3, y + 3, 26, 18);
      // bathroom nook (tiled) bottom-right
      const bwd = 26, bht = 22;
      floorTile(g, x + w - bwd, y + h - bht, bwd, bht);
      g.strokeStyle = C.wallSide; g.lineWidth = 2; g.strokeRect(x + w - bwd, y + h - bht, bwd, bht);
      toilet(g, x + w - bwd + 4, y + h - bht + 5);
      sink(g, x + w - 12, y + h - bht + 5);
      rug(g, cx - 6, cy + 4, 26, 16, RUGS[1]);
      table(g, cx + 6, cy - 2, 1);
      plant(g, x + 4, y + h - 14);
      break;
    }
    case "cafe": {
      counter(g, x + 4, y + 3, w - 30, 9, roof);
      for (let i = 0; i < 4; i++) stool(g, x + 10 + i * 16, y + 16);
      table(g, x + 22, y + h - 18, 1);
      table(g, x + w - 26, y + h - 18, 1);
      plant(g, x + w - 12, y + 4);
      shelfBooks(g, x + w - 12, y + 16, 9, 24, rnd); // pantry shelf
      break;
    }
    case "shop": {
      produce(g, x + 4, y + 4, w - 10, 14, rnd);
      produce(g, x + 4, y + h - 28, w - 34, 14, rnd);
      counter(g, x + w - 26, y + h - 24, 22, 18, roof);
      break;
    }
    case "library": {
      for (let i = 0; i < 3; i++) shelfBooks(g, x + 4 + i * 16, y + 4, 11, h - 30, rnd);
      table(g, x + w - 24, cy + 2, 1);
      rug(g, x + w - 24, cy + 2, 28, 18, RUGS[2]);
      break;
    }
    case "school": {
      board(g, x + 6, y + 2, w - 12);
      deskRows(g, x + 5, y + 14, w - 10, h - 18);
      break;
    }
    case "health": {
      cot(g, x + 4, y + 5);
      cot(g, x + 4, y + h - 20);
      appliance(g, x + w - 18, y + 6, 14, 20, C.fridge); // cabinet
      plant(g, x + w - 16, y + h - 14);
      break;
    }
    case "civic": {
      table(g, cx, cy, 2); // big meeting table
      shelfBooks(g, x + 4, y + 4, 11, h - 14, rnd);
      shelfBooks(g, x + w - 15, y + 4, 11, h - 14, rnd);
      break;
    }
    case "studio": {
      workbench(g, x + 4, y + 4, w - 30);
      easel(g, x + w - 20, cy);
      shelfBooks(g, x + w - 14, y + 4, 10, 18, rnd);
      rug(g, cx - 6, y + h - 14, 26, 12, RUGS[0]);
      break;
    }
    default: {
      table(g, cx, cy, 1);
      plant(g, x + 4, y + 4);
    }
  }
}

// ---- material polish (cheap, deterministic, subtle) -------------------------
// Soft ambient-occlusion gradient hugging the south and east interior walls so
// the cut-away room reads as a recessed box. Falls back to flat strokes if the
// canvas implementation lacks createLinearGradient (headless safety).
function interiorAO(g, x, y, w, h) {
  const depth = 7;
  if (typeof g.createLinearGradient === "function") {
    // south (bottom) wall
    let grS = g.createLinearGradient(0, y + h, 0, y + h - depth);
    grS.addColorStop(0, "rgba(20,16,10,0.20)");
    grS.addColorStop(1, "rgba(20,16,10,0)");
    g.fillStyle = grS; g.fillRect(x, y + h - depth, w, depth);
    // east (right) wall
    let grE = g.createLinearGradient(x + w, 0, x + w - depth, 0);
    grE.addColorStop(0, "rgba(20,16,10,0.16)");
    grE.addColorStop(1, "rgba(20,16,10,0)");
    g.fillStyle = grE; g.fillRect(x + w - depth, y, depth, h);
  } else {
    g.fillStyle = "rgba(20,16,10,0.10)";
    g.fillRect(x, y + h - 2, w, 2);
    g.fillRect(x + w - 2, y, 2, h);
  }
}

// Warm window-light wash on the building eave (only when lightsOn), evoking lit
// windows at dusk/night. Two small glows flanking the door line, kept subtle.
function eaveLight(g, r) {
  const glow = "rgba(255,214,140,0.35)";
  const xs = [r.bx + r.bw * 0.28, r.bx + r.bw * 0.72];
  for (const cx of xs) {
    if (typeof g.createRadialGradient === "function") {
      const gr = g.createRadialGradient(cx, r.by + 5, 0, cx, r.by + 5, 9);
      gr.addColorStop(0, glow);
      gr.addColorStop(1, "rgba(255,214,140,0)");
      g.fillStyle = gr;
      g.fillRect(cx - 9, r.by - 2, 18, 12);
    } else {
      g.fillStyle = glow;
      g.fillRect(cx - 2, r.by + 2, 4, 3);
    }
  }
}

// A cozy shingled roof eave capping the top of a building (Stardew-style cottage).
// Drawn as 3 offset rows of shingle tabs in the building's roof colour, with a
// ridge highlight, per-row shadow lines and a dark outline. Sits mostly above the
// footprint (a small overhang) so the cut-away interior stays visible below.
export function shingleRoof(g, r, roof) {
  const ov = 4, x0 = r.bx - ov, w = r.bw + ov * 2;
  const band = 13, top = r.by - 12;     // roof body; overhangs above the footprint
  const dark = shade(roof, -0.3), hi = shade(roof, 0.22);
  const tw = 8, tabH = 4, base = top + band; // base = where the hanging tabs start

  // roof body (3 offset shingle rows for a tiled look)
  g.fillStyle = roof; g.fillRect(x0, top, w, band);
  const rows = 3, sh = band / rows;
  for (let i = 0; i < rows; i++) {
    const ry = top + i * sh;
    g.fillStyle = i % 2 ? shade(roof, -0.06) : shade(roof, 0.07);
    g.fillRect(x0, ry, w, sh);
    g.fillStyle = dark;
    const off = (i % 2) * (tw / 2);
    for (let sx = x0 + off; sx < x0 + w; sx += tw) g.fillRect(Math.round(sx), Math.round(ry + 1), 1, Math.max(1, sh - 1));
    g.fillStyle = "rgba(0,0,0,0.13)"; g.fillRect(x0, ry + sh - 1, w, 1);
  }

  // scalloped hanging shingle tabs along the bottom edge — the unmistakable shingle silhouette
  for (let sx = x0; sx < x0 + w; sx += tw) {
    g.fillStyle = roof;
    g.beginPath();
    g.moveTo(sx, base - 1);
    g.lineTo(sx + tw, base - 1);
    g.lineTo(sx + tw, base);
    g.arc(sx + tw / 2, base, tw / 2, 0, Math.PI);
    g.closePath();
    g.fill();
    g.fillStyle = "rgba(0,0,0,0.10)"; // soft underside shadow on each tab
    g.fillRect(sx + 1, base + tabH - 1.5, tw - 2, 1);
    g.fillStyle = dark; g.fillRect(Math.round(sx), base - 1, 1, tabH + 1); // tab seam
  }

  g.fillStyle = hi; g.fillRect(x0, top, w, 1.6); // ridge highlight
  // outline: top + sides of the body (the scalloped bottom is self-outlined by seams)
  g.strokeStyle = "#2f2a22"; g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x0 + 0.5, base); g.lineTo(x0 + 0.5, top + 0.5);
  g.lineTo(x0 + w - 0.5, top + 0.5); g.lineTo(x0 + w - 0.5, base);
  g.stroke();
}

// A flat light-grey wall cap across the top of a building/complex — the top-down
// cutaway look (no colored roof): the wall's top face seen from above, lit on the
// top edge with a crisp dark outline. Replaces the shingle roof in the sprite path.
export function wallCap(g, r) {
  const x = r.bx, w = r.bw, y = r.by, capH = 7;
  g.fillStyle = "#d6d0c4"; g.fillRect(x, y - capH, w, capH);   // wall top face
  g.fillStyle = "#efeae0"; g.fillRect(x, y - capH, w, 2);      // top-lit highlight
  g.fillStyle = "#b4ac9a"; g.fillRect(x, y - 2, w, 2);         // contact shadow into the interior
  g.strokeStyle = "#3a352e"; g.lineWidth = 1;
  g.strokeRect(x + 0.5, y - capH + 0.5, w - 1, capH);
}

// ---- furniture & fixtures ---------------------------------------------------
function floorWood(g, x, y, w, h) {
  g.fillStyle = C.floorWood; g.fillRect(x, y, w, h);
  g.strokeStyle = C.plank; g.lineWidth = 1;
  for (let yy = y + 6; yy < y + h; yy += 7) { g.beginPath(); g.moveTo(x, yy); g.lineTo(x + w, yy); g.stroke(); }
}
function floorTile(g, x, y, w, h) {
  g.fillStyle = C.floorTile; g.fillRect(x, y, w, h);
  g.strokeStyle = C.grout; g.lineWidth = 1;
  for (let xx = x + 8; xx < x + w; xx += 8) { g.beginPath(); g.moveTo(xx, y); g.lineTo(xx, y + h); g.stroke(); }
  for (let yy = y + 8; yy < y + h; yy += 8) { g.beginPath(); g.moveTo(x, yy); g.lineTo(x + w, yy); g.stroke(); }
}
function rug(g, cx, cy, w, h, color) {
  g.fillStyle = color; roundRect(g, cx - w / 2, cy - h / 2, w, h, 4); g.fill();
  g.strokeStyle = "rgba(255,255,255,0.5)"; g.lineWidth = 1; g.stroke();
}
function bed(g, x, y, w, h) {
  g.fillStyle = C.wood; g.fillRect(x, y, w, h);
  g.fillStyle = C.mattress; g.fillRect(x + 2, y + 2, w - 4, h - 4);
  g.fillStyle = C.white; g.fillRect(x + 3, y + 3, w - 6, 6);     // pillow
  g.fillStyle = C.blanket; g.fillRect(x + 3, y + h - 9, w - 6, 6); // blanket
}
function chair(g, x, y) { g.fillStyle = C.woodDark; g.fillRect(x, y, 6, 6); }
function table(g, cx, cy, size) {
  const w = size >= 2 ? 30 : 18, h = size >= 2 ? 20 : 14;
  chair(g, cx - w / 2 - 6, cy - 3); chair(g, cx + w / 2, cy - 3);
  chair(g, cx - 4, cy - h / 2 - 6); chair(g, cx - 4, cy + h / 2);
  g.fillStyle = C.wood; roundRect(g, cx - w / 2, cy - h / 2, w, h, 3); g.fill();
  g.fillStyle = shade(C.wood, 0.15); g.fillRect(cx - w / 2 + 2, cy - h / 2 + 2, w - 4, 3);
}
function stool(g, x, y) { g.fillStyle = C.woodDark; g.beginPath(); g.arc(x, y, 3.5, 0, Math.PI * 2); g.fill(); }
function shelfBooks(g, x, y, w, h, rnd) {
  g.fillStyle = C.woodDark; g.fillRect(x, y, w, h);
  for (let yy = y + 2; yy < y + h - 3; yy += 8) {
    let xx = x + 1;
    while (xx < x + w - 2) {
      const bw = 1 + Math.floor(rnd() * 2) + 1;
      g.fillStyle = BOOKS[Math.floor(rnd() * BOOKS.length)];
      g.fillRect(xx, yy, bw, 6);
      xx += bw + 1;
    }
    g.fillStyle = C.wood; g.fillRect(x, yy + 6, w, 1);
  }
}
function counter(g, x, y, w, h, color) {
  g.fillStyle = C.woodDark; g.fillRect(x, y, w, h);
  g.fillStyle = shade(color, 0.1); g.fillRect(x, y, w, 3);
}
function produce(g, x, y, w, h, rnd) {
  g.fillStyle = C.woodDark; g.fillRect(x, y, w, h);
  for (let xx = x + 3; xx < x + w - 3; xx += 6) {
    g.fillStyle = PRODUCE[Math.floor(rnd() * PRODUCE.length)];
    g.beginPath(); g.arc(xx, y + 4, 2.2, 0, Math.PI * 2); g.fill();
    g.fillStyle = PRODUCE[Math.floor(rnd() * PRODUCE.length)];
    g.beginPath(); g.arc(xx, y + h - 4, 2.2, 0, Math.PI * 2); g.fill();
  }
}
function deskRows(g, x, y, w, h) {
  for (let yy = y; yy < y + h - 8; yy += 14) {
    for (let xx = x; xx < x + w - 10; xx += 16) {
      g.fillStyle = C.wood; g.fillRect(xx, yy + 4, 11, 6);
      g.fillStyle = C.woodDark; g.fillRect(xx + 3, yy, 5, 4);
    }
  }
}
function board(g, x, y, w) { g.fillStyle = "#2f5e3a"; g.fillRect(x, y, w, 6); g.fillStyle = "#7c5430"; g.fillRect(x, y + 6, w, 1); }
function appliance(g, x, y, w, h, color) {
  g.fillStyle = color; g.fillRect(x, y, w, h);
  g.strokeStyle = "rgba(0,0,0,0.25)"; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  g.fillStyle = "rgba(0,0,0,0.2)"; g.fillRect(x + w - 4, y + 3, 2, 5);
}
function cot(g, x, y) { bed(g, x, y, 24, 15); }
function toilet(g, x, y) { g.fillStyle = C.white; roundRect(g, x, y, 8, 10, 3); g.fill(); g.strokeStyle = "#b9c0c6"; g.lineWidth = 1; g.stroke(); }
function sink(g, x, y) { g.fillStyle = C.white; g.fillRect(x, y, 8, 6); g.fillStyle = "#9fb6c4"; g.fillRect(x + 3, y + 1, 2, 2); }
function plant(g, x, y) {
  g.fillStyle = C.potA; g.fillRect(x, y + 6, 7, 6);
  g.fillStyle = C.leaf; g.beginPath(); g.arc(x + 3.5, y + 4, 5, 0, Math.PI * 2); g.fill();
  g.fillStyle = shade(C.leaf, 0.15); g.beginPath(); g.arc(x + 1.5, y + 3, 2.5, 0, Math.PI * 2); g.fill();
}
function workbench(g, x, y, w) {
  g.fillStyle = C.woodDark; g.fillRect(x, y, w, 12);
  g.fillStyle = "#9aa0ad"; g.fillRect(x + 3, y + 2, 5, 4); // tools
  g.fillStyle = "#cf7d3c"; g.fillRect(x + 11, y + 3, 6, 3);
}
function easel(g, x, y) {
  g.fillStyle = C.wood; g.fillRect(x, y - 8, 3, 18);
  g.fillStyle = C.white; g.fillRect(x - 6, y - 10, 12, 12);
  g.fillStyle = FLOWERS[1]; g.fillRect(x - 4, y - 7, 4, 4);
  g.fillStyle = RUGS[1]; g.fillRect(x + 1, y - 3, 4, 4);
}

// ---- park & plaza -----------------------------------------------------------
function drawPark(g, r, rnd) {
  // grassy plot
  g.fillStyle = shade(C.grass, 0.06); g.fillRect(r.bx, r.by, r.bw, r.bh);
  // wooden fence around the perimeter
  g.fillStyle = C.fence;
  for (let x = r.bx; x <= r.bx + r.bw; x += 12) { g.fillRect(x, r.by, 3, 6); g.fillRect(x, r.by + r.bh - 6, 3, 6); }
  for (let y = r.by; y <= r.by + r.bh; y += 12) { g.fillRect(r.bx, y, 3, 6); g.fillRect(r.bx + r.bw - 3, y, 3, 6); }
  g.fillStyle = C.fenceDark; g.fillRect(r.bx, r.by + 2, r.bw, 2); g.fillRect(r.bx, r.by + r.bh - 4, r.bw, 2);
  // flower rows
  flowerBed(g, r.bx + 6, r.by + r.bh - 20, r.bw - 12, 12, rnd);
  // bench
  g.fillStyle = C.woodDark; g.fillRect(r.cx + 8, r.by + 12, 16, 5);
  // big central tree
  tree(g, r.cx - 6, r.cy + 4, 1.5, rnd);
}
function drawPlaza(g, r, rnd) {
  g.fillStyle = C.stone; g.fillRect(r.bx, r.by, r.bw, r.bh);
  g.strokeStyle = C.stoneGrout; g.lineWidth = 1;
  for (let x = r.bx + 10; x < r.bx + r.bw; x += 10) { g.beginPath(); g.moveTo(x, r.by); g.lineTo(x, r.by + r.bh); g.stroke(); }
  for (let y = r.by + 10; y < r.by + r.bh; y += 10) { g.beginPath(); g.moveTo(r.bx, y); g.lineTo(r.bx + r.bw, y); g.stroke(); }
  // fountain
  g.fillStyle = "#9aa0ad"; g.beginPath(); g.arc(r.cx, r.cy, 13, 0, Math.PI * 2); g.fill();
  g.fillStyle = C.water; g.beginPath(); g.arc(r.cx, r.cy, 9, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#cfeaf6"; g.beginPath(); g.arc(r.cx - 2, r.cy - 2, 3, 0, Math.PI * 2); g.fill();
  // two market stalls (striped tents)
  stall(g, r.bx + 6, r.by + 6);
  stall(g, r.bx + r.bw - 26, r.by + r.bh - 22);
}
function stall(g, x, y) {
  g.fillStyle = C.woodDark; g.fillRect(x, y + 8, 20, 8);
  for (let i = 0; i < 5; i++) { g.fillStyle = i % 2 ? "#d24f4f" : "#eee0c4"; g.fillRect(x + i * 4, y, 4, 8); }
}

// ---- nature -----------------------------------------------------------------
function tree(g, x, y, s, rnd) {
  s = s || 1;
  g.fillStyle = "rgba(30,46,24,0.22)";
  g.beginPath(); g.ellipse(x, y + 13 * s, 13 * s, 5 * s, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#7a5a36"; g.fillRect(x - 2 * s, y, 4 * s, 13 * s);
  g.fillStyle = "#3f8a44"; g.beginPath(); g.arc(x, y - 3 * s, 12 * s, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#4fa052"; g.beginPath(); g.arc(x - 5 * s, y - 1 * s, 7 * s, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#5fb863"; g.beginPath(); g.arc(x - 3 * s, y - 6 * s, 5 * s, 0, Math.PI * 2); g.fill();
}
function flowerBed(g, x, y, w, h, rnd) {
  g.fillStyle = "#7a5a36"; roundRect(g, x, y, w, h, 4); g.fill(); // tilled soil
  for (let i = 0; i < (w * h) / 22; i++) {
    const fx = x + 4 + rnd() * (w - 8);
    const fy = y + 4 + rnd() * (h - 8);
    g.fillStyle = FLOWERS[Math.floor(rnd() * FLOWERS.length)];
    g.beginPath(); g.arc(fx, fy, 1.8, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#f4e08a"; g.fillRect(fx - 0.5, fy - 0.5, 1, 1);
  }
}

// ---- sprite (tilemap) compositing -------------------------------------------
function drawTownSprites(g, layout, S, worldRect, lightsOn) {
  const { W, H, cols, rows, rects } = layout;
  const wr = worldRect || { x: 0, y: 0, w: W, h: H };
  if (g.imageSmoothingEnabled !== undefined) g.imageSmoothingEnabled = false;

  // grass carpet + sandy south shore + scattered ground decor, only over wr.
  const gr = seededRandom("spr-grass");
  const xr = tileRange(0, W, W, 16, wr, "x");
  const yr = tileRange(0, H, H, 16, wr, "y");
  const beachTop = H - Math.round(CELL * 1.4); // sandy shoreline along the south edge
  for (let y = 0; y < H; y += 16) {
    for (let x = 0; x < W; x += 16) {
      // advance the RNG for EVERY world tile so placement stays chunk-independent,
      // but only paint tiles inside wr.
      const a = gr();
      const b = gr();
      const c = gr();
      if (x < xr.a || x >= xr.b || y < yr.a || y >= yr.b) continue;
      // south shore: a 1-tile dithered grass→sand transition, then full beach.
      if (S.sand && y >= beachTop && (y >= beachTop + 16 || a < 0.5)) {
        g.drawImage(S.sand, x, y, 16, 16);
        if (c < 0.05 && S.rock) g.drawImage(S.rock, x, y + 3, 16, 12);
        continue;
      }
      g.drawImage(a < 0.14 && S.grass2 ? S.grass2 : S.grass, x, y, 16, 16);
      // scattered lawn decor (mutually exclusive; building footprints get painted
      // over by the building pass, so a stray sprite there is harmless).
      if (b < 0.045 && S.flower) g.drawImage(S.flower, x, y, 16, 16);
      else if (c < 0.03 && S.flower2) g.drawImage(S.flower2, x, y, 16, 16);
      else if (c < 0.075 && S.weed) g.drawImage(S.weed, x, y, 16, 16);
      else if (c < 0.092 && S.mushroom) g.drawImage(S.mushroom, x + 2, y + 3, 12, 12);
      else if (c < 0.104 && S.rock) g.drawImage(S.rock, x, y + 3, 16, 12);
    }
  }
  // Paved STREETS between the city blocks: the packer emits real 'street' cells,
  // each paved full-bleed so neighbouring street cells merge into one continuous
  // road. Drawn here (before trees/buildings) so eaves and canopies overhang the
  // street naturally.
  for (const rc of rects.values()) {
    const t = rc.loc.type;
    if (t !== "street" && t !== "road") continue;
    const ux = rc.loc.x * CELL, uy = rc.loc.y * CELL;
    if (rectsIntersect(wr, ux, uy, CELL, CELL)) paveStreet(g, S, rc, wr);
  }

  // a deterministic forest grove (dense top-left, sparse elsewhere) on open cells
  forestCluster(g, S, layout, wr);

  // NO per-building edge trees/bushes. In the dense city-block layout those poked
  // into the streets and overhung the ROOFLESS cutaway interiors + the hanging
  // shop signs. Greenery now lives only where it can never overlap a building:
  // inside the green/park courtyards (spriteGreen/spritePark, below) and the
  // forest grove on the open grass beyond the town (forestCluster, above).
  const MARGIN = 48;

  // apartment complexes (grouped buildings), back-to-front, only those near wr
  const complexes = (layout.complexes || [])
    .filter((cp) => rectsIntersect(wr, cp.x - MARGIN, cp.y - MARGIN, cp.w + MARGIN * 2, cp.h + MARGIN * 2))
    .sort((a, b) => (a.y + a.h) - (b.y + b.h));
  for (const cp of complexes) spriteComplex(g, S, cp, lightsOn, layout.wallTopology);
  // parks, plazas & greens (outdoor) drawn standalone, on top; street furniture
  // (lamps) drawn last so it sits above the pavement and any overhang.
  for (const rc of rects.values()) {
    if (!footprintNearRect(wr, rc, MARGIN)) continue;
    const t = rc.loc.type;
    if (t === "park") spritePark(g, S, rc);
    else if (t === "square" || t === "plaza") spritePlaza(g, S, rc);
    else if (t === "green") spriteGreen(g, S, rc);
    else if (t === "street" || t === "road") streetFurniture(g, S, rc);
  }
}

function clipTile(g, img, x, y, w, h, wr) {
  if (!img) return;
  g.save();
  g.beginPath();
  // When a chunk worldRect is given, intersect the clip with it so a path band
  // spanning the whole world only paints this chunk's slice.
  let cx = x, cy = y, cw = w, ch = h;
  if (wr) {
    const rx = Math.max(x, wr.x), ry = Math.max(y, wr.y);
    const rr = Math.min(x + w, wr.x + wr.w), rb = Math.min(y + h, wr.y + wr.h);
    cx = rx; cy = ry; cw = rr - rx; ch = rb - ry;
    if (cw <= 0 || ch <= 0) { g.restore(); return; }
  }
  g.rect(cx, cy, cw, ch);
  g.clip();
  const x0 = Math.floor(cx / 16) * 16;
  const y0 = Math.floor(cy / 16) * 16;
  for (let yy = y0; yy < cy + ch; yy += 16) for (let xx = x0; xx < cx + cw; xx += 16) g.drawImage(img, xx, yy, 16, 16);
  g.restore();
}

// Scatter varied trees across OPEN (non-building) cells — a dense grove toward the
// top-left corner, thinning out elsewhere — to echo the reference's woodland. Each
// cell seeds its own RNG (seededRandom per cell), so placement is identical in every
// chunk bake regardless of the worldRect (no cross-chunk drift). Trees draw behind
// buildings (this runs before the building pass), so overhang reads naturally.
function forestCluster(g, S, layout, wr) {
  const species = [S.tree, S.tree_apple, S.tree_pine].filter(Boolean);
  if (!species.length) return;
  const { cols, rows, rects } = layout;
  const occ = new Set();
  for (const r of rects.values()) occ.add(r.loc.x + "," + r.loc.y);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if (occ.has(cx + "," + cy)) continue;
      const rnd = seededRandom("forest-" + cx + "-" + cy);
      const grove = cx < cols * 0.3 && cy < rows * 0.34; // top-left woodland
      if (rnd() > (grove ? 0.6 : 0.045)) continue;
      const px = cx * CELL + CELL * 0.5 + (rnd() - 0.5) * CELL * 0.4;
      const py = cy * CELL + CELL * 0.62 + (rnd() - 0.5) * CELL * 0.3;
      const t = species[Math.floor(rnd() * species.length)];
      if (!rectsIntersect(wr, px - 20, py - 42, 40, 56)) continue;
      g.drawImage(t, px - 16, py - 40, 32, 46);
    }
  }
}

function put(g, img, x, y) {
  if (!img) return;
  // Furniture sprites are authored ART_SS× their on-screen size (crisp, material-rich
  // when zoomed in); draw them back down so placement and footprints are unchanged.
  const w = img.width / ART_SS, h = img.height / ART_SS;
  // soft contact shadow grounds the object on the floor
  g.fillStyle = "rgba(22,28,18,0.20)";
  g.beginPath();
  g.ellipse(x + w / 2, y + h - 1.5, w * 0.42, 2.8, 0, 0, Math.PI * 2);
  g.fill();
  g.drawImage(img, x, y, w, h);
}

function pick(arr, rnd) { return arr.length ? arr[Math.floor(rnd() * arr.length)] : null; }

// The reference's signature centrepiece: a table ringed by four chairs in alternating
// red/yellow, sitting on a rug — fills the open middle of a common room so it doesn't
// read as empty wood. (cx,cy) is the table centre. Draw order tucks the back/side
// chairs under the table, then the front chair in front of it.
function diningSet(g, S, cx, cy, rng, opts = {}) {
  const rugs = [S.rug, S.rug_blue, S.rug_green].filter(Boolean);
  if (opts.rug !== false && rugs.length) put(g, pick(rugs, rng), cx - 17, cy - 13);
  const R = S.chair_red || S.chair, Y = S.chair_yellow || S.chair_red || S.chair;
  put(g, R, cx - 7, cy - 19);                       // back chair (under table top edge)
  put(g, Y, cx - 19, cy - 7);                       // left chair
  put(g, Y, cx + 5, cy - 7);                        // right chair
  if (S.table) put(g, S.table, cx - 14, cy - 12);   // table over the side/back chairs
  put(g, R, cx - 7, cy + 4);                        // front chair, in front of the table
}

// A hanging WOOD SHOP-SIGN, mounted high on the storefront so it NEVER covers room
// furniture. The plank sits OVER the top wall band: its bottom rests on the wall's inner
// edge — `baseY`, the y where the unit's interior furniture begins — and it rises upward
// over the wall, with two iron hanger links + a peg above it (kept within the wall band).
// Warm wood, beveled, faint grain, the name PAINTED in cream over a dark underpaint. The
// name is dynamic so this is procedural (board + text drawn together; both renderers bake
// it identically). Auto-fits the font (9→7px) then ellipsis-truncates, and sizes the plank
// to the fitted text so it reads as a sign. Args: (mountX, baseY) is the wall point the
// plank rests against, maxW the plank width budget. opts.fascia mounts the plank FLAT on
// the wall band (no hanger peg/links above it — used for the per-complex building sign on
// the south face, where anything above the plank would poke into the room interior).
function nameSign(g, name, mountX, baseY, maxW, opts = {}) {
  const clean = (name.replace(/^(The|Town|Community|Corner|Willow|Cedar)\s+/i, "") || name).trim();

  // auto-fit: shrink the font to a 7px floor, then ellipsis-truncate
  const padX = 8;
  const cap = Math.max(24, Math.min(maxW, 132));    // plank width budget — always
  // respects the caller's maxW (a 46px floor here used to push the plank past a
  // narrow budget into door gaps/walls at non-default subdivisions); the 24px
  // hard floor only guards degenerate inputs.
  const fontAt = (px) => "700 " + px + "px ui-monospace, Menlo, monospace";
  let font = 9, text = clean;
  g.font = fontAt(font);
  while (g.measureText(text).width > cap - padX * 2 && font > 7) { font -= 0.5; g.font = fontAt(font); }
  if (g.measureText(text).width > cap - padX * 2) {  // still too wide at the floor → ellipsis
    while (text.length > 1 && g.measureText(text + "…").width > cap - padX * 2) text = text.slice(0, -1);
    text = text + "…";
  }

  // plank geometry: sized to the fitted text; its BOTTOM rests on the wall's inner edge
  // (baseY) so the whole board sits up over the wall band, clear of the room interior.
  const boardW = Math.min(cap, Math.max(44, Math.ceil(g.measureText(text).width) + padX * 2));
  const boardH = 13, r = 3;
  const bx = Math.round(mountX - boardW / 2);
  const bottomY = Math.round(baseY);                 // furniture begins here — plank stays above it
  const topY = bottomY - boardH;                     // plank rises over the wall band

  g.save();
  g.textAlign = "center"; g.textBaseline = "middle"; g.lineJoin = "round"; g.lineCap = "round";

  // (1) soft cast shadow under the plank (mostly over the wall; only ~2px translucent dip)
  g.fillStyle = "rgba(0,0,0,0.20)";
  roundRect(g, bx + 1.5, topY + 2, boardW, boardH, r); g.fill();

  // (2) two iron hanger links + a wall peg ABOVE the plank (kept within the wall band;
  // skipped for fascia mounts, which bolt flat to the wall instead of hanging)
  if (!opts.fascia) {
    const peg = topY - 4;
    g.strokeStyle = "#2b2118"; g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(mountX, peg); g.lineTo(bx + 6, topY + 1);
    g.moveTo(mountX, peg); g.lineTo(bx + boardW - 6, topY + 1);
    g.stroke();
    g.fillStyle = "#3a2e22"; g.beginPath(); g.arc(mountX, peg, 1.7, 0, Math.PI * 2); g.fill();  // peg on the wall
  }

  // (3) the wood plank: warm fill + lit top bevel / shaded bottom edge
  g.fillStyle = C.wood; roundRect(g, bx, topY, boardW, boardH, r); g.fill();
  g.fillStyle = shade(C.wood, 0.16); roundRect(g, bx + 1, topY + 1, boardW - 2, 3, Math.max(0.5, r - 1)); g.fill();
  g.fillStyle = shade(C.wood, -0.22); g.fillRect(bx + 2, topY + boardH - 3, boardW - 4, 2);

  // (4) faint horizontal wood grain (clipped to the plank)
  g.save(); roundRect(g, bx, topY, boardW, boardH, r); g.clip();
  g.strokeStyle = shade(C.wood, -0.12); g.lineWidth = 0.5;
  for (let i = 0; i < 2; i++) { const gy = topY + 4.5 + i * 3.6; g.beginPath(); g.moveTo(bx + 3, gy); g.lineTo(bx + boardW - 3, gy); g.stroke(); }
  g.restore();

  // (5) thin painted border + two iron pegs binding the plank to the links
  g.strokeStyle = shade(C.wood, 0.30); g.lineWidth = 0.75;
  roundRect(g, bx + 2.5, topY + 2.5, boardW - 5, boardH - 5, Math.max(0.5, r - 1.5)); g.stroke();
  g.fillStyle = "#332a20";
  g.beginPath(); g.arc(bx + 6, topY + 1.5, 1.2, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(bx + boardW - 6, topY + 1.5, 1.2, 0, Math.PI * 2); g.fill();

  // (6) PAINTED name: warm cream over a faint dark underpaint (gives the strokes body)
  g.font = fontAt(font);
  const ty = topY + boardH / 2 + 0.5;
  g.fillStyle = "rgba(40,28,16,0.45)"; g.fillText(text, mountX + 0.4, ty + 0.5);
  g.fillStyle = "#f3e6c8"; g.fillText(text, mountX, ty);

  g.restore();
  g.textAlign = "left";                              // reset for the rest of the draw
}

// ONE sign per BUILDING, not per room: a multi-unit complex gets a single fascia
// plank with a building-level name derived from its type ("Maple Apartments",
// "Creek Market Hall", …) — the per-unit names stay in the side panels/legend.
// The prefix is deterministic per complex id and deliberately avoids the
// Willow/Cedar/The/… prefixes nameSign strips for fitting. A 1-member complex IS
// its building, so it keeps the member's own name (spriteBuilding handles it).
const SIGN_LABELS = {
  home: "Apartments", market: "Market Hall", cafe: "Café Row", shop: "Shopping Row",
  clinic: "Health Centre", bakery: "Bakery Row", school: "School Campus", civic: "Civic Centre",
  garden: "Gardens", dock: "Harbourfront", gallery: "Arts Centre", gym: "Athletics Hall",
  studio: "Studio Lofts", office: "Office Hall", bar: "Tavern Row", workshop: "Workshops",
  library: "Library Hall", chapel: "Chapels", theater: "Theatre Block", bank: "Bank House",
  salon: "Salon Row", florist: "Flower Market", pharmacy: "Apothecary Row",
  museum: "Museum Hall", post: "Post House", diner: "Diner Row",
};
const SIGN_PREFIXES = ["Creek", "Maple", "Harbour", "Garden", "Rosewood", "Linden", "Aspen"];
function buildingName(members) {
  const loc = members[0].loc;
  const label = SIGN_LABELS[loc.type] || loc.type.charAt(0).toUpperCase() + loc.type.slice(1) + " Hall";
  const prefix = SIGN_PREFIXES[Math.floor(seededRandom("sign-" + (loc.complex || loc.id))() * SIGN_PREFIXES.length)];
  return prefix + " " + label;
}

// Group buildings into apartment COMPLEXES by super-block, so a cluster of homes/
// shops renders as ONE shell with an array of rooms + shared corridors (parks &
// plazas stay standalone). Deterministic; computed once in computeLayout.
function groupComplexes(layout) {
  const groups = new Map();
  for (const rc of layout.rects.values()) {
    const t = rc.loc.type;
    if (isOutdoorType(t)) continue;
    // a building with no complex id renders standalone (its own unique key), never
    // grid-merged — merging by a coarse grid lumped unrelated buildings into giant
    // sparse complexes flooded with bare corridor floor.
    const key = rc.loc.complex || ("solo_" + rc.loc.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rc);
  }
  const complexes = [];
  for (const members of groups.values()) {
    // full-cell bounding box (cells are contiguous → the shell is a solid block)
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const r of members) { a = Math.min(a, r.loc.x); b = Math.min(b, r.loc.y); c = Math.max(c, r.loc.x); d = Math.max(d, r.loc.y); }
    complexes.push({ members, x: a * CELL, y: b * CELL, w: (c - a + 1) * CELL, h: (d - b + 1) * CELL });
  }
  return complexes;
}

// Door/tunnel gap window (cell-fraction) — the SAME narrow opening the routing
// grid punches (pathfinding.gapSpan, derived from gapIndices), so a drawn doorway
// lines up EXACTLY with the walkable gap A* threads (render ↔ routing lockstep).
// sub=8 → {0.375, 0.625}: a 44px doorway, so the wall covers ~75% of the edge.
const WALL_GAP = gapSpan((CONFIG.movement && CONFIG.movement.subdivisions) || 8) || { lo: 0.25, hi: 0.75 };

// Draw one wall edge — a CELL-long run of 16px wall tiles — punching the narrow
// centred doorway GAP (WALL_GAP) when the edge is a door/tunnel; otherwise the
// edge is a solid wall covering its whole length. Horizontal edges run along x at
// fixed y (16px thick); vertical edges run along y at fixed x.
function wallEdge(g, img, horizontal, ex, ey, len, open) {
  if (!img) return;
  if (!open) { if (horizontal) clipTile(g, img, ex, ey, len, 16); else clipTile(g, img, ex, ey, 16, len); return; }
  const g0 = len * WALL_GAP.lo, g1 = len * WALL_GAP.hi;   // narrow centred gap window
  if (horizontal) { clipTile(g, img, ex, ey, g0, 16); clipTile(g, img, ex + g1, ey, len - g1, 16); }
  else { clipTile(g, img, ex, ey, 16, g0); clipTile(g, img, ex, ey + g1, 16, len - g1); }
}

// A complex may not perfectly tile its bounding rectangle; the leftover GAP cells
// used to render as a bare wood floor with a lone rug+plant, which reads as a broken
// empty room. Instead furnish each gap as the block's SHARED LOUNGE: a reading nook
// along the back wall, a central seating set on a rug, and greenery in the corners —
// so the apartment complex looks fully inhabited. Deterministic per cell; clipped to
// the cell so nothing spills into the neighbouring units.
function gapLounge(g, S, ux, uy) {
  const rng = seededRandom("gap-" + ux + "-" + uy);
  clipTile(g, S.floor_wood, ux, uy, CELL, CELL);                    // shared common-room floor
  g.save(); g.beginPath(); g.rect(ux, uy, CELL, CELL); g.clip();
  const L = ux + 18, T = uy + 18, R = ux + CELL - 16, B = uy + CELL - 16, MX = ux + CELL / 2, MY = uy + CELL / 2;
  if (S.sofa) put(g, S.sofa, L, T);                                 // back wall: reading nook
  if (S.plant) put(g, S.plant, MX - 7, T);
  if (S.bookshelf) put(g, S.bookshelf, R - 19, T);
  diningSet(g, S, MX, MY + 2, rng);                                 // central shared seating on a rug
  if (S.bush) put(g, S.bush, L, MY + 4);                            // greenery hugging the side walls
  if (S.plant) put(g, S.plant, R - 16, MY);
  if (S.bench) put(g, S.bench, MX - 13, B - 12);                    // a bench along the front
  g.restore();
}

// Draw an apartment complex as ONE shell (matching the top-down cutaway reference):
// every cell is a full-bleed unit, units share SINGLE-thickness walls on the cell
// boundaries, each unit is subdivided into rooms, and the wall topology (`topo`,
// shared with the routing grid) cuts a centred DOOR gap in each unit's street-
// facing shell wall and a TUNNEL gap in every wall shared with a sibling unit — so
// agents enter through the door and move room-to-room through the tunnels exactly
// where the picture shows an opening. A lone member renders as a standalone building.
function spriteComplex(g, S, complex, lightsOn, topo) {
  const { members, x, y, w, h } = complex;
  if (members.length <= 1) { if (members[0]) spriteBuilding(g, S, members[0], lightsOn, { topo }); return; }

  // grid of full cells inside the shell (cells are contiguous → a solid block)
  const WT = 16;                                          // perimeter wall thickness (one tile)
  const cols = Math.round(w / CELL), rows = Math.round(h / CELL);
  const gx0 = Math.round(x / CELL), gy0 = Math.round(y / CELL);
  const maxGy = gy0 + rows - 1;                           // bottom (ground-floor) row
  const occ = new Set(members.map((m) => m.loc.x + "," + m.loc.y));

  // --- per-unit full-cell interiors, drawn BEFORE the shared wall grid -------
  // Each unit fills its whole cell; the interior is inset by a FULL wall tile on the
  // shell's outer edges and a HALF tile (the shared-wall half-width) on internal
  // edges, so room floors meet the wall centrelines exactly — no gap, no wood strip.
  for (const rc of [...members].sort((p, q) => p.loc.y - q.loc.y)) {
    const ux = rc.loc.x * CELL, uy = rc.loc.y * CELL;
    const cI = rc.loc.x - gx0, rI = rc.loc.y - gy0;       // cell column/row within the shell
    const iL = cI === 0 ? WT : 8, iT = rI === 0 ? WT : 8; // inset per edge (perimeter vs shared)
    const iR = cI === cols - 1 ? WT : 8, iB = rI === rows - 1 ? WT : 8;
    const ix = ux + iL, iy = uy + iT, iw = CELL - iL - iR, ih = CELL - iT - iB;
    clipTile(g, S.floor_wood, ux, uy, CELL, CELL);        // full-cell base floor (no seams)
    const rng = seededRandom("furn-" + rc.loc.id);
    g.save(); g.beginPath(); g.rect(ux, uy, CELL, CELL); g.clip();
    drawRooms(g, S, rc.loc.type, ix, iy, iw, ih, rng, { beds: rc.residents || 1 });
    interiorAO(g, ix, iy, iw, ih);
    g.restore();
    // (per-unit nameplates are drawn LAST, on top of the shared wall grid below)
  }

  // dress any GAP cells (a complex may not perfectly fill its bounding rectangle)
  // as the block's furnished shared lounge — never a bare empty wood floor
  if (members.length < cols * rows) {
    for (let gy = gy0; gy <= maxGy; gy++) for (let gx = gx0; gx < gx0 + cols; gx++) {
      if (occ.has(gx + "," + gy)) continue;
      gapLounge(g, S, gx * CELL, gy * CELL);
    }
  }

  // --- walls: per-unit edges with topology-driven door/tunnel gaps -----------
  // Each member draws its four walls. An edge shared with a SIBLING unit is an
  // internal wall centred on the boundary with a TUNNEL gap; a shell edge sits
  // flush at the outer face and is solid unless it is this unit's DOOR. Internal
  // walls are drawn by BOTH neighbours at the same pixels (idempotent), so the
  // shell reads as one block with single-thickness shared walls + clean doorways.
  const WL = S.wall2 || S.wall, WI = S.wall || WL;
  const topoOf = (cx, cy) => (topo && topo.get(cx + "," + cy)) || { N: 0, E: 0, S: 0, W: 0 };
  if (WL) {
    g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
    for (const m of members) {
      const cx = m.loc.x, cy = m.loc.y, ux = cx * CELL, uy = cy * CELL;
      const cl = topoOf(cx, cy);
      const inN = occ.has(cx + "," + (cy - 1)), inS = occ.has(cx + "," + (cy + 1));
      const inW = occ.has((cx - 1) + "," + cy), inE = occ.has((cx + 1) + "," + cy);
      wallEdge(g, inN ? WI : WL, true, ux, inN ? uy - 8 : uy, CELL, cl.N !== 0);                 // N
      wallEdge(g, inS ? WI : WL, true, ux, inS ? uy + CELL - 8 : uy + CELL - 16, CELL, cl.S !== 0); // S
      wallEdge(g, inW ? WI : WL, false, inW ? ux - 8 : ux, uy, CELL, cl.W !== 0);                // W
      wallEdge(g, inE ? WI : WL, false, inE ? ux + CELL - 8 : ux + CELL - 16, uy, CELL, cl.E !== 0); // E
    }
    if (S.window) for (let wx = x + 30; wx < x + w - 30; wx += 80) g.drawImage(S.window, wx, y + 2, 16, 12); // windows on the front (top) wall
    g.restore();
  }

  // --- cap, outline, per-unit entry fixtures ---------------------------------
  g.strokeStyle = "#3a352e"; g.lineWidth = 1.5; g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  wallCap(g, { bx: x, bw: w, by: y });                               // flat light-grey wall cap (top-down cutaway, no roof)
  if (lightsOn) eaveLight(g, { bx: x, bw: w, by: y });
  // entry fixtures on each unit's DOOR side. Only SOUTH doors get a deck+stairs
  // (their art faces south, onto the open ground the door opens toward). No
  // threshold doormat: it draws unclipped on top of furniture, and at E/W/N doors
  // it lands on the wall-hugging shelves/cabinets (the reported meds_shelf overlay);
  // the wall gap itself already marks every doorway.
  for (const m of members) {
    const cx = m.loc.x, cy = m.loc.y, ux = cx * CELL, uy = cy * CELL, cxu = ux + CELL / 2;
    const cl = topoOf(cx, cy);
    if (cl.S === 1) {
      if (S.deck) clipTile(g, S.deck, cxu - 22, uy + CELL - 1, 44, 18);
      if (S.stairs) g.drawImage(S.stairs, cxu - 14, uy + CELL - 3, 28, 16);
    }
  }
  if (S.mailbox) g.drawImage(S.mailbox, x + 6, y + h - 20, 16, 16);

  // ONE building sign per complex (not one per room): a fascia plank mounted on the
  // south (entrance) face's wall band, drawn LAST so walls/windows never clip it.
  // The plank sits fully INSIDE the bottom wall band [y+h-16, y+h], so it can never
  // cover room furniture, courtyard decor, or a neighbouring cell. Mount position
  // dodges the door gaps (all widths derived from WALL_GAP so they track
  // CONFIG.movement.subdivisions): prefer a bottom-row unit WITHOUT a south door;
  // else the shared boundary between two adjacent bottom units (a plank up to
  // 2·lo·CELL just clears both door gaps, which start ±lo·CELL out — 132px/±66px
  // at sub=8); else the clear strip RIGHT of the lone unit's door (the matching
  // left strip would collide with the complex mailbox at x+6 whenever the lone
  // unit sits in the leftmost column — true of all 7 shipped lone-branch complexes).
  const ctrX = x + w / 2;
  const bottomRow = members.filter((m) => m.loc.y === maxGy)
    .sort((p, q) => Math.abs(p.loc.x * CELL + CELL / 2 - ctrX) - Math.abs(q.loc.x * CELL + CELL / 2 - ctrX));
  const quiet = bottomRow.find((m) => topoOf(m.loc.x, m.loc.y).S !== 1);
  let signX, signW = 2 * CELL * WALL_GAP.lo;                         // 132 at sub=8
  if (quiet) signX = quiet.loc.x * CELL + CELL / 2;
  else {
    const xs = bottomRow.map((m) => m.loc.x).sort((p, q) => p - q);
    let boundary = null;
    for (let i = 0; i + 1 < xs.length; i++) if (xs[i + 1] === xs[i] + 1) { boundary = (xs[i] + 1) * CELL; break; }
    if (boundary != null) signX = boundary;
    else {                                  // lone bottom unit with a south door
      const ux = bottomRow[0].loc.x * CELL;
      const gapR = ux + CELL * WALL_GAP.hi;                          // door gap's right edge
      const wallL = ux + CELL - WT;                                  // right wall's inner edge
      signX = (gapR + wallL) / 2;
      signW = wallL - gapR - 4;                                      // 46 at sub=8
    }
  }
  nameSign(g, buildingName(members), signX, y + h - 2, signW, { fascia: true });
}

function spriteBuilding(g, S, rc, lightsOn, opts = {}) {
  const { bx, by, bw, bh, cx } = rc;
  const rng = seededRandom("furn-" + rc.loc.id);

  // wooden entry deck/porch below the door (standalone buildings only, not in a complex)
  if (!opts.noRoof && S.deck && seededRandom("deck-" + rc.loc.id)() < 0.5) clipTile(g, S.deck, cx - 22, by + bh - 1, 44, 18);

  clipTile(g, S.floor_wood, bx, by, bw, bh); // base floor

  g.save();
  g.beginPath();
  g.rect(bx, by, bw, bh);
  g.clip();
  // perimeter walls with a doorway gap on this unit's DOOR side — topology-driven
  // (matches the routing grid's gap), defaulting to a south door without topology.
  if (S.wall) {
    const cl = (opts.topo && opts.topo.get(rc.loc.x + "," + rc.loc.y)) || { N: 0, E: 0, S: 1, W: 0 };
    const dir = cl.S === 1 ? "S" : cl.E === 1 ? "E" : cl.W === 1 ? "W" : cl.N === 1 ? "N" : "S";
    wallEdge(g, S.wall, true, bx, by, bw, dir === "N");                 // top
    wallEdge(g, S.wall, true, bx, by + bh - 16, bw, dir === "S");       // bottom
    wallEdge(g, S.wall, false, bx, by, bh, dir === "W");                // left
    wallEdge(g, S.wall, false, bx + bw - 16, by, bh, dir === "E");      // right
  }
  // multi-room interior laid out from the building type's blueprint
  drawRooms(g, S, rc.loc.type, bx + 16, by + 16, bw - 32, bh - 30, rng, { beds: rc.residents || 1 });
  // soft AO hugging the south/east interior walls (cheap, deterministic)
  interiorAO(g, bx + 16, by + 16, bw - 32, bh - 30);
  g.restore();

  g.strokeStyle = "#2f2a22";
  g.lineWidth = 1;
  g.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
  // flat light-grey wall cap capping the top (skipped for units inside a complex)
  if (!opts.noRoof) wallCap(g, rc);
  // warm window-light wash on the eave when lit (e.g. night bakes)
  if (lightsOn) eaveLight(g, rc);
  // hanging wood shop-sign mounted over the wall band (rests on the interior top: by+16)
  nameSign(g, rc.loc.name, cx, by + 16, Math.min(150, bw - 8));
}

// ---- house blueprints (one template per building type) ----------------------
// Instead of every building sharing one fixed plan, each TYPE has its own
// blueprint: a grid where `cols`/`rows` are fractional track sizes of the interior
// and `cells` place rooms on that grid (optional cspan/rspan merge tracks into a
// bigger room). `foot` is the footprint as a fraction of a cell, so types differ
// in overall size too. drawRooms() renders any blueprint generically — laying out
// each room, then deriving interior walls (with one doorway per adjacent room
// pair) from the cell spans. Add a type here to give it a bespoke floor plan.
const BLUEPRINTS = {
  // 2-over-1 plans, varied proportions + footprints
  home:    { foot: [0.84, 0.76], cols: [0.56, 0.44],       rows: [0.44, 0.56], cells: [{ c: 0, r: 0, kind: "bedroom" }, { c: 1, r: 0, kind: "bath" }, { c: 0, r: 1, cspan: 2, kind: "living" }] },
  shop:    { foot: [0.90, 0.78], cols: [0.56, 0.44],       rows: [0.36, 0.64], cells: [{ c: 0, r: 0, kind: "storage" }, { c: 1, r: 0, kind: "bath" }, { c: 0, r: 1, cspan: 2, kind: "shop" }] },
  library: { foot: [0.92, 0.82], cols: [0.60, 0.40],       rows: [0.30, 0.70], cells: [{ c: 0, r: 0, kind: "study" }, { c: 1, r: 0, kind: "bath" }, { c: 0, r: 1, cspan: 2, kind: "library" }] },
  school:  { foot: [0.92, 0.82], cols: [0.62, 0.38],       rows: [0.34, 0.66], cells: [{ c: 0, r: 0, kind: "study" }, { c: 1, r: 0, kind: "bath" }, { c: 0, r: 1, cspan: 2, kind: "class" }] },
  studio:  { foot: [0.88, 0.80], cols: [0.58, 0.42],       rows: [0.40, 0.60], cells: [{ c: 0, r: 0, kind: "bedroom" }, { c: 1, r: 0, kind: "bath" }, { c: 0, r: 1, cspan: 2, kind: "studio" }] },
  gym:     { foot: [0.92, 0.82], cols: [0.64, 0.36],       rows: [0.28, 0.72], cells: [{ c: 0, r: 0, kind: "study" }, { c: 1, r: 0, kind: "bath" }, { c: 0, r: 1, cspan: 2, kind: "meeting" }] },
  // 3-over-1 plans (wide footprints so the three top rooms fit)
  cafe:    { foot: [0.92, 0.80], cols: [0.34, 0.28, 0.38], rows: [0.34, 0.66], cells: [{ c: 0, r: 0, kind: "bedroom" }, { c: 1, r: 0, kind: "bath" }, { c: 2, r: 0, kind: "kitchen" }, { c: 0, r: 1, cspan: 3, kind: "cafe" }] },
  civic:   { foot: [0.90, 0.80], cols: [0.34, 0.30, 0.36], rows: [0.34, 0.66], cells: [{ c: 0, r: 0, kind: "study" }, { c: 1, r: 0, kind: "bath" }, { c: 2, r: 0, kind: "storage" }, { c: 0, r: 1, cspan: 3, kind: "meeting" }] },
  // a 2×2 clinic
  health:  { foot: [0.88, 0.80], cols: [0.52, 0.48],       rows: [0.50, 0.50], cells: [{ c: 0, r: 0, kind: "ward" }, { c: 1, r: 0, kind: "bath" }, { c: 0, r: 1, kind: "ward" }, { c: 1, r: 1, kind: "study" }] },
  // ---- community buildings: a small service band + one big public room ----
  chapel:  { foot: [0.92, 0.86], cols: [0.50, 0.50],       rows: [0.26, 0.74], cells: [{ c: 0, r: 0, kind: "study" }, { c: 1, r: 0, kind: "storage" }, { c: 0, r: 1, cspan: 2, kind: "chapel" }] },
  theater: { foot: [0.94, 0.84], cols: [0.58, 0.42],       rows: [0.30, 0.70], cells: [{ c: 0, r: 0, kind: "storage" }, { c: 1, r: 0, kind: "bath" }, { c: 0, r: 1, cspan: 2, kind: "theater" }] },
  bank:    { foot: [0.90, 0.80], cols: [0.50, 0.50],       rows: [0.40, 0.60], cells: [{ c: 0, r: 0, kind: "vaultroom" }, { c: 1, r: 0, kind: "study" }, { c: 0, r: 1, cspan: 2, kind: "bank" }] },
  salon:   { foot: [0.88, 0.80], cols: [0.56, 0.44],       rows: [0.34, 0.66], cells: [{ c: 0, r: 0, kind: "storage" }, { c: 1, r: 0, kind: "bath" }, { c: 0, r: 1, cspan: 2, kind: "salon" }] },
  florist: { foot: [0.90, 0.80], cols: [0.50, 0.50],       rows: [0.34, 0.66], cells: [{ c: 0, r: 0, kind: "storage" }, { c: 1, r: 0, kind: "kitchen" }, { c: 0, r: 1, cspan: 2, kind: "florist" }] },
  pharmacy:{ foot: [0.90, 0.80], cols: [0.56, 0.44],       rows: [0.36, 0.64], cells: [{ c: 0, r: 0, kind: "storage" }, { c: 1, r: 0, kind: "study" }, { c: 0, r: 1, cspan: 2, kind: "pharmacy" }] },
  museum:  { foot: [0.94, 0.82], cols: [0.50, 0.50],       rows: [0.34, 0.66], cells: [{ c: 0, r: 0, kind: "study" }, { c: 1, r: 0, kind: "storage" }, { c: 0, r: 1, cspan: 2, kind: "museum" }] },
  post:    { foot: [0.90, 0.80], cols: [0.56, 0.44],       rows: [0.36, 0.64], cells: [{ c: 0, r: 0, kind: "storage" }, { c: 1, r: 0, kind: "study" }, { c: 0, r: 1, cspan: 2, kind: "post" }] },
  diner:   { foot: [0.94, 0.80], cols: [0.34, 0.28, 0.38], rows: [0.34, 0.66], cells: [{ c: 0, r: 0, kind: "storage" }, { c: 1, r: 0, kind: "bath" }, { c: 2, r: 0, kind: "kitchen" }, { c: 0, r: 1, cspan: 3, kind: "diner" }] },
};
// related types reuse a base blueprint
const BLUEPRINT_ALIAS = {
  bar: "cafe", bakery: "cafe", market: "shop", gallery: "library",
  clinic: "health", office: "civic", workshop: "studio", dock: "home", garden: "home",
  // community-type synonyms reuse a bespoke plan above
  church: "chapel", cinema: "theater", deli: "diner", grocer: "shop",
  studio_art: "studio", clinic_dental: "health",
};
const DEFAULT_BLUEPRINT = { foot: [0.84, 0.74], cols: [0.56, 0.44], rows: [0.44, 0.56], cells: [{ c: 0, r: 0, kind: "bedroom" }, { c: 1, r: 0, kind: "bath" }, { c: 0, r: 1, cspan: 2, kind: "living" }] };

function blueprintFor(type) {
  return BLUEPRINTS[type] || BLUEPRINTS[BLUEPRINT_ALIAS[type]] || DEFAULT_BLUEPRINT;
}

// Render any blueprint into the interior rect (x,y,w,h): lay out each room from the
// grid, furnish it, then draw the interior walls implied by the cell spans — with
// exactly one doorway punched per pair of adjacent rooms (so every room connects).
function drawRooms(g, S, type, x, y, w, h, rng, opts) {
  const bp = blueprintFor(type);
  const cols = bp.cols, rows = bp.rows, nc = cols.length, nr = rows.length;
  const wall = 3, door = 15;
  const colX = [x]; for (let i = 0; i < nc; i++) colX.push(colX[i] + cols[i] * w); colX[nc] = x + w;
  const rowY = [y]; for (let i = 0; i < nr; i++) rowY.push(rowY[i] + rows[i] * h); rowY[nr] = y + h;
  // which cell index owns each grid square (respecting spans)
  const occ = Array.from({ length: nr }, () => new Array(nc).fill(-1));
  bp.cells.forEach((cell, i) => {
    for (let r = cell.r; r < cell.r + (cell.rspan || 1) && r < nr; r++)
      for (let c = cell.c; c < cell.c + (cell.cspan || 1) && c < nc; c++) occ[r][c] = i;
  });
  // floors + furniture, one room per cell
  bp.cells.forEach((cell) => {
    const c2 = cell.c + (cell.cspan || 1), r2 = cell.r + (cell.rspan || 1);
    const rx = colX[cell.c] + wall / 2, ry = rowY[cell.r] + wall / 2;
    const rw = colX[c2] - colX[cell.c] - wall, rh = rowY[r2] - rowY[cell.r] - wall;
    if (rw > 4 && rh > 4) furnish(g, S, cell.kind, { x: rx, y: ry, w: rw, h: rh }, rng, opts);
  });
  // interior walls — one doorway per adjacent room pair (light-grey plaster)
  g.fillStyle = "#cdc7ba";
  const doored = new Set();
  const key = (a, b) => (a < b ? a + ":" + b : b + ":" + a);
  for (let c = 1; c < nc; c++) for (let r = 0; r < nr; r++) {
    const a = occ[r][c - 1], b = occ[r][c];
    if (a === b) continue;
    const wx = colX[c] - wall / 2, y0 = rowY[r], y1 = rowY[r + 1], k = key(a, b);
    if (doored.has(k)) g.fillRect(wx, y0, wall, y1 - y0);
    else { doored.add(k); const m = (y0 + y1) / 2; g.fillRect(wx, y0, wall, Math.max(0, m - door / 2 - y0)); g.fillRect(wx, m + door / 2, wall, Math.max(0, y1 - (m + door / 2))); }
  }
  for (let r = 1; r < nr; r++) for (let c = 0; c < nc; c++) {
    const a = occ[r - 1][c], b = occ[r][c];
    if (a === b) continue;
    const wy = rowY[r] - wall / 2, x0 = colX[c], x1 = colX[c + 1], k = key(a, b);
    if (doored.has(k)) g.fillRect(x0, wy, x1 - x0, wall);
    else { doored.add(k); const m = (x0 + x1) / 2; g.fillRect(x0, wy, Math.max(0, m - door / 2 - x0), wall); g.fillRect(m + door / 2, wy, Math.max(0, x1 - (m + door / 2)), wall); }
  }
}

// Common rooms get warm wood; private/utility + institutional rooms get tan tile;
// baths get pink. Banks/pharmacies/post/museum read better on cool civic tile.
const TILED_ROOMS = new Set(["bedroom", "study", "storage", "ward", "kitchen", "vaultroom", "bank", "pharmacy", "post", "museum"]);
function roomFloor(g, S, kind, c) {
  let f = S.floor_wood;
  if (kind === "bath") f = S.floor_pink || S.floor_tile;
  else if (TILED_ROOMS.has(kind)) f = S.floor_tile;
  clipTile(g, f || S.floor_wood, c.x, c.y, c.w, c.h);
}

function furnish(g, S, kind, c, rng, opts) {
  roomFloor(g, S, kind, c);
  g.save();
  g.beginPath();
  g.rect(c.x, c.y, c.w, c.h);
  g.clip();
  const L = c.x + 2, T = c.y + 2, R = c.x + c.w, B = c.y + c.h, MX = c.x + c.w / 2;
  const beds = [S.bed, S.bed_red, S.bed_green].filter(Boolean);
  const chairs = [S.chair, S.chair_red, S.chair_yellow, S.chair_green].filter(Boolean);
  // the signature dining set fills the open middle of a common room
  const centrepiece = () => diningSet(g, S, MX, B - 18, rng);
  switch (kind) {
    // ---- small rooms in the top band: fixtures hug the back (top) wall ----
    case "bedroom": {
      // One HORIZONTAL bed per RESIDENT (opts.beds, capped at 2), pillow-left,
      // stacked DOWN the left wall so a pair share that wall (both heads left).
      // The second bed reuses the first's sprite pick (no extra rng draw, so a
      // 1- vs 2-resident room stays art-stream-identical). Bed positions come
      // from the SHARED bedPlacement helper, so the sleeper spots
      // computeBedAssignments emits land on these exact rects; the rest of the
      // furniture sits to the RIGHT of / below the beds, clear of the left wall.
      const nBeds = Math.min(2, Math.max(1, (opts && opts.beds) || 1));
      const bedImg = pick(beds, rng);
      const b0 = bedPlacement(c.x, c.y, 0);          // (c.x+2, c.y+2) = (L, T)
      put(g, bedImg, b0.x, b0.y);                    // bed on the left wall, top
      if (nBeds >= 2) { const b1 = bedPlacement(c.x, c.y, 1); put(g, bedImg, b1.x, b1.y); } // second resident's bed below it
      const bedRight = b0.x + BED.w + 2;             // x just clear of the left-wall beds
      if (c.w > 50) put(g, S.nightstand, bedRight, T); // nightstand right of the top bed
      const wide = c.w > 62;
      if (wide) put(g, (rng() < 0.5 && S.wardrobe) ? S.wardrobe : S.dresser, R - 19, T); // wardrobe/dresser, top-right
      if (S.rug && c.h > 44) put(g, pick([S.rug, S.rug_blue, S.rug_green].filter(Boolean), rng), MX - 4, B - 24); // floor rug, centre-bottom
      if (S.lamp && c.h > 46) put(g, S.lamp, R - 17, B - 20);     // corner floor lamp (only with bottom-band room)
      if (!wide && S.dresser) put(g, S.dresser, L + 2, B - 16);   // narrow plan: dresser bottom-LEFT (1 bed only, top row), clear of the lamp
      if (nBeds < 2 && S.painting && c.w > 84) put(g, S.painting, R - 38, T); // wall art on the top wall, left of the wardrobe
      break;
    }
    case "bath":
      put(g, S.toilet, L, T);
      put(g, S.vanity || S.sink, R - 18, T);
      if (S.sink && (S.vanity) && c.h > 50) put(g, S.sink, R - 18, B - 18); // second basin on a deep bath
      if (S.plant) put(g, S.plant, L, B - 18);
      if (S.rug && c.w > 40) put(g, S.rug_blue || S.rug, MX - 6, B - 20);   // bath mat
      break;
    case "study":
      put(g, S.desk, L, T);
      put(g, pick(chairs, rng), L + 2, T + 16);
      put(g, S.bookshelf, R - 19, T);
      break;
    case "storage":
      put(g, S.washer, L, T);                          // washer on the back wall
      if (c.w > 40) put(g, S.dresser, L + 20, T);      // dresser beside it (only if it fits)
      if (S.fridge) {                                  // fridge top-right; bottom-right when the top wall is too narrow
        if (c.w > 60) put(g, S.fridge, R - 18, T);
        else if (c.h > 30) put(g, S.fridge, R - 18, B - 26);
      }
      break;
    case "ward":
      put(g, pick(beds, rng), L, T);                 // horizontal bed, pillow-left
      if (c.w > 46) put(g, S.nightstand, L + BED.w + 2, T); // nightstand clear of the bed
      if (c.w > 62) put(g, S.dresser, R - 19, T);
      break;
    case "kitchen":
      put(g, S.counter, L, T);
      put(g, S.fridge, R - 18, T);
      put(g, S.oven || S.stove, L, B - 18);
      if (S.utensil_rack) put(g, S.utensil_rack, L + 2, T + 13);
      break;
    // ---- large common rooms (bottom): back-wall feature + spaced front seating ----
    case "living":
      put(g, S.sofa, L + 6, T);                       // sofa | tv | shelf along the back wall
      if (S.tv) put(g, S.tv, L + 42, T);
      put(g, S.bookshelf, R - 19, T);
      centrepiece();
      if (S.piano && c.w > 116) put(g, S.piano, R - 32, B - 22); // upright piano in the far corner (inside the right wall)
      if (S.plant) put(g, S.plant, L, B - 18);                   // potted plant by the door
      if (S.lamp && c.w > 96) put(g, S.lamp, L + 4, T + 20);     // reading lamp beside the sofa
      break;
    case "cafe":
      put(g, S.bar || S.counter, L + 4, T);           // bar along the back wall
      if (S.stool) for (let i = 0; i < 3; i++) put(g, S.stool, L + 9 + i * 12, T + 15);
      put(g, S.fridge, R - 18, T);
      put(g, S.table, L + 10, B - 26); put(g, pick(chairs, rng), L + 6, B - 13); put(g, pick(chairs, rng), L + 28, B - 13);
      put(g, S.table, R - 34, B - 26); put(g, pick(chairs, rng), R - 38, B - 13); put(g, pick(chairs, rng), R - 16, B - 13);
      if (S.microphone) put(g, S.microphone, MX - 4, B - 24);
      break;
    case "shop":
      put(g, S.bookshelf, L + 2, T); put(g, S.bookshelf, L + 22, T); put(g, S.bookshelf, L + 42, T); // stock wall
      put(g, S.fridge, R - 18, T);
      put(g, S.counter, MX - 16, B - 18);
      if (rng() < 0.6) put(g, S.plant, L, B - 18);
      break;
    case "library":
      put(g, S.bookshelf, L + 2, T); put(g, S.bookshelf, L + 22, T); put(g, S.bookshelf, L + 42, T); put(g, S.bookshelf, R - 19, T);
      centrepiece();
      put(g, pick(chairs, rng), MX - 26, B - 13); put(g, pick(chairs, rng), MX + 12, B - 13);
      break;
    case "class":
      if (S.board) put(g, S.board, MX - 15, T);       // chalkboard on the back wall
      for (let r = 0; r < 2; r++) for (let i = 0; i < 3; i++) put(g, S.desk, L + 10 + i * 22, T + 18 + r * 18);
      break;
    case "meeting": {
      const my = c.y + c.h / 2 + 4;
      diningSet(g, S, MX, my, rng);
      put(g, S.bookshelf, L + 2, T); put(g, S.bookshelf, R - 19, T);
      break;
    }
    case "studio":
      put(g, S.easel || S.table, L + 6, T);
      if (S.microphone) put(g, S.microphone, L + 30, T);
      put(g, S.bookshelf, R - 19, T);
      centrepiece();
      if (rng() < 0.6) put(g, S.plant, L, B - 18);
      break;
    // ---- community building public rooms ----
    case "vaultroom":                               // bank back room: the vault
      put(g, S.vault || S.fridge, L + 2, T);
      if (S.display_case) put(g, S.display_case, R - 28, T);
      else if (S.bookshelf) put(g, S.bookshelf, R - 19, T);
      break;
    case "chapel": {                                // altar on the back wall, pews facing it
      put(g, S.altar || S.table, MX - 12, T);
      const nrows = c.h > 76 ? 3 : 2;
      for (let i = 0; i < nrows; i++) {
        const py = T + 22 + i * 16;
        if (py + 10 > B) break;
        put(g, S.pew || S.sofa, L + 4, py);          // left pew column
        put(g, S.pew || S.sofa, MX + 4, py);         // right pew column (center aisle)
      }
      if (S.plant) put(g, S.plant, L, B - 18);
      break;
    }
    case "theater":                                 // screen on the back wall + tiered seat rows
      put(g, S.screen || S.board, MX - 20, T);
      for (let i = 0; i < 3; i++) {
        const py = T + 18 + i * 15;
        if (py + 12 > B) break;
        put(g, S.seatrow || S.sofa, MX - 16, py);
      }
      break;
    case "bank":                                    // teller line + a writing desk
      put(g, S.teller || S.counter, MX - 15, T);
      put(g, S.desk, L + 4, B - 18);                // writing desk, bottom-left
      put(g, pick(chairs, rng), L + 24, B - 16);    // chair beside the desk, inside the room
      if (S.register) put(g, S.register, R - 18, B - 16);
      if (S.plant) put(g, S.plant, L, T);
      break;
    case "salon":                                   // mirrors on the back wall, a chair below each
      for (let i = 0; i < 3; i++) {
        const sx = L + 8 + i * 30;
        if (sx + 14 > R) break;
        if (S.mirror) put(g, S.mirror, sx + 2, T);
        put(g, S.barber_chair || pick(chairs, rng), sx, T + 18);
      }
      if (S.plant) put(g, S.plant, R - 12, B - 18);
      break;
    case "florist":                                 // tiered flower stands + a checkout case
      put(g, S.flower_stand || S.plant, L + 4, T);
      if (S.flower_stand) put(g, S.flower_stand, L + 28, T);
      if (S.display_case) put(g, S.display_case, MX - 13, B - 16);
      if (S.register) put(g, S.register, R - 18, T);
      if (S.plant) put(g, S.plant, R - 12, B - 18);
      break;
    case "pharmacy":                                // wall of medicine shelves + a register
      put(g, S.meds_shelf || S.bookshelf, L + 2, T);
      put(g, S.meds_shelf || S.bookshelf, L + 22, T);
      if (S.meds_shelf || S.bookshelf) put(g, S.meds_shelf || S.bookshelf, R - 20, T);
      if (S.register) put(g, S.register, MX - 8, B - 16);
      if (S.display_case) put(g, S.display_case, L + 4, B - 16);
      break;
    case "museum":                                  // a line of pedestals + glass cases
      for (let i = 0; i < 3; i++) {
        const px = L + 12 + i * 34;
        if (px + 14 > R) break;
        put(g, S.pedestal || S.plant, px, T + 6);
      }
      if (S.display_case) { put(g, S.display_case, L + 2, B - 16); put(g, S.display_case, R - 28, B - 16); }
      break;
    case "post":                                    // wall of PO boxes + counter
      put(g, S.po_boxes || S.bookshelf, L + 2, T);
      if (S.po_boxes) put(g, S.po_boxes, L + 24, T);
      if (S.register) put(g, S.register, R - 18, T);
      put(g, S.counter, MX - 16, B - 16);
      if (S.plant) put(g, S.plant, R - 12, B - 18);
      break;
    case "diner":                                   // booths flanking a counter + a dining set
      put(g, S.booth || S.sofa, L + 4, T);
      if (S.booth) put(g, S.booth, R - 28, T);
      put(g, S.counter, MX - 16, T);
      diningSet(g, S, MX, B - 18, rng);
      if (S.register) put(g, S.register, L + 4, B - 16);
      break;
    default:
      centrepiece();
      if (S.plant) put(g, S.plant, L, T);
  }
  g.restore();
}

// A fenced park: grass, a leafy border, a central tree, plus a bench, a flower bed
// and a street lamp drawn from the new outdoor sprites (deterministic per plot).
function spritePark(g, S, rc) {
  const { bx, by, bw, bh, cx, cy } = rc;
  const rng = seededRandom("park-" + rc.loc.id);
  clipTile(g, S.grass2 || S.grass, bx, by, bw, bh);
  g.fillStyle = "#9c7a4c";
  for (let x = bx; x <= bx + bw; x += 12) { g.fillRect(x, by, 3, 6); g.fillRect(x, by + bh - 6, 3, 6); }
  for (let y = by; y <= by + bh; y += 12) { g.fillRect(bx, y, 3, 6); g.fillRect(bx + bw - 3, y, 3, 6); }
  if (S.tree) g.drawImage(S.tree, cx - 16, cy - 20, 32, 40);
  if (S.flowerbed) put(g, S.flowerbed, bx + 8, by + bh - 18);
  else if (S.flower) for (let i = 0; i < 5; i++) g.drawImage(S.flower, bx + 8 + i * 14, by + bh - 22, 16, 16);
  if (S.bench) put(g, S.bench, bx + bw - 32, by + bh - 16);
  if (S.streetlamp) put(g, S.streetlamp, bx + 6, by + 6);
  if (S.bush && rng() < 0.6) put(g, S.bush, bx + bw - 24, by + 8);
  g.strokeStyle = "#2f2a22"; g.lineWidth = 1; g.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
}

// A paved town plaza centred on the stone fountain sprite, with corner planters,
// a bench and a street lamp. Falls back to the old drawn fountain if no sprite.
function spritePlaza(g, S, rc) {
  const { bx, by, bw, bh, cx, cy } = rc;
  if (S.gravel) {
    clipTile(g, S.gravel, bx, by, bw, bh); // cobbled plaza ground
  } else {
    g.fillStyle = "#cfc6b2"; g.fillRect(bx, by, bw, bh);
    g.strokeStyle = "#b6ac95"; g.lineWidth = 1;
    for (let x = bx + 10; x < bx + bw; x += 10) { g.beginPath(); g.moveTo(x, by); g.lineTo(x, by + bh); g.stroke(); }
    for (let y = by + 10; y < by + bh; y += 10) { g.beginPath(); g.moveTo(bx, y); g.lineTo(bx + bw, y); g.stroke(); }
  }
  if (S.fountain) {
    put(g, S.fountain, cx - 16, cy - 16);
  } else {
    g.fillStyle = "#9aa0ad"; g.beginPath(); g.arc(cx, cy, 13, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#7fb6d8"; g.beginPath(); g.arc(cx, cy, 9, 0, Math.PI * 2); g.fill();
  }
  if (S.bench) put(g, S.bench, bx + bw - 34, by + bh - 16);
  if (S.streetlamp) put(g, S.streetlamp, bx + 6, by + 6);
  put(g, S.plant, bx + 4, by + bh - 22);
  put(g, S.plant, bx + bw - 18, by + 4);
  g.strokeStyle = "#2f2a22"; g.lineWidth = 1; g.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
}

// A landscaped GREEN — the gap-filler plot that keeps the town free of bare grass
// holes. Grass base, a clipped-hedge border, and a deterministic mix of greenery
// (tree, flower bed, bench, the odd statue/pond/market stall) so each green differs.
function spriteGreen(g, S, rc) {
  const { bx, by, bw, bh, cx, cy } = rc;
  const rng = seededRandom("green-" + rc.loc.id);
  clipTile(g, S.grass || S.grass2, bx, by, bw, bh);
  // hedge border (top-down, tileable) framing the plot
  if (S.hedge) {
    for (let x = bx; x < bx + bw; x += 16) { g.drawImage(S.hedge, x, by, 16, 16); g.drawImage(S.hedge, x, by + bh - 16, 16, 16); }
    for (let y = by + 16; y < by + bh - 16; y += 16) { g.drawImage(S.hedge, bx, y, 16, 16); g.drawImage(S.hedge, bx + bw - 16, y, 16, 16); }
  }
  // one feature roll per plot for variety
  const roll = rng();
  if (roll < 0.16 && S.pond) put(g, S.pond, cx - 15, cy - 11);
  else if (roll < 0.30 && S.statue) put(g, S.statue, cx - 8, cy - 14);
  else if (roll < 0.44 && S.market_stall) put(g, S.market_stall, cx - 15, cy - 12);
  else if (S.tree) g.drawImage(S.tree, cx - 16, cy - 22, 32, 40);
  // secondary dressing
  if (S.flowerbed && rng() < 0.7) put(g, S.flowerbed, bx + 22, by + bh - 26);
  if (S.bench && rng() < 0.6) put(g, S.bench, bx + bw - 38, by + bh - 24);
  if (S.streetlamp && rng() < 0.5) put(g, S.streetlamp, bx + 22, by + 22);
}

// A paved STREET cell — filled full-bleed (the WHOLE cell, edge to edge) with the
// cobble tile so a run of street cells reads as one seamless road between the city
// blocks. Street furniture (lamps) is added on top later by streetFurniture().
function paveStreet(g, S, rc, wr) {
  const ux = rc.loc.x * CELL, uy = rc.loc.y * CELL;
  if (S.gravel) clipTile(g, S.gravel, ux, uy, CELL, CELL, wr);
  else if (S.path) clipTile(g, S.path, ux, uy, CELL, CELL, wr);
  else { g.fillStyle = "#b3ac9e"; g.fillRect(ux, uy, CELL, CELL); }
}

// Street lamps along the road — a deterministic subset of cells (so lamps don't
// crowd every cell), set toward a corner clear of the centre where avatars walk.
function streetFurniture(g, S, rc) {
  if (!S.streetlamp) return;
  const rng = seededRandom("streetf-" + rc.loc.id);
  if (rng() < 0.34) put(g, S.streetlamp, rc.loc.x * CELL + 12, rc.loc.y * CELL + 10);
}

// Procedural-fallback street: a full-cell cobbled road with a faint stone grid.
function drawStreet(g, r) {
  const ux = r.loc.x * CELL, uy = r.loc.y * CELL;
  g.fillStyle = "#b3ac9e"; g.fillRect(ux, uy, CELL, CELL);   // cobble grey
  g.strokeStyle = "rgba(60,52,40,0.10)"; g.lineWidth = 1;
  for (let x = ux + 16; x < ux + CELL; x += 20) { g.beginPath(); g.moveTo(x, uy); g.lineTo(x, uy + CELL); g.stroke(); }
  for (let y = uy + 16; y < uy + CELL; y += 20) { g.beginPath(); g.moveTo(ux, y); g.lineTo(ux + CELL, y); g.stroke(); }
}

// ---- shared helpers ---------------------------------------------------------
export function activityEmoji(activity, fallback) {
  const a = String(activity || "").toLowerCase();
  if (/sleep|rest|wind down/.test(a)) return "💤";
  if (/breakfast|coffee|café|cafe|pastr/.test(a)) return "☕";
  if (/lunch|eat|meal/.test(a)) return "🍽️";
  if (/walk|stroll/.test(a)) return "🚶";
  if (/errand|shop|store|supplies/.test(a)) return "🛍️";
  if (/read|book|librar|study/.test(a)) return "📖";
  if (/teach|lesson|student|school/.test(a)) return "✏️";
  if (/patient|clinic|care|health|nurse/.test(a)) return "🩺";
  if (/zoning|plan|map|public space/.test(a)) return "🗺️";
  if (/prototype|build|tinker|studio|art/.test(a)) return "🛠️";
  if (/neighbour|neighbor|social|talk|community/.test(a)) return "💬";
  if (/work/.test(a)) return "💼";
  return fallback || "🙂";
}

export function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function shade(hex, amt) {
  const c = hexToRgb(hex);
  if (!c) return hex;
  const f = amt < 0 ? 1 + amt : 1;
  const add = amt > 0 ? 255 * amt : 0;
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v * f + add)));
  return `rgb(${ch(c.r)},${ch(c.g)},${ch(c.b)})`;
}

export function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex));
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
}

export function ambient(minutes) {
  const keys = [
    { t: 0, c: [12, 18, 48], a: 0.5 },
    { t: 300, c: [20, 26, 60], a: 0.42 },
    { t: 390, c: [240, 150, 90], a: 0.22 },
    { t: 480, c: [255, 240, 210], a: 0.04 },
    { t: 720, c: [255, 255, 255], a: 0.0 },
    { t: 1020, c: [255, 235, 200], a: 0.05 },
    { t: 1110, c: [240, 130, 70], a: 0.24 },
    { t: 1230, c: [30, 30, 70], a: 0.42 },
    { t: 1440, c: [12, 18, 48], a: 0.5 },
  ];
  let lo = keys[0], hi = keys[keys.length - 1];
  for (let i = 0; i < keys.length - 1; i++) {
    if (minutes >= keys[i].t && minutes <= keys[i + 1].t) { lo = keys[i]; hi = keys[i + 1]; break; }
  }
  const span = hi.t - lo.t || 1;
  const f = (minutes - lo.t) / span;
  const lerp = (a, b) => a + (b - a) * f;
  return {
    r: Math.round(lerp(lo.c[0], hi.c[0])),
    g: Math.round(lerp(lo.c[1], hi.c[1])),
    b: Math.round(lerp(lo.c[2], hi.c[2])),
    a: lerp(lo.a, hi.a),
  };
}
