// validate_tiles.mjs — dev-only sanity check before packing the tile atlas.
// Verifies every tools/tile_svg/<name>.svg: declares the EXACT expected size
// (SPRITES base × SS), is well-formed-ish (single root <svg>, balanced), and that
// all element ids are prefixed with the tile name (so they can't collide once all
// tiles are merged into one atlas SVG).
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SPRITES } from "./pack_tiles.mjs";

const SS = 4;
const DIR = join(dirname(fileURLToPath(import.meta.url)), "tile_svg");
let problems = 0;
const seenIds = new Map(); // id -> file (global collision check)

for (const s of SPRITES) {
  const f = join(DIR, s.name + ".svg");
  let svg;
  try { svg = readFileSync(f, "utf8"); } catch { console.log(`MISSING ${s.name}.svg`); problems++; continue; }
  const wm = /<svg[^>]*\bwidth="(\d+(?:\.\d+)?)"/.exec(svg);
  const hm = /<svg[^>]*\bheight="(\d+(?:\.\d+)?)"/.exec(svg);
  const w = wm && +wm[1], h = hm && +hm[1];
  const ew = s.w * SS, eh = s.h * SS;
  const tags = (svg.match(/<svg\b/g) || []).length;
  const closes = (svg.match(/<\/svg>/g) || []).length;
  const issues = [];
  if (w !== ew || h !== eh) issues.push(`size ${w}x${h} != expected ${ew}x${eh}`);
  if (tags !== 1 || closes !== 1) issues.push(`root <svg> count ${tags}/${closes} (want 1/1)`);
  // id prefix + global-collision check
  const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  for (const id of ids) {
    if (!id.startsWith(s.name)) issues.push(`id "${id}" not prefixed with "${s.name}"`);
    if (seenIds.has(id)) issues.push(`id "${id}" also in ${seenIds.get(id)} (COLLISION)`);
    else seenIds.set(id, s.name + ".svg");
  }
  if (issues.length) { console.log(`✗ ${s.name}: ${issues.join("; ")}`); problems += issues.length; }
}
console.log(problems ? `\n${problems} problem(s) across tiles` : `\nAll ${SPRITES.length} tiles OK (sizes, single root, namespaced ids, no collisions)`);
process.exit(problems ? 1 : 0);
