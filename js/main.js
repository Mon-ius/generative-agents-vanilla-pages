// main.js — application entry point.
//
// Boots the simulation, wires it to the renderer and controls, runs the playback
// loop, persists lightweight UI settings, and exposes window.runSmokeTest() and
// window.__app for inspection. This is the only place that owns "running" state.

import { CONFIG } from "./config.js";
import { storage } from "./utils/storage.js";
import { Simulation } from "./simulation/Simulation.js";
import { LocalGenerationProvider } from "./agents/GenerationProvider.js";
import { Renderer } from "./ui/Renderer.js";
import { Controls } from "./ui/Controls.js";
import { MapView } from "./ui/MapView.js";
import { initTabs } from "./ui/Tabs.js";
import { SEED_AGENTS } from "./data/seedAgents.js";
import { SEED_LOCATIONS } from "./data/seedLocations.js";
import { SEED_EVENTS } from "./data/seedEvents.js";

// ---- settings (speed / debug / seed) persisted separately from sim state -----
const settings = Object.assign(
  { speedIndex: CONFIG.defaultSpeedIndex, debugVisible: false, seed: CONFIG.defaultSeed },
  storage.load(CONFIG.settingsKey, {})
);
function persistSettings() {
  storage.save(CONFIG.settingsKey, settings);
}

// ---- build the world ---------------------------------------------------------
const sim = new Simulation({
  seed: settings.seed,
  agents: SEED_AGENTS,
  locations: SEED_LOCATIONS,
  events: SEED_EVENTS,
  provider: new LocalGenerationProvider(),
});

const renderer = new Renderer(sim);

// ---- playback loop -----------------------------------------------------------
const app = {
  running: false,
  speedIndex: settings.speedIndex,
  timer: null,

  start() {
    if (this.running) return;
    this.running = true;
    renderer.setRunning(true);
    controls.setRunning(true);
    this._schedule();
  },
  pause() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    renderer.setRunning(false);
    controls.setRunning(false);
  },
  step() {
    this.pause();
    sim.step();
  },
  reset(seed) {
    this.pause();
    if (seed) {
      settings.seed = seed;
      persistSettings();
    }
    sim.reset(seed || settings.seed);
  },
  setSpeed(i) {
    this.speedIndex = i;
    settings.speedIndex = i;
    persistSettings();
    if (this.running) this._schedule();
  },
  save() {
    const ok = sim.save();
    controls.setLoadAvailable(sim.hasSaved());
    flashStatus(ok ? "Saved" : "Save unavailable");
  },
  load() {
    if (sim.load()) {
      this.pause();
      flashStatus("Loaded");
    } else {
      flashStatus("Nothing to load");
    }
  },
  clear() {
    sim.clearSaved();
    controls.setLoadAvailable(false);
    flashStatus("Saved state cleared");
  },
  toggleDebug() {
    settings.debugVisible = !settings.debugVisible;
    persistSettings();
    renderer.setDebugVisible(settings.debugVisible);
    controls.setDebug(settings.debugVisible);
  },
  _schedule() {
    if (this.timer) clearInterval(this.timer);
    const ms = CONFIG.speeds[this.speedIndex].ms;
    this.timer = setInterval(() => sim.step(), ms);
  },
};

const controls = new Controls(app);
initTabs();

// ---- apply persisted settings to the UI --------------------------------------
controls.setSpeedIndex(app.speedIndex);
controls.setSeed(settings.seed);
controls.setRunning(false);
controls.setLoadAvailable(sim.hasSaved());
controls.setDebug(settings.debugVisible);
renderer.setDebugVisible(settings.debugVisible);
renderer.setRunning(false);

let _flashTimer = null;
function flashStatus(text) {
  const pill = document.getElementById("status-pill");
  if (!pill) return;
  pill.textContent = text;
  if (_flashTimer) clearTimeout(_flashTimer);
  _flashTimer = setTimeout(() => {
    pill.textContent = app.running ? "Running" : "Paused";
  }, 1200);
}

// ---- browser smoke test ------------------------------------------------------
// Run window.runSmokeTest() in the console. Note: it mutates the live simulation
// (it steps, selects, saves, and resets) and re-renders afterwards.
function runSmokeTest() {
  const results = [];
  const log = (name, ok, detail = "") => {
    results.push({ name, ok: Boolean(ok), detail });
    console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  };
  console.log("%cGenerative Agents — runSmokeTest()", "font-weight:bold");

  log("app booted", Boolean(window.__app && sim && renderer));
  log("locations exist (>=8)", sim.environment.allLocations().length >= 8, `${sim.environment.allLocations().length}`);
  log("agents exist (>=5)", sim.agents.length >= 5, `${sim.agents.length}`);

  const t0 = sim.time.totalMinutes;
  sim.step();
  log("simulation can step", sim.tickCount > 0);
  log("time advances", sim.time.totalMinutes > t0, sim.time.format());

  const before = sim.agents.reduce((s, a) => s + a.memoryCount, 0);
  for (let i = 0; i < 3; i++) sim.step();
  const after = sim.agents.reduce((s, a) => s + a.memoryCount, 0);
  log("memories can be created", after >= before, `${after} memories`);

  const ids = sim.agents.map((a) => a.id);
  const next = ids[(ids.indexOf(sim.selectedAgentId) + 1) % ids.length];
  sim.selectAgent(next);
  log("selected agent can be changed", sim.selectedAgentId === next);

  log("save function exists", typeof sim.save === "function");
  log("load function exists", typeof sim.load === "function");
  log("save returns a boolean", typeof sim.save() === "boolean", storage.available() ? "localStorage available" : "localStorage unavailable");

  sim.reset();
  log("reset works", sim.tickCount === 0);

  renderer.renderAll();
  const passed = results.filter((r) => r.ok).length;
  console.log(`runSmokeTest: ${passed}/${results.length} checks passed`);
  return { passed, total: results.length, results };
}

// ---- map renderer: PixiJS (WebGL) primary, canvas-2D fallback ----------------
const onSelect = (id) => sim.selectAgent(id);

function hasWebGL() {
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2") || c.getContext("webgl"));
  } catch (_) {
    return false;
  }
}

async function setupMap() {
  const host = document.getElementById("map-host");
  const overlay = document.getElementById("map-overlay");
  if (!host) return null;
  // Only attempt Pixi in a real browser with WebGL (the requestAnimationFrame
  // gate also keeps Node out of the Pixi import path entirely).
  if (typeof requestAnimationFrame === "function" && hasWebGL()) {
    try {
      const { PixiMapView } = await import("./ui/PixiMapView.js");
      const view = new PixiMapView(host, sim, { onSelect });
      await view.init();
      host.dataset.renderer = "pixi";
      console.log("Map renderer: PixiJS (WebGL)");
      return view;
    } catch (e) {
      console.warn("PixiJS unavailable — using the canvas renderer instead.", e);
      host.innerHTML = "";
    }
  }
  const view = new MapView(host, overlay, sim, { onSelect });
  view.start();
  host.dataset.renderer = "canvas";
  console.log("Map renderer: canvas 2D (fallback)");
  return view;
}

// ---- expose for inspection / testing -----------------------------------------
window.__app = { app, sim, renderer, controls, map: null };
window.runSmokeTest = runSmokeTest;

setupMap().then((view) => {
  window.__app.map = view;
});

console.log("Generative Agents (vanilla) ready. Try window.runSmokeTest() in the console.");
