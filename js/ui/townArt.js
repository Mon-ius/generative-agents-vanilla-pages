// townArt.js — shared town geometry + procedural art.
//
// Both renderers use this so they agree on layout exactly:
//   - PixiMapView (primary, WebGL via PixiJS) uses drawTown() to bake the static
//     world into a texture, then animates agents as Pixi objects on top.
//   - MapView (canvas 2D fallback) uses the same layout + drawTown() + helpers.
//
// Pure drawing/geometry; no engine-specific code.

import { seededRandom } from "../utils/random.js";

export const CELL = 132; // logical px per grid cell (building + yard)

export const ROOF = {
  home: "#8a6fc4", cafe: "#e07a3c", park: "#4fa05a", library: "#3f78c0",
  school: "#e6b53c", shop: "#cf5aa0", civic: "#2f9e9e", health: "#7d5ad0",
  studio: "#d6486a", square: "#9aa0ad",
};
const WALL = "#f3ead7";
const WALL_SHADE = "#e2d4ba";

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
    const bw = CELL * 0.62;
    const bh = CELL * 0.5;
    const bx = cx - bw / 2;
    const by = cy - bh / 2 - 8;
    rects.set(l.id, { loc: l, cx, cy, bx, by, bw, bh, door: { x: cx, y: by + bh + 14 } });
  }
  return { cols, rows, W, H, CELL, rects };
}

// Standing spot for occupant `index` of `count` at a location (fans them out).
export function spotFor(layout, locId, index, count) {
  const r = layout.rects.get(locId);
  if (!r) return { x: layout.W / 2, y: layout.H / 2 };
  if (count <= 1) return { x: r.door.x, y: r.door.y };
  const spread = Math.min(CELL * 0.5, 22 * (count - 1));
  const start = r.door.x - spread / 2;
  const step = count > 1 ? spread / (count - 1) : 0;
  return { x: start + step * index, y: r.door.y + (index % 2) * 10 };
}

// Draw the static world (grass, paths, trees, buildings) onto a 2D context.
export function drawTown(g, layout) {
  const { W, H, cols, rows, rects } = layout;
  const rnd = seededRandom("willow-creek-art");

  // grass + dithered tiles
  g.fillStyle = "#84b95a";
  g.fillRect(0, 0, W, H);
  const t = 22;
  for (let y = 0; y < H; y += t) {
    for (let x = 0; x < W; x += t) {
      if ((x / t + y / t) % 2 === 0) { g.fillStyle = "#7fb354"; g.fillRect(x, y, t, t); }
      if (rnd() < 0.05) { g.fillStyle = "#74a84c"; g.fillRect(x + 4, y + 4, 5, 5); }
    }
  }

  // tan path grid along row/column "streets"
  g.fillStyle = "#d8c39a";
  const road = 26;
  for (let c = 0; c < cols; c++) g.fillRect(c * CELL + CELL / 2 - road / 2, 0, road, H);
  for (let r = 0; r < rows; r++) g.fillRect(0, r * CELL + CELL / 2 - road / 2, W, road);
  g.fillStyle = "#cdb487";
  for (let i = 0; i < W * rows * 0.02; i++) g.fillRect(Math.floor(rnd() * W), Math.floor(rnd() * H), 3, 3);

  // trees in some yards
  for (const r of rects.values()) {
    if (rnd() < 0.55) tree(g, r.cx - CELL * 0.4 + rnd() * 8, r.cy - CELL * 0.36);
    if (rnd() < 0.45) tree(g, r.cx + CELL * 0.36, r.cy + CELL * 0.34);
  }

  // buildings, back-to-front
  for (const r of [...rects.values()].sort((a, b) => a.cy - b.cy)) building(g, r);
}

function tree(g, x, y) {
  g.fillStyle = "rgba(40,60,30,0.18)";
  g.beginPath(); g.ellipse(x, y + 12, 12, 5, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#7a5a36"; g.fillRect(x - 2, y, 4, 12);
  g.fillStyle = "#3f8a44"; g.beginPath(); g.arc(x, y - 4, 11, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#4fa052"; g.beginPath(); g.arc(x - 4, y - 2, 6, 0, Math.PI * 2); g.fill();
}

function building(g, r) {
  const roof = ROOF[r.loc.type] || "#9aa0ad";
  g.fillStyle = "rgba(30,35,45,0.18)"; g.fillRect(r.bx + 3, r.by + r.bh - 2, r.bw, 12);
  g.fillStyle = WALL; g.fillRect(r.bx, r.by, r.bw, r.bh);
  g.fillStyle = WALL_SHADE; g.fillRect(r.bx, r.by + r.bh - 8, r.bw, 8);
  g.fillStyle = roof;
  g.beginPath();
  g.moveTo(r.bx - 6, r.by);
  g.lineTo(r.bx + r.bw + 6, r.by);
  g.lineTo(r.bx + r.bw - 6, r.by - r.bh * 0.5);
  g.lineTo(r.bx + 6, r.by - r.bh * 0.5);
  g.closePath(); g.fill();
  g.fillStyle = shade(roof, -0.12); g.fillRect(r.bx - 6, r.by - 3, r.bw + 12, 4);
  g.fillStyle = shade(roof, -0.28);
  const dw = 14, dh = 20;
  g.fillRect(r.cx - dw / 2, r.by + r.bh - dh, dw, dh);
  g.fillStyle = "#bfe0ef";
  g.fillRect(r.bx + 8, r.by + 8, 12, 12);
  g.fillRect(r.bx + r.bw - 20, r.by + 8, 12, 12);
  const label = r.loc.name.replace(/^(The|Town|Community|Corner|Willow|Cedar)\s+/i, "") || r.loc.name;
  g.font = "600 12px ui-monospace, Menlo, Consolas, monospace";
  const tw = Math.min(g.measureText(label).width + 14, CELL * 0.92);
  const sx = r.cx - tw / 2;
  const sy = r.by + r.bh + 6;
  g.fillStyle = "#3a2f23"; roundRect(g, sx, sy, tw, 18, 5); g.fill();
  g.fillStyle = "#f4ead4"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(label, r.cx, sy + 10, tw - 8);
  g.textAlign = "left";
}

// ---- shared helpers ----------------------------------------------------------
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

// Day/night ambient overlay {r,g,b,a} from minutes-into-day, via keyframe lerp.
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
