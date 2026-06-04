// pack_locations.mjs — repack the town as a DENSE, GAP-FREE block. Building TYPES
// form tight apartment COMPLEXES (members occupy CONTIGUOUS cells), the complexes
// are bin-packed (first-fit-decreasing) into a roughly square footprint with NO
// grass lanes between them, existing parks/squares are interspersed as 1×1 plots,
// and EVERY remaining empty cell inside the town's bounding box is filled with a
// landscaped GREEN (or the occasional paved PLAZA) so there are no bare gaps. The
// town then floats as one solid block in the boundless field of grass.
//
// Idempotent: previously-generated filler plots (id `loc_fill_*`) are stripped on
// import and regenerated fresh, so re-running never accumulates fillers.
//
// Run: node tools/pack_locations.mjs
import { SEED_LOCATIONS } from "../js/data/seedLocations.js";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "js", "data", "seedLocations.js");

// Drop any fillers from a previous run so packing is reproducible.
const real = SEED_LOCATIONS.filter((l) => !/^loc_fill_/.test(l.id));

// Existing outdoor plots (hand-authored parks/squares) intersperse as 1×1 plots.
const isOutdoor = (l) => l.type === "park" || l.type === "square";
const buildings = real.filter((l) => !isOutdoor(l));
const outdoor = real.filter(isOutdoor);

// group buildings by type, splitting large type-groups into complexes of <= MAX
const MAX = 8;
const byType = new Map();
for (const l of buildings) { if (!byType.has(l.type)) byType.set(l.type, []); byType.get(l.type).push(l); }
const complexes = [];
let cid = 0;
for (const [type, locs] of byType) {
  for (let i = 0; i < locs.length; i += MAX) {
    const members = locs.slice(i, i + MAX);
    const n = members.length;
    const cols = Math.max(2, Math.min(5, Math.round(Math.sqrt(n * 1.5)))); // wider than tall
    const rows = Math.ceil(n / cols);
    complexes.push({ id: "cx" + cid++, type, members, cols, rows });
  }
}
// each existing park/square is its own 1×1 plot, mixed into the packing
for (const l of outdoor) complexes.push({ id: "out_" + l.id, type: l.type, members: [l], cols: 1, rows: 1, outdoor: true });

// first-fit-DECREASING: tallest/biggest blocks first, small ones fill the corners
complexes.sort((a, b) => (b.rows - a.rows) || (b.cols - a.cols) || (b.cols * b.rows - a.cols * a.rows));

// town width: enough to make the packed footprint roughly square
const totalCells = complexes.reduce((s, c) => s + c.cols * c.rows, 0);
const TW = Math.max(8, Math.round(Math.sqrt(totalCells * 1.35)));

// occupancy of the full bounding box (a complex reserves its WHOLE cols×rows
// rectangle — interior gaps belong to its shell, never to a filler).
const occ = new Set();
const key = (x, y) => x + "," + y;
const fits = (x, y, w, h) => {
  if (x + w > TW) return false;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (occ.has(key(x + i, y + j))) return false;
  return true;
};
function place(c) {
  for (let y = 0; y < 4000; y++) {
    for (let x = 0; x + c.cols <= TW; x++) {
      if (!fits(x, y, c.cols, c.rows)) continue;
      for (let j = 0; j < c.rows; j++) for (let i = 0; i < c.cols; i++) occ.add(key(x + i, y + j));
      c.members.forEach((l, k) => { l.x = x + (k % c.cols); l.y = y + Math.floor(k / c.cols); l.complex = c.id; });
      c.x0 = x; c.y0 = y;
      return;
    }
  }
  throw new Error("could not place complex " + c.id);
}
for (const c of complexes) place(c);

// town bounding box height
let maxY = 0;
for (const k of occ) maxY = Math.max(maxY, +k.split(",")[1]);

// fill EVERY empty cell in [0,TW)×[0,maxY] with a landscaped plot — no bare gaps
const GREEN_NAMES = ["Maple Green", "Cedar Green", "Willow Green", "Linden Green", "Birch Green", "Elm Green", "Aspen Green", "Hawthorn Green", "Rowan Green", "Alder Green", "Sycamore Green", "Juniper Green"];
const PLAZA_NAMES = ["Market Plaza", "Fountain Square", "Founders' Plaza", "Old Town Square", "Chapel Plaza", "Mill Plaza"];
const fillers = [];
let fi = 0;
for (let y = 0; y <= maxY; y++) {
  for (let x = 0; x < TW; x++) {
    if (occ.has(key(x, y))) continue;
    occ.add(key(x, y));
    const plaza = ((x * 7 + y * 13 + fi) % 6) === 0;        // ~1 in 6 fillers is a paved plaza
    const type = plaza ? "plaza" : "green";
    const name = plaza ? PLAZA_NAMES[fi % PLAZA_NAMES.length] : GREEN_NAMES[fi % GREEN_NAMES.length];
    fillers.push({
      id: "loc_fill_" + fi,
      name,
      type,
      x, y,
      description: plaza ? "a paved plaza around a stone fountain." : "a leafy green with benches and flower beds.",
      tags: plaza ? ["square", "public", "outdoor"] : ["park", "public", "outdoor"],
      complex: "out_fill_" + fi,
    });
    fi++;
  }
}

const out = real.concat(fillers);

// sanity: unique coords
const seen = new Set();
for (const l of out) { const k = l.x + "," + l.y; if (seen.has(k)) throw new Error("dup coord " + k + " at " + l.id); seen.add(k); }

const header =
`// seedLocations.js — town packed into a DENSE, GAP-FREE block of apartment
// COMPLEXES (contiguous rooms) plus interspersed parks/squares and landscaped
// 'green'/'plaza' fillers so no cell inside the town is bare grass. Generated by
// tools/pack_locations.mjs (idempotent — re-run to re-pack; loc_fill_* are
// regenerated). Only x/y and 'complex' are assigned; ids/types/tags are unchanged.

`;
writeFileSync(OUT, header + "export const SEED_LOCATIONS = " + JSON.stringify(out, null, 2) + ";\n");
console.log(`packed ${buildings.length} building rooms into ${complexes.length - outdoor.length} complexes + ${outdoor.length} plots; filled ${fillers.length} green/plaza cells; grid ${TW}x${maxY + 1}; total ${out.length} locations`);
