// MapView.js — canvas-2D fallback town renderer.
//
// Used automatically when PixiJS/WebGL is unavailable (old browsers, headless
// without GL, or Node). It mounts its own <canvas> inside the given host and
// reuses the shared townArt layout + townChunks bakes, so it matches the Pixi
// renderer's geometry. A shared Camera (camera.js) adds pan/zoom (which the old
// canvas view lacked); the static world is drawn from lazily-baked, culled chunks
// under the camera transform; agents are drawn by the shared CharacterFactory and
// walk along A* waypoints via requestAnimationFrame. Floating bubbles are DOM
// elements in the overlay, positioned via the camera. Node-safe: with no 2D
// context / RAF it constructs without drawing.

import { computeLayout, spotFor, activityEmoji, ambient, routeFrom } from "./townArt.js";
import { chunkKey, chunkWorldRect, visibleChunks, makeChunkCanvas } from "./townChunks.js";
import { Camera } from "./camera.js";
import { CONFIG } from "../config.js";

const SAY_MS = 4200;
const TEXTURE_SCALE = 2; // supersample factor for chunk bakes (crisp on zoom)
const AGENT_CULL_PAD = 64; // world px margin for agent visibility culling
const AVATAR_SCALE = (CONFIG.characters && CONFIG.characters.frameScale) || 1; // on-screen avatar size

export class MapView {
  constructor(host, overlay, sim, { onSelect, sprites, characters } = {}) {
    this.host = host;
    this.overlay = overlay;
    this.sim = sim;
    this.onSelect = onSelect || (() => {});
    this.sprites = sprites || null;
    this.characters = characters || null;

    this.canvas = typeof document !== "undefined" && document.createElement ? document.createElement("canvas") : null;
    if (this.canvas) {
      this.canvas.className = "map-canvas";
      this.canvas.setAttribute("role", "img");
      this.canvas.setAttribute("aria-label", "Top-down map of Willow Creek. Use the agent list below the map to select an agent.");
      this.canvas.style.display = "block";
      this.canvas.style.width = "100%";
      this.canvas.style.height = "100%";
      if (host && host.appendChild) host.appendChild(this.canvas);
    }
    this.ctx = this.canvas && typeof this.canvas.getContext === "function" ? this.canvas.getContext("2d") : null;

    this.pos = new Map(); // agentId -> { x, y, bob, dir, waypoints, wpIndex, av, lastLoc }
    this.chunks = new Map(); // chunkKey -> { canvas, cx, cy }
    this.bubbles = new Map();
    this.say = new Map();
    this.groupSay = new Map();
    this._raf = null;
    this._frameN = 0;
    this._dpr = 1;

    this._layout();
    this._setupCamera();
    this._syncTargets(true);
    this._wire();
    this._resizeCanvas();
    this.defaultView();
  }

  // Center the camera on the selected agent at a comfortable game zoom
  // (~cellsAcross cells across the viewport width), snapping for the first paint.
  // Smoothly center the camera on the currently selected resident.
  _focusSelected() {
    const p = this.pos.get(this.sim.selectedAgentId);
    if (p && this.camera) this.camera.centerOn(p.x, p.y);
  }

  defaultView(cellsAcross = 12) {
    const cam = this.camera;
    if (!cam) return;
    const CELL = this.layout.CELL || 176;
    const vp = this._viewport();
    const s = Math.min(cam.maxScale(), Math.max(cam.minScale(), vp.w / (cellsAcross * CELL)));
    cam.tscale = s;
    cam.centerOn(this.layout.W / 2, this.layout.H / 2); // open centered on the map
    cam.scale = cam.tscale;
    cam.x = cam.tx;
    cam.y = cam.ty;
  }

  _layout() {
    this.layout = computeLayout(this.sim);
  }

  _viewport() {
    const host = this.host;
    const w = (host && host.clientWidth) || (this.canvas && this.canvas.clientWidth) || this.layout.W;
    const h = (host && host.clientHeight) || (this.canvas && this.canvas.clientHeight) || this.layout.H;
    return { w: w || this.layout.W, h: h || this.layout.H };
  }

  _setupCamera() {
    this.camera = new Camera({
      worldW: this.layout.W,
      worldH: this.layout.H,
      getViewport: () => this._viewport(),
      onChange: () => this._persist && this._persist(),
      config: {
        infinite: CONFIG.camera.infinite,
        minZoom: CONFIG.camera.minZoom,
        maxZoom: CONFIG.camera.maxZoom,
        zoomStep: CONFIG.camera.zoomStep,
        easing: CONFIG.camera.easing,
      },
    });
    if (this.canvas) this.camera.attach(this.canvas, { onTap: (sx, sy) => this._pickAt(sx, sy) });
  }

  // High-DPI sizing: backing store = cssPx*dpr, CSS size = cssPx, ctx pre-scaled.
  _resizeCanvas() {
    if (!this.canvas) return;
    const { w, h } = this._viewport();
    const dpr = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
    this._dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    if (this.camera) this.camera.setWorld(this.layout.W, this.layout.H);
  }

  // ---- chunk bakes (lazy) --------------------------------------------------

  _chunkCanvas(cx, cy) {
    const key = chunkKey(cx, cy);
    let entry = this.chunks.get(key);
    if (!entry) {
      const canvas = makeChunkCanvas(this.layout, this.sprites, cx, cy, { scale: TEXTURE_SCALE });
      entry = { canvas, cx, cy };
      this.chunks.set(key, entry);
      // Soft cap: drop oldest bakes when we accumulate too many.
      const cap = (CONFIG.rendering && CONFIG.rendering.chunkCacheMax) || 64;
      if (this.chunks.size > cap) {
        const oldest = this.chunks.keys().next().value;
        if (oldest !== key) this.chunks.delete(oldest);
      }
    }
    return entry.canvas;
  }

  // ---- targets / path-following --------------------------------------------

  _syncTargets(snap) {
    const groups = new Map();
    for (const a of this.sim.agents) {
      if (!groups.has(a.currentLocationId)) groups.set(a.currentLocationId, []);
      groups.get(a.currentLocationId).push(a);
    }
    for (const [locId, group] of groups) {
      group.sort((x, y) => (x.id < y.id ? -1 : 1));
      group.forEach((a, i) => {
        const finalSpot = spotFor(this.layout, locId, i, group.length);
        let p = this.pos.get(a.id);
        if (!p) {
          p = {
            x: finalSpot.x, y: finalSpot.y, bob: 0, dir: "down",
            waypoints: [{ x: finalSpot.x, y: finalSpot.y }], wpIndex: 1,
            av: this._avatarFor(a), lastLoc: a.currentLocationId,
          };
          this.pos.set(a.id, p);
        }
        const locationChanged = p.lastLoc !== a.currentLocationId || snap;
        if (locationChanged) {
          const path = Array.isArray(a.path) && a.path.length ? a.path.slice() : null;
          let wps = path ? path.map((q) => ({ x: q.x, y: q.y })) : [{ x: finalSpot.x, y: finalSpot.y }];
          // Mid-walk re-route: the sim path starts at the PREVIOUS location's
          // room centre — walking straight there from the avatar's current
          // position would cut through walls. Re-plan from the avatar's actual
          // position on the sim's own grid (see PixiMapView._syncTargets, the
          // identical logic, for the full rationale). Display-only.
          if (!snap && CONFIG.movement && CONFIG.movement.pathfindingEnabled) {
            const eps = ((this.layout && this.layout.CELL) || 176) * 0.24;
            if (Math.hypot(wps[0].x - p.x, wps[0].y - p.y) > eps) {
              const re = routeFrom(this.layout, { x: p.x, y: p.y }, { x: finalSpot.x, y: finalSpot.y });
              if (re && re.length) wps = re.map((q) => ({ x: q.x, y: q.y }));
            }
          }
          wps[wps.length - 1] = { x: finalSpot.x, y: finalSpot.y };
          p.waypoints = wps;
          p.wpIndex = 0;
          p.lastLoc = a.currentLocationId;
          if (snap) {
            const last = wps[wps.length - 1];
            p.x = last.x; p.y = last.y;
            p.wpIndex = wps.length;
          }
        } else if (p.waypoints && p.waypoints.length) {
          // refresh settle target for crowd re-balancing
          p.waypoints[p.waypoints.length - 1] = { x: finalSpot.x, y: finalSpot.y };
        } else {
          p.waypoints = [{ x: finalSpot.x, y: finalSpot.y }];
          p.wpIndex = 0;
        }
      });
    }
  }

  _avatarFor(a) {
    if (this.characters) return this.characters.makeAvatar(a);
    return null; // null -> existing inline avatar drawing (legacy fallback)
  }

  // ---- wiring --------------------------------------------------------------

  _wire() {
    const bus = this.sim && this.sim.bus;
    if (bus) {
      bus.on("tick", () => this._syncTargets(false));
      bus.on("reset", () => this.rebuild());
      bus.on("load", () => this.rebuild());
      bus.on("timeline", (e) => this._onTimeline(e));
      // Clicking a resident (on the map or in the legend) pans to locate them.
      bus.on("select", () => this._focusSelected());
    }
    if (typeof window !== "undefined") {
      this._onResize = () => this._resizeCanvas();
      window.addEventListener("resize", this._onResize);
    }
  }

  _onTimeline(e) {
    if (!e || e.type !== "conversation" || typeof performance === "undefined") return;
    const until = performance.now() + SAY_MS;
    const ids = (e.participantIds && e.participantIds.length ? e.participantIds : e.agentIds) || [];
    for (const id of ids) this.say.set(id, { until });
    if (ids.length) this.groupSay.set(e.locationId || ids.join("|"), { until, ids: ids.slice() });
  }

  rebuild() {
    this._layout();
    this.chunks.clear();
    // Avatars are deterministic per agent id (assignVariant), so rebuilding them
    // on a reset/load is cheap and keeps the look stable across the new agent set.
    this.pos.clear();
    if (this.camera) this.camera.setWorld(this.layout.W, this.layout.H);
    this._syncTargets(true);
    this.defaultView();
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

  // ---- hit-testing ---------------------------------------------------------

  _pickAt(sx, sy) {
    if (!this.camera) return;
    const wp = this.camera.screenToWorld(sx, sy);
    let best = null;
    let bestD = 28 * 28;
    for (const a of this.sim.agents) {
      const p = this.pos.get(a.id);
      if (!p) continue;
      const dx = p.x - wp.x;
      const dy = (p.y - 14) - wp.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = a.id; }
    }
    if (best) this.onSelect(best);
  }

  // ---- draw ----------------------------------------------------------------

  _draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    this._frameN++;
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = this._dpr || 1;
    const cam = this.camera;
    cam.tick(reduce);

    // Clear the whole backing store (identity transform).
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // World transform: dpr * camera.
    ctx.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.x, dpr * cam.y);

    // Infinite grass: fill the entire visible world rect (which extends beyond the
    // town into the boundless surrounding meadow) with the world-anchored grass tile.
    const viewRect = cam.visibleWorldRect();
    const cell = this.layout.CELL;
    const grassCv = this.sprites && this.sprites.grass;
    if (grassCv && !this._grassPattern) { try { this._grassPattern = ctx.createPattern(grassCv, "repeat"); } catch (_) { this._grassPattern = null; } }
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = this._grassPattern || "#84b95a";
    ctx.fillRect(viewRect.x - cell, viewRect.y - cell, viewRect.w + cell * 2, viewRect.h + cell * 2);

    // Culled static chunks.
    const expanded = { x: viewRect.x - cell, y: viewRect.y - cell, w: viewRect.w + cell * 2, h: viewRect.h + cell * 2 };
    for (const { cx, cy } of visibleChunks(this.layout, expanded)) {
      const wr = chunkWorldRect(this.layout, cx, cy);
      const canvas = this._chunkCanvas(cx, cy);
      if (canvas && canvas.width) ctx.drawImage(canvas, wr.x, wr.y, wr.w, wr.h);
    }

    // Agents (depth-sorted by y), walked along waypoints + culled.
    const selected = this.sim.selectedAgentId;
    const speed = CONFIG.movement.walkSpeedPixelsPerFrame;
    const drawList = this.sim.agents.slice().sort((a, b) => {
      const pa = this.pos.get(a.id), pb = this.pos.get(b.id);
      return (pa ? pa.y : 0) - (pb ? pb.y : 0);
    });
    for (const a of drawList) {
      const p = this.pos.get(a.id);
      if (!p) continue;

      let moving = false;
      let dir = p.dir || "down";
      if (p.waypoints && p.wpIndex < p.waypoints.length) {
        const wp = p.waypoints[p.wpIndex];
        const dx = wp.x - p.x;
        const dy = wp.y - p.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 1.5) {
          const step = Math.min(speed, dist);
          p.x += (dx / dist) * step;
          p.y += (dy / dist) * step;
          moving = true;
          dir = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? "left" : "right") : (dy < 0 ? "up" : "down");
        } else {
          p.x = wp.x; p.y = wp.y;
          p.wpIndex++;
        }
      }
      p.dir = dir;
      p.bob = reduce ? 0 : moving ? Math.sin(this._frameN * 0.4) * 2 : Math.sin(this._frameN * 0.08 + p.x) * 0.8;

      // Cull off-screen agents.
      if (
        p.x < viewRect.x - AGENT_CULL_PAD || p.x > viewRect.x + viewRect.w + AGENT_CULL_PAD ||
        p.y < viewRect.y - AGENT_CULL_PAD || p.y > viewRect.y + viewRect.h + AGENT_CULL_PAD
      ) continue;

      this._drawAgent(ctx, a, p, a.id === selected, reduce, moving, dir);
    }

    // Day/night overlay: one cheap world-rect fill under the same transform.
    const amb = ambient(this.sim.time.minutesIntoDay);
    if (amb.a > 0.001) {
      ctx.fillStyle = `rgba(${amb.r},${amb.g},${amb.b},${amb.a})`;
      ctx.fillRect(viewRect.x - cell, viewRect.y - cell, viewRect.w + cell * 2, viewRect.h + cell * 2);
    }

    // Reset transform for the DOM bubble pass (screen-space positioning).
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this._updateBubbles();
  }

  _drawAgent(ctx, agent, p, isSelected, reduce, moving, dir) {
    const x = p.x;
    const y = p.y + p.bob;
    if (p.av) {
      // Shared CharacterFactory avatar (draws its own ground shadow).
      p.av.update({ dir, moving, dtFrames: 1 });
      if (isSelected) {
        const fr = (p.av.footRadius || 9) * AVATAR_SCALE;
        const r = fr + 2 + (reduce ? 0 : Math.sin(this._frameN * 0.15) * 1.5);
        ctx.strokeStyle = "#ffd23f"; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.ellipse(p.x, p.y + 1, r, r * 0.5, 0, 0, Math.PI * 2); ctx.stroke();
      }
      p.av.drawCanvas(ctx, x, y, AVATAR_SCALE);
    } else {
      this._legacyAvatar(ctx, agent, p, isSelected, reduce);
    }
  }

  // Legacy inline avatar — used only when no CharacterFactory was supplied so the
  // canvas view never breaks. Mirrors the original look.
  _legacyAvatar(ctx, agent, p, isSelected, reduce) {
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
    ctx.fillStyle = color;
    this._rr(ctx, x - 6, y - 6, 12, 13, 3); ctx.fill();
    ctx.fillStyle = "#f1c9a5"; ctx.beginPath(); ctx.arc(x, y - 10, 5.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#2a2333";
    ctx.fillRect(x - 2, y - 11.5, 1.4, 1.6);
    ctx.fillRect(x + 1, y - 11.5, 1.4, 1.6);
  }

  _rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---- DOM bubbles (screen-space via camera) -------------------------------

  _updateBubbles() {
    if (!this.overlay || !this.canvas || typeof this.canvas.getBoundingClientRect !== "function") return;
    const now = typeof performance !== "undefined" ? performance.now() : 0;
    const cam = this.camera;
    const viewRect = cam.visibleWorldRect();

    // Resolve the active group conversation (last wins) for a single shared bubble.
    let activeGroup = null;
    for (const [key, g] of this.groupSay) {
      if (g.until <= now) { this.groupSay.delete(key); continue; }
      activeGroup = g;
    }
    const groupIds = new Set(activeGroup ? activeGroup.ids : []);

    const live = new Set();
    for (const a of this.sim.agents) {
      const p = this.pos.get(a.id);
      if (!p) continue;
      // Cull bubbles outside the view.
      if (
        p.x < viewRect.x - AGENT_CULL_PAD || p.x > viewRect.x + viewRect.w + AGENT_CULL_PAD ||
        p.y < viewRect.y - AGENT_CULL_PAD || p.y > viewRect.y + viewRect.h + AGENT_CULL_PAD
      ) continue;
      // Members of the active group hide their per-agent bubble (shared one shows).
      if (groupIds.has(a.id)) continue;

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
      const s = cam.worldToScreen(p.x, p.y - 24 * AVATAR_SCALE);
      bubble.style.left = `${s.x}px`;
      bubble.style.top = `${s.y}px`;
    }

    // Shared group bubble.
    let gb = this.bubbles.get("__group__");
    if (activeGroup) {
      let sx = 0, sy = 0, n = 0;
      for (const id of activeGroup.ids) {
        const p = this.pos.get(id);
        if (!p) continue;
        sx += p.x; sy += p.y; n++;
      }
      if (n) {
        if (!gb) {
          gb = document.createElement("div");
          gb.className = "speech-bubble speech-bubble--talking";
          this.overlay.appendChild(gb);
          this.bubbles.set("__group__", gb);
        }
        gb.textContent = "💬";
        const s = cam.worldToScreen(sx / n, sy / n - 30);
        gb.style.left = `${s.x}px`;
        gb.style.top = `${s.y}px`;
        gb.style.display = "";
        live.add("__group__");
      }
    } else if (gb) {
      gb.style.display = "none";
    }

    for (const [id, node] of this.bubbles) {
      if (id === "__group__") continue;
      if (!live.has(id)) { node.remove(); this.bubbles.delete(id); }
    }
  }

  destroy() {
    this.stop();
    if (this._onResize && typeof window !== "undefined") window.removeEventListener("resize", this._onResize);
    if (this.camera) this.camera.destroy();
    for (const node of this.bubbles.values()) node.remove();
    this.bubbles.clear();
  }
}
