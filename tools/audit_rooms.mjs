// audit_rooms.mjs — DETERMINISTIC room-furniture overlap audit.
//
// Instruments the REAL sprite render path (townArt.drawTownInto with a mock canvas
// + mock sprites sized from assets/manifest.json) so it records the exact rectangle
// of every furniture sprite, tagged with the room (clip rect) it was drawn under.
// Then it reports, per building type:
//   * furniture/ furniture overlaps WITHIN a room (excluding intended underlays:
//     rugs/doormats, and the diningSet table↔chair tuck), with overlap area, and
//   * furniture that SPILLS outside its room rect (visually clipped → cramped plan).
//
// No DOM, no Chrome — pure geometry from the real draw calls. Run:
//   node tools/audit_rooms.mjs            (summary)
//   node tools/audit_rooms.mjs --verbose  (every flagged pair)
import { Simulation } from "../js/simulation/Simulation.js";
import { LocalGenerationProvider } from "../js/agents/GenerationProvider.js";
import { SEED_AGENTS } from "../js/data/seedAgents.js";
import { SEED_LOCATIONS } from "../js/data/seedLocations.js";
import { SEED_EVENTS } from "../js/data/seedEvents.js";
import { computeLayout, drawTownInto, BED } from "../js/ui/townArt.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERBOSE = process.argv.includes("--verbose");

// ---- mock sprites: name -> { width, height } at the runtime (ART_SS×) size -------
const manifest = JSON.parse(readFileSync(join(ROOT, "assets", "manifest.json"), "utf8"));
const S = {};
for (const [name, r] of Object.entries(manifest.sprites)) S[name] = { width: r.w, height: r.h, __name: name };

// floors/walls/structure/ground — NOT furniture; excluded from overlap checks.
const STRUCT = new Set([
  "grass", "grass2", "path", "gravel", "sand", "deck", "corridor",
  "floor_wood", "floor_tile", "floor_pink", "wall", "wall2", "window", "door",
  "hedge",
]);
// intended underlays: a rug/mat sits UNDER other furniture by design.
const UNDERLAY = new Set(["rug", "rug_blue", "rug_green", "doormat"]);

// ---- mock 2D context: records drawImage rects with the active clip rect ----------
function mockCtx() {
  const records = [];
  let state = { clip: null };
  const stack = [];
  let pendRect = null; // last rect() since beginPath (single-rect clips only)
  const intersect = (a, b) => {
    if (!a) return b; if (!b) return a;
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    const r = Math.min(a.x + a.w, b.x + b.w), bot = Math.min(a.y + a.h, b.y + b.h);
    return { x, y, w: Math.max(0, r - x), h: Math.max(0, bot - y) };
  };
  const noop = () => {};
  const g = {
    canvas: { width: 1, height: 1 },
    save() { stack.push({ clip: state.clip }); },
    restore() { if (stack.length) state = stack.pop(); },
    beginPath() { pendRect = null; },
    rect(x, y, w, h) { pendRect = { x, y, w, h }; },
    clip() { if (pendRect) state.clip = intersect(state.clip, pendRect); },
    drawImage(img, x, y, w, h) {
      // clipTile/grass pass through tiny 16px tiles; we record everything but tag name.
      records.push({ name: img && img.__name, x, y, w, h, clip: state.clip });
    },
    measureText(t) { const f = this._fontPx || 9; return { width: String(t).length * f * 0.58 }; },
    fillText: noop, strokeText: noop,
    fillRect: noop, strokeRect: noop, clearRect: noop,
    moveTo: noop, lineTo: noop, arc: noop, arcTo: noop, ellipse: noop, quadraticCurveTo: noop, bezierCurveTo: noop, closePath: noop, roundRect: noop,
    fill: noop, stroke: noop,
    translate: noop, scale: noop, rotate: noop, setTransform: noop, transform: noop, resetTransform: noop,
    createLinearGradient() { return { addColorStop: noop }; },
    createRadialGradient() { return { addColorStop: noop }; },
    createPattern() { return null; },
    setLineDash: noop, getImageData() { return { data: [] }; }, putImageData: noop,
  };
  // font is a setter so nameSign's measureText scales; track px for width estimate.
  Object.defineProperty(g, "font", { set(v) { const m = /(\d+(?:\.\d+)?)px/.exec(v); this._fontPx = m ? +m[1] : 9; }, get() { return (this._fontPx || 9) + "px monospace"; } });
  for (const k of ["fillStyle", "strokeStyle", "lineWidth", "globalAlpha", "lineJoin", "lineCap", "textAlign", "textBaseline", "imageSmoothingEnabled", "shadowColor", "shadowBlur", "globalCompositeOperation"]) g[k] = 0;
  return { g, records };
}

// ---- run the real renderer ------------------------------------------------------
const sim = new Simulation({ seed: "smallville-2024", agents: SEED_AGENTS, locations: SEED_LOCATIONS, events: SEED_EVENTS, provider: new LocalGenerationProvider() });
const layout = computeLayout(sim);
const { g, records } = mockCtx();
drawTownInto(g, layout, S, { x: 0, y: 0, w: layout.W, h: layout.H }, {});

// ---- group furniture records by room (clip rect) --------------------------------
// Map each occupied building cell -> its type, to label rooms.
const cellType = new Map();
for (const rc of layout.rects.values()) cellType.set(Math.floor(rc.loc.x) + "," + Math.floor(rc.loc.y), rc.loc.type);
const typeOfClip = (clip) => {
  if (!clip) return "?";
  const cx = Math.floor((clip.x + clip.w / 2) / 176), cy = Math.floor((clip.y + clip.h / 2) / 176);
  return cellType.get(cx + "," + cy) || "?";
};

const rooms = new Map(); // clipKey -> { type, items:[{name,x,y,w,h}], clip }
for (const r of records) {
  if (!r.name || STRUCT.has(r.name)) continue;          // skip ground/walls/floors
  if (!r.clip || r.clip.w < 4 || r.clip.h < 4) continue; // unclipped/degenerate
  // a "room" is identified by its clip rectangle (furnish clips to the room rect)
  const k = [Math.round(r.clip.x), Math.round(r.clip.y), Math.round(r.clip.w), Math.round(r.clip.h)].join(":");
  if (!rooms.has(k)) rooms.set(k, { type: typeOfClip(r.clip), items: [], clip: r.clip });
  rooms.get(k).items.push(r);
}

// ---- overlap detection ----------------------------------------------------------
const overlapArea = (a, b) => {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w), bot = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, r - x) * Math.max(0, bot - y);
};
const isDining = (n) => /^(table|chair|chair_red|chair_yellow|chair_green|chair)$/.test(n);

// per-type aggregation
const byType = new Map(); // type -> { rooms:0, overlaps:[], spills:[] }
const bump = (t) => { if (!byType.has(t)) byType.set(t, { rooms: 0, overlaps: [], spills: [] }); return byType.get(t); };

for (const room of rooms.values()) {
  const T = bump(room.type); T.rooms++;
  const it = room.items;
  // furniture-furniture overlaps
  for (let i = 0; i < it.length; i++) for (let j = i + 1; j < it.length; j++) {
    const a = it[i], b = it[j];
    if (UNDERLAY.has(a.name) || UNDERLAY.has(b.name)) continue;   // rug/mat underlay — intended
    if (isDining(a.name) && isDining(b.name)) continue;           // diningSet tuck — intended
    const area = overlapArea(a, b);
    if (area < 6) continue;                                       // ignore ≤ a few px touching
    const minA = Math.min(a.w * a.h, b.w * b.h);
    const frac = area / minA;                                    // overlap as fraction of smaller item
    if (frac < 0.12) continue;                                   // ignore slight clipping/touch
    T.overlaps.push({ a: a.name, b: b.name, area: Math.round(area), frac: +frac.toFixed(2), clip: room.clip });
  }
  // furniture spilling outside the room rect (visually clipped → cramped / mis-placed)
  const c = room.clip, EPS = 2;
  for (const a of it) {
    const outL = c.x - a.x, outT = c.y - a.y, outR = (a.x + a.w) - (c.x + c.w), outB = (a.y + a.h) - (c.y + c.h);
    const out = Math.max(outL, outT, outR, outB);
    if (out > EPS && Math.min(a.w, a.h) > 0) {
      const frac = out / Math.min(a.w, a.h);
      if (frac > 0.18) T.spills.push({ name: a.name, out: Math.round(out), frac: +frac.toFixed(2) });
    }
  }
}

// ---- bed-spot alignment (sleep feature) ------------------------------------------
// Every layout.bedAssign feet-anchor spot must land ON a drawn bed sprite rect of
// the expected (BED.w × BED.h) size, one DISTINCT drawn bed per sleeper. This pins
// the computeBedAssignments ↔ furnish geometry (shared via bedPlacement) against
// the REAL draw path — including the sprite's manifest dims (re-author the bed tile
// at a new size and the size-mismatch counter trips while BED.w/h are stale).
const bedNames = new Set(["bed", "bed_red", "bed_green"]);
const bedRects = records.filter((r) => r.name && bedNames.has(r.name));
let bedMisses = 0, bedSizeMis = 0;
{
  const used = new Set();
  for (const [agentId, spot] of layout.bedAssign) {
    const hit = bedRects.find((r) => !used.has(r) &&
      spot.x >= r.x && spot.x <= r.x + r.w && spot.y >= r.y && spot.y <= r.y + r.h);
    if (!hit) {
      bedMisses++;
      if (VERBOSE) console.log(`bed-spot MISS: ${agentId} @ ${spot.x.toFixed(1)},${spot.y.toFixed(1)} (${spot.locId})`);
      continue;
    }
    used.add(hit);
    if (Math.abs(hit.w - BED.w) > 0.5 || Math.abs(hit.h - BED.h) > 0.5) {
      bedSizeMis++;
      if (VERBOSE) console.log(`bed SIZE drift: drawn ${hit.w}×${hit.h} vs BED ${BED.w}×${BED.h} (${spot.locId})`);
    }
  }
}

// ---- report ---------------------------------------------------------------------
const types = [...byType.keys()].sort();
let totO = 0, totS = 0;
console.log(`Rooms audited: ${rooms.size}  (across ${types.length} building types)\n`);
console.log("type        rooms  overlaps  spills   worst-overlap");
for (const t of types) {
  const d = byType.get(t);
  totO += d.overlaps.length; totS += d.spills.length;
  const worst = d.overlaps.slice().sort((x, y) => y.frac - x.frac)[0];
  const w = worst ? `${worst.a}×${worst.b} ${Math.round(worst.frac * 100)}%` : "—";
  console.log(`${t.padEnd(11)} ${String(d.rooms).padStart(4)}  ${String(d.overlaps.length).padStart(7)}  ${String(d.spills.length).padStart(6)}   ${w}`);
}
console.log(`\nTOTAL unintended furniture overlaps: ${totO};  out-of-room spills: ${totS};  bed-spot misses: ${bedMisses} (${layout.bedAssign.size} sleepers, size drift ${bedSizeMis})`);

if (VERBOSE) {
  console.log("\n--- detail (unique by type+pair) ---");
  for (const t of types) {
    const d = byType.get(t);
    const seen = new Map();
    for (const o of d.overlaps) { const k = o.a + "×" + o.b; seen.set(k, Math.max(seen.get(k) || 0, o.frac)); }
    const sp = new Map();
    for (const s of d.spills) { const k = s.name; sp.set(k, Math.max(sp.get(k) || 0, s.frac)); }
    if (!seen.size && !sp.size) continue;
    console.log(`\n[${t}]`);
    for (const [k, f] of [...seen.entries()].sort((a, b) => b[1] - a[1])) console.log(`   overlap ${k}  up to ${Math.round(f * 100)}% of smaller`);
    for (const [k, f] of [...sp.entries()].sort((a, b) => b[1] - a[1])) console.log(`   spill   ${k}  out ${Math.round(f * 100)}% of its size`);
  }
}
