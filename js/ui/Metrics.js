// Metrics.js — live quantitative dashboard.
//
// Renders a grid of summary statistics about the running simulation and
// refreshes itself on the bus events that change those numbers.

import { el, clear } from "../utils/dom.js";

export function mountMetrics(container, sim) {
  function computeStats() {
    const agents = sim.agents;

    // Conversations recorded in the timeline.
    const conversations = sim.timeline.filter((e) => e.type === "conversation").length;

    // Acquainted (unordered) pairs that have met at least once.
    const pairs = new Set();
    let memories = 0;
    let reflections = 0;
    let affinitySum = 0;
    let affinityCount = 0;

    for (const agent of agents) {
      memories += agent.memoryStream.count();
      reflections += agent.memoryStream.byType("reflection").length;

      for (const rel of agent.relationships.all()) {
        affinitySum += rel.affinity;
        affinityCount += 1;
        if (rel.familiarity > 0) {
          const key = [agent.id, rel.targetAgentId].sort().join("|");
          pairs.add(key);
        }
      }
    }

    const avgAffinity = affinityCount > 0 ? (affinitySum / affinityCount).toFixed(1) : "—";

    // Busiest location by current occupancy.
    let busiest = "—";
    let busiestCount = -1;
    for (const loc of sim.environment.allLocations()) {
      const count = sim.environment.agentsAt(loc.id, agents).length;
      if (count > busiestCount) {
        busiestCount = count;
        busiest = loc.name;
      }
    }

    return [
      ["Day / Time", sim.time.format()],
      ["Tick", String(sim.tickCount)],
      ["Residents", String(agents.length)],
      ["Conversations", String(conversations)],
      ["Acquainted pairs", String(pairs.size)],
      ["Memories", String(memories)],
      ["Reflections", String(reflections)],
      ["Avg affinity", String(avgAffinity)],
      ["Busiest place", busiest],
    ];
  }

  function render() {
    clear(container);
    const grid = el("div", { class: "metrics-grid" });
    for (const [label, value] of computeStats()) {
      grid.appendChild(
        el("div", { class: "metric" }, [
          el("div", { class: "metric__value", text: value }),
          el("div", { class: "metric__label", text: label }),
        ])
      );
    }
    container.appendChild(grid);
  }

  render();

  for (const type of ["tick", "reset", "load", "init"]) {
    sim.bus.on(type, render);
  }
}
