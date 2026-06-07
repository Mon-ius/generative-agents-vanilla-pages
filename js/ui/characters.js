// characters.js — the shared CharacterFactory: ONE source of avatars for BOTH
// renderers (PixiMapView's WebGL view and MapView's canvas-2D fallback).
//
// It owns everything about how an agent's body looks and animates:
//   (a) a RUNTIME SPRITESHEET system — an `assets/characters.json` manifest
//       (a frames grid: down/left/right/up rows × N walk columns), a browser
//       canvas slicer that cuts a loaded sheet image into per-direction frame
//       canvases (kept 1×; the renderer scales), and a 4-direction walk loop; and
//   (b) an enhanced PROCEDURAL avatar fallback drawn from canvas primitives —
//       varied body shape, skin tone, hairstyle and outfit colour, all derived
//       *deterministically* from a hash of agent.id (never global randomness),
//       with directional facing and a 2-frame leg-swing/bob walk.
//
// Renderers never touch sprites or palettes directly. They construct one factory,
// call factory.makeAvatar(agent), then drive each Avatar with update()/refresh()
// and draw it via drawCanvas() (canvas-2D) or pixiBuild(PIXI) (Pixi). The Pixi
// path is given the PIXI namespace object (NOT a bare import) because Pixi is
// dynamically imported in PixiMapView and must stay out of the static graph that
// the Node tests load — exactly mirroring townArt/PixiMapView conventions.
//
// Node-safe by construction: with no `document`/`fetch`/`Image` the loaders
// resolve to null/{} and makeAvatar() always returns a working procedural Avatar
// whose canvas-producing methods no-op gracefully when no 2D context exists.

import { seededRandom } from "../utils/random.js";
import { shade, hexToRgb } from "./townArt.js";

// ---- tuning -----------------------------------------------------------------
// Mirrors the architect's CONFIG.characters defaults. Renderers may override by
// reading their own CONFIG; these constants are the module's self-contained
// fallbacks so characters.js works standalone (and in headless tests).
export const FPS = 6;            // walk-frame advance rate (frames per second)
export const FRAME_W = 16;       // logical sprite/art width  (1× art)
export const FRAME_H = 24;       // logical sprite/art height (1× art)
const DIRS = ["down", "left", "right", "up"];
const IDLE_FALLBACK_DIR = "down";

// =============================================================================
// MANIFEST + SHEET LOADING (node-safe)
// =============================================================================

/**
 * @typedef {Object} SheetDef
 * @property {string}  file     path to the PNG relative to `base`
 * @property {number}  cols     columns in the sheet grid
 * @property {number}  rows     rows in the sheet grid
 * @property {{down:number,left:number,right:number,up:number}} dirRows row index per direction
 * @property {number[]} walkCols ordered column indices that make up the walk cycle
 * @property {number}  [idleCol] column to use when standing still (defaults walkCols[0]||0)
 */

/**
 * @typedef {Object} Manifest
 * @property {number} frameW
 * @property {number} frameH
 * @property {number} anchorX  horizontal anchor inside a frame (px, from left)
 * @property {number} anchorY  vertical anchor inside a frame (px, from top — the "feet")
 * @property {number} fps
 * @property {Object.<string,SheetDef>} sheets
 * @property {string[]} variants   sheet keys eligible for random per-agent assignment
 * @property {{skins:string[],hairs:string[],outfits:string[]}} palette
 */

/**
 * Load the character manifest. Resolves to null (rather than throwing) whenever
 * fetch is unavailable (Node), the file is missing, or the JSON is malformed —
 * the factory then runs in pure procedural mode.
 * @param {string} [base="assets/"]
 * @returns {Promise<Manifest|null>}
 */
export async function loadCharacterManifest(base = "assets/") {
  if (typeof fetch !== "function") return null;
  try {
    const res = await fetch(`${base}characters.json`, { cache: "no-cache" });
    if (!res || !res.ok) return null;
    const m = await res.json();
    return normalizeManifest(m);
  } catch {
    return null;
  }
}

/**
 * Defensive normalisation so a partial/hand-edited manifest can't crash the
 * factory: fills defaults, coerces numbers, and clamps the grid description.
 * @param {any} m
 * @returns {Manifest|null}
 */
export function normalizeManifest(m) {
  if (!m || typeof m !== "object") return null;
  const frameW = num(m.frameW, FRAME_W);
  const frameH = num(m.frameH, FRAME_H);
  const sheets = {};
  const src = m.sheets && typeof m.sheets === "object" ? m.sheets : {};
  for (const [key, d] of Object.entries(src)) {
    if (!d || typeof d.file !== "string") continue;
    const cols = Math.max(1, Math.floor(num(d.cols, 1)));
    const rows = Math.max(1, Math.floor(num(d.rows, 1)));
    const dr = d.dirRows && typeof d.dirRows === "object" ? d.dirRows : {};
    const dirRows = {
      down: clampInt(dr.down, 0, rows - 1, 0),
      left: clampInt(dr.left, 0, rows - 1, Math.min(1, rows - 1)),
      right: clampInt(dr.right, 0, rows - 1, Math.min(2, rows - 1)),
      up: clampInt(dr.up, 0, rows - 1, Math.min(3, rows - 1)),
    };
    let walkCols = Array.isArray(d.walkCols) && d.walkCols.length
      ? d.walkCols.map((c) => clampInt(c, 0, cols - 1, 0))
      : Array.from({ length: cols }, (_, i) => i);
    const idleCol = clampInt(d.idleCol, 0, cols - 1, walkCols[0] ?? 0);
    // ox/oy: this variant's frame-block origin (px) inside a shared atlas.
    // Default 0 keeps the OLD one-file-per-variant manifests working unchanged.
    const ox = num(d.ox, 0);
    const oy = num(d.oy, 0);
    sheets[key] = { file: d.file, cols, rows, dirRows, walkCols, idleCol, ox, oy };
  }
  const variants = Array.isArray(m.variants) && m.variants.length
    ? m.variants.filter((k) => sheets[k])
    : Object.keys(sheets);
  const p = m.palette && typeof m.palette === "object" ? m.palette : {};
  const palette = {
    skins: arrOf(p.skins, DEFAULT_PALETTE.skins),
    hairs: arrOf(p.hairs, DEFAULT_PALETTE.hairs),
    outfits: arrOf(p.outfits, DEFAULT_PALETTE.outfits),
  };
  const out = {
    frameW,
    frameH,
    anchorX: num(m.anchorX, Math.round(frameW / 2)),
    anchorY: num(m.anchorY, frameH - 2),
    fps: num(m.fps, FPS),
    sheets,
    variants,
    palette,
  };
  // Tolerate an optional top-level `atlas` (the shared PNG every variant points
  // at); carried through so loaders/tools can read it without breaking old data.
  if (typeof m.atlas === "string") out.atlas = m.atlas;
  return out;
}

/**
 * Load every sheet image referenced by the manifest, in parallel. Individual
 * failures are dropped (that variant silently falls back to procedural); returns
 * {} when there's nothing to load or no Image constructor (Node).
 * @param {Manifest|null} manifest
 * @param {string} [base="assets/"]
 * @returns {Promise<Object.<string,HTMLImageElement>>}
 */
export async function loadCharacterSheets(manifest, base = "assets/") {
  if (!manifest || typeof Image === "undefined") return {};
  const keys = Object.keys(manifest.sheets || {});
  if (!keys.length) return {};

  // Single-request optimisation (the CSS-sprite win): many variants can share
  // one atlas PNG, so fetch each UNIQUE def.file exactly once, then point every
  // sheetKey that uses that file at the SAME decoded HTMLImageElement.
  const files = [...new Set(keys.map((k) => manifest.sheets[k].file))];
  const byFile = {};
  await Promise.all(
    files.map(
      (file) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            byFile[file] = img;
            resolve();
          };
          img.onerror = () => resolve(); // drop the failed atlas, keep the rest
          try {
            img.src = `${base}${file}`;
          } catch {
            resolve();
          }
        })
    )
  );

  const out = {};
  for (const key of keys) {
    const img = byFile[manifest.sheets[key].file];
    if (img) out[key] = img; // shared atlas → same element across keys
  }
  return out;
}

// =============================================================================
// RUNTIME SLICER (browser only)
// =============================================================================

// Slice cache, keyed by sheetKey -> { [dir]: { walk:[Canvas...], idle:Canvas } }.
// Shared across all agents using the same sheet, so a 4-row sheet is decoded and
// cut exactly once regardless of how many agents wear it.
const _sliceCache = new Map();
// Lazy PIXI.Texture cache keyed `${sheetKey}|${dir}|${frame}` (frame -1 = idle).
// Wrapping the SAME per-frame canvas avoids a second image decode for Pixi.
const _textureCache = new Map();

/**
 * Cut one sheet image into per-direction frame canvases at 1× (frameW×frameH).
 * Idempotent + cached per sheetKey. Returns null in headless environments.
 * @param {HTMLImageElement} img
 * @param {SheetDef} sheetDef
 * @param {Manifest} manifest
 * @param {string} sheetKey
 * @returns {{[dir:string]:{walk:HTMLCanvasElement[], idle:HTMLCanvasElement}}|null}
 */
export function sliceSheet(img, sheetDef, manifest, sheetKey) {
  if (sheetKey && _sliceCache.has(sheetKey)) return _sliceCache.get(sheetKey);
  if (!img || !canMakeCanvas()) return null;
  const fw = manifest.frameW;
  const fh = manifest.frameH;
  // This variant's frame-block origin within the atlas (0,0 for legacy sheets).
  const ox = sheetDef.ox || 0;
  const oy = sheetDef.oy || 0;
  const result = {};
  for (const dir of DIRS) {
    const row = sheetDef.dirRows[dir];
    const walk = sheetDef.walkCols.map((col) => cutCell(img, col, row, fw, fh, ox, oy));
    const idle =
      sheetDef.idleCol === sheetDef.walkCols[0]
        ? walk[0]
        : cutCell(img, sheetDef.idleCol, row, fw, fh, ox, oy);
    result[dir] = { walk, idle: idle || walk[0] };
  }
  if (sheetKey) _sliceCache.set(sheetKey, result);
  return result;
}

/**
 * Draw one grid cell into its own frameW×frameH canvas (1×, nearest-neighbour).
 * The source cell sits at the atlas offset: ((ox)+col*fw, (oy)+row*fh).
 */
function cutCell(img, col, row, fw, fh, ox = 0, oy = 0) {
  const cv = newCanvas(fw, fh);
  const g = cv.getContext && cv.getContext("2d");
  if (!g) return cv;
  if (g.imageSmoothingEnabled !== undefined) g.imageSmoothingEnabled = false;
  g.drawImage(img, ox + col * fw, oy + row * fh, fw, fh, 0, 0, fw, fh);
  return cv;
}

/**
 * Lazily wrap a sliced per-frame canvas in a PIXI.Texture, cached module-wide so
 * every agent on a given sheet/dir/frame shares one GPU texture.
 * @param {Object} PIXI  the dynamically-imported Pixi namespace
 * @param {string} sheetKey
 * @param {string} dir
 * @param {number} frame  walk index, or -1 for idle
 * @param {HTMLCanvasElement} canvas
 * @returns {any} PIXI.Texture
 */
function textureFor(PIXI, sheetKey, dir, frame, canvas) {
  const key = `${sheetKey}|${dir}|${frame}`;
  let tex = _textureCache.get(key);
  if (!tex) {
    tex = PIXI.Texture.from(canvas);
    // crisp pixel art when the camera zooms in
    if (tex.source && "scaleMode" in tex.source) tex.source.scaleMode = "nearest";
    else if ("scaleMode" in tex) tex.scaleMode = "nearest";
    _textureCache.set(key, tex);
  }
  return tex;
}

/** Test/seam helper: drop all cached slices + textures (e.g. on a sheet reload). */
export function clearCharacterCaches() {
  _sliceCache.clear();
  _textureCache.clear();
}

// =============================================================================
// DETERMINISTIC VARIANT ASSIGNMENT
// =============================================================================

// Used whenever the manifest is absent or supplies no palette of its own.
const DEFAULT_PALETTE = {
  skins: ["#f1c9a5", "#e6b48f", "#c98e63", "#a96e44", "#8a5a36", "#f7d9bd"],
  hairs: ["#2a2333", "#5a3a1e", "#7c5430", "#9c6b3f", "#b08a4f", "#3a3a44", "#caa44e", "#86323a"],
  outfits: ["#4b6bdc", "#d24f6f", "#5aa05a", "#e0673c", "#8a5fb0", "#2f9e9e", "#e6b53c", "#cf5aa0"],
};
const BODY_SHAPES = ["slim", "round"];
const HAIR_STYLES = ["cap", "short", "long", "bun"];

/**
 * Pick a stable spritesheet + colour palette for an agent. Deterministic via
 * seededRandom(agent.id), so the same agent looks identical across reloads and
 * across both renderers, and it NEVER consumes the simulation's RNG. Honours an
 * explicit agent.spriteVariant / agent.palette if present (e.g. from a save).
 *
 * @param {{id:string, color?:string, spriteVariant?:string, palette?:object}} agent
 * @param {Manifest|null} manifest
 * @returns {{sheetKey:string|null, palette:{skin:string,hair:string,outfit:string}}}
 */
export function assignVariant(agent, manifest) {
  const rng = seededRandom(`avatar:${agent && agent.id != null ? agent.id : "?"}`);
  const pal = (manifest && manifest.palette) || DEFAULT_PALETTE;

  // Sheet: explicit pick wins (if still valid), else deterministic from variants.
  let sheetKey = null;
  if (manifest && manifest.sheets) {
    const variants = manifest.variants && manifest.variants.length
      ? manifest.variants
      : Object.keys(manifest.sheets);
    if (agent && agent.spriteVariant && manifest.sheets[agent.spriteVariant]) {
      sheetKey = agent.spriteVariant;
    } else if (variants.length) {
      sheetKey = variants[Math.floor(rng() * variants.length)] || null;
      if (sheetKey && !manifest.sheets[sheetKey]) sheetKey = null;
    }
  }

  // Colours: explicit agent.palette / agent.color override, else seeded picks.
  const given = (agent && agent.palette) || {};
  const skin = given.skin || pickHex(pal.skins, DEFAULT_PALETTE.skins, rng);
  const hair = given.hair || pickHex(pal.hairs, DEFAULT_PALETTE.hairs, rng);
  const outfit =
    given.outfit ||
    (agent && agent.color) ||
    pickHex(pal.outfits, DEFAULT_PALETTE.outfits, rng);

  return { sheetKey, palette: { skin, hair, outfit } };
}

/**
 * Resolve the full deterministic "look" for an agent: variant + extra procedural
 * traits (body shape, hair style, directional eye nudge). Pure; same id → same
 * look every time. Renderers don't call this directly — makeAvatar() does.
 * @param {object} agent
 * @param {Manifest|null} manifest
 */
function resolveLook(agent, manifest) {
  const v = assignVariant(agent, manifest);
  // A second independent stream so adding/removing palette picks above never
  // shifts these structural traits.
  const rng = seededRandom(`avatar-shape:${agent && agent.id != null ? agent.id : "?"}`);
  return {
    sheetKey: v.sheetKey,
    palette: v.palette,
    body: BODY_SHAPES[Math.floor(rng() * BODY_SHAPES.length)],
    hairStyle: HAIR_STYLES[Math.floor(rng() * HAIR_STYLES.length)],
    // tiny per-agent jitter so a crowd of procedural folk doesn't look stamped
    headBob: 0.85 + rng() * 0.4,
  };
}

// =============================================================================
// FACTORY + AVATARS
// =============================================================================

/**
 * Build the shared factory. `manifest`/`sheets` may be null/empty — the factory
 * then hands out procedural avatars only. Pre-slices every loaded sheet up front
 * (cached) so the first frame of animation is cheap.
 *
 * @param {{manifest:Manifest|null, sheets:Object.<string,HTMLImageElement>|{}}} opts
 * @returns {{ manifest:Manifest|null, makeAvatar:(agent:object)=>Avatar }}
 */
export function createCharacterFactory({ manifest = null, sheets = {} } = {}) {
  const haveSheets = manifest && sheets && Object.keys(sheets).length > 0;

  // Eagerly slice loaded sheets (no-op/null in headless). Cached by sheetKey.
  const slices = {};
  if (haveSheets) {
    for (const [key, img] of Object.entries(sheets)) {
      const def = manifest.sheets[key];
      if (!def) continue;
      const cut = sliceSheet(img, def, manifest, key);
      if (cut) slices[key] = cut;
    }
  }

  return {
    manifest,
    /**
     * @param {object} agent
     * @returns {Avatar}
     */
    makeAvatar(agent) {
      const look = resolveLook(agent, manifest);
      const useSprite = Boolean(look.sheetKey && slices[look.sheetKey]);
      return useSprite
        ? new SpriteAvatar(agent, look, manifest, slices[look.sheetKey])
        : new ProceduralAvatar(agent, look, manifest);
    },
  };
}

/**
 * @typedef {Object} Avatar
 * @property {'sprite'|'procedural'} mode
 * @property {number} footRadius  half-width of the shadow ellipse / selection ring
 * @property {(s:{dir:'down'|'left'|'right'|'up', moving:boolean, dtFrames:number})=>void} update
 * @property {()=>HTMLCanvasElement|null} frameCanvas
 * @property {(ctx:CanvasRenderingContext2D, x:number, y:number, scale:number)=>void} drawCanvas
 * @property {(PIXI:object)=>{node:any, refresh:()=>void}} pixiBuild
 */

// Shared per-avatar walk-timer mixin. update() advances an integer frame on an
// fps timer; it is PURE (no drawing) — exactly the contract the renderers need.
class BaseAvatar {
  constructor(agent, look, manifest) {
    this.agent = agent;
    this.look = look;
    this.fps = (manifest && manifest.fps) || FPS;
    this.frameW = (manifest && manifest.frameW) || FRAME_W;
    this.frameH = (manifest && manifest.frameH) || FRAME_H;
    this.anchorX = manifest ? manifest.anchorX : Math.round(this.frameW / 2);
    this.anchorY = manifest ? manifest.anchorY : this.frameH - 2;
    this.dir = IDLE_FALLBACK_DIR;
    this.moving = false;
    this.lying = false;    // asleep in bed: face-up idle pose, no shadow, blanket on
    this.frame = 0;        // walk-cycle index
    this._acc = 0;         // seconds accumulated toward the next frame flip
    this._dirty = true;    // a redraw/texture-swap is needed
    // footRadius keeps the shadow/ring proportionate to the 16×24 art.
    this.footRadius = Math.max(7, Math.round(this.frameW * 0.42));
  }

  /**
   * Advance the walk timer. dtFrames is elapsed *display* frames (~1 per tick at
   * 60fps); we convert to seconds with a 60fps assumption so fps reads naturally.
   * `lying` lays the avatar in bed: beds are drawn vertically (pillow at the
   * top), so the "down"-facing standing idle frame — head up, face to camera —
   * reads as lying on the back; no rotation needed. The renderers pass it only
   * once the avatar has SETTLED on its bed spot (townArt.isSleeping && arrived).
   */
  update({ dir, moving, dtFrames, lying }) {
    const lie = !!lying;
    if (lie !== this.lying) {
      this.lying = lie;
      this._dirty = true;
    }
    if (lie) { dir = "down"; moving = false; }
    if (dir && dir !== this.dir) {
      this.dir = dir;
      this._dirty = true;
    }
    if (moving !== this.moving) {
      this.moving = moving;
      this._dirty = true;
      if (!moving) {
        // settle to a neutral standing frame
        if (this.frame !== this._idleFrameIndex()) this._dirty = true;
        this.frame = this._idleFrameIndex();
        this._acc = 0;
      }
    }
    if (moving) {
      this._acc += (Math.max(0, dtFrames) / 60) * this.fps;
      while (this._acc >= 1) {
        this._acc -= 1;
        this.frame = (this.frame + 1) % this._cycleLength();
        this._dirty = true;
      }
    }
  }

  _cycleLength() { return 1; }
  _idleFrameIndex() { return 0; }

  /**
   * Blanket rect in frame-local px, origin at the FEET anchor (both renderers
   * anchor avatars there). Covers the body from the hips down so a lying avatar
   * reads as tucked into its bed; shared by the canvas + Pixi draw paths.
   */
  _blanketRect() {
    const w = this.frameW * 0.72;
    const h = this.frameH * 0.42;
    return { x: -w / 2, y: -h + 2, w, h };
  }

  /** Canvas blanket overlay (Pixi uses a Graphics child toggled in refresh()). */
  _drawBlanketCanvas(ctx, x, y, scale) {
    const r = this._blanketRect();
    const bx = x + r.x * scale, by = y + r.y * scale;
    const bw = r.w * scale, bh = r.h * scale;
    roundRectPath(ctx, bx, by, bw, bh, 3 * scale);
    ctx.fillStyle = "rgba(176,83,63,0.92)";              // warm quilt
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.55)";            // folded sheet line at the top
    ctx.fillRect(bx + 1.5 * scale, by, bw - 3 * scale, 2.5 * scale);
  }
}

// ---- sprite avatar ----------------------------------------------------------
class SpriteAvatar extends BaseAvatar {
  /**
   * @param {object} agent
   * @param {object} look
   * @param {Manifest} manifest
   * @param {{[dir:string]:{walk:HTMLCanvasElement[], idle:HTMLCanvasElement}}} slice
   */
  constructor(agent, look, manifest, slice) {
    super(agent, look, manifest);
    this.mode = "sprite";
    this.slice = slice;
    const def = manifest.sheets[look.sheetKey];
    this.walkLen = (def.walkCols && def.walkCols.length) || 1;
    this.frame = this._idleFrameIndex();
  }

  _cycleLength() { return this.walkLen; }
  // Many sheets put the standing pose at column 0; mid-cycle reads as "planted".
  _idleFrameIndex() { return 0; }

  /** The per-frame canvas for the current dir + walk/idle frame. */
  frameCanvas() {
    const d = this.slice[this.dir] || this.slice[IDLE_FALLBACK_DIR];
    if (!d) return null;
    return this.moving ? d.walk[this.frame % d.walk.length] : d.idle;
  }

  drawCanvas(ctx, x, y, scale = 1) {
    if (!ctx) return;
    if (!this.lying) drawGroundShadow(ctx, x, y, this.footRadius * scale); // in bed: no floor shadow
    const cv = this.frameCanvas();
    if (!cv) return;
    const prev = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    const dw = this.frameW * scale;
    const dh = this.frameH * scale;
    ctx.drawImage(cv, x - this.anchorX * scale, y - this.anchorY * scale, dw, dh);
    ctx.imageSmoothingEnabled = prev;
    if (this.lying) this._drawBlanketCanvas(ctx, x, y, scale);
  }

  pixiBuild(PIXI) {
    const node = new PIXI.Container();
    const shadow = new PIXI.Graphics()
      .ellipse(0, 0, this.footRadius, this.footRadius * 0.45)
      .fill({ color: 0x000000, alpha: 0.22 });
    const sprite = new PIXI.Sprite();
    sprite.anchor.set(this.anchorX / this.frameW, this.anchorY / this.frameH);
    node.addChild(shadow);
    node.addChild(sprite);
    const blanket = buildPixiBlanket(PIXI, this._blanketRect());
    node.addChild(blanket);
    const refresh = () => {
      shadow.visible = !this.lying;     // in bed: blanket on, floor shadow off
      blanket.visible = this.lying;
      const cv = this.frameCanvas();
      if (!cv) return;
      const frameIdx = this.moving ? this.frame % this.walkLen : -1;
      sprite.texture = textureFor(PIXI, this.look.sheetKey, this.dir, frameIdx, cv);
      this._dirty = false;
    };
    refresh();
    return { node, refresh };
  }
}

// ---- enhanced procedural avatar ---------------------------------------------
// Strictly richer than the old single static blob: seeded body shape + hair
// style + skin/outfit colour, 4 directions that genuinely read differently
// (eyes/hair shift, back-of-head when facing up, profile when facing sideways),
// and a 2-frame leg-swing walk. Each (dir, frameParity) is rendered once into a
// cached canvas and reused — re-rendering only when dir/frame changes.
class ProceduralAvatar extends BaseAvatar {
  constructor(agent, look, manifest) {
    super(agent, look, manifest);
    this.mode = "procedural";
    this.skin = look.palette.skin;
    this.hair = look.palette.hair;
    this.outfit = look.palette.outfit;
    this.body = look.body;        // 'slim' | 'round'
    this.hairStyle = look.hairStyle;
    // canvas cache keyed `${dir}|${parity}` (parity: 0 stand, 1 left-step, 2 right-step)
    this._cache = new Map();
  }

  // Two walk frames (step-left / step-right) plus the implicit standing pose.
  _cycleLength() { return 2; }
  _idleFrameIndex() { return 0; }

  /** Current leg phase: 0 standing, 1 left foot fwd, 2 right foot fwd. */
  _parity() {
    if (!this.moving) return 0;
    return (this.frame % 2) + 1;
  }

  frameCanvas() {
    const key = `${this.dir}|${this._parity()}`;
    let cv = this._cache.get(key);
    if (!cv) {
      cv = this._render(this.dir, this._parity());
      if (cv) this._cache.set(key, cv);
    }
    this._dirty = false;
    return cv;
  }

  drawCanvas(ctx, x, y, scale = 1) {
    if (!ctx) return;
    if (!this.lying) drawGroundShadow(ctx, x, y, this.footRadius * scale); // in bed: no floor shadow
    const cv = this.frameCanvas();
    if (!cv) return;
    const prev = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      cv,
      x - this.anchorX * scale,
      y - this.anchorY * scale,
      this.frameW * scale,
      this.frameH * scale
    );
    ctx.imageSmoothingEnabled = prev;
    if (this.lying) this._drawBlanketCanvas(ctx, x, y, scale);
  }

  pixiBuild(PIXI) {
    const node = new PIXI.Container();
    const shadow = new PIXI.Graphics()
      .ellipse(0, 0, this.footRadius, this.footRadius * 0.45)
      .fill({ color: 0x000000, alpha: 0.22 });
    const sprite = new PIXI.Sprite();
    sprite.anchor.set(this.anchorX / this.frameW, this.anchorY / this.frameH);
    node.addChild(shadow);
    node.addChild(sprite);
    const blanket = buildPixiBlanket(PIXI, this._blanketRect());
    node.addChild(blanket);
    // Wrap the SAME cached per-pose canvases as textures (keyed per agent id so
    // distinct looks don't collide). Cheap: each pose decodes once.
    const idTag = this.agent && this.agent.id != null ? this.agent.id : "?";
    const refresh = () => {
      shadow.visible = !this.lying;     // in bed: blanket on, floor shadow off
      blanket.visible = this.lying;
      const cv = this.frameCanvas();
      if (!cv) return;
      const key = `proc:${idTag}|${this.dir}|${this._parity()}`;
      let tex = _textureCache.get(key);
      if (!tex) {
        tex = PIXI.Texture.from(cv);
        if (tex.source && "scaleMode" in tex.source) tex.source.scaleMode = "nearest";
        else if ("scaleMode" in tex) tex.scaleMode = "nearest";
        _textureCache.set(key, tex);
      }
      sprite.texture = tex;
    };
    refresh();
    return { node, refresh };
  }

  /**
   * Render one (direction, parity) pose into a fresh frameW×frameH canvas at 1×.
   * Returns null in headless environments (no canvas) — drawCanvas/pixiBuild then
   * simply skip the body, leaving the shadow (Pixi) / nothing (canvas) behind.
   */
  _render(dir, parity) {
    if (!canMakeCanvas()) return null;
    const W = this.frameW, H = this.frameH;
    const cv = newCanvas(W, H);
    const g = cv.getContext && cv.getContext("2d");
    if (!g) return null;
    if (g.imageSmoothingEnabled !== undefined) g.imageSmoothingEnabled = false;

    const cx = W / 2;
    const baseY = H - 2;                 // feet line (matches anchorY)
    const slim = this.body === "slim";
    const torsoW = slim ? 7 : 9;
    const torsoH = 9;
    const torsoX = Math.round(cx - torsoW / 2);
    const torsoY = baseY - 6 - torsoH;   // leave room for legs
    const headR = slim ? 3.4 : 3.8;
    const headCY = torsoY - headR + 1;

    const facingUp = dir === "up";
    const facingLeft = dir === "left";
    const facingRight = dir === "right";
    const side = facingLeft || facingRight;
    const sideSign = facingRight ? 1 : -1; // which way a profile leans

    // --- legs (2-frame swing) ---
    const legW = slim ? 2 : 3;
    const legTop = baseY - 6;
    const legColor = shade(this.outfit, -0.34);
    g.fillStyle = legColor;
    let lLen = 6, rLen = 6, lDx = 0, rDx = 0;
    if (parity === 1) { lLen = 6; rLen = 4; lDx = side ? sideSign : 0; rDx = side ? -sideSign : 0; }
    else if (parity === 2) { lLen = 4; rLen = 6; lDx = side ? -sideSign : 0; rDx = side ? sideSign : 0; }
    const legGap = slim ? 1 : 1.5;
    g.fillRect(Math.round(cx - legGap - legW + lDx), legTop, legW, lLen); // left leg
    g.fillRect(Math.round(cx + legGap + rDx), legTop, legW, rLen);        // right leg
    // little shoes
    g.fillStyle = shade(this.outfit, -0.55);
    g.fillRect(Math.round(cx - legGap - legW + lDx), legTop + lLen - 1, legW, 1);
    g.fillRect(Math.round(cx + legGap + rDx), legTop + rLen - 1, legW, 1);

    // --- torso / outfit ---
    g.fillStyle = this.outfit;
    roundRectPath(g, torsoX, torsoY, torsoW, torsoH, 2);
    g.fill();
    // shaded hem + a center seam for depth
    g.fillStyle = shade(this.outfit, -0.18);
    g.fillRect(torsoX, torsoY + torsoH - 2, torsoW, 2);
    g.fillStyle = shade(this.outfit, 0.12);
    g.fillRect(torsoX + 1, torsoY + 1, torsoW - 2, 1);

    // --- arms (skin cuffs); swing opposite the legs for a natural gait ---
    const armColor = shade(this.outfit, 0.04);
    const armSwing = parity === 1 ? 1 : parity === 2 ? -1 : 0;
    g.fillStyle = armColor;
    if (side) {
      // profile: one arm visible, nudged by the step
      g.fillRect(Math.round(cx + sideSign * (torsoW / 2 - 1)), torsoY + 1, 2, 5 + Math.abs(armSwing));
    } else {
      g.fillRect(torsoX - 2, torsoY + 1 - armSwing, 2, 6);            // left arm
      g.fillRect(torsoX + torsoW, torsoY + 1 + armSwing, 2, 6);       // right arm
    }
    // hands
    g.fillStyle = this.skin;
    if (side) {
      g.fillRect(Math.round(cx + sideSign * (torsoW / 2 - 1)), torsoY + 5 + Math.abs(armSwing), 2, 2);
    } else {
      g.fillRect(torsoX - 2, torsoY + 6 - armSwing, 2, 2);
      g.fillRect(torsoX + torsoW, torsoY + 6 + armSwing, 2, 2);
    }

    // --- head ---
    g.fillStyle = this.skin;
    circlePath(g, cx, headCY, headR);
    g.fill();
    // subtle shading on the far side
    g.fillStyle = shade(this.skin, -0.12);
    g.beginPath();
    g.arc(cx, headCY, headR, side ? (sideSign > 0 ? -Math.PI / 2 : Math.PI / 2) : 0,
      side ? (sideSign > 0 ? Math.PI / 2 : (3 * Math.PI) / 2) : Math.PI);
    g.fill();

    // --- hair (style + per-direction coverage) ---
    this._drawHair(g, cx, headCY, headR, dir, facingUp, side, sideSign);

    // --- face (skip when facing away) ---
    if (!facingUp) {
      g.fillStyle = "#2a2333";
      const eyeY = headCY - 0.2;
      if (side) {
        // single forward eye on the profile
        g.fillRect(Math.round(cx + sideSign * (headR - 2)), Math.round(eyeY - 0.5), 1.4, 1.6);
      } else {
        g.fillRect(Math.round(cx - 2.1), Math.round(eyeY - 0.5), 1.4, 1.6);
        g.fillRect(Math.round(cx + 0.7), Math.round(eyeY - 0.5), 1.4, 1.6);
      }
    }

    return cv;
  }

  _drawHair(g, cx, cy, r, dir, facingUp, side, sideSign) {
    g.fillStyle = this.hair;
    const style = this.hairStyle;
    if (facingUp) {
      // back of the head: hair covers almost everything
      circlePath(g, cx, cy, r + 0.3);
      g.fill();
      if (style === "long") g.fillRect(Math.round(cx - r), Math.round(cy), Math.ceil(r * 2), Math.round(r + 2));
      if (style === "bun") { circlePath(g, cx, cy - r * 0.4, r * 0.5); g.fill(); }
      return;
    }
    // front/side: a fringe across the top, style-specific extras
    g.beginPath();
    g.arc(cx, cy + (style === "cap" ? 0.6 : 0), r + 0.3, Math.PI, 0);
    g.closePath();
    g.fill();
    if (style === "short") {
      g.fillRect(Math.round(cx - r), Math.round(cy - r * 0.4), Math.ceil(r * 2), 2);
    } else if (style === "long") {
      // locks down the sides (or the trailing side in profile)
      if (side) {
        g.fillRect(Math.round(cx - sideSign * r - (sideSign > 0 ? 0 : 1)), Math.round(cy - r * 0.4), 1.6, Math.round(r + 3));
      } else {
        g.fillRect(Math.round(cx - r - 0.2), Math.round(cy - r * 0.4), 1.6, Math.round(r + 3));
        g.fillRect(Math.round(cx + r - 1.4), Math.round(cy - r * 0.4), 1.6, Math.round(r + 3));
      }
    } else if (style === "bun") {
      circlePath(g, cx, cy - r - 0.6, r * 0.45);
      g.fill();
    }
    // 'cap' = just the rounded fringe drawn above (clean short cap).
  }
}

// =============================================================================
// SMALL DRAW + UTILITY HELPERS (local; mirrors townArt's primitive style)
// =============================================================================

/** Soft contact shadow under an avatar's feet, in world coords (canvas-2D). */
function drawGroundShadow(ctx, x, y, rx) {
  ctx.save();
  ctx.fillStyle = "rgba(20,28,16,0.22)";
  ctx.beginPath();
  ctx.ellipse(x, y, rx, rx * 0.45, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Pixi blanket overlay for a lying (sleeping) avatar — the same warm quilt +
 * folded-sheet top the canvas path draws (BaseAvatar._drawBlanketCanvas).
 * Built once per avatar, hidden by default; refresh() toggles it with `lying`.
 */
function buildPixiBlanket(PIXI, r) {
  const blanket = new PIXI.Graphics()
    .roundRect(r.x, r.y, r.w, r.h, 3).fill({ color: 0xb0533f, alpha: 0.92 })
    .rect(r.x + 1.5, r.y, r.w - 3, 2.5).fill({ color: 0xffffff, alpha: 0.55 });
  blanket.visible = false;
  blanket.eventMode = "none";
  return blanket;
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function circlePath(ctx, cx, cy, r) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
}

/** True when we can allocate a 2D-capable canvas (browser/jsdom). */
function canMakeCanvas() {
  return typeof document !== "undefined" && typeof document.createElement === "function";
}

function newCanvas(w, h) {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  return cv;
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function arrOf(v, dflt) {
  return Array.isArray(v) && v.length ? v.slice() : dflt.slice();
}

/**
 * Pick a colour from `arr` (falling back to `dflt`) using the supplied rng.
 * Always returns a hex STRING (validated via hexToRgb) — the palette contract is
 * {skin,hair,outfit}:hex, and shade()/Pixi fills expect strings, not {r,g,b}.
 */
function pickHex(arr, dflt, rng) {
  const list = Array.isArray(arr) && arr.length ? arr : dflt;
  const c = list[Math.floor(rng() * list.length)];
  // validate so a malformed manifest entry can't poison shade()/fill()
  return hexToRgb(c) ? c : dflt[0];
}
