// smoke.node.mjs — headless harness for the DOM-free core (no browser/canvas).
//
// Boots the expanded 24x24 world, steps it, and asserts world integrity,
// determinism, save/load round-trip, pathfinding, and group-conversation
// invariants. Run: `node test/smoke.node.mjs` (exits non-zero on failure).

import { Simulation } from "../js/simulation/Simulation.js";
import { LocalGenerationProvider } from "../js/agents/GenerationProvider.js";
import { SEED_AGENTS } from "../js/data/seedAgents.js";
import { SEED_LOCATIONS } from "../js/data/seedLocations.js";
import { SEED_EVENTS } from "../js/data/seedEvents.js";
import { computeLayout, routeFrom } from "../js/ui/townArt.js";
import * as PF from "../js/utils/pathfinding.js";
import { CONFIG } from "../js/config.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log("  ✓", name, detail ? "— " + detail : ""); }
  else { fail++; console.log("  ✗ FAIL", name, detail ? "— " + detail : ""); }
};

function build() {
  return new Simulation({
    seed: "smallville-2024",
    agents: SEED_AGENTS,
    locations: SEED_LOCATIONS,
    events: SEED_EVENTS,
    provider: new LocalGenerationProvider(),
  });
}

console.log("World integrity:");
const sim = build();
const locs = sim.environment.allLocations();
ok("locations >= 60", locs.length >= 60, `${locs.length}`);
ok("agents >= 20", sim.agents.length >= 20, `${sim.agents.length}`);
const coords = new Set();
let dup = 0;
for (const l of locs) { const k = l.x + "," + l.y; if (coords.has(k)) dup++; coords.add(k); }
ok("no duplicate location coords", dup === 0, dup ? dup + " dup" : "");
let badRef = 0;
for (const a of sim.agents) for (const r of ["homeLocationId", "workLocationId", "currentLocationId"]) {
  if (!sim.environment.getLocation(a[r])) badRef++;
}
ok("all agent location refs resolve", badRef === 0, badRef ? badRef + " bad" : "");

console.log("\nLayout + collision grid:");
let layout = null, grid = null;
try {
  layout = computeLayout(sim);
  grid = layout.collisionGrid;
  ok("computeLayout returns collisionGrid", !!grid && grid.blocked, grid ? `${grid.w}x${grid.h}` : "");
  let blocked = 0, open = 0;
  if (grid) for (const b of grid.blocked) (b ? blocked++ : open++);
  ok("grid has blocked tiles (buildings)", blocked > 0, `${blocked} blocked`);
  ok("grid has open tiles (streets)", open > 0, `${open} open`);
  ok("chunk dims present", layout.chunkCols > 0 && layout.chunkRows > 0, `${layout.chunkCols}x${layout.chunkRows} chunks`);
} catch (e) { ok("computeLayout works", false, e.message); }

console.log("\nPathfinding:");
try {
  const g = PF.buildGridFromEnvironment(sim.environment);
  ok("buildGridFromEnvironment", !!g && g.blocked.length > 0, `${g.w}x${g.h}`);
  const a = locs[0], b = locs[Math.floor(locs.length / 2)];
  const ca = PF.cellForLocation(g, a), cb = PF.cellForLocation(g, b);
  const path = PF.aStar(g, ca, cb);
  ok("aStar finds a route between two locations", Array.isArray(path) && path.length >= 1, path ? path.length + " cells" : "null");
  const wp = PF.pathWorldPoints(g, { x: a.x * CONFIG.world.cellPixels + 80, y: a.y * CONFIG.world.cellPixels + 80 }, { x: b.x * CONFIG.world.cellPixels + 80, y: b.y * CONFIG.world.cellPixels + 80 });
  ok("pathWorldPoints returns waypoints", Array.isArray(wp) && wp.length >= 2, wp ? wp.length + " pts" : "null");
} catch (e) { ok("pathfinding works", false, e.message); }

console.log("\nRenderer re-route (walls stay solid on screen):");
try {
  // The renderers re-plan mid-walk avatars on layout.collisionGrid (routeFrom),
  // so it must be BYTE-IDENTICAL to the grid the sim routes agents on — a
  // divergence means avatars walk routes the sim's walls don't allow. Compare
  // against the sim's OWN cached grid (sim._getGrid(), the real routing
  // artifact — safe to pre-warm: deterministic and RNG-free), not a re-built
  // copy, so the check still catches a drift in _getGrid's construction opts.
  // cell/sub/ox/oy matter too: worldToGrid uses them, so a mismatch re-routes
  // avatars on the wrong sub-tiles even with identical blocked/cost arrays.
  const simGrid = sim._getGrid();
  const lg = layout.collisionGrid;
  let same = !!lg && lg.w === simGrid.w && lg.h === simGrid.h &&
    lg.cell === simGrid.cell && lg.sub === simGrid.sub &&
    (lg.ox || 0) === (simGrid.ox || 0) && (lg.oy || 0) === (simGrid.oy || 0);
  if (same) for (let i = 0; i < lg.blocked.length; i++) {
    if (lg.blocked[i] !== simGrid.blocked[i] || lg.cost[i] !== simGrid.cost[i]) { same = false; break; }
  }
  ok("layout.collisionGrid matches the sim routing grid", same, lg ? `${lg.w}x${lg.h}` : "missing");

  // A re-routed walk must be wall-legal end-to-end: sample every segment at
  // quarter-sub-tile resolution and require zero blocked hits.
  const subPx = lg.cell / lg.sub;
  const blockedAt = (x, y) => {
    const { gx, gy } = PF.worldToGrid(lg, x, y);
    return !!lg.blocked[gy * lg.w + gx];
  };
  const legal = (r) => {
    if (!Array.isArray(r) || r.length < 2) return false;
    for (let i = 1; i < r.length; i++) {
      const p = r[i - 1], q = r[i];
      const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / (subPx / 4)));
      for (let s = 0; s <= n; s++) {
        const t = s / n;
        if (blockedAt(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t)) return false;
      }
    }
    return true;
  };
  const OPEN = new Set(["park", "square", "plaza", "green", "street", "road"]);
  const street = locs.find((l) => l.type === "street");
  const bldgs = locs.filter((l) => !OPEN.has(l.type));
  const CELLPX = CONFIG.world.cellPixels;
  const midStreet = { x: street.x * CELLPX + CELLPX / 2, y: street.y * CELLPX + CELLPX / 2 };
  const spotA = layout.doorSpots.get(bldgs[0].id);
  const spotB = layout.doorSpots.get(bldgs[Math.floor(bldgs.length / 2)].id);
  const r1 = routeFrom(layout, midStreet, { x: spotB.x, y: spotB.y });
  ok("re-route street → room is wall-legal", legal(r1), r1 ? r1.length + " pts" : "null");
  const r2 = routeFrom(layout, { x: spotA.x, y: spotA.y }, { x: spotB.x, y: spotB.y });
  ok("re-route room → room is wall-legal (exits via doors)", legal(r2), r2 ? r2.length + " pts" : "null");
} catch (e) { ok("renderer re-route works", false, e.message); }

console.log("\nStepping 200 ticks:");
try {
  const before = sim.agents.reduce((s, a) => s + a.memoryCount, 0);
  const t0 = sim.time.totalMinutes;
  const start = Date.now();
  for (let i = 0; i < 200; i++) sim.step();
  const ms = Date.now() - start;
  const after = sim.agents.reduce((s, a) => s + a.memoryCount, 0);
  ok("time advances", sim.time.totalMinutes > t0, sim.time.format());
  ok("memories accumulate", after > before, `${after}`);
  ok("tickCount == 200", sim.tickCount === 200);
  ok("200 steps under 4s (no O(n^2) blowup)", ms < 4000, ms + "ms");
} catch (e) { ok("stepping works", false, e.message); }

console.log("\nGroup conversation invariants:");
const convos = sim.timeline.filter((e) => e.type === "conversation");
ok("conversations occurred", convos.length > 0, `${convos.length}`);
let overCap = 0, withParts = 0;
for (const c of convos) {
  const parts = c.participantIds || c.agentIds || [];
  if (parts.length > (CONFIG.conversation.maxGroupSize || 4)) overCap++;
  if (c.participantIds) withParts++;
}
ok("no conversation exceeds maxGroupSize", overCap === 0, overCap ? overCap + " over" : "");
ok("conversation events carry participantIds", withParts > 0 || convos.length === 0, `${withParts}/${convos.length}`);

console.log("\nDeterminism (two fresh runs, same seed, 150 steps):");
try {
  const s1 = build(); const s2 = build();
  for (let i = 0; i < 150; i++) { s1.step(); s2.step(); }
  const j1 = JSON.stringify(s1.getState());
  const j2 = JSON.stringify(s2.getState());
  ok("identical seed -> identical state", j1 === j2, j1 === j2 ? "" : "DIVERGED");
} catch (e) { ok("determinism", false, e.message); }

console.log("\nSave/load round-trip:");
try {
  const s1 = build();
  for (let i = 0; i < 100; i++) s1.step();
  const snap = JSON.parse(JSON.stringify(s1.getState()));
  const s2 = build();
  const loaded = s2.loadState(snap);
  ok("loadState accepts exported state", loaded === true);
  for (let i = 0; i < 40; i++) { s1.step(); s2.step(); }
  ok("loaded run continues identically", JSON.stringify(s1.getState()) === JSON.stringify(s2.getState()));
} catch (e) { ok("save/load", false, e.message); }

console.log(`\n${pass}/${pass + fail} checks passed${fail ? " — " + fail + " FAILED" : ""}`);
process.exit(fail ? 1 : 0);
