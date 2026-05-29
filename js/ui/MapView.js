// MapView.js — canvas-2D fallback town renderer.
//
// Used automatically when PixiJS/WebGL is unavailable (old browsers, headless
// without GL, or Node). It mounts its own <canvas> inside the given host and
// reuses the shared townArt layout + procedural art, so it matches the Pixi
// renderer's geometry. Agents walk via requestAnimationFrame; floating bubbles
// are DOM elements in the overlay. Node-safe: with no 2D context / RAF it
// constructs without drawing.

import { computeLayout, spotFor, makeTownCanvas, activityEmoji, shade, roundRect, ambient } from "./townArt.js";

const WALK_SPEED = 2.2;
const SAY_MS = 4200;

export class MapView {
  constructor(host, overlay, sim, { onSelect } = {}) {
    this.host = host;
    this.overlay = overlay;
    this.sim = sim;
    this.onSelect = onSelect || (() => {});

    this.canvas = typeof document !== "undefined" && document.createElement ? document.createElement("canvas") : null;
    if (this.canvas) {
      this.canvas.className = "map-canvas";
      this.canvas.setAttribute("role", "img");
      this.canvas.setAttribute("aria-label", "Top-down map of Willow Creek. Use the agent list below the map to select an agent.");
      if (host && host.appendChild) host.appendChild(this.canvas);
    }
    this.ctx = this.canvas && typeof this.canvas.getContext === "function" ? this.canvas.getContext("2d") : null;

    this.pos = new Map();
    this.bubbles = new Map();
    this.say = new Map();
    this._raf = null;
    this._frameN = 0;

    this._layout();
    this._buildStatic();
    this._syncTargets(true);
    this._wire();
  }

  _layout() {
    this.layout = computeLayout(this.sim);
    if (this.canvas) { this.canvas.width = this.layout.W; this.canvas.height = this.layout.H; }
  }

  _buildStatic() {
    if (typeof document === "undefined" || !document.createElement) return;
    this.static = makeTownCanvas(this.layout);
  }

  _syncTargets(snap) {
    const groups = new Map();
    for (const a of this.sim.agents) {
      if (!groups.has(a.currentLocationId)) groups.set(a.currentLocationId, []);
      groups.get(a.currentLocationId).push(a);
    }
    for (const [locId, group] of groups) {
      group.sort((x, y) => (x.id < y.id ? -1 : 1));
      group.forEach((a, i) => {
        const spot = spotFor(this.layout, locId, i, group.length);
        let p = this.pos.get(a.id);
        if (!p) { p = { x: spot.x, y: spot.y, tx: spot.x, ty: spot.y, bob: 0, facing: 1 }; this.pos.set(a.id, p); }
        p.tx = spot.x; p.ty = spot.y;
        if (snap) { p.x = spot.x; p.y = spot.y; }
      });
    }
  }

  _wire() {
    const bus = this.sim && this.sim.bus;
    if (bus) {
      bus.on("tick", () => this._syncTargets(false));
      bus.on("reset", () => this.rebuild());
      bus.on("load", () => this.rebuild());
      bus.on("timeline", (e) => {
        if (e && e.type === "conversation" && typeof performance !== "undefined") {
          const until = performance.now() + SAY_MS;
          for (const id of e.agentIds || []) this.say.set(id, { until });
        }
      });
    }
    if (this.canvas && typeof this.canvas.addEventListener === "function") {
      this.canvas.addEventListener("click", (ev) => this._onClick(ev));
    }
  }

  rebuild() {
    this._layout();
    this._buildStatic();
    this._syncTargets(true);
  }

  start() {
    if (typeof requestAnimationFrame !== "function" || !this.ctx) return; // node-safe
    const loop = () => { this._draw(); this._raf = requestAnimationFrame(loop); };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this._raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _onClick(ev) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = this.layout.W / rect.width;
    const sy = this.layout.H / rect.height;
    const mx = (ev.clientX - rect.left) * sx;
    const my = (ev.clientY - rect.top) * sy;
    let best = null;
    let bestD = 26 * 26;
    for (const a of this.sim.agents) {
      const p = this.pos.get(a.id);
      if (!p) continue;
      const dx = p.x - mx;
      const dy = p.y - 12 - my;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = a.id; }
    }
    if (best) this.onSelect(best);
  }

  _draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    this._frameN++;
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (this.static) ctx.drawImage(this.static, 0, 0, this.layout.W, this.layout.H);
    else { ctx.fillStyle = "#84b95a"; ctx.fillRect(0, 0, this.layout.W, this.layout.H); }

    const selected = this.sim.selectedAgentId;
    const drawList = this.sim.agents.slice().sort((a, b) => {
      const pa = this.pos.get(a.id), pb = this.pos.get(b.id);
      return (pa ? pa.y : 0) - (pb ? pb.y : 0);
    });
    for (const a of drawList) {
      const p = this.pos.get(a.id);
      if (!p) continue;
      const dx = p.tx - p.x;
      const dy = p.ty - p.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 1.5) {
        const step = Math.min(WALK_SPEED, dist);
        p.x += (dx / dist) * step;
        p.y += (dy / dist) * step;
        if (Math.abs(dx) > 0.5) p.facing = dx < 0 ? -1 : 1;
        p.bob = reduce ? 0 : Math.sin(this._frameN * 0.4) * 2;
      } else {
        p.x = p.tx; p.y = p.ty;
        p.bob = reduce ? 0 : Math.sin(this._frameN * 0.08 + p.x) * 0.8;
      }
      this._avatar(ctx, a, p, a.id === selected, reduce);
    }

    const amb = ambient(this.sim.time.minutesIntoDay);
    if (amb.a > 0.001) {
      ctx.fillStyle = `rgba(${amb.r},${amb.g},${amb.b},${amb.a})`;
      ctx.fillRect(0, 0, this.layout.W, this.layout.H);
    }

    this._updateBubbles();
  }

  _avatar(ctx, agent, p, isSelected, reduce) {
    const x = p.x;
    const y = p.y + p.bob;
    ctx.fillStyle = "rgba(25,30,40,0.22)";
    ctx.beginPath(); ctx.ellipse(x, p.y + 9, 9, 4, 0, 0, Math.PI * 2); ctx.fill();
    if (isSelected) {
      const r = 11 + (reduce ? 0 : Math.sin(this._frameN * 0.15) * 1.5);
      ctx.strokeStyle = "#ffd23f"; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.ellipse(x, p.y + 9, r, 5.5, 0, 0, Math.PI * 2); ctx.stroke();
    }
    const color = agent.color || "#4b6bdc";
    ctx.fillStyle = color; roundRect(ctx, x - 6, y - 6, 12, 13, 3); ctx.fill();
    ctx.fillStyle = shade(color, -0.18); ctx.fillRect(x - 6, y + 4, 12, 3);
    ctx.fillStyle = "#f1c9a5"; ctx.beginPath(); ctx.arc(x, y - 10, 5.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = shade(color, -0.3); ctx.beginPath(); ctx.arc(x, y - 11, 5.6, Math.PI, 0); ctx.fill();
    ctx.fillStyle = "#2a2333";
    ctx.fillRect(x - 2 + p.facing, y - 11.5, 1.4, 1.6);
    ctx.fillRect(x + 1 + p.facing, y - 11.5, 1.4, 1.6);
  }

  _updateBubbles() {
    if (!this.overlay || !this.canvas || typeof this.canvas.getBoundingClientRect !== "function") return;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width) return;
    const sx = rect.width / this.layout.W;
    const sy = rect.height / this.layout.H;
    const now = typeof performance !== "undefined" ? performance.now() : 0;
    const live = new Set();
    for (const a of this.sim.agents) {
      const p = this.pos.get(a.id);
      if (!p) continue;
      live.add(a.id);
      let bubble = this.bubbles.get(a.id);
      if (!bubble) {
        bubble = document.createElement("div");
        bubble.className = "speech-bubble";
        this.overlay.appendChild(bubble);
        this.bubbles.set(a.id, bubble);
      }
      const saying = this.say.get(a.id);
      const talking = Boolean(saying && saying.until > now);
      if (saying && saying.until <= now) this.say.delete(a.id);
      const emoji = talking ? "💬" : activityEmoji(a.currentActivity, a.emoji);
      const label = `${a.initials}: ${emoji}`;
      if (bubble._label !== label) { bubble.textContent = label; bubble._label = label; }
      bubble.classList.toggle("speech-bubble--selected", a.id === this.sim.selectedAgentId);
      bubble.classList.toggle("speech-bubble--talking", talking);
      bubble.style.left = `${p.x * sx}px`;
      bubble.style.top = `${(p.y - 22) * sy}px`;
    }
    for (const [id, node] of this.bubbles) {
      if (!live.has(id)) { node.remove(); this.bubbles.delete(id); }
    }
  }
}
