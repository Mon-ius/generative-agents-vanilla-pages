// NetworkView.js — relationship sociogram on a canvas.
//
// Draws residents as nodes on a circle and links those who have met, with edge
// thickness scaling by familiarity. Redrawn on bus events; no animation loop so
// it stays safe under a headless DOM shim.

import { el, on } from "../utils/dom.js";

export function mountNetwork(container, sim) {
  const W = 360;
  const H = 300;
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(W, H) / 2 - 44;

  const canvas = el("canvas", { class: "network-canvas" });
  canvas.width = W;
  canvas.height = H;
  container.appendChild(canvas);
  container.appendChild(
    el("div", {
      class: "network__hint",
      text: "Lines link residents who have met; thicker = more familiar. Click a node to select.",
    })
  );

  const ctx = canvas.getContext && canvas.getContext("2d");
  if (!ctx) return;

  // Node layout, recomputed whenever the agent count changes.
  let layoutN = -1;
  let positions = []; // [{ id, x, y }]

  function computeLayout() {
    const agents = sim.agents;
    const N = agents.length;
    positions = agents.map((agent, i) => {
      const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
      return {
        id: agent.id,
        x: cx + R * Math.cos(angle),
        y: cy + R * Math.sin(angle),
      };
    });
    layoutN = N;
  }

  function posOf(id) {
    return positions.find((p) => p.id === id);
  }

  // Familiarity that x feels toward y (0 if no relationship recorded).
  function famFromTo(x, y) {
    const rels = x.relationships.all();
    for (const rel of rels) {
      if (rel.targetAgentId === y.id) return rel.familiarity || 0;
    }
    return 0;
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    const agents = sim.agents;

    // Edges: one per unordered pair, using the stronger of the two directions.
    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        const a = agents[i];
        const b = agents[j];
        const fam = Math.max(famFromTo(a, b), famFromTo(b, a));
        if (fam > 0) {
          const pa = posOf(a.id);
          const pb = posOf(b.id);
          if (!pa || !pb) continue;
          ctx.lineWidth = 1 + Math.min(6, fam / 16);
          ctx.strokeStyle =
            "rgba(244,183,64," + (0.12 + Math.min(0.6, fam / 160)) + ")";
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pb.x, pb.y);
          ctx.stroke();
        }
      }
    }

    // Nodes.
    for (const agent of agents) {
      const p = posOf(agent.id);
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
      ctx.fillStyle = agent.color;
      ctx.fill();
      if (agent.id === sim.selectedAgentId) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#ffd23f";
      } else {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(0,0,0,0.5)";
      }
      ctx.stroke();

      ctx.fillStyle = "#fff";
      ctx.font = "bold 10px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(agent.initials, p.x, p.y);
    }
  }

  function refresh() {
    if (sim.agents.length !== layoutN) computeLayout();
    draw();
  }

  computeLayout();
  draw();

  for (const evt of ["tick", "select", "reset", "load", "init"]) {
    sim.bus.on(evt, refresh);
  }

  on(canvas, "click", (ev) => {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    const mx = (ev.clientX - r.left) * (W / r.width);
    const my = (ev.clientY - r.top) * (H / r.height);
    let nearestId = null;
    let nearestDist = Infinity;
    for (const p of positions) {
      const dx = p.x - mx;
      const dy = p.y - my;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= 16 && d < nearestDist) {
        nearestDist = d;
        nearestId = p.id;
      }
    }
    if (nearestId) sim.selectAgent(nearestId);
  });
}
