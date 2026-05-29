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

export const CELL = 132;        // logical px per grid cell
export const TEXTURE_SCALE = 2; // bake the static world at 2× for crisp detail

export const ROOF = {
  home: "#8a6fc4", cafe: "#e07a3c", park: "#4fa05a", library: "#3f78c0",
  school: "#e6b53c", shop: "#cf5aa0", civic: "#2f9e9e", health: "#7d5ad0",
  studio: "#d6486a", square: "#9aa0ad",
};

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
    const bw = Math.round(CELL * 0.82);
    const bh = Math.round(CELL * 0.64);
    const bx = Math.round(cx - bw / 2);
    const by = Math.round(cy - bh / 2 - 6);
    rects.set(l.id, { loc: l, cx, cy, bx, by, bw, bh, door: { x: cx, y: by + bh + 12 } });
  }
  return { cols, rows, W, H, CELL, rects };
}

export function spotFor(layout, locId, index, count) {
  const r = layout.rects.get(locId);
  if (!r) return { x: layout.W / 2, y: layout.H / 2 };
  if (count <= 1) return { x: r.door.x, y: r.door.y };
  const spread = Math.min(CELL * 0.5, 22 * (count - 1));
  const start = r.door.x - spread / 2;
  const step = count > 1 ? spread / (count - 1) : 0;
  return { x: start + step * index, y: r.door.y + (index % 2) * 10 };
}

// Create the baked static-world canvas at TEXTURE_SCALE (caller draws agents on top).
export function makeTownCanvas(layout, scale = TEXTURE_SCALE) {
  const cv = document.createElement("canvas");
  cv.width = Math.round(layout.W * scale);
  cv.height = Math.round(layout.H * scale);
  const g = cv.getContext && cv.getContext("2d");
  if (g) {
    g.scale(scale, scale);
    drawTown(g, layout);
  }
  return cv;
}

// ---- world ------------------------------------------------------------------
export function drawTown(g, layout) {
  const { W, H, cols, rows, rects } = layout;
  const rnd = seededRandom("willow-creek-art-v2");

  drawGrass(g, W, H, rnd);
  drawPaths(g, layout, rnd);

  // standalone flower beds (echo the flower field) at a couple of deterministic spots
  flowerBed(g, W - 150, 70, 110, 46, seededRandom("bed-a"));
  flowerBed(g, 70, H - 80, 90, 40, seededRandom("bed-b"));

  // scattered trees around building edges / corners
  for (const r of rects.values()) {
    const tr = seededRandom("tree-" + r.loc.id);
    if (tr() < 0.6) tree(g, r.bx - 16 + tr() * 6, r.by - 6, 0.9 + tr() * 0.3, tr);
    if (tr() < 0.5) tree(g, r.bx + r.bw + 14, r.by + r.bh + 6, 0.85 + tr() * 0.3, tr);
  }

  // buildings / park / plaza, back-to-front for correct overlap
  for (const r of [...rects.values()].sort((a, b) => a.cy - b.cy)) {
    const rng = seededRandom("bld-" + r.loc.id);
    if (r.loc.type === "park") drawPark(g, r, rng);
    else if (r.loc.type === "square") drawPlaza(g, r, rng);
    else drawBuilding(g, r, rng);
  }
}

function drawGrass(g, W, H, rnd) {
  g.fillStyle = C.grass;
  g.fillRect(0, 0, W, H);
  const t = 24;
  for (let y = 0; y < H; y += t) {
    for (let x = 0; x < W; x += t) {
      if ((x / t + y / t) % 2 === 0) { g.fillStyle = C.grassCheck; g.fillRect(x, y, t, t); }
    }
  }
  // grass tufts + tiny flowers/pebbles
  for (let i = 0; i < W * H * 0.0016; i++) {
    const x = Math.floor(rnd() * W);
    const y = Math.floor(rnd() * H);
    const k = rnd();
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

function drawPaths(g, layout, rnd) {
  const { W, H, cols, rows } = layout;
  const road = 30;
  const draw = (x, y, w, h) => {
    g.fillStyle = C.pathEdge; g.fillRect(x - 2, y - 2, w + 4, h + 4);
    g.fillStyle = C.path; g.fillRect(x, y, w, h);
  };
  for (let c = 0; c < cols; c++) draw(c * CELL + CELL / 2 - road / 2, 0, road, H);
  for (let r = 0; r < rows; r++) draw(0, r * CELL + CELL / 2 - road / 2, W, road);
  // lighter centre + speckle
  g.fillStyle = C.pathMid;
  for (let c = 0; c < cols; c++) g.fillRect(c * CELL + CELL / 2 - 4, 0, 8, H);
  for (let r = 0; r < rows; r++) g.fillRect(0, r * CELL + CELL / 2 - 4, W, 8);
  g.fillStyle = C.pathSpeck;
  for (let i = 0; i < (W * rows) * 0.02; i++) g.fillRect(Math.floor(rnd() * W), Math.floor(rnd() * H), 2, 2);
}

// ---- buildings (cut-away interiors) -----------------------------------------
function drawBuilding(g, r, rnd) {
  const roof = ROOF[r.loc.type] || "#9aa0ad";
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

  // dark outline + roof eave overhang on top
  g.strokeStyle = C.wallLine; g.lineWidth = 1.5;
  g.strokeRect(r.bx + 0.5, r.by + 4.5, r.bw - 1, r.bh - 4);
  g.fillStyle = roof; g.fillRect(r.bx - 4, r.by, r.bw + 8, 6);
  g.fillStyle = shade(roof, -0.16); g.fillRect(r.bx - 4, r.by + 5, r.bw + 8, 2);

  composeInterior(g, r.loc.type, ix, iy, iw, ih, roof, rnd);

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
