// Renderer.js — coordinates all on-screen rendering.
//
// It caches the DOM containers declared in index.html, renders the town map and
// legend itself, and delegates the side panels to their modules. It subscribes
// to the Simulation's EventBus so the UI re-renders after every tick / selection
// / reset / load. The Renderer is the only place that maps simulation state to
// the DOM; the simulation core stays UI-agnostic.

import { el, clear, qs, on } from "../utils/dom.js";
import { renderAgentDetails, renderPlan, renderRelationships } from "./AgentPanel.js";
import { renderMemory } from "./MemoryPanel.js";
import { renderTimeline } from "./TimelinePanel.js";

export class Renderer {
  constructor(sim) {
    this.sim = sim;
    this.running = false;
    this.debugVisible = false;
    this._cache();
    this._wireMapSelection();
    this._subscribe();
    this.renderAll();
  }

  _cache() {
    this.els = {
      statusPill: qs("#status-pill"),
      timeIndicator: qs("#time-indicator"),
      map: qs("#map"),
      legend: qs("#map-legend"),
      agentName: qs("#agent-name"),
      agentDetails: qs("#agent-details"),
      planList: qs("#plan-list"),
      relList: qs("#relationship-list"),
      memList: qs("#memory-list"),
      timelineList: qs("#timeline-list"),
      debugPanel: qs("#debug-panel"),
      debugContent: qs("#debug-content"),
    };
  }

  _subscribe() {
    const rerender = () => this.renderAll();
    this.sim.bus.on("tick", rerender);
    this.sim.bus.on("reset", rerender);
    this.sim.bus.on("load", rerender);
    this.sim.bus.on("select", rerender);
    this.sim.bus.on("init", rerender);
  }

  // Re-bind selection after a reset/load swaps the sim's agent objects:
  // event delegation on the (stable) map element means we only wire this once.
  _wireMapSelection() {
    on(this.els.map, "click", (ev) => {
      const btn = ev.target.closest("[data-agent-id]");
      if (btn) this.sim.selectAgent(btn.getAttribute("data-agent-id"));
    });
    on(this.els.legend, "click", (ev) => {
      const btn = ev.target.closest("[data-agent-id]");
      if (btn) this.sim.selectAgent(btn.getAttribute("data-agent-id"));
    });
  }

  setRunning(running) {
    this.running = running;
    this._renderStatus();
  }

  setDebugVisible(visible) {
    this.debugVisible = visible;
    if (this.els.debugPanel) this.els.debugPanel.hidden = !visible;
    if (visible) this._renderDebug();
  }

  renderAll() {
    this._renderStatus();
    this._renderMap();
    this._renderLegend();
    this._renderAgent();
    renderMemory(this.els.memList, this.sim);
    renderTimeline(this.els.timelineList, this.sim);
    if (this.debugVisible) this._renderDebug();
  }

  _renderStatus() {
    if (this.els.timeIndicator) this.els.timeIndicator.textContent = this.sim.time.format();
    if (this.els.statusPill) {
      this.els.statusPill.textContent = this.running ? "Running" : "Paused";
      this.els.statusPill.dataset.state = this.running ? "running" : "paused";
    }
  }

  _renderAgent() {
    const agent = this.sim.getSelectedAgent();
    if (this.els.agentName) this.els.agentName.textContent = agent ? `${agent.emoji} ${agent.name}` : "Agent";
    renderAgentDetails(this.els.agentDetails, this.sim);
    renderPlan(this.els.planList, this.sim);
    renderRelationships(this.els.relList, this.sim);
  }

  _renderMap() {
    const sim = this.sim;
    const locs = sim.environment.allLocations();
    const map = this.els.map;
    clear(map);
    const cols = Math.max(0, ...locs.map((l) => l.x)) + 1;
    const rows = Math.max(0, ...locs.map((l) => l.y)) + 1;
    map.style.setProperty("--cols", String(cols));
    map.style.setProperty("--rows", String(rows));
    const selected = sim.getSelectedAgent();

    for (const loc of locs) {
      const present = sim.environment.agentsAt(loc.id, sim.agents);
      const hasSelected = selected && present.some((a) => a.id === selected.id);
      const tile = el("div", {
        class: `tile tile--${loc.type}${hasSelected ? " tile--active" : ""}`,
        style: { gridColumn: String(loc.x + 1), gridRow: String(loc.y + 1) },
        role: "group",
        "aria-label": `${loc.name}: ${present.length} ${present.length === 1 ? "person" : "people"} present`,
        title: `${loc.name} — ${loc.description}`,
      }, [
        el("span", { class: "tile-name", text: loc.name }),
        el("div", { class: "markers" }, present.map((a) => this._marker(a, loc, selected))),
      ]);
      map.appendChild(tile);
    }
  }

  _marker(agent, loc, selected) {
    const isSel = selected && agent.id === selected.id;
    return el("button", {
      type: "button",
      class: `marker${isSel ? " marker--selected" : ""}`,
      style: { "--marker-color": agent.color },
      "data-agent-id": agent.id,
      "aria-pressed": isSel ? "true" : "false",
      "aria-label": `Select ${agent.name}, ${agent.role}, at ${loc.name}${isSel ? " (selected)" : ""}`,
      title: `${agent.name} — ${agent.currentActivity}`,
    }, [
      el("span", { class: "marker-emoji", "aria-hidden": "true", text: agent.emoji }),
      el("span", { class: "marker-initials", text: agent.initials }),
      isSel ? el("span", { class: "marker-check", "aria-hidden": "true", text: "✓" }) : null,
    ]);
  }

  _renderLegend() {
    const sim = this.sim;
    const legend = this.els.legend;
    clear(legend);
    const selected = sim.getSelectedAgent();
    for (const a of sim.agents) {
      const isSel = selected && a.id === selected.id;
      legend.appendChild(
        el("button", {
          type: "button",
          class: `legend-chip${isSel ? " legend-chip--selected" : ""}`,
          "data-agent-id": a.id,
          "aria-pressed": isSel ? "true" : "false",
          "aria-label": `Select ${a.name}, ${a.role}`,
        }, [
          el("span", { class: "legend-swatch", "aria-hidden": "true", style: { background: a.color } }, a.emoji),
          el("span", { class: "legend-name", text: a.name }),
        ])
      );
    }
  }

  _renderDebug() {
    if (!this.els.debugContent) return;
    const info = this.sim.getDebugInfo();
    clear(this.els.debugContent);
    const dl = el("dl", { class: "details" },
      Object.entries(info).map(([k, v]) =>
        el("div", { class: "detail-row" }, [el("dt", { text: k }), el("dd", { text: String(v) })])
      )
    );
    this.els.debugContent.appendChild(dl);
  }
}
