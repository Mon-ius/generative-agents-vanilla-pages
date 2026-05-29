// RetrievalProbe.js — interactive probe over the selected agent's deterministic
// memory retrieval. Demonstrates the paper's retrieval mechanism by surfacing
// the top-scoring memories for a query alongside their score breakdowns.

import { el, clear, on } from "../utils/dom.js";
import { TimeManager } from "../simulation/TimeManager.js";

export function mountRetrievalProbe(container, sim) {
  clear(container);

  const input = el("input", {
    class: "input probe__input",
    type: "text",
    placeholder: "e.g. coffee, market, Sam",
  });

  const form = el(
    "form",
    {
      class: "probe__form",
      onsubmit: (e) => {
        e.preventDefault();
        run();
      },
    },
    [input, el("button", { class: "btn", type: "submit", text: "Retrieve" })]
  );

  const hint = el("div", { class: "probe__hint" });
  const results = el("ul", { class: "probe__results" });

  container.appendChild(form);
  container.appendChild(hint);
  container.appendChild(results);

  function updateHint() {
    const agent = sim.getSelectedAgent();
    if (!agent) {
      hint.textContent = "Select a resident.";
    } else if (agent.memoryStream.count() === 0) {
      hint.textContent = "No memories yet — step the simulation.";
    } else {
      hint.textContent = "Querying " + agent.name + "'s memory…";
    }
  }

  function run() {
    const agent = sim.getSelectedAgent();
    if (!agent || agent.memoryStream.count() === 0) {
      updateHint();
      return;
    }

    const q = input.value.trim() || "town";
    const found = agent.memoryStream.retrieve(
      { text: q },
      sim.time.totalMinutes,
      6
    );

    clear(results);

    for (const r of found) {
      const meta = el("div", { class: "probe-item__meta" }, [
        el("span", { text: TimeManager.formatTotal(r.memory.timestamp) }),
        el("span", { class: "probe-score", text: "score " + r.score.toFixed(2) }),
      ]);

      const factors = [
        ["recency", r.recency],
        ["importance", r.importance],
        ["relevance", r.relevance],
      ];

      const bars = el(
        "div",
        { class: "probe-bars" },
        factors.map(([key, value]) =>
          el("div", { class: "probe-bar probe-bar--" + key }, [
            key,
            el("div", { class: "probe-bar__track" }, [
              el("div", {
                class: "probe-bar__fill",
                style: { width: Math.round(value * 100) + "%" },
              }),
            ]),
          ])
        )
      );

      results.appendChild(
        el("li", { class: "probe-item" }, [
          el("div", { class: "probe-item__desc", text: r.memory.description }),
          meta,
          bars,
        ])
      );
    }
  }

  updateHint();

  const onChange = () => {
    updateHint();
    clear(results);
  };

  const unsubs = [
    sim.bus.on("select", onChange),
    sim.bus.on("reset", onChange),
    sim.bus.on("load", onChange),
  ];

  return () => {
    for (const u of unsubs) u && u();
  };
}
