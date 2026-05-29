// PixiMapView.js — the primary town renderer, built on PixiJS (WebGL).
//
// The static world (grass/paths/buildings) is baked once into a texture via the
// shared townArt module; agents are Pixi Containers (avatar Graphics + a Text
// speech bubble + a selection ring) animated by the Pixi ticker so they walk
// smoothly between buildings. A day/night overlay tints the whole scene with the
// simulated clock, and Pixi's interaction layer handles click-to-select.
//
// Pixi is loaded with a dynamic import so that (a) it never enters the static
// module graph the Node tests load, and (b) any load/WebGL failure rejects
// init() cleanly, letting main.js fall back to the canvas MapView.

import { computeLayout, spotFor, drawTown, activityEmoji, shade, ambient } from "./townArt.js";

const WALK_SPEED = 2.4;
const SAY_MS = 4200;

export class PixiMapView {
  constructor(host, sim, { onSelect } = {}) {
    this.host = host;
    this.sim = sim;
    this.onSelect = onSelect || (() => {});
    this.PIXI = null;
    this.app = null;
    this.entries = new Map(); // agentId -> { c, ring, bubble, bubbleBg, pos }
    this.say = new Map();
    this._built = false;
  }

  async init() {
    const PIXI = await import("../vendor/pixi.min.mjs");
    this.PIXI = PIXI;
    this.layout = computeLayout(this.sim);

    const app = new PIXI.Application();
    await app.init({
      width: this.layout.W,
      height: this.layout.H,
      background: "#84b95a",
      antialias: true,
      preference: "webgl",
      resolution: 1,
      autoDensity: false,
      powerPreference: "low-power",
    });
    this.app = app;
    const cv = app.canvas;
    cv.style.width = "100%";
    cv.style.height = "100%";
    cv.style.display = "block";
    this.host.appendChild(cv);

    this._buildScene();
    this._wire();
    app.ticker.add(() => this._frame());
    return this;
  }

  _buildScene() {
    const PIXI = this.PIXI;
    const stage = this.app.stage;
    stage.removeChildren();
    this.entries.clear();
    this.layout = computeLayout(this.sim);

    // static world baked to a texture
    const off = document.createElement("canvas");
    off.width = this.layout.W;
    off.height = this.layout.H;
    drawTown(off.getContext("2d"), this.layout);
    const bg = new PIXI.Sprite(PIXI.Texture.from(off));
    stage.addChild(bg);

    // agents layer (depth-sorted by y)
    this.agentsLayer = new PIXI.Container();
    this.agentsLayer.sortableChildren = true;
    stage.addChild(this.agentsLayer);

    for (const a of this.sim.agents) this._makeAgent(a);
    this._syncTargets(true);

    // day/night overlay on top
    this.overlay = new PIXI.Graphics().rect(0, 0, this.layout.W, this.layout.H).fill("#ffffff");
    this.overlay.alpha = 0;
    this.overlay.eventMode = "none";
    stage.addChild(this.overlay);

    this._built = true;
  }

  _makeAgent(a) {
    const PIXI = this.PIXI;
    const c = new PIXI.Container();
    c.eventMode = "static";
    c.cursor = "pointer";
    c.hitArea = new PIXI.Rectangle(-12, -30, 24, 46);
    c.on("pointertap", () => this.onSelect(a.id));

    const ring = new PIXI.Graphics().ellipse(0, 9, 12, 5.6).stroke({ color: "#ffd23f", width: 2.5 });
    ring.visible = false;
    c.addChild(ring);

    const av = new PIXI.Graphics();
    av.ellipse(0, 9, 9, 4).fill({ color: "#000000", alpha: 0.22 }); // shadow
    av.roundRect(-6, -6, 12, 13, 3).fill(a.color || "#4b6bdc");
    av.rect(-6, 4, 12, 3).fill(shade(a.color || "#4b6bdc", -0.18));
    av.circle(0, -10, 5.5).fill("#f1c9a5"); // head
    av.moveTo(-5.6, -11).arc(0, -11, 5.6, Math.PI, 0).fill(shade(a.color || "#4b6bdc", -0.3)); // hair cap
    av.rect(-2, -11.5, 1.4, 1.6).fill("#2a2333");
    av.rect(1, -11.5, 1.4, 1.6).fill("#2a2333");
    c.addChild(av);

    const bubbleBg = new PIXI.Graphics();
    const bubble = new PIXI.Text({
      text: `${a.initials}: ${a.emoji}`,
      style: { fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: 12, fontWeight: "700", fill: "#1e2330" },
    });
    bubble.anchor.set(0.5, 1);
    bubble.y = -22;
    bubbleBg.y = 0;
    c.addChild(bubbleBg);
    c.addChild(bubble);

    this.agentsLayer.addChild(c);
    this.entries.set(a.id, { c, ring, av, bubble, bubbleBg, lastLabel: null, pos: { x: 0, y: 0, tx: 0, ty: 0, bob: 0, facing: 1 } });
  }

  _drawBubble(e) {
    const w = e.bubble.width + 12;
    const h = e.bubble.height + 4;
    const x = -w / 2;
    const y = -22 - h;
    const talking = this._isTalking(e._id);
    e.bubbleBg.clear()
      .roundRect(x, y, w, h, 7).fill(talking ? "#fff6e2" : "#ffffff")
      .roundRect(x, y, w, h, 7).stroke({ color: e._sel ? "#b8770a" : "#2a2333", width: 2 })
      .moveTo(-5, y + h).lineTo(5, y + h).lineTo(0, y + h + 6).fill(e._sel ? "#b8770a" : "#2a2333");
  }

  _isTalking(id) {
    const s = this.say.get(id);
    const now = typeof performance !== "undefined" ? performance.now() : 0;
    return Boolean(s && s.until > now);
  }

  _wire() {
    const bus = this.sim.bus;
    bus.on("tick", () => this._syncTargets(false));
    bus.on("reset", () => this._buildScene());
    bus.on("load", () => this._buildScene());
    bus.on("timeline", (e) => {
      if (e && e.type === "conversation" && typeof performance !== "undefined") {
        const until = performance.now() + SAY_MS;
        for (const id of e.agentIds || []) this.say.set(id, { until });
      }
    });
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
        const e = this.entries.get(a.id);
        if (!e) return;
        const spot = spotFor(this.layout, locId, i, group.length);
        e.pos.tx = spot.x;
        e.pos.ty = spot.y;
        if (snap) { e.pos.x = spot.x; e.pos.y = spot.y; }
      });
    }
  }

  _frame() {
    if (!this._built) return;
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    this._t = (this._t || 0) + 1;
    const selId = this.sim.selectedAgentId;

    for (const a of this.sim.agents) {
      const e = this.entries.get(a.id);
      if (!e) continue;
      e._id = a.id;
      const p = e.pos;
      const dx = p.tx - p.x;
      const dy = p.ty - p.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 1.5) {
        const step = Math.min(WALK_SPEED, dist);
        p.x += (dx / dist) * step;
        p.y += (dy / dist) * step;
        if (Math.abs(dx) > 0.5) p.facing = dx < 0 ? -1 : 1;
        p.bob = reduce ? 0 : Math.sin(this._t * 0.4) * 2;
      } else {
        p.x = p.tx; p.y = p.ty;
        p.bob = reduce ? 0 : Math.sin(this._t * 0.08 + p.x) * 0.8;
      }
      e.c.x = p.x;
      e.c.y = p.y - p.bob;
      e.c.zIndex = p.y;
      e.av.scale.x = p.facing < 0 ? -1 : 1;

      const sel = a.id === selId;
      e.ring.visible = sel;

      const emoji = this._isTalking(a.id) ? "💬" : activityEmoji(a.currentActivity, a.emoji);
      const label = `${a.initials}: ${emoji}`;
      if (label !== e.lastLabel || sel !== e._sel) {
        e.bubble.text = label;
        e.lastLabel = label;
        e._sel = sel;
        this._drawBubble(e);
      }
    }

    const amb = ambient(this.sim.time.minutesIntoDay);
    this.overlay.tint = (amb.r << 16) | (amb.g << 8) | amb.b;
    this.overlay.alpha = amb.a;
  }

  start() { /* the Pixi ticker auto-starts in init() */ }

  stop() {
    if (this.app) this.app.ticker.stop();
  }

  destroy() {
    if (this.app) {
      this.app.destroy(true, { children: true });
      this.app = null;
    }
  }
}
