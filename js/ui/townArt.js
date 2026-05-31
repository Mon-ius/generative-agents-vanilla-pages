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
import { buildGrid } from "../utils/pathfinding.js";

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
};
export const ROOF_DEFAULT = "#b06a4a";

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
    const bw = Math.round(CELL * 0.86);
    const bh = Math.round(CELL * 0.74);
    const bx = Math.round(cx - bw / 2);
    const by = Math.round(cy - bh / 2 - 8);
    rects.set(l.id, { loc: l, cx, cy, bx, by, bw, bh, door: { x: cx, y: by + bh + 12 } });
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
  layout.collisionGrid = buildGrid(layout);

  return layout;
}

// Place agent `index` of `count` standing around a location's door. For small
// crowds we fan out along a single arc; for larger crowds (up to ~capacity) we
// stack concentric rings below/around the door so 20+ agents never pile onto the
// same pixel. Deterministic: depends only on (index, count) — no RNG.
export function spotFor(layout, locId, index, count) {
  const r = layout.rects.get(locId);
  if (!r) return { x: layout.W / 2, y: layout.H / 2 };
  if (count <= 1) return { x: r.door.x, y: r.door.y };

  const cx = r.door.x;
  const cy = r.door.y;
  // Keep the crowd within the cell footprint around the door (avoid spilling
  // onto neighbours): clamp the outermost ring to a fraction of the cell.
  const maxRadius = CELL * 0.42;
  const ringGap = 15;            // radial spacing between rings
  const minSpacing = 14;         // target arc spacing between neighbours (~sprite width)
  const baseRadius = 14;         // first ring sits just outside the door
  // Fan agents across a downward arc (toward the open road below the door) so the
  // building is never occluded; the arc widens on outer rings up to a near-full
  // semicircle, but always faces down.
  const down = Math.PI / 2;      // straight down in screen space (+y)
  const fanHalfFor = (ringIdx) => Math.min(Math.PI * 0.85, 0.9 + ringIdx * 0.35);

  // Per-ring capacity sized from the arc length at that radius so neighbour
  // spacing stays ~minSpacing regardless of ring. Walk rings until `index` lands.
  const ringCapacity = (ringIdx) => {
    const radius = baseRadius + ringIdx * ringGap;
    const arcLen = 2 * fanHalfFor(ringIdx) * radius;
    return Math.max(ringIdx === 0 ? 3 : 5, Math.round(arcLen / minSpacing) + 1);
  };

  let i = index;
  let ring = 0;
  let cap = ringCapacity(0);
  while (i >= cap) {
    i -= cap;
    ring += 1;
    cap = ringCapacity(ring);
  }

  const radius = Math.min(maxRadius, baseRadius + ring * ringGap);
  const slots = cap;
  const fanHalf = fanHalfFor(ring);
  // Even placement across the fan; a lone occupant on a ring sits centred (down).
  const t = slots <= 1 ? 0.5 : i / (slots - 1);
  const angle = down - fanHalf + t * (2 * fanHalf);

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
  drawPaths(g, layout, rnd, wr);

  // standalone flower beds (echo the flower field) at a couple of deterministic
  // spots — drawn only if they fall within this rect.
  if (rectsIntersect(wr, W - 150, 70, 110, 46)) flowerBed(g, W - 150, 70, 110, 46, seededRandom("bed-a"));
  if (rectsIntersect(wr, 70, H - 80, 90, 40)) flowerBed(g, 70, H - 80, 90, 40, seededRandom("bed-b"));

  // scattered trees around building edges / corners (only near this rect)
  const MARGIN = 40; // eaves / tree canopy overhang
  for (const r of rects.values()) {
    if (!footprintNearRect(wr, r, MARGIN)) continue;
    const tr = seededRandom("tree-" + r.loc.id);
    if (tr() < 0.6) tree(g, r.bx - 16 + tr() * 6, r.by - 6, 0.9 + tr() * 0.3, tr);
    if (tr() < 0.5) tree(g, r.bx + r.bw + 14, r.by + r.bh + 6, 0.85 + tr() * 0.3, tr);
  }

  // buildings / park / plaza, back-to-front for correct overlap (only those whose
  // eave-expanded footprint intersects this rect).
  const visible = [...rects.values()]
    .filter((r) => footprintNearRect(wr, r, MARGIN))
    .sort((a, b) => a.cy - b.cy);
  for (const r of visible) {
    const rng = seededRandom("bld-" + r.loc.id);
    if (r.loc.type === "park") drawPark(g, r, rng);
    else if (r.loc.type === "square") drawPlaza(g, r, rng);
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

function drawPaths(g, layout, rnd, wr) {
  const { W, H, cols, rows } = layout;
  const road = 30;
  // Draw a path band clipped to wr so we only touch this chunk's pixels.
  const draw = (x, y, w, h) => {
    if (!rectsIntersect(wr, x - 2, y - 2, w + 4, h + 4)) return;
    g.fillStyle = C.pathEdge; g.fillRect(x - 2, y - 2, w + 4, h + 4);
    g.fillStyle = C.path; g.fillRect(x, y, w, h);
  };
  for (let c = 0; c < cols; c++) draw(c * CELL + CELL / 2 - road / 2, 0, road, H);
  for (let r = 0; r < rows; r++) draw(0, r * CELL + CELL / 2 - road / 2, W, road);
  // lighter centre + speckle
  g.fillStyle = C.pathMid;
  for (let c = 0; c < cols; c++) {
    const x = c * CELL + CELL / 2 - 4;
    if (rectsIntersect(wr, x, 0, 8, H)) g.fillRect(x, 0, 8, H);
  }
  for (let r = 0; r < rows; r++) {
    const y = r * CELL + CELL / 2 - 4;
    if (rectsIntersect(wr, 0, y, W, 8)) g.fillRect(0, y, W, 8);
  }
  g.fillStyle = C.pathSpeck;
  for (let i = 0; i < (W * rows) * 0.02; i++) {
    const sx = Math.floor(rnd() * W);
    const sy = Math.floor(rnd() * H);
    if (sx < wr.x - 2 || sx > wr.x + wr.w + 2 || sy < wr.y - 2 || sy > wr.y + wr.h + 2) continue;
    g.fillRect(sx, sy, 2, 2);
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

  // small unobtrusive label on the eave (aids the demo; original relies on the map)
  const label = r.loc.name.replace(/^(The|Town|Community|Corner|Willow|Cedar)\s+/i, "") || r.loc.name;
  g.font = "600 8px ui-monospace, Menlo, monospace";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillStyle = "rgba(0,0,0,0.55)";
  g.fillText(label, r.cx, r.by + 3, r.bw - 6);
  g.textAlign = "left";
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
  // dirt paths along the row/column streets (clipped to wr inside clipTile).
  const road = 32;
  for (let c = 0; c < cols; c++) {
    const x = c * CELL + CELL / 2 - road / 2;
    if (rectsIntersect(wr, x, 0, road, H)) clipTile(g, S.path, x, 0, road, H, wr);
  }
  for (let r = 0; r < rows; r++) {
    const y = r * CELL + CELL / 2 - road / 2;
    if (rectsIntersect(wr, 0, y, W, road)) clipTile(g, S.path, 0, y, W, road, wr);
  }

  // a deterministic forest grove (dense top-left, sparse elsewhere) on open cells
  forestCluster(g, S, layout, wr);

  // trees (varied species), bushes, stumps + rocks hugging building edges (only near wr)
  const MARGIN = 48;
  const species = [S.tree, S.tree_apple, S.tree_pine].filter(Boolean);
  for (const rc of rects.values()) {
    if (!footprintNearRect(wr, rc, MARGIN)) continue;
    const tr = seededRandom("t-" + rc.loc.id);
    if (tr() < 0.6 && species.length) g.drawImage(species[Math.floor(tr() * species.length)], rc.bx - 26, rc.by - 36, 32, 46);
    if (tr() < 0.4 && S.bush) g.drawImage(S.bush, rc.bx + rc.bw + 6, rc.by + rc.bh - 4, 20, 16);
    if (tr() < 0.28 && S.stump) g.drawImage(S.stump, rc.bx - 18, rc.by + rc.bh - 8, 16, 14);
    if (tr() < 0.3 && S.rock) g.drawImage(S.rock, rc.bx + rc.bw + 8, rc.by - 6, 16, 12);
  }
  if (rectsIntersect(wr, W - 150, 60, 9 * 14, 3 * 14)) flowerPatch(g, S, W - 150, 60, 9, 3, seededRandom("fp1"));
  if (rectsIntersect(wr, 52, H - 96, 6 * 14, 3 * 14)) flowerPatch(g, S, 52, H - 96, 6, 3, seededRandom("fp2"));

  // buildings / park / plaza, back-to-front (only those near wr)
  const visible = [...rects.values()]
    .filter((rc) => footprintNearRect(wr, rc, MARGIN))
    .sort((a, b) => a.cy - b.cy);
  for (const rc of visible) {
    if (rc.loc.type === "park") spritePark(g, S, rc);
    else if (rc.loc.type === "square") spritePlaza(g, S, rc);
    else spriteBuilding(g, S, rc, lightsOn);
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

function flowerPatch(g, S, x, y, cw, ch, rnd) {
  if (!S.flower) return;
  for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) if (rnd() < 0.8) g.drawImage(S.flower, x + i * 14, y + j * 14, 16, 16);
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

function spriteBuilding(g, S, rc, lightsOn) {
  const { bx, by, bw, bh, cx } = rc;
  const rng = seededRandom("furn-" + rc.loc.id);

  // wooden entry deck/porch below the door (about half of the buildings)
  if (S.deck && seededRandom("deck-" + rc.loc.id)() < 0.5) clipTile(g, S.deck, cx - 22, by + bh - 1, 44, 18);

  clipTile(g, S.floor_wood, bx, by, bw, bh); // base floor

  g.save();
  g.beginPath();
  g.rect(bx, by, bw, bh);
  g.clip();
  // perimeter walls with a bottom door gap
  if (S.wall) {
    for (let x = bx; x < bx + bw; x += 16) g.drawImage(S.wall, x, by, 16, 16);
    for (let y = by; y < by + bh; y += 16) { g.drawImage(S.wall, bx, y, 16, 16); g.drawImage(S.wall, bx + bw - 16, y, 16, 16); }
    const doorL = cx - 13, doorR = cx + 13;
    for (let x = bx; x < bx + bw; x += 16) if (x + 16 <= doorL || x >= doorR) g.drawImage(S.wall, x, by + bh - 16, 16, 16);
  }
  // multi-room interior, furnished per-building for variety
  spriteRooms(g, S, rc.loc.type, bx + 16, by + 16, bw - 32, bh - 30, rng);
  // soft AO hugging the south/east interior walls (cheap, deterministic)
  interiorAO(g, bx + 16, by + 16, bw - 32, bh - 30);
  g.restore();

  g.strokeStyle = "#2f2a22";
  g.lineWidth = 1;
  g.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
  // cozy shingled roof eave capping the top
  shingleRoof(g, rc, ROOF[rc.loc.type] || ROOF_DEFAULT);
  // warm window-light wash on the eave when lit (e.g. night bakes)
  if (lightsOn) eaveLight(g, rc);
  const label = rc.loc.name.replace(/^(The|Town|Community|Corner|Willow|Cedar)\s+/i, "") || rc.loc.name;
  g.font = "600 9px ui-monospace, Menlo, monospace";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "rgba(0,0,0,0.62)";
  g.fillText(label, cx, by + 8, bw - 8);
  g.textAlign = "left";
}

// Per-type floor plan: a top band of two small rooms (a private room + a bath/
// utility) over one large common room — matching the reference houses. Each entry
// is { tl, tr, main } room-kind ids consumed by furnish().
const PLAN = {
  home:    { tl: "bedroom", tr: "bath", main: "living"  },
  cafe:    { tl: "bedroom", tr: "bath", main: "cafe"    },
  shop:    { tl: "storage", tr: "bath", main: "shop"    },
  library: { tl: "study",   tr: "bath", main: "library" },
  school:  { tl: "bedroom", tr: "bath", main: "class"   },
  health:  { tl: "ward",    tr: "bath", main: "ward"    },
  civic:   { tl: "study",   tr: "bath", main: "meeting" },
  studio:  { tl: "bedroom", tr: "bath", main: "studio"  },
};
const DEFAULT_PLAN = { tl: "bedroom", tr: "bath", main: "living" };

// Lay out a building interior as "two small rooms over one large room" with a
// doorway gap punched through each interior wall, then furnish each room with
// wall-hugging fixtures.
function spriteRooms(g, S, type, x, y, w, h, rng) {
  const plan = PLAN[type] || DEFAULT_PLAN;
  const wall = 3, door = 16;
  const topH = Math.max(22, Math.round(h * 0.38));   // residential band (shorter → deeper common room)
  const splitX = x + Math.round(w * 0.56);           // private | bath divider
  const tl = { x, y, w: splitX - x - wall, h: topH };
  const tr = { x: splitX + wall, y, w: x + w - (splitX + wall), h: topH };
  const main = { x, y: y + topH + wall, w, h: h - topH - wall };

  furnish(g, S, plan.tl, tl, rng);
  furnish(g, S, plan.tr, tr, rng);
  furnish(g, S, plan.main, main, rng);

  // interior walls, each with a doorway gap
  g.fillStyle = "#bdb094";
  const hGap = x + Math.round(w * 0.5) - door / 2;   // door between band & common room
  g.fillRect(x, y + topH, Math.max(0, hGap - x), wall);
  g.fillRect(hGap + door, y + topH, Math.max(0, x + w - (hGap + door)), wall);
  const vGap = y + Math.round(topH * 0.52) - door / 2; // door between the two top rooms
  g.fillRect(splitX, y, wall, Math.max(0, vGap - y));
  g.fillRect(splitX, vGap + door, wall, Math.max(0, y + topH - (vGap + door)));
}

// Common rooms get warm wood; private/utility rooms get tan tile; baths get pink.
const TILED_ROOMS = new Set(["bedroom", "study", "storage", "ward", "kitchen"]);
function roomFloor(g, S, kind, c) {
  let f = S.floor_wood;
  if (kind === "bath") f = S.floor_pink || S.floor_tile;
  else if (TILED_ROOMS.has(kind)) f = S.floor_tile;
  clipTile(g, f || S.floor_wood, c.x, c.y, c.w, c.h);
}

function furnish(g, S, kind, c, rng) {
  roomFloor(g, S, kind, c);
  g.save();
  g.beginPath();
  g.rect(c.x, c.y, c.w, c.h);
  g.clip();
  const L = c.x + 2, T = c.y + 2, R = c.x + c.w, B = c.y + c.h, MX = c.x + c.w / 2;
  const beds = [S.bed, S.bed_red, S.bed_green].filter(Boolean);
  const chairs = [S.chair, S.chair_red, S.chair_yellow, S.chair_green].filter(Boolean);
  const rugs = [S.rug, S.rug_blue, S.rug_green].filter(Boolean);
  // place a coffee table on a rug, centred along the front wall of a common room
  const centrepiece = () => { put(g, pick(rugs, rng), MX - 15, B - 23); put(g, S.table, MX - 14, B - 25); };
  switch (kind) {
    // ---- small rooms in the top band: fixtures hug the back (top) wall ----
    case "bedroom":
      put(g, pick(beds, rng), L, T);                 // bed | nightstand | dresser, left→right
      put(g, S.nightstand, L + 26, T);
      put(g, (rng() < 0.5 && S.wardrobe) ? S.wardrobe : S.dresser, R - 19, T);
      if (S.lamp && rng() < 0.5) put(g, S.lamp, R - 12, B - 20);
      break;
    case "bath":
      put(g, S.toilet, L, T);
      put(g, S.vanity || S.sink, R - 18, T);
      if (rng() < 0.5) put(g, S.plant, L, B - 18);
      break;
    case "study":
      put(g, S.desk, L, T);
      put(g, pick(chairs, rng), L + 2, T + 16);
      put(g, S.bookshelf, R - 19, T);
      break;
    case "storage":
      put(g, S.washer, L, T);
      put(g, S.dresser, L + 20, T);
      if (S.fridge) put(g, S.fridge, R - 18, T);
      break;
    case "ward":
      put(g, pick(beds, rng), L, T);
      put(g, S.nightstand, L + 26, T);
      put(g, S.dresser, R - 19, T);
      break;
    // ---- large common rooms (bottom): back-wall feature + spaced front seating ----
    case "living":
      put(g, S.sofa, L + 6, T);                       // sofa | tv | shelf along the back wall
      if (S.tv) put(g, S.tv, L + 42, T);
      put(g, S.bookshelf, R - 19, T);
      centrepiece();
      if (rng() < 0.6) put(g, S.plant, L, B - 18);
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
      const my = c.y + c.h / 2;
      put(g, S.table, MX - 14, my - 12);
      put(g, pick(chairs, rng), MX - 22, my - 22); put(g, pick(chairs, rng), MX + 8, my - 22);
      put(g, pick(chairs, rng), MX - 22, my + 8); put(g, pick(chairs, rng), MX + 8, my + 8);
      put(g, S.bookshelf, L + 2, T); put(g, S.bookshelf, R - 19, T);
      break;
    }
    case "studio":
      put(g, S.easel || S.table, L + 6, T);
      if (S.microphone) put(g, S.microphone, L + 30, T);
      put(g, S.bookshelf, R - 19, T);
      put(g, S.table, MX - 14, B - 24);
      if (rng() < 0.6) put(g, S.plant, L, B - 18);
      break;
    default:
      centrepiece();
      if (S.plant) put(g, S.plant, L, T);
  }
  g.restore();
}

function spritePark(g, S, rc) {
  const { bx, by, bw, bh, cx, cy } = rc;
  clipTile(g, S.grass2 || S.grass, bx, by, bw, bh);
  g.fillStyle = "#9c7a4c";
  for (let x = bx; x <= bx + bw; x += 12) { g.fillRect(x, by, 3, 6); g.fillRect(x, by + bh - 6, 3, 6); }
  for (let y = by; y <= by + bh; y += 12) { g.fillRect(bx, y, 3, 6); g.fillRect(bx + bw - 3, y, 3, 6); }
  if (S.flower) for (let i = 0; i < 5; i++) g.drawImage(S.flower, bx + 8 + i * 14, by + bh - 22, 16, 16);
  if (S.tree) g.drawImage(S.tree, cx - 16, cy - 16, 32, 40);
  g.strokeStyle = "#2f2a22"; g.lineWidth = 1; g.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
}

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
  g.fillStyle = "#9aa0ad"; g.beginPath(); g.arc(cx, cy, 13, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#7fb6d8"; g.beginPath(); g.arc(cx, cy, 9, 0, Math.PI * 2); g.fill();
  put(g, S.plant, bx + 4, by + 4);
  put(g, S.plant, bx + bw - 18, by + bh - 18);
  g.strokeStyle = "#2f2a22"; g.lineWidth = 1; g.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
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
