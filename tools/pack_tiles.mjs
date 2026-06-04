// pack_tiles.mjs — shelf-pack every hand-authored tile/object SVG (tools/tile_svg/
// <name>.svg) into ONE sprite atlas SVG and write the region manifest
// (assets/manifest.json). Like the character atlas, this is the "CSS sprites"
// technique for the town art: a single image fetched once, every tile addressed
// by an {x,y,w,h} region. Tiles keep their existing native sizes so townArt's
// drawImage(S.name, …) calls are unchanged.
//
// Usage: node tools/pack_tiles.mjs <out.svg> [--manifest]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Canonical tiles + their native sizes (must match what townArt draws).
export const SPRITES = [
  { name: "grass", w: 16, h: 16 }, { name: "grass2", w: 16, h: 16 }, { name: "path", w: 16, h: 16 }, { name: "flower", w: 16, h: 16 },
  { name: "tree", w: 32, h: 40 }, { name: "bush", w: 20, h: 16 },
  { name: "floor_wood", w: 16, h: 16 }, { name: "floor_tile", w: 16, h: 16 }, { name: "floor_pink", w: 16, h: 16 }, { name: "wall", w: 16, h: 16 },
  { name: "rug", w: 30, h: 20 }, { name: "bed", w: 24, h: 28 }, { name: "table", w: 28, h: 24 }, { name: "chair", w: 14, h: 14 },
  { name: "bookshelf", w: 18, h: 28 }, { name: "fridge", w: 16, h: 26 }, { name: "counter", w: 32, h: 14 }, { name: "stove", w: 16, h: 16 },
  { name: "plant", w: 14, h: 18 }, { name: "piano", w: 30, h: 20 }, { name: "toilet", w: 14, h: 16 }, { name: "sink", w: 14, h: 12 },
  { name: "desk", w: 18, h: 14 }, { name: "board", w: 30, h: 10 },
  { name: "bed_red", w: 24, h: 28 }, { name: "bed_green", w: 24, h: 28 },
  { name: "chair_red", w: 14, h: 14 }, { name: "chair_yellow", w: 14, h: 14 }, { name: "chair_green", w: 14, h: 14 },
  { name: "rug_blue", w: 30, h: 20 }, { name: "rug_green", w: 30, h: 20 },
  { name: "dresser", w: 18, h: 14 }, { name: "nightstand", w: 12, h: 12 }, { name: "sofa", w: 30, h: 16 }, { name: "lamp", w: 10, h: 18 },
  { name: "tv", w: 18, h: 12 }, { name: "painting", w: 12, h: 10 },
  // ---- expansion: replicate the reference render (indoor props) ----
  { name: "bar", w: 40, h: 14 }, { name: "stool", w: 8, h: 8 }, { name: "microphone", w: 8, h: 22 },
  { name: "washer", w: 16, h: 18 }, { name: "utensil_rack", w: 22, h: 10 }, { name: "wardrobe", w: 18, h: 24 },
  { name: "vanity", w: 16, h: 18 }, { name: "oven", w: 16, h: 18 }, { name: "clock", w: 10, h: 10 }, { name: "easel", w: 16, h: 22 },
  // ---- expansion: outdoor decor ----
  { name: "tree_pine", w: 32, h: 44 }, { name: "tree_apple", w: 32, h: 40 }, { name: "flower2", w: 16, h: 16 },
  { name: "weed", w: 16, h: 16 }, { name: "rock", w: 16, h: 12 }, { name: "mushroom", w: 12, h: 12 }, { name: "stump", w: 16, h: 14 },
  // ---- expansion: terrain (tileable ground) ----
  { name: "gravel", w: 16, h: 16 }, { name: "sand", w: 16, h: 16 }, { name: "deck", w: 16, h: 16 },
  // ---- apartment complexes: corridors, doors, entry, fixtures, wall variants ----
  { name: "corridor", w: 16, h: 16 }, { name: "door", w: 12, h: 20 },
  { name: "stairs", w: 28, h: 16 }, { name: "doormat", w: 16, h: 8 },
  { name: "mailbox", w: 16, h: 16 }, { name: "island", w: 28, h: 16 },
  { name: "wall2", w: 16, h: 16 }, { name: "window", w: 16, h: 12 },
  // ---- community building props (chapel, theater, bank, salon, florist,
  //      pharmacy, museum, post office, diner) ----
  { name: "pew", w: 26, h: 10 }, { name: "altar", w: 24, h: 16 },
  { name: "screen", w: 40, h: 14 }, { name: "seatrow", w: 32, h: 12 },
  { name: "teller", w: 30, h: 14 }, { name: "vault", w: 20, h: 22 },
  { name: "barber_chair", w: 14, h: 18 }, { name: "mirror", w: 10, h: 18 },
  { name: "flower_stand", w: 22, h: 18 }, { name: "display_case", w: 26, h: 14 },
  { name: "meds_shelf", w: 20, h: 28 }, { name: "po_boxes", w: 22, h: 26 },
  { name: "pedestal", w: 14, h: 18 }, { name: "register", w: 16, h: 14 },
  { name: "booth", w: 26, h: 16 },
  // ---- outdoor decor: fountains/benches/lamps/greenery to fill the town with no gaps ----
  { name: "fountain", w: 32, h: 32 }, { name: "bench", w: 26, h: 12 },
  { name: "streetlamp", w: 12, h: 30 }, { name: "hedge", w: 16, h: 16 },
  { name: "flowerbed", w: 22, h: 14 }, { name: "statue", w: 16, h: 28 },
  { name: "market_stall", w: 30, h: 24 }, { name: "pond", w: 30, h: 22 },
];

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SVG_DIR = join(ROOT, "tools", "tile_svg");
const outSvg = process.argv[2] || "/tmp/tile_atlas.svg";
const doManifest = process.argv.includes("--manifest");
// Supersample factor: every tile is authored SS× its logical size so the renderer's
// upscale to a 176px cell stays crisp and can carry rich gradient/texture/material
// detail. Keep in sync with ART_SS in js/ui/townArt.js. Region sizes = base × SS.
const SS = 4;
const MAXW = 256 * SS, PAD = 8;

function innerOf(svg) { const m = /<svg[^>]*>([\s\S]*)<\/svg>/i.exec(svg); return m ? m[1] : svg; }

// shelf pack (sorted by height desc, then name) — deterministic
const order = SPRITES.map((s, i) => ({ ...s, w: s.w * SS, h: s.h * SS, i })).sort((a, b) => (b.h - a.h) || a.name.localeCompare(b.name));
let x = PAD, y = PAD, rowH = 0, atlasW = 0;
const placed = {};
for (const s of order) {
  if (x + s.w + PAD > MAXW) { x = PAD; y += rowH + PAD; rowH = 0; }
  placed[s.name] = { x, y, w: s.w, h: s.h };
  x += s.w + PAD; rowH = Math.max(rowH, s.h); atlasW = Math.max(atlasW, x);
}
const W = MAXW, H = y + rowH + PAD;

const missing = [];
let body = "";
for (const s of SPRITES) {
  const p = placed[s.name];
  let inner = "";
  try { inner = innerOf(readFileSync(join(SVG_DIR, s.name + ".svg"), "utf8")); }
  catch { missing.push(s.name); }
  // Nested <svg> per tile clips each region (overflow hidden) so soft shadows,
  // anti-aliasing and filter bleed can't leak into neighbouring sprites.
  body += `<svg x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" viewBox="0 0 ${p.w} ${p.h}" overflow="hidden">${inner}</svg>`;
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
writeFileSync(outSvg, svg);
console.log(`tile atlas SVG ${W}x${H}, ${SPRITES.length} tiles -> ${outSvg}${missing.length ? "  MISSING: " + missing.join(",") : ""}`);

if (doManifest) {
  const sprites = {};
  for (const s of SPRITES) sprites[s.name] = placed[s.name];
  const manifest = { tile: 16 * SS, atlas: "sprites/atlas.png", atlasW: W, atlasH: H, sprites };
  writeFileSync(join(ROOT, "assets", "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote assets/manifest.json — single-atlas, ${SPRITES.length} tile regions${missing.length ? " (with " + missing.length + " MISSING)" : ""}`);
}
if (missing.length) process.exitCode = 1;
