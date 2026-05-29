// config.js — central tunable constants for the simulation and UI.
// Everything here is plain data so it can be inspected, tweaked, and persisted.

export const CONFIG = {
  // ----- Time -----
  startMinutes: 8 * 60, // simulation begins at 08:00 on Day 1 (minutes since Day 1 00:00)
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
    minZoom: null, // computed as fit-to-viewport when null
    maxZoom: 4,
    zoomStep: 1.12,
    easing: 0.18,
  },

  // ----- Movement / pathfinding -----
  movement: {
    pathfindingEnabled: true,
    subdivisions: 2,
    walkSpeedPixelsPerFrame: 2.4,
    maxAStarNodes: 4000,
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
