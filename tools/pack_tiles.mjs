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
];

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SVG_DIR = join(ROOT, "tools", "tile_svg");
const outSvg = process.argv[2] || "/tmp/tile_atlas.svg";
const doManifest = process.argv.includes("--manifest");
const MAXW = 256, PAD = 1;

function innerOf(svg) { const m = /<svg[^>]*>([\s\S]*)<\/svg>/i.exec(svg); return m ? m[1] : svg; }

// shelf pack (sorted by height desc, then name) — deterministic
const order = SPRITES.map((s, i) => ({ ...s, i })).sort((a, b) => (b.h - a.h) || a.name.localeCompare(b.name));
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
  body += `<g transform="translate(${p.x} ${p.y})">${inner}</g>`;
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">${body}</svg>`;
writeFileSync(outSvg, svg);
console.log(`tile atlas SVG ${W}x${H}, ${SPRITES.length} tiles -> ${outSvg}${missing.length ? "  MISSING: " + missing.join(",") : ""}`);

if (doManifest) {
  const sprites = {};
  for (const s of SPRITES) sprites[s.name] = placed[s.name];
  const manifest = { tile: 16, atlas: "sprites/atlas.png", atlasW: W, atlasH: H, sprites };
  writeFileSync(join(ROOT, "assets", "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote assets/manifest.json — single-atlas, ${SPRITES.length} tile regions${missing.length ? " (with " + missing.length + " MISSING)" : ""}`);
}
if (missing.length) process.exitCode = 1;
