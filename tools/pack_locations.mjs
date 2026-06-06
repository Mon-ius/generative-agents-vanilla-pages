// pack_locations.mjs — lay the town out like a WELL-PLANNED community: a grid of
// ZONED CITY BLOCKS separated by a continuous network of PAVED STREETS so the
// residents have visible roads to walk.
//
//   * Buildings of a type form tight apartment COMPLEXES (members occupy
//     CONTIGUOUS cells); complexes are skyline-packed into fixed BW×BH blocks
//     WITH A 1-CELL LANDSCAPED GAP between any two complexes (each complex is
//     inflated by one pad cell on its right/bottom while packing, so no two
//     buildings ever touch — the pad cells become green courtyards).
//   * Blocks are ZONE-PURE — every complex type belongs to a zone (commercial /
//     civic / residential / craft) and each block holds one zone only — and the
//     blocks are placed CENTER-OUT in zone order: commercial core, civic ring,
//     residential next, workshops/industry at the edge. Hand-authored parks and
//     squares are dealt round-robin across the zones so every neighbourhood
//     keeps its own green. Leftover grid slots (blocksN < cols×rows) sit at the
//     CENTER and render as all-courtyard park blocks — the town park.
//   * Blocks tile a roughly-square grid; the 1-cell gaps between them are
//     full-length STREETS (type 'street') — straight avenues both ways.
//   * Every cell a block doesn't use becomes a landscaped GREEN courtyard (the
//     odd paved PLAZA) — so the town is GAP-FREE: every cell is a building, a
//     street or a green, never bare grass. The whole grid floats in the field
//     of grass.
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
// between blocks are streets. Keep BW/BH >= the largest complex dimension + 1
// (the pad) so every inflated complex fits some block.
// ---------------------------------------------------------------------------
const BW = 7, BH = 7;

// Zoning: every building type belongs to a zone; blocks are zone-pure and the
// zones are placed center-out in this order (commercial core → craft edge).
const ZONE_ORDER = ["commercial", "civic", "residential", "craft"];
const ZONES = {
  home: "residential",
  market: "commercial", cafe: "commercial", shop: "commercial", bakery: "commercial",
  bar: "commercial", diner: "commercial", salon: "commercial", florist: "commercial",
  pharmacy: "commercial", bank: "commercial", post: "commercial",
  clinic: "civic", school: "civic", civic: "civic", library: "civic", museum: "civic",
  office: "civic", chapel: "civic", theater: "civic", gallery: "civic",
  workshop: "craft", studio: "craft", gym: "craft", dock: "craft", garden: "craft",
};
const zoneOf = (type) => ZONES[type] || "commercial";

// group buildings by type, splitting large type-groups into complexes of <= MAX.
// cols is capped at the member count AND at BW-1 (room for the pad) so the
// inflated cols×rows box always fits a block and never reserves a cell the
// members don't fill.
const MAX = 8;
const byType = new Map();
for (const l of buildings) { if (!byType.has(l.type)) byType.set(l.type, []); byType.get(l.type).push(l); }
const complexes = [];
let cid = 0;
for (const [type, locs] of byType) {
  for (let i = 0; i < locs.length; i += MAX) {
    const members = locs.slice(i, i + MAX);
    const n = members.length;
    const cols = Math.min(n, BW - 1, Math.max(1, Math.min(5, Math.round(Math.sqrt(n * 1.5))))); // wide-ish, <= n and <= BW-1
    const rows = Math.ceil(n / cols);
    complexes.push({ id: "cx" + cid++, type, members, cols, rows, pad: 1 }); // pad: 1-cell gap vs neighbours
  }
}

// zone lists: each zone packs its own blocks. Parks/squares (1×1, no pad — a
// building flush against a park IS the breathing room) are dealt round-robin so
// every zone keeps some green; within a zone, big complexes pack first
// (first-fit-DECREASING) and the 1×1 plots slot into the gaps.
const zoneLists = new Map(ZONE_ORDER.map((z) => [z, []]));
for (const c of complexes) zoneLists.get(zoneOf(c.type)).push(c);
outdoor.forEach((l, i) => zoneLists.get(ZONE_ORDER[i % ZONE_ORDER.length]).push({ id: "out_" + l.id, type: l.type, members: [l], cols: 1, rows: 1, pad: 0 }));
for (const list of zoneLists.values()) list.sort((a, b) => (b.rows - a.rows) || (b.cols - a.cols) || (b.cols * b.rows - a.cols * a.rows));

// ---------------------------------------------------------------------------
// Skyline-pack each zone's complexes into zone-pure BW×BH blocks. A padded
// complex reserves (cols+1)×(rows+1) in a VIRTUAL (BW+1)×(BH+1) grid — the +1
// row/col may overhang onto the street beyond the block edge, so an edge
// complex sits flush with the street while interior neighbours always keep a
// 1-cell courtyard between their actual cells.
// ---------------------------------------------------------------------------
const VW = BW + 1, VH = BH + 1;
const blocks = [];
for (const zone of ZONE_ORDER) {
  let remaining = zoneLists.get(zone).slice();
  let guard = 0;
  while (remaining.length && guard++ < 10000) {
    const colH = new Array(VW).fill(0);   // skyline: filled height per virtual column
    const placements = [], rest = [];
    for (const c of remaining) {
      const pc = c.cols + c.pad, pr = c.rows + c.pad;
      let bestX = -1, bestY = VH + 1;
      for (let x = 0; x + pc <= VW && x + c.cols <= BW; x++) {
        let top = 0;
        for (let i = 0; i < pc; i++) top = Math.max(top, colH[x + i]);
        if (top + pr <= VH && top + c.rows <= BH && top < bestY) { bestY = top; bestX = x; }
      }
      if (bestX >= 0) { placements.push({ c, x: bestX, y: bestY }); for (let i = 0; i < pc; i++) colH[bestX + i] = bestY + pr; }
      else rest.push(c);
    }
    if (!placements.length) throw new Error("complex too big for a block: " + (rest[0] && rest[0].id));
    blocks.push({ zone, placements });
    remaining = rest;
  }
}

// arrange blocks in a roughly-square grid, with 1-cell streets between them.
// Grid slots are sorted CENTER-OUT; leftover slots (none assigned a block) are
// the most central and render as all-courtyard park blocks — the town park —
// then commercial takes the next-central slots, craft the outermost (blocks
// were built in ZONE_ORDER, so assigning them in order honours the zoning).
const blocksN = blocks.length;
const BLOCKS_COLS = Math.max(1, Math.round(Math.sqrt(blocksN)));
const BLOCKS_ROWS = Math.ceil(blocksN / BLOCKS_COLS);
const slots = [];
for (let br = 0; br < BLOCKS_ROWS; br++) for (let bc = 0; bc < BLOCKS_COLS; bc++) slots.push({ bc, br });
const ctr = { x: (BLOCKS_COLS - 1) / 2, y: (BLOCKS_ROWS - 1) / 2 };
slots.sort((a, b) => (Math.hypot(a.bc - ctr.x, a.br - ctr.y) - Math.hypot(b.bc - ctr.x, b.br - ctr.y)) || (a.br - b.br) || (a.bc - b.bc));
const spare = slots.length - blocksN;            // most-central spare slots = the town park
blocks.forEach((blk, bi) => {
  const { bc, br } = slots[spare + bi];
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
// cell a block didn't use — including every pad cell between complexes — plus
// the cells of unused grid slots). No cell is bare.
// ---------------------------------------------------------------------------
const key = (x, y) => x + "," + y;
const occ = new Set();   // building/shell cells (the ACTUAL cols×rows box per complex; pads stay open)
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
        // NOTE: no park/square/cafe tag — like streets, courtyards are scenery
        // residents walk through, never a plan destination (274 of them would
        // swamp the real parks/squares in the planner's candidate pools and
        // scatter agents so thin that lunch/leisure gatherings collapse).
        tags: plaza ? ["plaza", "courtyard", "outdoor"] : ["green", "courtyard", "outdoor"],
        complex: "out_fill_" + fi,
      });
      fi++;
    }
  }
}

const out = real.concat(streets, fillers);

// sanity: unique coords + the 1-cell gap invariant (no two complexes' actual
// cells may ever be 4-adjacent or diagonal-adjacent across different complexes)
const seen = new Map();
for (const l of out) { const k = l.x + "," + l.y; if (seen.has(k)) throw new Error("dup coord " + k + " at " + l.id); seen.set(k, l); }
for (const l of buildings) {
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    const n = seen.get((l.x + dx) + "," + (l.y + dy));
    if (n && !isOutdoor(n) && !/^loc_(street|fill)_/.test(n.id) && n.complex !== l.complex) {
      throw new Error("complexes touch: " + l.id + " (" + l.complex + ") and " + n.id + " (" + n.complex + ")");
    }
  }
}

const header =
`// seedLocations.js — town laid out as a WELL-PLANNED community: apartment
// COMPLEXES (contiguous rooms) skyline-packed into ZONE-PURE CITY BLOCKS
// (commercial core, civic ring, residential, craft edge — placed center-out)
// with a 1-cell landscaped gap between any two complexes, separated by a
// continuous network of PAVED STREETS (type 'street'). Hand-authored parks/
// squares are dealt round-robin across the zones; 'green'/'plaza' courtyards
// fill every remaining cell (spare central block slots become the town park),
// so nothing is bare grass. Generated by tools/pack_locations.mjs (idempotent —
// re-run to re-pack; loc_street_*/loc_fill_* are regenerated). Only x/y and
// 'complex' are assigned; the real buildings' ids/types/tags are unchanged.

`;
writeFileSync(OUT, header + "export const SEED_LOCATIONS = " + JSON.stringify(out, null, 2) + ";\n");
const perZone = ZONE_ORDER.map((z) => z + " " + blocks.filter((b) => b.zone === z).length).join(", ");
console.log(`packed ${buildings.length} building rooms into ${complexes.length} complexes + ${outdoor.length} plots; ${blocksN} zone-pure blocks (${perZone}) in a ${BLOCKS_COLS}x${BLOCKS_ROWS} grid (${spare} central park slot${spare === 1 ? "" : "s"}); ${streets.length} street cells; ${fillers.length} green/plaza courtyards; town ${townW}x${townH}; total ${out.length} locations`);
