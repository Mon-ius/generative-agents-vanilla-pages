// ParamControls.js — live "ablation" sliders that mutate CONFIG so users can
// watch retrieval/reflection behaviour change without reloading.
//
// The engine reads CONFIG live, so writing to it here takes effect on the next
// tick. We capture the mount-time defaults once so "Reset defaults" can restore
// the original tuning.

import { el, clear } from "../utils/dom.js";
import { CONFIG } from "../config.js";

export function mountParams(container, sim) {
  // Snapshot the values present at mount so we can restore them later.
  const defaults = {
    recencyWeight: CONFIG.retrieval.recencyWeight,
    relevanceWeight: CONFIG.retrieval.relevanceWeight,
    importanceWeight: CONFIG.retrieval.importanceWeight,
    importanceThreshold: CONFIG.reflection.importanceThreshold,
    minutesPerTick: CONFIG.minutesPerTick,
  };

  // Each control fully owns one CONFIG value via get/set.
  const controls = [
    {
      label: "Recency weight",
      min: 0,
      max: 3,
      step: 0.1,
      get: () => CONFIG.retrieval.recencyWeight,
      set: (v) => {
        CONFIG.retrieval.recencyWeight = v;
      },
    },
    {
      label: "Relevance weight",
      min: 0,
      max: 5,
      step: 0.1,
      get: () => CONFIG.retrieval.relevanceWeight,
      set: (v) => {
        CONFIG.retrieval.relevanceWeight = v;
      },
    },
    {
      label: "Importance weight",
      min: 0,
      max: 3,
      step: 0.1,
      get: () => CONFIG.retrieval.importanceWeight,
      set: (v) => {
        CONFIG.retrieval.importanceWeight = v;
      },
    },
    {
      label: "Reflection threshold",
      min: 10,
      max: 80,
      step: 1,
      get: () => CONFIG.reflection.importanceThreshold,
      set: (v) => {
        CONFIG.reflection.importanceThreshold = v;
      },
    },
    {
      label: "Minutes / tick",
      min: 5,
      max: 30,
      step: 5,
      get: () => CONFIG.minutesPerTick,
      set: (v) => {
        CONFIG.minutesPerTick = v;
        // The TimeManager keeps its own copy; keep them in sync.
        if (sim && sim.time) sim.time.minutesPerTick = v;
      },
    },
  ];

  // Track each slider so Reset (and any future re-sync) can update them.
  const widgets = [];

  function render() {
    clear(container);
    widgets.length = 0;

    const wrap = el("div", { class: "params" });

    for (const ctrl of controls) {
      const valSpan = el("span", { class: "param__val", text: String(ctrl.get()) });

      const range = el("input", {
        type: "range",
        min: ctrl.min,
        max: ctrl.max,
        step: ctrl.step,
        value: ctrl.get(),
        oninput: (e) => {
          const v = Number(e.target.value);
          ctrl.set(v);
          valSpan.textContent = String(v);
        },
      });

      const param = el("div", { class: "param" }, [
        el("div", { class: "param__head" }, [
          el("span", { class: "param__label", text: ctrl.label }),
          valSpan,
        ]),
        range,
      ]);

      widgets.push({ ctrl, range, valSpan });
      wrap.appendChild(param);
    }

    const resetBtn = el("button", {
      class: "btn",
      text: "Reset defaults",
      onclick: () => {
        CONFIG.retrieval.recencyWeight = defaults.recencyWeight;
        CONFIG.retrieval.relevanceWeight = defaults.relevanceWeight;
        CONFIG.retrieval.importanceWeight = defaults.importanceWeight;
        CONFIG.reflection.importanceThreshold = defaults.importanceThreshold;
        CONFIG.minutesPerTick = defaults.minutesPerTick;
        if (sim && sim.time) sim.time.minutesPerTick = defaults.minutesPerTick;

        for (const w of widgets) {
          const cur = w.ctrl.get();
          w.range.value = cur;
          w.valSpan.textContent = String(cur);
        }
      },
    });

    wrap.appendChild(el("div", { class: "params__footer" }, [resetBtn]));

    wrap.appendChild(
      el("p", {
        class: "muted",
        text:
          "Retrieval weights re-rank memory live; the reflection threshold changes how readily agents form insights.",
      })
    );

    container.appendChild(wrap);
  }

  render();
}
