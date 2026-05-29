// townChunks.js — lazy, culled CHUNK baking for the static town world.
//
// A 24×24 town at CELL=176 is ~4224 world px per side and bakes to ~8448px at
// TEXTURE_SCALE — well past the ~4096/8192px WebGL max-texture limit and far more
// pixels than any single viewport needs. So instead of one giant background
// texture, BOTH renderers carve the world into fixed-size square CHUNKS
// (chunkCells × chunkCells logical cells, i.e. chunkPx world px), bake only the
// chunks the camera can currently see, and cache them (LRU, CONFIG-bounded).
//
// This module owns the chunk MATH (dims / keys / world rects / which chunks are
// visible for a camera rect) and the per-chunk BAKE. It bakes a chunk by drawing
// ONLY that chunk's world sub-rectangle via townArt.drawTownInto into a chunk-
// sized canvas (scale + negative translate + clip), so the work per chunk is
// bounded by the chunk — not the whole world — and seams line up because objects
// straddling a seam are drawn by both neighbours and clipped.
//
// It re-derives chunk dimensions from the fields computeLayout() already attached
// to `layout` (chunkCells/chunkPx/chunkCols/chunkRows). It does NOT import the
// collision-grid machinery and townArt.computeLayout computes those same numbers
// INLINE rather than importing here, so there is no import cycle.
//
// Determinism: chunk bakes call townArt.drawTownInto, which seeds its own RNG
// purely off stable ids/strings (never the sim RNG), so the same chunk always
// bakes identically regardless of when or in what order it is baked.
//
// Node-safe: chunkDims/chunkKey/chunkWorldRect/visibleChunks are pure math and
// run headless; makeChunkCanvas returns null when there is no `document`.

import { CELL, TEXTURE_SCALE, drawTownInto } from "./townArt.js";
import { CONFIG } from "../config.js";

// Resolve the chunk grid for a layout. Prefer the values computeLayout already
// attached (the superset layout), else derive them with the same inline formula
// so a bare layout still works. chunkCells = logical cells/chunk; chunkPx = world
// px/chunk.
export function chunkDims(layout) {
  if (
    layout &&
    Number.isFinite(layout.chunkCells) &&
    Number.isFinite(layout.chunkPx) &&
    Number.isFinite(layout.chunkCols) &&
    Number.isFinite(layout.chunkRows)
  ) {
    return {
      chunkCells: layout.chunkCells,
      chunkPx: layout.chunkPx,
      chunkCols: layout.chunkCols,
      chunkRows: layout.chunkRows,
    };
  }
  const cell = (layout && Number.isFinite(layout.CELL)) ? layout.CELL : CELL;
  const cols = (layout && Number.isFinite(layout.cols)) ? layout.cols : 1;
  const rows = (layout && Number.isFinite(layout.rows)) ? layout.rows : 1;
  const chunkCells = (CONFIG.rendering && CONFIG.rendering.chunkCells) || 4;
  const chunkPx = chunkCells * cell;
  const chunkCols = Math.max(1, Math.ceil(cols / chunkCells));
  const chunkRows = Math.max(1, Math.ceil(rows / chunkCells));
  return { chunkCells, chunkPx, chunkCols, chunkRows };
}

// Stable string key for a chunk coordinate (used as a Map/cache key).
export function chunkKey(cx, cy) {
  return cx + "," + cy;
}

// World-space (logical px) rectangle covered by chunk (cx,cy). Always the full
// chunkPx square (the caller/clip handles the world edge); this keeps the bake
// math uniform and the translate exact.
export function chunkWorldRect(layout, cx, cy) {
  const { chunkPx } = chunkDims(layout);
  return { x: cx * chunkPx, y: cy * chunkPx, w: chunkPx, h: chunkPx };
}

// All chunks whose world rect intersects `worldRect` (typically the camera's
// visibleWorldRect, optionally padded), clamped to [0,chunkCols)×[0,chunkRows).
// Returns [{cx,cy,key}] in deterministic row-major order so bake order is stable.
export function visibleChunks(layout, worldRect) {
  const { chunkPx, chunkCols, chunkRows } = chunkDims(layout);
  const out = [];
  if (!worldRect) {
    for (let cy = 0; cy < chunkRows; cy++)
      for (let cx = 0; cx < chunkCols; cx++) out.push({ cx, cy, key: chunkKey(cx, cy) });
    return out;
  }
  const cx0 = clampInt(Math.floor(worldRect.x / chunkPx), 0, chunkCols - 1);
  const cy0 = clampInt(Math.floor(worldRect.y / chunkPx), 0, chunkRows - 1);
  // Right/bottom edges are exclusive; nudge inward so a rect ending exactly on a
  // chunk boundary does not pull in the next chunk.
  const cx1 = clampInt(Math.floor((worldRect.x + worldRect.w - 1e-3) / chunkPx), 0, chunkCols - 1);
  const cy1 = clampInt(Math.floor((worldRect.y + worldRect.h - 1e-3) / chunkPx), 0, chunkRows - 1);
  for (let cy = cy0; cy <= cy1; cy++)
    for (let cx = cx0; cx <= cx1; cx++) out.push({ cx, cy, key: chunkKey(cx, cy) });
  return out;
}

// Bake ONE chunk into its own canvas. Returns null under a headless runtime (no
// `document`), so the Node tests can import this module without a DOM.
//
//   layout   : computeLayout(sim) result
//   sprites  : tilemap sprite atlas (or null/{} for the procedural fallback)
//   cx, cy   : chunk coordinate
//   opts.scale    : device px per logical px (default TEXTURE_SCALE), auto-clamped
//                   so chunkPx*scale never exceeds CONFIG.rendering.maxBakePx
//   opts.lightsOn : pass-through to drawTownInto for the warm window-light pass
export function makeChunkCanvas(layout, sprites, cx, cy, opts = {}) {
  if (typeof document === "undefined" || !document.createElement) return null;

  const { chunkPx } = chunkDims(layout);

  // Clamp scale so the baked canvas stays within the platform's max bake size.
  const maxBakePx = (CONFIG.rendering && CONFIG.rendering.maxBakePx) || 4096;
  let scale = (Number.isFinite(opts.scale) && opts.scale > 0) ? opts.scale : TEXTURE_SCALE;
  if (chunkPx * scale > maxBakePx) scale = Math.max(1, maxBakePx / chunkPx);

  const px = Math.max(1, Math.round(chunkPx * scale));
  const cv = document.createElement("canvas");
  cv.width = px;
  cv.height = px;
  const g = cv.getContext && cv.getContext("2d");
  if (!g) return cv;
  if (g.imageSmoothingEnabled !== undefined) g.imageSmoothingEnabled = false;

  const rect = chunkWorldRect(layout, cx, cy);
  // Map world space -> this chunk's local pixels: scale up, shift world origin so
  // (rect.x, rect.y) lands at the canvas origin, then clip so objects straddling a
  // seam (drawn by both neighbours) never bleed past this chunk's bounds.
  g.scale(scale, scale);
  g.translate(-rect.x, -rect.y);
  g.beginPath();
  g.rect(rect.x, rect.y, rect.w, rect.h);
  g.clip();

  drawTownInto(g, layout, sprites, rect, { lightsOn: !!opts.lightsOn });
  return cv;
}

function clampInt(v, lo, hi) {
  v = Math.floor(v);
  return v < lo ? lo : v > hi ? hi : v;
}

export default {
  chunkDims,
  chunkKey,
  chunkWorldRect,
  visibleChunks,
  makeChunkCanvas,
};
