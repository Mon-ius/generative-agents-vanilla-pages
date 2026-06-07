// gates.js — shared swinging-gate geometry + per-renderer animator for walled
// gardens. ONE source for BOTH renderers (PixiMapView WebGL + MapView canvas-2D),
// exactly like camera.js (shared controller) and characters.js (shared avatar):
// the GEOMETRY is derived once (computeGates → layout.gates, the single shared
// descriptor list), and each renderer owns ONE animator INSTANCE so the per-gate
// open/close STATE lives with the live view — never in a module-global (CLAUDE.md
// forbids module-global mutable state; cf. the Planner plan-id leak).
//
// Why this file exists at all: the static fence ring + hinge posts may be BAKED
// into the chunk textures (townArt), but a chunk bake is a frozen, LRU-cached,
// daytime-only texture — so the SWINGING gate LEAF must be drawn PER-FRAME by the
// renderers' overlay (like avatars and 💬 bubbles), advanced by a render clock,
// NEVER by the sim RNG (so a gate swing can't desync a save).
//
// The gate gap is the SAME centred opening the routing grid punches and the
// building doors use — gapSpan()/GAP_SUBTILES (pathfinding) — so the drawn gate
// lines up pixel-exactly with the walkable gap A* threads (render↔routing
// lockstep). Two centred gaps on a shared edge always align (same gapSpan), so a
// building-door↔garden-gate or garden↔garden passage stays connected.
//
// Node-safe: pure math + a plain class, no DOM, no canvas, no sim import.

import { gapSpan } from "../utils/pathfinding.js";
import { CONFIG } from "../config.js";

// The centred door/tunnel gap window (cell-fraction) — IDENTICAL source as
// townArt.WALL_GAP, so a gate gap == a building-door gap == the A* gap. NEVER
// hand-tune this: change the opening via GAP_SUBTILES in pathfinding.js only.
const WALL_GAP = gapSpan((CONFIG.movement && CONFIG.movement.subdivisions) || 8) || { lo: 0.375, hi: 0.625 };

// Per-edge geometry: the axis along the edge (a) and the outward normal (n).
// The hinge is the LOWER-coordinate end of the centred gap; the leaf lies flush
// ALONG the edge when closed (closedAngle = atan2(a.y,a.x)) and points along the
// outward normal when open (openAngle = atan2(n.y,n.x)). With the hinge fixed at
// the lower end, the swing is ALWAYS a 90° shortest-path rotation:
//   S: closed 0     → open +π/2   (down/outward)
//   N: closed 0     → open -π/2   (up/outward)
//   E: closed +π/2  → open  0     (right/outward)
//   W: closed +π/2  → open +π     (left/outward)
const EDGE = {
  N: { ax: 1, ay: 0, nx: 0, ny: -1 },
  S: { ax: 1, ay: 0, nx: 0, ny: 1 },
  W: { ax: 0, ay: 1, nx: -1, ny: 0 },
  E: { ax: 0, ay: 1, nx: 1, ny: 0 },
};
const EDGES = ["N", "S", "E", "W"];

// ---- type-varied gate style -------------------------------------------------
// Renderer-side copy of tools/pack_locations.mjs ZONES (a Node-only dev tool,
// never imported at runtime). KEEP IN LOCKSTEP with pack_locations' ZONES map.
const ZONE_BY_TYPE = {
  home: "residential",
  market: "commercial", cafe: "commercial", shop: "commercial", bakery: "commercial",
  bar: "commercial", diner: "commercial", salon: "commercial", florist: "commercial",
  pharmacy: "commercial", bank: "commercial", post: "commercial",
  clinic: "civic", school: "civic", civic: "civic", library: "civic", museum: "civic",
  office: "civic", chapel: "civic", theater: "civic", gallery: "civic",
  workshop: "craft", studio: "craft", gym: "craft", dock: "craft", garden: "craft",
};
function zoneOfType(t) { return ZONE_BY_TYPE[t] || "commercial"; }

// Outdoor plots never count as a "building" neighbour. Mirror pathfinding.isOpenType
// + townArt.OUTDOOR_TYPES (the BUILDING type "garden" is NOT here — it IS a building).
const OUTDOOR = new Set(["park", "square", "plaza", "green", "street", "road"]);
const SCAN = [["N", 0, -1], ["E", 1, 0], ["S", 0, 1], ["W", -1, 0], ["NE", 1, -1], ["SE", 1, 1], ["SW", -1, 1], ["NW", -1, -1]];
function nearestBuildingType(loc, atMap) {
  if (!loc) return null;
  for (const [, dx, dy] of SCAN) {
    const n = atMap.get((loc.x + dx) + "," + (loc.y + dy));
    if (n && !OUTDOOR.has(n.type)) return n.type;
  }
  return null;
}

// Each STYLE: the swinging leaf sprite, the perimeter fence sprite, the flanking
// pier, and an optional MULTIPLY tint (Pixi sprite.tint; canvas ignores it for v1).
const STYLES = {
  arbor:  { key: "arbor",  leaf: "gate_arbor",  fence: "fence", post: "gate_post", tint: null },
  grand:  { key: "grand",  leaf: "gate_grand",  fence: "fence", post: "gate_post", tint: null },
  iron:   { key: "iron",   leaf: "gate_iron",   fence: "fence", post: "gate_post", tint: null },
  lych:   { key: "lych",   leaf: "lychgate",    fence: "hedge", post: "gate_post", tint: null },
  picket: { key: "picket", leaf: "gate_picket", fence: "fence", post: "gate_post", tint: 0xf5f3ec },
  rustic: { key: "rustic", leaf: "gate_picket", fence: "fence", post: "gate_post", tint: 0x9a6a3a },
};

// Pure, deterministic from the plot type + nearest building. For the shipped scope
// (park|square) the first two branches fire (every park → arbor, every square →
// grand, since they border only courtyards); the neighbour-based branches are ready
// for a future green/plaza opt-in.
function gateStyleFor(plotType, nbType) {
  if (plotType === "park")   return STYLES.arbor;   // rose-arbor arch
  if (plotType === "square") return STYLES.grand;   // ornate civic gate
  if (nbType === "chapel")   return STYLES.lych;    // roofed lychgate
  const zone = zoneOfType(nbType);
  if (zone === "civic")       return STYLES.grand;
  if (zone === "residential") return STYLES.picket; // white picket
  if (zone === "craft")       return STYLES.rustic; // rustic timber (tinted)
  return STYLES.iron;                               // commercial / isolated default
}

/**
 * Derive the gate descriptors for a layout, deterministically (no RNG except a
 * stable seededRandom(locId+edge) for the cosmetic `style`). Reads the walled-
 * garden topology the SAME way townArt reads wallTopology: a Map keyed "x,y" ->
 * { N, S, E, W } where each edge is { 0: solid fence, 1: GATE, 2: open seam }.
 * (A "2"/open seam is a shared edge with a same-complex garden cell — no fence,
 * no gate, no descriptor.) Until the pathfinding garden-walling pass attaches
 * `layout.gardenTopology`, this returns [] and the whole feature is an inert
 * no-op — so wiring it into computeLayout + both renderers now is safe.
 *
 * @param {object} layout  townArt.computeLayout result (needs .CELL, .rects, .gardenTopology)
 * @returns {Array<GateDescriptor>}
 */
export function computeGates(layout) {
  const gates = [];
  if (!layout) return gates;
  const topo = layout.gardenTopology;
  if (!topo || typeof topo.get !== "function" || typeof topo.keys !== "function") return gates;

  const CELL = layout.CELL || (CONFIG.world && CONFIG.world.cellPixels) || 176;
  const lo = WALL_GAP.lo, hi = WALL_GAP.hi;

  // coord "x,y" -> { locId, loc }, so each descriptor carries its real location id
  // and the plot type (for the gate STYLE). Built once from layout.rects.
  const idAt = new Map();
  const atMap = new Map();
  if (layout.rects && typeof layout.rects.forEach === "function") {
    layout.rects.forEach((rc, id) => {
      if (rc && rc.loc) { idAt.set(rc.loc.x + "," + rc.loc.y, id); atMap.set(rc.loc.x + "," + rc.loc.y, rc.loc); }
    });
  }

  // Deterministic emission order (sorted keys, fixed edge order) so the gate list
  // — and thus the renderers' sprite arrays — never depend on Map insertion order.
  const keys = [...topo.keys()].sort();
  for (const key of keys) {
    const cl = topo.get(key);
    if (!cl) continue;
    const comma = key.indexOf(",");
    if (comma < 0) continue;
    const cellX = Number(key.slice(0, comma));
    const cellY = Number(key.slice(comma + 1));
    if (!Number.isFinite(cellX) || !Number.isFinite(cellY)) continue;
    const ux = cellX * CELL, uy = cellY * CELL;
    const locId = idAt.get(key) || ("garden_" + key);

    for (const edge of EDGES) {
      if (cl[edge] !== 1) continue; // 1 = GATE only (0 = fence, 2 = open seam)
      const e = EDGE[edge];

      // Gap endpoints along the edge; the LOWER-coordinate end is the hinge.
      let gapX0, gapY0, gapX1, gapY1;
      if (edge === "N")      { gapX0 = ux + lo * CELL; gapY0 = uy;        gapX1 = ux + hi * CELL; gapY1 = uy; }
      else if (edge === "S") { gapX0 = ux + lo * CELL; gapY0 = uy + CELL; gapX1 = ux + hi * CELL; gapY1 = uy + CELL; }
      else if (edge === "W") { gapX0 = ux;             gapY0 = uy + lo * CELL; gapX1 = ux;             gapY1 = uy + hi * CELL; }
      else /* E */           { gapX0 = ux + CELL;      gapY0 = uy + lo * CELL; gapX1 = ux + CELL;      gapY1 = uy + hi * CELL; }

      // Type-varied style: base from the plot type (park → arbor, square → grand),
      // refined by the nearest building neighbour (chapel → lychgate, civic → grand,
      // residential → picket, craft → rustic, else iron). Deterministic, no RNG.
      const myLoc = atMap.get(key);
      const style = gateStyleFor(myLoc ? myLoc.type : "park", nearestBuildingType(myLoc, atMap));

      gates.push({
        id: "gate_" + locId + "_" + edge,
        locId,
        edge,
        // hinge = lower-coordinate gap end; the leaf draws from x=0 here.
        hingeX: gapX0, hingeY: gapY0,
        gapX0, gapY0, gapX1, gapY1,
        // gap centre (proximity test + culling) and leaf length (hinge → far end).
        gapCX: (gapX0 + gapX1) / 2, gapCY: (gapY0 + gapY1) / 2,
        length: Math.hypot(gapX1 - gapX0, gapY1 - gapY0), // ≈ (hi-lo)*CELL ≈ 44px
        faceDX: e.nx, faceDY: e.ny,                        // outward normal
        closedAngle: Math.atan2(e.ay, e.ax),              // leaf flush along the edge
        openAngle: Math.atan2(e.ny, e.nx),                // leaf along outward normal
        style,
      });
    }
  }
  return gates;
}

// ---- per-renderer animator --------------------------------------------------

const OPEN_FRAMES = 10;  // display frames for a full closed↔open swing
const HOLD_FRAMES = 30;  // frames the gate stays open after the LAST avatar leaves
const NEAR_FACTOR = 0.5; // proximity radius as a fraction of CELL (~88px at 176)

function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
function smoothstep(t) { t = clamp01(t); return t * t * (3 - 2 * t); }

// Shortest signed angular distance a→b (radians, in [-π, π]).
function shortestDelta(a, b) {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * A proximity-triggered open→hold→close state machine, one per gate. Owned by a
 * single renderer instance (created in the constructor/_buildScene, recreated on
 * rebuild) so its mutable state never leaks across views or town rebuilds.
 *
 * Per frame the renderer:
 *   1. calls noteAvatar(p.x, p.y) for every agent, BEFORE the cull `continue`
 *      (an off-screen approacher still opens the gate — p.x/p.y advance even when
 *      the avatar is culled);
 *   2. calls tick(dtFrames, reduce) ONCE after the agent loop;
 *   3. reads angleFor(gate) to draw/rotate each leaf.
 */
class GateAnimator {
  constructor(gates, opts = {}) {
    this.gates = Array.isArray(gates) ? gates : [];
    const cell = opts.cell || (CONFIG.world && CONFIG.world.cellPixels) || 176;
    this.nearR2 = (cell * NEAR_FACTOR) * (cell * NEAR_FACTOR);
    this._st = new Map();
    for (const g of this.gates) {
      this._st.set(g.id, {
        phase: "closed",     // closed | opening | open | closing
        progress: 0,         // 0 = fully closed, 1 = fully open
        holdLeft: 0,         // frames remaining before the open gate starts closing
        near: false,         // an avatar was within range THIS frame
        delta: shortestDelta(g.closedAngle, g.openAngle), // ±π/2, precomputed
      });
    }
  }

  /** Flag any gate whose gap centre is within ~0.5·CELL of (x, y). Cheap (sq dist). */
  noteAvatar(x, y) {
    if (!this.gates.length) return;
    for (const g of this.gates) {
      const st = this._st.get(g.id);
      if (st.near) continue; // already flagged this frame
      const dx = g.gapCX - x, dy = g.gapCY - y;
      if (dx * dx + dy * dy <= this.nearR2) st.near = true;
    }
  }

  /**
   * Advance every gate by `dtFrames` display frames — 1 for canvas (no delta) and
   * app.ticker.deltaTime for Pixi, so swing speed matches across renderers.
   * `reduce` (prefers-reduced-motion) SNAPS open/closed with no tween — mirroring
   * how the renderers zero p.bob under reduce.
   */
  tick(dtFrames, reduce) {
    const dt = dtFrames > 0 ? dtFrames : 0;
    for (const g of this.gates) {
      const st = this._st.get(g.id);
      if (reduce) {
        st.progress = st.near ? 1 : 0;
        st.holdLeft = st.near ? HOLD_FRAMES : 0;
        st.phase = st.near ? "open" : "closed";
        st.near = false;
        continue;
      }
      if (st.near) st.holdLeft = HOLD_FRAMES; // refresh hold while in range
      const wantOpen = st.holdLeft > 0;
      if (wantOpen) {
        st.progress = Math.min(1, st.progress + dt / OPEN_FRAMES);
        st.phase = st.progress >= 1 ? "open" : "opening";
      } else {
        st.progress = Math.max(0, st.progress - dt / OPEN_FRAMES);
        st.phase = st.progress <= 0 ? "closed" : "closing";
      }
      st.holdLeft = st.holdLeft > dt ? st.holdLeft - dt : 0;
      st.near = false; // consumed; re-flagged next frame by noteAvatar
    }
  }

  /** Current world-space leaf angle (radians): closedAngle → openAngle, eased. */
  angleFor(gate) {
    const st = this._st.get(gate.id);
    if (!st) return gate.closedAngle;
    return gate.closedAngle + st.delta * smoothstep(st.progress);
  }

  /** The live {phase, progress, holdLeft} for a gate (read-only use). */
  stateFor(gate) {
    return this._st.get(gate.id) || { phase: "closed", progress: 0, holdLeft: 0 };
  }
}

/**
 * Build a fresh animator for a gate-descriptor list. One instance per renderer,
 * recreated on rebuild()/_buildScene() so no open state survives a town rebuild.
 */
export function createGateAnimator(gates, opts) {
  return new GateAnimator(gates, opts);
}

/**
 * @typedef {Object} GateDescriptor
 * @property {string} id
 * @property {string} locId
 * @property {"N"|"S"|"E"|"W"} edge
 * @property {number} hingeX @property {number} hingeY  pivot (lower gap end), world px
 * @property {number} gapX0 @property {number} gapY0    gap start (= hinge), world px
 * @property {number} gapX1 @property {number} gapY1    gap end (far), world px
 * @property {number} gapCX @property {number} gapCY    gap centre, world px
 * @property {number} length                            hinge→tip leaf length (≈44px)
 * @property {number} faceDX @property {number} faceDY  outward normal
 * @property {number} closedAngle                       leaf flush along the edge
 * @property {number} openAngle                         leaf along the outward normal
 * @property {{key:string,leaf:string,fence:string,post:string,tint:?number}} style  type-varied look
 */
