// assets.js — loads the pixel-art sprites from a single shared sprite ATLAS.
//
// Instead of fetching 37 separate PNGs, this uses a CSS-sprites approach: ONE PNG
// (the atlas) is fetched once, and every tile is sliced out of it from an
// { x, y, w, h } region described in manifest.json. Each region is drawn onto its
// own small HTMLCanvasElement, so the result is a { name: HTMLCanvasElement } map.
// townArt consumes these canvases exactly like the old Images — drawImage(S.name, ...)
// and put() reading .width/.height both work on a canvas.
//
// Loading is cached and node-safe: with no Image constructor (headless tests) it
// resolves to {} so the renderer falls back to procedural drawing. Any fetch/parse
// or atlas load failure also resolves to {} (procedural fallback).

// Informational list of expected sprite names (the actual set is driven by the
// manifest's `sprites` map; this export is kept for reference/back-compat).
export const SPRITE_NAMES = [
  "grass", "grass2", "path", "flower", "tree", "bush",
  "floor_wood", "floor_tile", "floor_pink", "wall", "rug",
  "bed", "table", "chair", "bookshelf", "fridge", "counter",
  "stove", "plant", "piano", "toilet", "sink", "desk", "board",
  // variants + extra furniture for richer, more varied interiors
  "bed_red", "bed_green", "chair_red", "chair_yellow", "chair_green",
  "rug_blue", "rug_green", "dresser", "nightstand", "sofa", "lamp", "tv", "painting",
  // expansion: indoor props, outdoor decor, terrain (replicating the reference render)
  "bar", "stool", "microphone", "washer", "utensil_rack", "wardrobe", "vanity", "oven", "clock", "easel",
  "tree_pine", "tree_apple", "flower2", "weed", "rock", "mushroom", "stump",
  "gravel", "sand", "deck",
];

let _cache = null;

export function loadSprites(base = "assets/") {
  if (_cache) return _cache;
  if (typeof Image === "undefined") {
    _cache = Promise.resolve({});
    return _cache;
  }
  _cache = fetch(base + "manifest.json")
    .then((res) => res.json())
    .then(
      (manifest) =>
        new Promise((resolve) => {
          const sprites = (manifest && manifest.sprites) || {};
          const atlasImg = new Image();
          atlasImg.onload = () => {
            const map = {};
            for (const [name, r] of Object.entries(sprites)) {
              const canvas = document.createElement("canvas");
              canvas.width = r.w;
              canvas.height = r.h;
              const ctx = canvas.getContext("2d");
              ctx.imageSmoothingEnabled = false;
              ctx.drawImage(atlasImg, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
              map[name] = canvas;
            }
            resolve(map);
          };
          atlasImg.onerror = () => resolve({});
          atlasImg.src = base + manifest.atlas;
        })
    )
    .catch(() => ({}));
  return _cache;
}
