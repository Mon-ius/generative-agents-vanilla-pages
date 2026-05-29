// gen_chars_svg.mjs — generate the 12 resident SVG sheets with EXACT, consistent
// alignment (every cell: centered on x=16, feet on the y=46 baseline, one
// contiguous silhouette that fits inside the 32×48 frame). Hand-authored vector
// geometry (model-generated SVG), recoloured/re-styled per resident. Output is
// SVG asset files in tools/char_svg/ → packed by assemble_atlas.mjs → rasterised
// by svg2png.mjs into ONE atlas PNG. The runtime never draws characters in JS;
// it only blits frames out of the atlas.
//
// Run: node tools/gen_chars_svg.mjs   (then assemble_atlas + svg2png)

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const OUT = join(ROOT, "tools", "char_svg");
const FW = 32, FH = 48, COLS = 3, ROWS = 4;
const DIRS = ["down", "left", "right", "up"];
const OL = "#241f2e"; // outline

// ---- colour helpers ----
function toRgb(h) { const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h); return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [200, 200, 200]; }
function shade(h, a) { const c = toRgb(h), f = a < 0 ? 1 + a : 1, add = a > 0 ? 255 * a : 0; const v = c.map(x => Math.max(0, Math.min(255, Math.round(x * f + add)))); return `#${v.map(x => x.toString(16).padStart(2, "0")).join("")}`; }

// ---- shape helpers (return SVG strings; coords are LOCAL to the 32×48 cell) ----
const rr = (x, y, w, h, r, fill, stroke = true) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"${stroke ? ` stroke="${OL}" stroke-width="1"` : ""}/>`;
const ci = (cx, cy, r, fill, stroke = true) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"${stroke ? ` stroke="${OL}" stroke-width="1"` : ""}/>`;
const el = (cx, cy, rx, ry, fill, stroke = true) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}"${stroke ? ` stroke="${OL}" stroke-width="1"` : ""}/>`;
const dot = (cx, cy, r, fill) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`;
const path = (d, fill, stroke = true) => `<path d="${d}" fill="${fill}"${stroke ? ` stroke="${OL}" stroke-width="1" stroke-linejoin="round"` : ""}/>`;

// ---- one 32×48 frame ----
// look: { skin, hair, outfit, pants?, hairStyle, hat?, apron?, glasses?, dress?, child? }
function frame(look, dir, fr) {
  const cx = 16, feet = 46;
  const skin = look.skin, skinSh = shade(skin, -0.14);
  const hair = look.hair, hairHi = shade(hair, 0.16);
  const outfit = look.outfit, outHi = shade(outfit, 0.16), outLo = shade(outfit, -0.22);
  const pants = look.pants || shade(outfit, -0.42), pantsSh = shade(pants, -0.2);
  const shoe = "#3a2f2a";
  const up = dir === "up", side = dir === "left" || dir === "right";
  const sgn = dir === "right" ? 1 : -1;
  const swing = fr === 1 ? 1 : fr === 2 ? -1 : 0; // stand / step-left / step-right

  // geometry (fits y≈5..46, centred x=16)
  const headCy = 11, headR = 5.8;
  const torsoTop = 17.5, torsoBot = look.dress ? 30 : 33, torsoH = torsoBot - torsoTop;
  const tw = side ? 11 : 13, tx = cx - tw / 2;
  const legTop = look.dress ? 38 : torsoBot - 0.5, legBot = feet, legH = legBot - legTop;
  const legW = 4, gap = 1;

  let s = "";

  // ----- legs (drawn first, behind torso) -----
  if (look.dress) {
    // skirt + short legs below
    s += path(`M${cx - 7} ${torsoBot - 4} L${cx + 7} ${torsoBot - 4} L${cx + 9} ${legTop + 1} L${cx - 9} ${legTop + 1} Z`, outfit);
    s += rr(cx - 4.5, legTop, 3.2, legBot - legTop, 1.4, skin, true);
    s += rr(cx + 1.3, legTop, 3.2, legBot - legTop, 1.4, skin, true);
  } else if (side) {
    const front = swing * sgn; // front leg leads in facing dir
    s += rr(cx - legW / 2 - front, legTop, legW, legH, 1.6, pantsSh, true); // back leg
    s += rr(cx - legW / 2 + front, legTop, legW, legH, 1.6, pants, true);    // front leg
    s += rr(cx - legW / 2 + front, feet - 2, legW + 1 * sgn, 2.4, 1, shoe, true);
  } else {
    const lDown = swing > 0 ? -1.5 : 0, rDown = swing < 0 ? -1.5 : 0;
    s += rr(cx - gap - legW, legTop + lDown, legW, legH, 1.6, pants, true);
    s += rr(cx + gap, legTop + rDown, legW, legH, 1.6, pants, true);
    s += rr(cx - gap - legW, feet - 2 + lDown, legW, 2.4, 1, shoe, true);
    s += rr(cx + gap, feet - 2 + rDown, legW, 2.4, 1, shoe, true);
  }

  // ----- arms (behind torso, swing opposite legs) -----
  const armW = 3, sleeve = outfit, aSwing = swing;
  if (side) {
    s += rr(cx + sgn * (tw / 2 - 0.5), torsoTop + 1, armW, torsoH - 3, 1.4, shade(outfit, 0.04), true);
    s += ci(cx + sgn * (tw / 2 + 0.6), torsoTop + torsoH - 2, 1.7, skin, true);
  } else {
    s += rr(tx - armW + 0.5, torsoTop + 1 - aSwing, armW, torsoH - 4, 1.4, sleeve, true);
    s += rr(tx + tw - 0.5, torsoTop + 1 + aSwing, armW, torsoH - 4, 1.4, sleeve, true);
    s += ci(tx - armW + 2, torsoTop + torsoH - 3 - aSwing, 1.7, skin, true);
    s += ci(tx + tw + 1, torsoTop + torsoH - 3 + aSwing, 1.7, skin, true);
  }

  // ----- torso / outfit -----
  s += rr(tx, torsoTop, tw, torsoH, 3, outfit, true);
  s += `<rect x="${tx + 1}" y="${torsoTop + 1}" width="${tw - 2}" height="2" rx="1" fill="${outHi}"/>`;
  s += `<rect x="${tx + 1}" y="${torsoBot - 3}" width="${tw - 2}" height="2.2" fill="${outLo}"/>`;
  if (look.apron && !up) {
    s += rr(cx - 4, torsoTop + 2, 8, torsoH - 2, 1.2, look.apron, true);
    s += `<rect x="${cx - 4}" y="${torsoTop + 2}" width="8" height="1.4" fill="${shade(look.apron, 0.12)}"/>`;
  }

  // ----- neck -----
  s += `<rect x="${cx - 2}" y="${headCy + headR - 1.5}" width="4" height="3.5" fill="${skinSh}"/>`;

  // ----- head -----
  s += ci(cx, headCy, headR, skin, true);
  if (!side && !up) s += `<path d="M${cx + 1.5} ${headCy - 1} a${headR - 1.5} ${headR - 1.5} 0 0 1 0 ${ (headR-1.5)*2 }" fill="${skinSh}" opacity="0.5"/>`;

  // ----- hair -----
  s += hairFor(look, dir, cx, headCy, headR, hair, hairHi, sgn, side, up);

  // ----- hat -----
  if (look.hat === "straw" && !up) { s += el(cx, headCy - headR + 1.5, headR + 3, 2.4, "#d8b25a", true); s += path(`M${cx - 3.5} ${headCy - headR + 1} a3.5 3 0 0 1 7 0 z`, "#c79a3b"); }
  else if (look.hat === "straw" && up) { s += el(cx, headCy - headR + 2, headR + 3, 2.6, "#cdaa50", true); }
  else if (look.hat === "beanie") { s += path(`M${cx - headR - 0.6} ${headCy - 0.5} a${headR + 0.6} ${headR + 1.6} 0 0 1 ${(headR + 0.6) * 2} 0 z`, look.hatColor || "#46708f"); s += `<rect x="${cx - headR - 0.6}" y="${headCy - 0.8}" width="${(headR + 0.6) * 2}" height="1.6" fill="${shade(look.hatColor || "#46708f", -0.15)}"/>`; }

  // ----- face -----
  if (!up) {
    if (side) {
      s += dot(cx + sgn * 2.4, headCy - 0.3, 0.95, OL);
      s += `<path d="M${cx + sgn * (headR - 0.5)} ${headCy + 1} q${sgn * 1.4} 0.6 0 1.4" fill="none" stroke="${OL}" stroke-width="0.7"/>`;
    } else {
      s += dot(cx - 2.2, headCy - 0.2, 1, OL);
      s += dot(cx + 2.2, headCy - 0.2, 1, OL);
      s += `<path d="M${cx - 1.6} ${headCy + 2.4} q1.6 1.3 3.2 0" fill="none" stroke="${OL}" stroke-width="0.7" stroke-linecap="round"/>`;
    }
    if (look.glasses) {
      s += `<circle cx="${cx - 2.2}" cy="${headCy - 0.2}" r="1.8" fill="none" stroke="${OL}" stroke-width="0.6"/>`;
      s += `<circle cx="${cx + 2.2}" cy="${headCy - 0.2}" r="1.8" fill="none" stroke="${OL}" stroke-width="0.6"/>`;
      s += `<line x1="${cx - 0.4}" y1="${headCy - 0.2}" x2="${cx + 0.4}" y2="${headCy - 0.2}" stroke="${OL}" stroke-width="0.6"/>`;
    }
  }

  let body = s;
  if (look.child) body = `<g transform="translate(${cx} ${feet}) scale(0.86) translate(${-cx} ${-feet})">${s}</g>`;
  return body;
}

function hairFor(look, dir, cx, cy, r, hair, hairHi, sgn, side, up) {
  const st = look.hairStyle || "short";
  if (st === "bald") {
    if (up) return ci(cx, cy, r + 0.2, shade(look.skin, -0.05), true);
    return `<path d="M${cx - r} ${cy - 1.5} a${r} ${r} 0 0 1 ${r * 2} 0" fill="${hair}"/>`;
  }
  let s = "";
  const cap = `<path d="M${cx - r - 0.4} ${cy} a${r + 0.4} ${r + 0.4} 0 0 1 ${(r + 0.4) * 2} 0 q0 -2 ${-(r + 0.4)} -2 q${-(r + 0.4)} 0 ${-(r + 0.4)} 2 z" fill="${hair}" stroke="${OL}" stroke-width="0.8"/>`;
  if (up) {
    s += ci(cx, cy, r + 0.4, hair, true);
    if (st === "long" || st === "bob") s += rr(cx - r, cy - 1, r * 2, r + 3, 2, hair, true);
    if (st === "bun" || st === "topknot") s += ci(cx, cy - r - 0.5, r * 0.5, hair, true);
    if (st === "curly") for (const a of [-1, 0, 1]) s += dot(cx + a * (r * 0.7), cy - r * 0.7, r * 0.5, hairHi);
    return s;
  }
  s += cap;
  s += `<path d="M${cx - r + 1} ${cy - r + 1} q${r - 1} -2 ${(r - 1) * 2} 0" fill="none" stroke="${hairHi}" stroke-width="0.7" opacity="0.7"/>`;
  if (st === "long") {
    if (side) s += rr(cx - sgn * r - (sgn > 0 ? 0 : 1.6), cy - 1, 1.8, r + 4, 0.8, hair, true);
    else { s += rr(cx - r - 0.4, cy - 1, 1.9, r + 4, 0.8, hair, true); s += rr(cx + r - 1.5, cy - 1, 1.9, r + 4, 0.8, hair, true); }
  } else if (st === "bob") {
    if (side) s += rr(cx - sgn * r - (sgn > 0 ? 0 : 1.8), cy - 1, 2.0, r + 1.5, 1, hair, true);
    else { s += rr(cx - r - 0.6, cy - 1, 2.0, r + 1.5, 1, hair, true); s += rr(cx + r - 1.4, cy - 1, 2.0, r + 1.5, 1, hair, true); }
  } else if (st === "bun" || st === "topknot") {
    s += ci(cx, cy - r - 0.6, r * 0.46, hair, true);
  } else if (st === "curly") {
    for (const a of [-1.05, -0.35, 0.35, 1.05]) s += dot(cx + a * (r * 0.6), cy - r * 0.55, r * 0.5, hair);
  }
  return s;
}

// ---- 12 residents ----
const VARIANTS = [
  { key: "townsfolk_01", skin: "#f1c9a5", hair: "#3a2f2a", outfit: "#4b6bdc", pants: "#33405a", hairStyle: "short" },
  { key: "townsfolk_02", skin: "#e6b48f", hair: "#86323a", outfit: "#3f8a4a", hairStyle: "long", dress: true },
  { key: "townsfolk_03", skin: "#a96e44", hair: "#2a2333", outfit: "#e0673c", pants: "#4a3a2c", hairStyle: "topknot", apron: "#efe7d7" },
  { key: "townsfolk_04", skin: "#f7d9bd", hair: "#caa44e", outfit: "#cf5aa0", pants: "#3a5a8c", hairStyle: "long", hat: "straw" },
  { key: "townsfolk_05", skin: "#f1c9a5", hair: "#b8b8c0", outfit: "#6d6f86", pants: "#4a4c5e", hairStyle: "short", glasses: true },
  { key: "townsfolk_06", skin: "#7a4a2c", hair: "#1c1620", outfit: "#2f9e9e", pants: "#3a4452", hairStyle: "short" },
  { key: "townsfolk_07", skin: "#c98e63", hair: "#241f2e", outfit: "#8a5fb0", hairStyle: "long", dress: true },
  { key: "townsfolk_08", skin: "#f1c9a5", hair: "#7c5430", outfit: "#c2553e", pants: "#3a4452", hairStyle: "short", child: true },
  { key: "townsfolk_09", skin: "#8a5a36", hair: "#2a2333", outfit: "#cf9a3c", pants: "#3a6a5a", hairStyle: "curly" },
  { key: "townsfolk_10", skin: "#e6b48f", hair: "#3a2f2a", outfit: "#34406e", pants: "#566", hairStyle: "bald" },
  { key: "townsfolk_11", skin: "#f7d9bd", hair: "#c6c6cc", outfit: "#9c87c0", pants: "#6a5e86", hairStyle: "bob" },
  { key: "townsfolk_12", skin: "#9c6b3f", hair: "#241f2e", outfit: "#7c5430", pants: "#3a4452", hairStyle: "short", hat: "beanie", hatColor: "#46708f" },
];

for (const look of VARIANTS) {
  let body = "";
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    body += `<g transform="translate(${c * FW} ${r * FH})">${frame(look, DIRS[r], c)}</g>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${FW * COLS}" height="${FH * ROWS}" viewBox="0 0 ${FW * COLS} ${FH * ROWS}">${body}</svg>`;
  writeFileSync(join(OUT, look.key + ".svg"), svg);
}
console.log(`generated ${VARIANTS.length} aligned resident SVGs -> tools/char_svg/`);
