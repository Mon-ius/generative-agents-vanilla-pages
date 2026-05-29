// Controls.js — wires the control bar (declared in index.html) to handlers.
//
// The buttons live in the HTML so they are present and accessible without JS;
// this class only attaches behaviour and manages disabled / pressed states.

import { qs, on } from "../utils/dom.js";
import { CONFIG } from "../config.js";

export class Controls {
  // handlers: { start, pause, step, reset, save, load, clear, setSpeed, toggleDebug }
  constructor(handlers) {
    this.h = handlers;
    this.els = {
      start: qs("#btn-start"),
      pause: qs("#btn-pause"),
      step: qs("#btn-step"),
      reset: qs("#btn-reset"),
      save: qs("#btn-save"),
      load: qs("#btn-load"),
      clear: qs("#btn-clear"),
      speed: qs("#speed-select"),
      seed: qs("#seed-input"),
      debug: qs("#btn-debug"),
    };
    this._populateSpeeds();
    this._wire();
  }

  _populateSpeeds() {
    const sel = this.els.speed;
    if (!sel) return;
    sel.innerHTML = "";
    CONFIG.speeds.forEach((s, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = s.label;
      sel.appendChild(opt);
    });
  }

  _wire() {
    const { h, els } = this;
    if (els.start) on(els.start, "click", () => h.start());
    if (els.pause) on(els.pause, "click", () => h.pause());
    if (els.step) on(els.step, "click", () => h.step());
    if (els.reset) on(els.reset, "click", () => h.reset(els.seed ? els.seed.value.trim() : ""));
    if (els.save) on(els.save, "click", () => h.save());
    if (els.load) on(els.load, "click", () => h.load());
    if (els.clear) on(els.clear, "click", () => h.clear());
    if (els.speed) on(els.speed, "change", () => h.setSpeed(Number(els.speed.value)));
    if (els.debug) on(els.debug, "click", () => h.toggleDebug());
  }

  setRunning(running) {
    if (this.els.start) this.els.start.disabled = running;
    if (this.els.pause) this.els.pause.disabled = !running;
  }

  setLoadAvailable(available) {
    if (this.els.load) this.els.load.disabled = !available;
    if (this.els.clear) this.els.clear.disabled = !available;
  }

  setSpeedIndex(i) {
    if (this.els.speed) this.els.speed.value = String(i);
  }

  setSeed(seed) {
    if (this.els.seed) this.els.seed.value = seed;
  }

  setDebug(visible) {
    if (this.els.debug) {
      this.els.debug.setAttribute("aria-pressed", visible ? "true" : "false");
      this.els.debug.textContent = visible ? "Hide debug" : "Show debug";
    }
  }
}
