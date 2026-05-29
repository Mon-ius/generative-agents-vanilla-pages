// Renderer.js — coordinates on-screen rendering.
//
// The town map is a canvas, owned by MapView (which runs its own animation loop
// and reads sim state each frame). The Renderer owns everything else: the status
// header, the agent legend, the agent/plan/relationship panels, the memory
// stream, the timeline, and the debug panel. It subscribes to the Simulation's
// EventBus so the panels re-render after every tick / selection / reset / load.
// The simulation core never touches the DOM.

import { qs, on } from "../utils/dom.js";
import { renderAgentDetails, renderPlan, renderRelationships } from "./AgentPanel.js";
import { renderMemory } from "./MemoryPanel.js";
import { renderTimeline } from "./TimelinePanel.js";

export class Renderer {
  constructor(sim) {
    this.sim = sim;
    this.running = false;
    this.debugVisible = false;
    this._cache();
    this._wireLegendSelection();
    this._subscribe();
    this.renderAll();
  }

  _cache() {
    this.els = {
      statusPill: qs("#status-pill"),
      timeIndicator: qs("#time-indicator"),
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

  // Legend chips are the keyboard-accessible way to select an agent (the canvas
  // handles mouse selection). Event delegation on the stable legend element.
  _wireLegendSelection() {
    if (!this.els.legend) return;
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

  _renderLegend() {
    const sim = this.sim;
    const legend = this.els.legend;
    if (!legend) return;
    while (legend.firstChild) legend.removeChild(legend.firstChild);
    const selected = sim.getSelectedAgent();
    for (const a of sim.agents) {
      const isSel = selected && a.id === selected.id;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `legend-chip${isSel ? " legend-chip--selected" : ""}`;
      chip.setAttribute("data-agent-id", a.id);
      chip.setAttribute("aria-pressed", isSel ? "true" : "false");
      chip.setAttribute("aria-label", `Select ${a.name}, ${a.role}`);
      const sw = document.createElement("span");
      sw.className = "legend-swatch";
      sw.setAttribute("aria-hidden", "true");
      sw.style.background = a.color;
      sw.textContent = a.emoji;
      const nm = document.createElement("span");
      nm.className = "legend-name";
      nm.textContent = a.name;
      chip.appendChild(sw);
      chip.appendChild(nm);
      legend.appendChild(chip);
    }
  }

  _renderDebug() {
    if (!this.els.debugContent) return;
    const info = this.sim.getDebugInfo();
    const box = this.els.debugContent;
    while (box.firstChild) box.removeChild(box.firstChild);
    const dl = document.createElement("dl");
    dl.className = "details";
    for (const [k, v] of Object.entries(info)) {
      const row = document.createElement("div");
      row.className = "detail-row";
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = String(v);
      row.appendChild(dt);
      row.appendChild(dd);
      dl.appendChild(row);
    }
    box.appendChild(dl);
  }
}
