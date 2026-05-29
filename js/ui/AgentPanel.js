// AgentPanel.js — renders the selected agent's identity, plan, and relationships.
// Pure rendering: reads simulation state and rebuilds DOM. No simulation logic here.

import { el, clear } from "../utils/dom.js";
import { TimeManager } from "../simulation/TimeManager.js";

export function renderAgentDetails(container, sim) {
  clear(container);
  const agent = sim.getSelectedAgent();
  if (!agent) {
    container.appendChild(el("p", { class: "muted", text: "No agent selected." }));
    return;
  }
  const loc = sim.environment.getLocation(agent.currentLocationId);

  const traits = el("div", { class: "chips", "aria-label": "Traits" },
    agent.traits.map((t) => el("span", { class: "chip", text: t }))
  );

  const dl = el("dl", { class: "details" }, [
    row("Age", String(agent.age)),
    row("Role", agent.role),
    row("Personality", agent.personality),
    rowNode("Traits", traits),
    row("Location", loc ? loc.name : agent.currentLocationId),
    row("Activity", agent.currentActivity),
    row("Current goal", agent.currentGoal),
  ]);
  container.appendChild(dl);
}

export function renderPlan(container, sim) {
  clear(container);
  const agent = sim.getSelectedAgent();
  if (!agent || !agent.currentPlan.length) {
    container.appendChild(el("li", { class: "muted", text: "No plan yet." }));
    return;
  }
  for (const item of agent.currentPlan) {
    const loc = sim.environment.getLocation(item.locationId);
    const li = el("li", {
      class: `plan-item plan-item--${item.status}`,
      "aria-current": item.status === "active" ? "true" : null,
    }, [
      el("div", { class: "plan-time" }, `${TimeManager.clock(item.startTime)}–${TimeManager.clock(item.endTime)}`),
      el("div", { class: "plan-body" }, [
        el("div", { class: "plan-activity", text: item.activity }),
        el("div", { class: "plan-meta muted", text: loc ? loc.name : item.locationId }),
      ]),
      el("span", { class: `plan-status plan-status--${item.status}` },
        item.status === "active" ? "▶ active" : item.status === "completed" ? "✓ done" : "• scheduled"),
    ]);
    container.appendChild(li);
  }
}

export function renderRelationships(container, sim) {
  clear(container);
  const agent = sim.getSelectedAgent();
  if (!agent) return;
  const rels = agent.relationships.all().filter((r) => r.familiarity > 0 || r.affinity !== 0 || r.trust !== 0);
  if (!rels.length) {
    container.appendChild(el("li", { class: "muted", text: "No relationships yet — they form through conversations." }));
    return;
  }
  rels.sort((a, b) => b.familiarity - a.familiarity);
  for (const rel of rels) {
    const other = sim.getAgent(rel.targetAgentId);
    const li = el("li", { class: "rel-item" }, [
      el("div", { class: "rel-head" }, [
        el("span", { class: "rel-name", text: other ? other.name : rel.targetAgentId }),
      ]),
      bar("Affinity", rel.affinity, -100, 100),
      bar("Trust", rel.trust, -100, 100),
      bar("Familiarity", rel.familiarity, 0, 100),
      rel.notes.length ? el("p", { class: "rel-notes muted", text: rel.notes.join(" · ") }) : null,
    ]);
    container.appendChild(li);
  }
}

// ---- helpers -----------------------------------------------------------------
function row(label, value) {
  return el("div", { class: "detail-row" }, [
    el("dt", { text: label }),
    el("dd", { text: value }),
  ]);
}
function rowNode(label, node) {
  return el("div", { class: "detail-row" }, [el("dt", { text: label }), el("dd", {}, node)]);
}
function bar(label, value, min, max) {
  const pct = ((value - min) / (max - min)) * 100;
  return el("div", { class: "rel-bar" }, [
    el("div", { class: "rel-bar-label" }, [
      el("span", { text: label }),
      el("span", { class: "rel-bar-value", text: String(value) }),
    ]),
    el("div", {
      class: "rel-bar-track",
      role: "img",
      "aria-label": `${label}: ${value} out of range ${min} to ${max}`,
    }, [el("div", { class: "rel-bar-fill", style: { width: `${Math.max(0, Math.min(100, pct))}%` } })]),
  ]);
}
