// pack_locations.mjs — lay the town out like a REAL community: a grid of CITY
// BLOCKS separated by a continuous network of PAVED STREETS so the residents
// have visible roads to walk.
//
//   * Buildings of a type form tight apartment COMPLEXES (members occupy
//     CONTIGUOUS cells); complexes are skyline-packed into fixed BW×BH blocks.
//   * Blocks tile a roughly-square grid; the 1-cell gaps between them are
//     full-length STREETS (type 'street') — straight avenues both ways.
//   * Every cell a block doesn't use becomes a landscaped GREEN courtyard (the
//     odd paved PLAZA), and the hand-authored parks/squares pack in as plots —
//     so the town is GAP-FREE: every cell is a building, a street or a green,
//     never bare grass. The whole grid floats in the field of grass.
//
// Idempotent: previously-generated street/filler plots (ids `loc_street_*` /
// `loc_fill_*`) are stripped on import and regenerated fresh, so re-running
// never accumulates them.
//
// Run: node tools/pack_locations.mjs
import { SEED_LOCATIONS } from "../js/data/seedLocations.js";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "js", "data", "seedLocations.js");

// Drop any generated street/filler plots from a previous run so packing is
// reproducible (only the real buildings + hand-authored parks/squares remain).
const real = SEED_LOCATIONS.filter((l) => !/^loc_(street|fill)_/.test(l.id));

// Existing outdoor plots (hand-authored parks/squares) pack in as 1×1 blocks.
const isOutdoor = (l) => l.type === "park" || l.type === "square";
const buildings = real.filter((l) => !isOutdoor(l));
const outdoor = real.filter(isOutdoor);

// ---------------------------------------------------------------------------
// Block dimensions. A block holds up to BW×BH building cells; the 1-cell gaps
// between blocks are streets. Keep BW/BH >= the largest complex dimension so
// every complex fits some block.
// ---------------------------------------------------------------------------
const BW = 5, BH = 5;

// group buildings by type, splitting large type-groups into complexes of <= MAX.
// cols is capped at the member count AND at BW so the reserved cols×rows box
// always fits a block and never reserves a cell the members don't fill.
const MAX = 8;
const byType = new Map();
for (const l of buildings) { if (!byType.has(l.type)) byType.set(l.type, []); byType.get(l.type).push(l); }
const complexes = [];
let cid = 0;
for (const [type, locs] of byType) {
  for (let i = 0; i < locs.length; i += MAX) {
    const members = locs.slice(i, i + MAX);
    const n = members.length;
    const cols = Math.min(n, BW, Math.max(1, Math.min(5, Math.round(Math.sqrt(n * 1.5))))); // wide-ish, <= n and <= BW
    const rows = Math.ceil(n / cols);
    complexes.push({ id: "cx" + cid++, type, members, cols, rows });
  }
}
// each existing park/square is its own 1×1 block member, mixed into the packing
for (const l of outdoor) complexes.push({ id: "out_" + l.id, type: l.type, members: [l], cols: 1, rows: 1 });

// first-fit-DECREASING: tallest/biggest complexes first so the skyline packer
// seats the bulky ones and the small ones slot into the gaps.
complexes.sort((a, b) => (b.rows - a.rows) || (b.cols - a.cols) || (b.cols * b.rows - a.cols * a.rows));

// ---------------------------------------------------------------------------
// Skyline-pack complexes into BW×BH blocks: fill a block with every remaining
// complex that fits (leftmost-lowest), carry the rest to the next block.
// ---------------------------------------------------------------------------
const blocks = [];
let remaining = complexes.slice();
let guard = 0;
while (remaining.length && guard++ < 10000) {
  const colH = new Array(BW).fill(0);     // skyline: filled height per column
  const placements = [], rest = [];
  for (const c of remaining) {
    let bestX = -1, bestY = BH + 1;
    for (let x = 0; x + c.cols <= BW; x++) {
      let top = 0;
      for (let i = 0; i < c.cols; i++) top = Math.max(top, colH[x + i]);
      if (top + c.rows <= BH && top < bestY) { bestY = top; bestX = x; }
    }
    if (bestX >= 0) { placements.push({ c, x: bestX, y: bestY }); for (let i = 0; i < c.cols; i++) colH[bestX + i] = bestY + c.rows; }
    else rest.push(c);
  }
  if (!placements.length) throw new Error("complex too big for a block: " + (rest[0] && rest[0].id));
  blocks.push({ placements });
  remaining = rest;
}

// arrange blocks in a roughly-square grid, with 1-cell streets between them
const blocksN = blocks.length;
const BLOCKS_COLS = Math.max(1, Math.round(Math.sqrt(blocksN)));
const BLOCKS_ROWS = Math.ceil(blocksN / BLOCKS_COLS);
blocks.forEach((blk, bi) => {
  const bc = bi % BLOCKS_COLS, br = Math.floor(bi / BLOCKS_COLS);
  blk.ox = bc * (BW + 1);
  blk.oy = br * (BH + 1);
  for (const p of blk.placements) {
    const c = p.c;
    c.members.forEach((l, k) => { l.x = blk.ox + p.x + (k % c.cols); l.y = blk.oy + p.y + Math.floor(k / c.cols); l.complex = c.id; });
  }
});
const townW = BLOCKS_COLS * (BW + 1) - 1;   // no trailing street on the far edge
const townH = BLOCKS_ROWS * (BH + 1) - 1;

// ---------------------------------------------------------------------------
// Classify every cell of the town grid: building (occupied by a complex shell),
// street (the gaps between blocks → continuous avenues), or green/plaza (any
// cell a block didn't use, plus the cells of unused grid slots). No cell is bare.
// ---------------------------------------------------------------------------
const key = (x, y) => x + "," + y;
const occ = new Set();   // building/shell cells (whole cols×rows box per complex)
for (const blk of blocks) for (const p of blk.placements) {
  for (let j = 0; j < p.c.rows; j++) for (let i = 0; i < p.c.cols; i++) occ.add(key(blk.ox + p.x + i, blk.oy + p.y + j));
}
const isStreetCol = (x) => (x % (BW + 1)) === BW;   // the single column between two block columns
const isStreetRow = (y) => (y % (BH + 1)) === BH;   // the single row between two block rows

const STREET_NAMES = ["Main Street", "Oak Lane", "Maple Avenue", "Elm Street", "Cedar Lane", "Birch Avenue", "Pine Street", "Willow Lane", "Chestnut Avenue", "River Road", "Market Street", "Park Lane", "Mill Road", "Bridge Street", "Garden Lane"];
const GREEN_NAMES = ["Maple Green", "Cedar Green", "Willow Green", "Linden Green", "Birch Green", "Elm Green", "Aspen Green", "Hawthorn Green", "Rowan Green", "Alder Green", "Sycamore Green", "Juniper Green"];
const PLAZA_NAMES = ["Market Plaza", "Fountain Square", "Founders' Plaza", "Old Town Square", "Chapel Plaza", "Mill Plaza"];

const streets = [], fillers = [];
let si = 0, fi = 0;
for (let y = 0; y < townH; y++) {
  for (let x = 0; x < townW; x++) {
    if (occ.has(key(x, y))) continue;                       // building cell
    if (isStreetCol(x) || isStreetRow(y)) {                 // continuous street grid
      streets.push({
        id: "loc_street_" + si,
        name: STREET_NAMES[si % STREET_NAMES.length],
        type: "street",
        x, y,
        description: "a paved street lined with lamps where neighbours pass by.",
        tags: ["street", "road", "outdoor"],   // NOTE: no park/square/cafe tag — never a plan destination
        complex: "out_street_" + si,
      });
      si++;
    } else {                                                // unused block cell → courtyard
      const plaza = ((x * 7 + y * 13 + fi) % 6) === 0;      // ~1 in 6 courtyards is a paved plaza
      fillers.push({
        id: "loc_fill_" + fi,
        name: plaza ? PLAZA_NAMES[fi % PLAZA_NAMES.length] : GREEN_NAMES[fi % GREEN_NAMES.length],
        type: plaza ? "plaza" : "green",
        x, y,
        description: plaza ? "a paved plaza around a stone fountain." : "a leafy green with benches and flower beds.",
        tags: plaza ? ["square", "public", "outdoor"] : ["park", "public", "outdoor"],
        complex: "out_fill_" + fi,
      });
      fi++;
    }
  }
}

const out = real.concat(streets, fillers);

// sanity: unique coords
const seen = new Set();
for (const l of out) { const k = l.x + "," + l.y; if (seen.has(k)) throw new Error("dup coord " + k + " at " + l.id); seen.add(k); }

const header =
`// seedLocations.js — town laid out as a REAL community: apartment COMPLEXES
// (contiguous rooms) skyline-packed into a grid of CITY BLOCKS, separated by a
// continuous network of PAVED STREETS (type 'street'). Hand-authored parks/
// squares and landscaped 'green'/'plaza' courtyards fill every remaining cell,
// so nothing is bare grass. Generated by tools/pack_locations.mjs (idempotent —
// re-run to re-pack; loc_street_*/loc_fill_* are regenerated). Only x/y and
// 'complex' are assigned; the real buildings' ids/types/tags are unchanged.

`;
writeFileSync(OUT, header + "export const SEED_LOCATIONS = " + JSON.stringify(out, null, 2) + ";\n");
console.log(`packed ${buildings.length} building rooms into ${complexes.length - outdoor.length} complexes + ${outdoor.length} plots; ${blocksN} blocks in a ${BLOCKS_COLS}x${BLOCKS_ROWS} grid; ${streets.length} street cells; ${fillers.length} green/plaza courtyards; town ${townW}x${townH}; total ${out.length} locations`);
