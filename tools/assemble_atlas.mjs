// assemble_atlas.mjs — tile every per-variant SVG (authored by agents, one file
// per resident in tools/char_svg/<key>.svg) into ONE sprite-atlas SVG, and write
// the region manifest (assets/characters.json). This is the "CSS sprites" layout:
// a single image, every variant/direction/frame addressed by a pixel offset, so
// the runtime fetches ONE PNG.
//
// Each per-variant SVG is a 96×192 block: 3 columns (0 = stand, 1 = step-left,
// 2 = step-right) × 4 rows (down, left, right, up), 32×48 cells, feet at y≈46.
//
// Usage:
//   node tools/assemble_atlas.mjs <out.svg> [--manifest]

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FW = 32, FH = 48, COLS = 3, ROWS = 4, PER_ROW = 5;
const BLOCK_W = COLS * FW, BLOCK_H = ROWS * FH; // 96 × 192
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SVG_DIR = join(ROOT, "tools", "char_svg");

const outSvg = process.argv[2] || "/tmp/char_atlas.svg";
const doManifest = process.argv.includes("--manifest");

const files = readdirSync(SVG_DIR).filter((f) => f.endsWith(".svg")).sort();
if (!files.length) { console.error("no SVGs in tools/char_svg/"); process.exit(2); }

const N = files.length;
const W = PER_ROW * BLOCK_W;
const H = Math.ceil(N / PER_ROW) * BLOCK_H;

function innerOf(svg) {
  const m = /<svg[^>]*>([\s\S]*)<\/svg>/i.exec(svg);
  return m ? m[1] : svg;
}

const keys = [];
let body = "";
files.forEach((f, i) => {
  const key = f.replace(/\.svg$/i, "");
  keys.push(key);
  const bx = (i % PER_ROW) * BLOCK_W, by = Math.floor(i / PER_ROW) * BLOCK_H;
  const inner = innerOf(readFileSync(join(SVG_DIR, f), "utf8"));
  body += `<g transform="translate(${bx} ${by})">${inner}</g>`;
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="geometricPrecision">${body}</svg>`;
writeFileSync(outSvg, svg);
console.log(`atlas SVG ${W}x${H}, ${N} variants -> ${outSvg}`);

if (doManifest) {
  const sheets = {};
  keys.forEach((key, i) => {
    sheets[key] = {
      file: "characters/atlas.png", // ONE shared atlas (CSS-sprite): fetched once
      ox: (i % PER_ROW) * BLOCK_W, oy: Math.floor(i / PER_ROW) * BLOCK_H,
      cols: COLS, rows: ROWS,
      dirRows: { down: 0, left: 1, right: 2, up: 3 },
      walkCols: [1, 2], idleCol: 0, // walk alternates step-left/step-right; idle = stand
    };
  });
  const manifest = {
    frameW: FW, frameH: FH, anchorX: Math.round(FW / 2), anchorY: FH - 2, fps: 6,
    atlas: "characters/atlas.png",
    sheets, variants: keys,
    palette: {
      skins: ["#f1c9a5", "#e6b48f", "#c98e63", "#a96e44", "#8a5a36", "#f7d9bd"],
      hairs: ["#2a2333", "#5a3a1e", "#7c5430", "#9c6b3f", "#b0b0b8", "#caa44e", "#86323a", "#3a3a44"],
      outfits: ["#4b6bdc", "#d24f6f", "#5aa05a", "#e0673c", "#8a5fb0", "#2f9e9e", "#cf8a3c", "#cf5aa0", "#3f78c0", "#b9b04a"],
    },
  };
  writeFileSync(join(ROOT, "assets", "characters.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote assets/characters.json — single-atlas, ${keys.length} variant regions`);
}
