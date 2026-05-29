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
import { mountMetrics } from "./ui/Metrics.js";
import { mountRetrievalProbe } from "./ui/RetrievalProbe.js";
import { mountNetwork } from "./ui/NetworkView.js";
import { mountParams } from "./ui/ParamControls.js";
import { loadSprites } from "./assets.js";
import { loadCharacterManifest, loadCharacterSheets, createCharacterFactory } from "./ui/characters.js";
import { SEED_AGENTS } from "./data/seedAgents.js";
import { SEED_LOCATIONS } from "./data/seedLocations.js";
import { SEED_EVENTS } from "./data/seedEvents.js";

// ---- settings (speed / debug / seed / camera) persisted separately from state
const settings = Object.assign(
  { speedIndex: CONFIG.defaultSpeedIndex, debugVisible: false, seed: CONFIG.defaultSeed, camera: {} },
  storage.load(CONFIG.settingsKey, {})
);
if (!settings.camera || typeof settings.camera !== "object") settings.camera = {};
function persistSettings() {
  storage.save(CONFIG.settingsKey, settings);
}

// Seed permalink: "#seed=..." in the URL overrides the saved seed on load,
// so a specific (reproducible) run can be shared by link.
const hashParams = (() => {
  try {
    return new URLSearchParams((location.hash || "").replace(/^#/, ""));
  } catch (_) {
    return new URLSearchParams();
  }
})();
const sharedSeed = hashParams.get("seed");
if (sharedSeed) settings.seed = sharedSeed;

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
  // ---- camera zoom controls (forwarded to the active map view's camera) ------
  zoomIn() {
    const cam = window.__app && window.__app.map && window.__app.map.camera;
    if (cam && typeof cam.zoomIn === "function") cam.zoomIn();
  },
  zoomOut() {
    const cam = window.__app && window.__app.map && window.__app.map.camera;
    if (cam && typeof cam.zoomOut === "function") cam.zoomOut();
  },
  zoomFit() {
    const cam = window.__app && window.__app.map && window.__app.map.camera;
    if (cam && typeof cam.zoomFit === "function") cam.zoomFit();
  },
  _schedule() {
    if (this.timer) clearInterval(this.timer);
    const ms = CONFIG.speeds[this.speedIndex].ms;
    this.timer = setInterval(() => sim.step(), ms);
  },
};

const controls = new Controls(app);
initTabs();

// ---- mount research panels (guarded so headless Node import stays safe) -------
const $ = (id) => document.getElementById(id);
const metricsEl = $("metrics-mount");
if (metricsEl) mountMetrics(metricsEl, sim);
const probeEl = $("retrieval-mount");
if (probeEl) mountRetrievalProbe(probeEl, sim);
const networkEl = $("network-mount");
if (networkEl) mountNetwork(networkEl, sim);
const paramsEl = $("params-mount");
if (paramsEl) mountParams(paramsEl, sim);

// ---- reproducibility: export / import / share permalink ----------------------
function ioStatus(msg) {
  const n = $("io-status");
  if (n) n.textContent = msg;
}
const btnExport = $("btn-export");
if (btnExport) {
  btnExport.addEventListener("click", () => {
    try {
      const blob = new Blob([JSON.stringify(sim.getState(), null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `willow-creek-${sim.seed}-step${sim.tickCount}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      ioStatus(`Exported state at step ${sim.tickCount}.`);
    } catch (e) {
      ioStatus("Export failed: " + e.message);
    }
  });
}
const btnImport = $("btn-import");
const importFile = $("import-file");
if (btnImport && importFile) {
  btnImport.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", () => {
    const file = importFile.files && importFile.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const state = JSON.parse(String(reader.result));
        if (sim.loadState(state)) {
          app.pause();
          ioStatus("Imported simulation state.");
        } else {
          ioStatus("Import failed: unrecognised state file.");
        }
      } catch (e) {
        ioStatus("Import failed: " + e.message);
      }
      importFile.value = "";
    };
    reader.readAsText(file);
  });
}
const btnShare = $("btn-share");
if (btnShare) {
  btnShare.addEventListener("click", async () => {
    try {
      location.hash = "seed=" + encodeURIComponent(sim.seed);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(location.href);
        ioStatus("Permalink copied to clipboard.");
      } else {
        ioStatus("Permalink set in the address bar.");
      }
    } catch (e) {
      ioStatus("Share: seed set in URL (" + (e.message || "copy manually") + ").");
    }
  });
}

// ---- pause the loop when the tab is hidden (saves CPU; resumes on return) -----
if (typeof document.addEventListener === "function") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (app.running) {
        app._wasRunning = true;
        app.pause();
      }
    } else if (app._wasRunning) {
      app._wasRunning = false;
      app.start();
    }
  });
}

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
  log("locations exist (>=60)", sim.environment.allLocations().length >= 60, `${sim.environment.allLocations().length}`);
  log("agents exist (>=20)", sim.agents.length >= 20, `${sim.agents.length}`);

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

// Debounced camera persistence: stash the view's camera transform in
// settings.camera so the zoom/pan survives reloads. Re-applied after setupMap.
let _cameraSaveTimer = null;
function persistCameraFrom(view) {
  if (!view || !view.camera || typeof view.camera.toJSON !== "function") return;
  if (_cameraSaveTimer) clearTimeout(_cameraSaveTimer);
  _cameraSaveTimer = setTimeout(() => {
    try {
      settings.camera = view.camera.toJSON();
      persistSettings();
    } catch (_) {
      /* non-fatal */
    }
  }, 300);
}

// Wrap the camera's existing onChange so the renderer's own handler still fires,
// and append our debounced settings persistence on top of it.
function wireCameraPersistence(view) {
  const cam = view && view.camera;
  if (!cam) return;
  const prev = typeof cam.onChange === "function" ? cam.onChange : null;
  cam.onChange = () => {
    if (prev) prev();
    persistCameraFrom(view);
  };
}

// Restore a previously persisted camera transform once the view is ready. Only
// override the renderer's default game view when there is a REAL saved transform
// (a numeric scale); a fresh visitor keeps the centered, zoomed-in opening view.
function restoreCamera(view) {
  const cam = view && view.camera;
  const saved = settings.camera;
  if (cam && typeof cam.applyState === "function" && saved && typeof saved.scale === "number") {
    try {
      cam.applyState(saved);
    } catch (_) {
      /* ignore a stale/incompatible saved camera */
    }
  }
}

async function setupMap() {
  const host = document.getElementById("map-host");
  const overlay = document.getElementById("map-overlay");
  if (!host) return null;
  // Brief loading state while sprites + character assets stream in.
  host.setAttribute("aria-busy", "true");
  if (!host.dataset.renderer) host.textContent = "Loading map…";
  // Load the pixel-art sprite assets first (falls back to {} if unavailable,
  // in which case the renderers draw the procedural town instead).
  const sprites = await loadSprites().catch(() => ({}));
  // Load the shared character factory (manifest + sheets). Both resolve safely:
  // a missing manifest / no sheets means the factory yields procedural avatars.
  const manifest = await loadCharacterManifest().catch(() => null);
  const sheets = await loadCharacterSheets(manifest).catch(() => ({}));
  const characters = createCharacterFactory({ manifest, sheets });

  const finish = (view, label) => {
    host.removeAttribute("aria-busy");
    wireCameraPersistence(view);
    restoreCamera(view);
    console.log("Map renderer: " + label);
    return view;
  };

  // Only attempt Pixi in a real browser with WebGL (the requestAnimationFrame
  // gate also keeps Node out of the Pixi import path entirely).
  if (typeof requestAnimationFrame === "function" && hasWebGL()) {
    try {
      const { PixiMapView } = await import("./ui/PixiMapView.js");
      const view = new PixiMapView(host, sim, { onSelect, sprites, characters });
      await view.init();
      host.dataset.renderer = "pixi";
      return finish(view, "PixiJS (WebGL)");
    } catch (e) {
      console.warn("PixiJS unavailable — using the canvas renderer instead.", e);
      host.innerHTML = "";
    }
  }
  const view = new MapView(host, overlay, sim, { onSelect, sprites, characters });
  view.start();
  host.dataset.renderer = "canvas";
  return finish(view, "canvas 2D (fallback)");
}

// ---- expose for inspection / testing -----------------------------------------
window.__app = { app, sim, renderer, controls, map: null };
window.runSmokeTest = runSmokeTest;

setupMap().then((view) => {
  window.__app.map = view;
});

console.log("Generative Agents (vanilla) ready. Try window.runSmokeTest() in the console.");
