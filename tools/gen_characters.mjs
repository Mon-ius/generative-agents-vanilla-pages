// gen_characters.mjs — dev-only generator for ORIGINAL CC0 character spritesheets.
//
// Produces top-down pixel-art residents as 16×24 frames laid out 4 columns
// (walk frames) × 4 rows (directions: down, left, right, up), one PNG per
// variant, plus a matching assets/characters.json manifest. Zero dependencies
// (PNG encoded with Node's built-in zlib). Run: `node tools/gen_characters.mjs`.
//
// The art is generated here, so it is original and CC0 (public domain) — it is
// NOT derived from any third-party pack. Re-run after editing VARIANTS or the
// drawing code; the browser then renders sprite avatars with a 4-direction walk
// (characters.js falls back to its procedural avatars if these files are absent).

import zlib from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const OUT_DIR = join(ROOT, "assets", "characters");
const FW = 16, FH = 24;            // frame size
const COLS = 4, ROWS = 4;          // 4 walk frames × 4 directions
const ANCHOR_X = 8, ANCHOR_Y = 22; // feet anchor inside a frame
const DIRS = ["down", "left", "right", "up"];

// ---------------------------------------------------------------------------
// tiny PNG encoder (RGBA, no deps)
// ---------------------------------------------------------------------------
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return ~c >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, "ascii");
  const body = Buffer.concat([tb, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.subarray(y * stride, y * stride + stride).forEach && rgba.copy ? rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride) : null; }
  // rgba is a Buffer; copy scanlines (filter byte 0 prepended)
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// pixel buffer (a single frame), with alpha-over compositing + outline pass
// ---------------------------------------------------------------------------
class Frame {
  constructor(w, h) { this.w = w; this.h = h; this.d = Buffer.alloc(w * h * 4); }
  set(x, y, c) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const a = (c[3] == null ? 255 : c[3]) / 255;
    if (a >= 1) { this.d[i] = c[0]; this.d[i + 1] = c[1]; this.d[i + 2] = c[2]; this.d[i + 3] = 255; return; }
    const ba = this.d[i + 3] / 255, oa = a + ba * (1 - a);
    if (oa <= 0) return;
    this.d[i] = Math.round((c[0] * a + this.d[i] * ba * (1 - a)) / oa);
    this.d[i + 1] = Math.round((c[1] * a + this.d[i + 1] * ba * (1 - a)) / oa);
    this.d[i + 2] = Math.round((c[2] * a + this.d[i + 2] * ba * (1 - a)) / oa);
    this.d[i + 3] = Math.round(oa * 255);
  }
  alpha(x, y) { if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0; return this.d[(y * this.w + x) * 4 + 3]; }
  rect(x, y, w, h, c) { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, c); }
  // 1px dark outline around the whole silhouette (classic pixel-art read).
  outline(color) {
    const empties = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (this.alpha(x, y) > 0) continue;
      if (this.alpha(x - 1, y) > 40 || this.alpha(x + 1, y) > 40 || this.alpha(x, y - 1) > 40 || this.alpha(x, y + 1) > 40) empties.push([x, y]);
    }
    for (const [x, y] of empties) this.set(x, y, color);
  }
  blit(dst, ox, oy) {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const i = (y * this.w + x) * 4; if (this.d[i + 3] === 0) continue;
      const j = ((oy + y) * dst.w + (ox + x)) * 4;
      dst.d[j] = this.d[i]; dst.d[j + 1] = this.d[i + 1]; dst.d[j + 2] = this.d[i + 2]; dst.d[j + 3] = this.d[i + 3];
    }
  }
}

// ---------------------------------------------------------------------------
// colour helpers
// ---------------------------------------------------------------------------
function hexToRgb(h) { const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h); return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [200, 200, 200]; }
function shade(rgb, amt) { const f = amt < 0 ? 1 + amt : 1, add = amt > 0 ? 255 * amt : 0; return rgb.map((v) => Math.max(0, Math.min(255, Math.round(v * f + add)))); }
const OUTLINE = [33, 30, 44, 255];

// ---------------------------------------------------------------------------
// draw one resident into a 16×24 Frame for a (direction, walkFrame)
// ---------------------------------------------------------------------------
function drawResident(look, dir, frame) {
  const f = new Frame(FW, FH);
  const cx = 8;
  const skin = hexToRgb(look.skin), skinSh = shade(skin, -0.16);
  const hair = hexToRgb(look.hair), hairHi = shade(hair, 0.18);
  const outfit = hexToRgb(look.outfit), outHi = shade(outfit, 0.16), outLo = shade(outfit, -0.22);
  const pants = look.pants ? hexToRgb(look.pants) : shade(outfit, -0.42);
  const shoe = [58, 47, 42];

  const up = dir === "up", left = dir === "left", right = dir === "right", side = left || right;
  const sgn = right ? 1 : -1; // profile facing

  // walk swing: frames 0,1,2,3 -> 0,+1,0,-1
  const swing = [0, 1, 0, -1][frame] || 0;

  // ---- legs (y 17..21) ----
  const legTop = 17, legColor = pants, legColorSh = shade(pants, -0.25);
  if (side) {
    // front/back leg stride along facing axis
    const fLen = 5 + (swing === sgn ? 0 : 0), bLen = 5;
    f.rect(cx - 1 + (swing > 0 ? sgn : 0), legTop, 3, fLen, legColor);       // front leg
    f.rect(cx - 1 - (swing > 0 ? sgn : 0), legTop, 2, bLen, legColorSh);     // back leg (shaded)
    f.rect(cx - 1 + (swing > 0 ? sgn : 0), legTop + fLen, 3, 1, shoe);
  } else {
    const lDY = swing > 0 ? 0 : swing < 0 ? 1 : 0;
    const rDY = swing < 0 ? 0 : swing > 0 ? 1 : 0;
    f.rect(cx - 3, legTop + lDY, 2, 5 - lDY, legColor);  // left leg
    f.rect(cx + 1, legTop + rDY, 2, 5 - rDY, legColor);  // right leg
    f.rect(cx - 3, legTop + 5 - 1, 2, 1, shoe);
    f.rect(cx + 1, legTop + 5 - 1, 2, 1, shoe);
  }

  // ---- torso / outfit (y 9..17) ----
  const tw = side ? 6 : 8, tx = cx - Math.floor(tw / 2), ty = 9, th = 8;
  f.rect(tx, ty, tw, th, outfit);
  f.rect(tx, ty, tw, 1, outHi);                 // top highlight
  f.rect(tx, ty + th - 2, tw, 2, outLo);        // hem shade
  if (look.apron) { const ap = hexToRgb(look.apron); f.rect(cx - 2, ty + 1, 4, th - 1, ap); f.rect(cx - 2, ty + 1, 4, 1, shade(ap, 0.18)); }

  // ---- arms (swing opposite legs) ----
  const armC = skin, sleeve = shade(outfit, 0.02);
  if (side) {
    const ax = cx + sgn * 2 + (swing > 0 ? sgn : -sgn);
    f.rect(ax, ty + 1, 2, 5, sleeve);
    f.set(ax + (sgn > 0 ? 1 : 0), ty + 6, armC); f.set(ax + (sgn > 0 ? 1 : 0), ty + 7, armC);
  } else {
    const lAY = swing > 0 ? 1 : 0, rAY = swing < 0 ? 1 : 0;
    f.rect(tx - 2, ty + 1 + lAY, 2, 5, sleeve); f.rect(tx - 2, ty + 6 + lAY, 2, 2, armC);
    f.rect(tx + tw, ty + 1 + rAY, 2, 5, sleeve); f.rect(tx + tw, ty + 6 + rAY, 2, 2, armC);
  }

  // ---- head (y 2..9) ----
  const hy = 2, hh = 7, hw = side ? 6 : 7, hx = cx - Math.floor(hw / 2) + (side ? sgn : 0);
  // rounded head: fill a blob
  for (let yy = hy; yy < hy + hh; yy++) for (let xx = hx; xx < hx + hw; xx++) {
    const edge = (yy === hy || yy === hy + hh - 1);
    const corner = edge && (xx === hx || xx === hx + hw - 1);
    if (corner) continue;
    f.set(xx, yy, xx >= hx + hw - 2 && !side ? skinSh : skin);
  }

  // ---- hair ----
  drawHair(f, look, dir, hx, hy, hw, hh, cx, hair, hairHi, sgn, side, up);

  // ---- hat accessory ----
  if (look.hat) { const ht = hexToRgb(look.hat); f.rect(hx - 1, hy - 1, hw + 2, 2, ht); f.rect(hx, hy - 2, hw, 1, shade(ht, 0.15)); if (!up) f.rect(hx - 1, hy + 1, hw + 2, 1, shade(ht, -0.2)); }

  // ---- face ----
  if (!up) {
    const eyeY = hy + 3;
    if (side) f.set(cx + sgn * 1 + (sgn > 0 ? 1 : -1), eyeY, OUTLINE);
    else { f.set(cx - 2, eyeY, OUTLINE); f.set(cx + 1, eyeY, OUTLINE); }
  }

  f.outline(OUTLINE);
  return f;
}

function drawHair(f, look, dir, hx, hy, hw, hh, cx, hair, hairHi, sgn, side, up) {
  const style = look.hairStyle;
  // top cap of hair across the head
  f.rect(hx, hy - 1, hw, 2, hair);
  f.rect(hx, hy - 1, hw, 1, hairHi);
  if (up) { f.rect(hx, hy, hw, hh - 1, hair); } // back of head fully covered
  if (style === "short") { if (!up) { f.set(hx, hy + 1, hair); f.set(hx + hw - 1, hy + 1, hair); } }
  else if (style === "long") {
    if (side) f.rect(cx - sgn * 3, hy, 2, hh + 2, hair);
    else { f.rect(hx - 1, hy + 1, 2, hh + 2, hair); f.rect(hx + hw - 1, hy + 1, 2, hh + 2, hair); }
  } else if (style === "bun") { f.rect(cx - 1, hy - 3, 3, 3, hair); f.set(cx, hy - 3, hairHi); }
  else if (style === "cap") { /* just the top cap */ }
  else if (style === "bald") { /* clear the cap we drew */ f.rect(hx, hy - 1, hw, 2, [0,0,0,0]); }
}

// ---------------------------------------------------------------------------
// variants — a varied crowd (skin, hair, outfit, style, optional hat/apron)
// ---------------------------------------------------------------------------
const VARIANTS = [
  { key: "townsfolk_01", skin: "#f1c9a5", hair: "#3a2f2a", outfit: "#4b6bdc", hairStyle: "short" },
  { key: "townsfolk_02", skin: "#e6b48f", hair: "#7c5430", outfit: "#d24f6f", hairStyle: "long" },
  { key: "townsfolk_03", skin: "#c98e63", hair: "#2a2333", outfit: "#5aa05a", hairStyle: "bun" },
  { key: "townsfolk_04", skin: "#a96e44", hair: "#1c1620", outfit: "#e0673c", hairStyle: "short", hat: "#caa44e" },
  { key: "townsfolk_05", skin: "#f7d9bd", hair: "#caa44e", outfit: "#8a5fb0", hairStyle: "long" },
  { key: "townsfolk_06", skin: "#8a5a36", hair: "#3a3a44", outfit: "#2f9e9e", hairStyle: "cap" },
  { key: "townsfolk_07", skin: "#f1c9a5", hair: "#b0b0b8", outfit: "#6d6f86", hairStyle: "short" },        // elder, grey
  { key: "townsfolk_08", skin: "#e6b48f", hair: "#86323a", outfit: "#3f78c0", hairStyle: "long" },
  { key: "townsfolk_09", skin: "#c98e63", hair: "#2a2333", outfit: "#cf8a3c", hairStyle: "bun", apron: "#e7e0d0" }, // apron worker
  { key: "townsfolk_10", skin: "#f7d9bd", hair: "#9c6b3f", outfit: "#cf5aa0", hairStyle: "short" },
  { key: "townsfolk_11", skin: "#a96e44", hair: "#2a2333", outfit: "#4a8c6a", hairStyle: "cap", hat: "#b4534b" },
  { key: "townsfolk_12", skin: "#f1c9a5", hair: "#5a3a1e", outfit: "#b9b04a", hairStyle: "long" },
  { key: "townsfolk_13", skin: "#8a5a36", hair: "#caa44e", outfit: "#3a7d8c", hairStyle: "bun" },
  { key: "townsfolk_14", skin: "#e6b48f", hair: "#1c1620", outfit: "#9c4f8c", hairStyle: "short", apron: "#d8d2c2" },
  { key: "townsfolk_15", skin: "#c98e63", hair: "#6b6f86", outfit: "#c2553e", hairStyle: "cap", hat: "#3a3a44" }, // worker, dark cap
  { key: "townsfolk_16", skin: "#f7d9bd", hair: "#86323a", outfit: "#46708f", hairStyle: "long" },
  { key: "townsfolk_17", skin: "#a96e44", hair: "#3a2f2a", outfit: "#5a9c4a", hairStyle: "bald" },             // bald
  { key: "townsfolk_18", skin: "#f1c9a5", hair: "#caa44e", outfit: "#d8893c", hairStyle: "bun", hat: "#7c5430" }, // straw-hat farmer vibe
  { key: "townsfolk_19", skin: "#e6b48f", hair: "#2a2333", outfit: "#6d5fb0", hairStyle: "short" },
  { key: "townsfolk_20", skin: "#c98e63", hair: "#b0b0b8", outfit: "#4a5a6e", hairStyle: "long" },              // silver-haired
];

mkdirSync(OUT_DIR, { recursive: true });
const sheets = {};
for (const v of VARIANTS) {
  const sheet = new Frame(FW * COLS, FH * ROWS);
  ROWS && DIRS.forEach((dir, r) => {
    for (let c = 0; c < COLS; c++) {
      const fr = drawResident(v, dir, c);
      fr.blit(sheet, c * FW, r * FH);
    }
  });
  const png = encodePNG(sheet.w, sheet.h, sheet.d);
  writeFileSync(join(OUT_DIR, v.key + ".png"), png);
  sheets[v.key] = { file: `characters/${v.key}.png`, cols: COLS, rows: ROWS, dirRows: { down: 0, left: 1, right: 2, up: 3 }, walkCols: [0, 1, 2, 3], idleCol: 0 };
}

const manifest = {
  frameW: FW, frameH: FH, anchorX: ANCHOR_X, anchorY: ANCHOR_Y, fps: 6,
  sheets,
  variants: VARIANTS.map((v) => v.key),
  palette: {
    skins: ["#f1c9a5", "#e6b48f", "#c98e63", "#a96e44", "#8a5a36", "#f7d9bd"],
    hairs: ["#2a2333", "#5a3a1e", "#7c5430", "#9c6b3f", "#b0b0b8", "#caa44e", "#86323a", "#3a3a44"],
    outfits: ["#4b6bdc", "#d24f6f", "#5aa05a", "#e0673c", "#8a5fb0", "#2f9e9e", "#cf8a3c", "#cf5aa0", "#3f78c0", "#b9b04a"],
  },
};
writeFileSync(join(ROOT, "assets", "characters.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote ${VARIANTS.length} character sheets (${FW * COLS}×${FH * ROWS}px each) to assets/characters/ + assets/characters.json`);
