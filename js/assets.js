// assets.js — loads the generated pixel-art sprite PNGs into Image objects.
//
// The PNGs live in /assets/sprites/ (produced by tools/gen_assets.mjs). Loading is
// cached and resolves to a { name: HTMLImageElement } map. It is node-safe: with no
// Image constructor (headless tests) it resolves to {} so the renderer falls back
// to procedural drawing. Individual load failures are skipped, not fatal.

export const SPRITE_NAMES = [
  "grass", "grass2", "path", "flower", "tree", "bush",
  "floor_wood", "floor_tile", "floor_pink", "wall", "rug",
  "bed", "table", "chair", "bookshelf", "fridge", "counter",
  "stove", "plant", "piano", "toilet", "sink", "desk", "board",
];

let _cache = null;

export function loadSprites(base = "assets/sprites/") {
  if (_cache) return _cache;
  if (typeof Image === "undefined") {
    _cache = Promise.resolve({});
    return _cache;
  }
  _cache = Promise.all(
    SPRITE_NAMES.map(
      (name) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve([name, img]);
          img.onerror = () => resolve(null);
          img.src = base + name + ".png";
        })
    )
  ).then((pairs) => {
    const map = {};
    for (const p of pairs) if (p) map[p[0]] = p[1];
    return map;
  });
  return _cache;
}
