// config.js — central tunable constants for the simulation and UI.
// Everything here is plain data so it can be inspected, tweaked, and persisted.

export const CONFIG = {
  // ----- Time -----
  startMinutes: 5 * 60 + 50, // 05:50 on Day 1 — residents boot asleep in bed (overnight block is 00:00–06:00) and rise at 06:00 (minutes since Day 1 00:00)
  minutesPerTick: 10, // each simulation step advances the clock by this many minutes
  dayLengthMinutes: 24 * 60, // 1440

  // ----- Determinism -----
  defaultSeed: "smallville-2024",

  // ----- Memory retrieval weights (see utils/scoring.js) -----
  retrieval: {
    recencyWeight: 1.0,
    importanceWeight: 1.0,
    relevanceWeight: 1.0,
    recencyHalfLifeMinutes: 240, // a memory keeps half its recency score every 4 simulated hours
    defaultCount: 6,
  },

  // ----- Reflection trigger -----
  reflection: {
    importanceThreshold: 30, // accumulated importance since the last reflection
    minIntervalMinutes: 120, // never reflect more often than every 2 simulated hours
    recentMemoryWindow: 12, // synthesize insights from the last N memories
  },

  // ----- Conversations -----
  conversation: {
    cooldownMinutes: 90, // the same pair will not start a new conversation within this window
    baseChance: 0.45, // RNG gate when two agents share a location
    maxPerLocationPerTick: 1, // limit conversations per location per tick to keep things legible
    maxGroupSize: 4, // cap on the number of participants in a single conversation
  },

  // ----- World grid (town layout) -----
  world: {
    gridWidth: 24,
    gridHeight: 24,
    cellPixels: 176,
  },

  // ----- Rendering / tiling -----
  rendering: {
    resolutionScale: typeof devicePixelRatio !== "undefined" ? Math.min(2, devicePixelRatio) : 1,
    autoDensity: true,
    chunkCells: 4,
    maxBakePx: 4096,
    chunkCacheMax: 64,
  },

  // ----- Camera (zoom/pan) -----
  camera: {
    infinite: true, // boundless world: infinite grass beyond the town, roam freely
    minZoom: 0.16, // absolute zoom-out floor (town sits in a sea of grass)
    maxZoom: 4,
    zoomStep: 1.12,
    easing: 0.18,
  },

  // ----- Movement / pathfinding -----
  movement: {
    pathfindingEnabled: true,
    // sub = 8 so every building cell has a THIN perimeter WALL ring + a roomy
    // interior (the centre 6×6 sub-tiles), and each door/tunnel is a NARROW
    // centred gap (2 of 8 tiles ≈ 44px) — walls cover ~75% of every edge while
    // a limited doorway stays walkable. The resolution the wall/door/tunnel model
    // needs to look like a real building. See pathfinding.js.
    subdivisions: 8,
    walkSpeedPixelsPerFrame: 2.4,
    // Finer grid (≈152×152) → longer routes that explore more nodes; bumped so
    // cross-town A* never bails before it reaches a far door.
    maxAStarNodes: 60000,
    // Per-cell A* step cost so routes follow the paved streets instead of cutting
    // straight across: roads are the cheap highway, building interiors are dear,
    // open ground (parks/plazas/greens/grass) sits between. See utils/pathfinding.js.
    streetCost: 1,
    openCost: 4,
    buildingCost: 12,
    // Solid buildings: the routing grid walls each building cell's perimeter but
    // leaves a narrow centred gap on its one DOOR edge (facing the street) and on
    // every TUNNEL edge (shared with a sibling unit). Agents walk the
    // street/grass network, enter through the door, move room-to-room through the
    // tunnels, and stand inside — never crossing a wall. The town is framed by one
    // ring of open grass (gridPad) so corner/edge complexes stay reachable.
    solidBuildings: true,
    gridPad: 1,
  },

  // ----- Character sprites -----
  characters: {
    useSpritesheets: true,
    fps: 6,
    frameScale: 0.7, // on-screen display scale of the 32×48 SVG avatar art (≈22px wide, crisp downscale)
  },

  // ----- Debug toggles -----
  debug: {
    showPaths: false,
  },

  // ----- Relative importance assigned to new memories by type -----
  importance: {
    observation: 2,
    movement: 1,
    action: 3,
    conversation: 5,
    reflection: 7,
    event: 6,
  },

  // ----- UI playback speeds -----
  speeds: [
    { label: "0.5×", ms: 2000 },
    { label: "1×", ms: 1000 },
    { label: "2×", ms: 500 },
    { label: "4×", ms: 250 },
    { label: "8×", ms: 120 },
  ],
  defaultSpeedIndex: 1,

  // ----- Persistence keys (localStorage) -----
  storageKey: "generative-agents-vanilla:state:v1",
  settingsKey: "generative-agents-vanilla:settings:v1",

  // ----- Display caps -----
  ui: {
    timelineVisible: 60, // most recent N timeline entries shown
    memoryVisible: 50, // most recent N memories shown in the memory panel
    timelineMax: 500, // hard cap on retained timeline entries
  },
};
