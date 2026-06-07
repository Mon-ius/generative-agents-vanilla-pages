// PixiMapView.js — the primary town renderer, built on PixiJS (WebGL).
//
// The static world (grass/paths/buildings) is baked LAZILY into per-chunk
// textures (townChunks) and culled to what the camera can see — a single 24×24
// bake would exceed WebGL's max texture size. Agents are Pixi Containers built by
// the shared CharacterFactory (sprite or procedural avatars) and walked along
// A* world paths by the Pixi ticker. A shared Camera (camera.js) owns pan/zoom/
// fit and feeds both culling and hit-testing. A day/night overlay tints the whole
// scene; a single shared bubble marks group conversations.
//
// Pixi is loaded with a dynamic import so that (a) it never enters the static
// module graph the Node tests load, and (b) any load/WebGL failure rejects
// init() cleanly, letting main.js fall back to the canvas MapView.

import { computeLayout, spotFor, activityEmoji, ambient, routeFrom } from "./townArt.js";
import { chunkWorldRect, visibleChunks, makeChunkCanvas } from "./townChunks.js";
import { Camera } from "./camera.js";
import { CONFIG } from "../config.js";

const SAY_MS = 4200;
const TEXTURE_SCALE = 2; // supersample factor for chunk bakes (crisp on zoom)
const AGENT_CULL_PAD = 64; // world px margin for agent visibility culling
const AVATAR_SCALE = (CONFIG.characters && CONFIG.characters.frameScale) || 1; // on-screen avatar size

export class PixiMapView {
  constructor(host, sim, { onSelect, sprites, characters } = {}) {
    this.host = host;
    this.sim = sim;
    this.onSelect = onSelect || (() => {});
    this.sprites = sprites || null;
    this.characters = characters || null;
    this.PIXI = null;
    this.app = null;
    this.entries = new Map(); // agentId -> { c, ring, av, built, bubble, bubbleBg, pos, waypoints, wpIndex }
    this.say = new Map(); // agentId -> { until }
    this.groupSay = new Map(); // key -> { until, cx, cy, text }
    this.chunkTex = new Map(); // chunkKey -> PIXI.Texture (LRU, capped)
    this.chunkSprite = new Map(); // chunkKey -> PIXI.Sprite
    this._built = false;
    this._lastCull = { x: NaN, y: NaN, scale: NaN };
  }

  async init() {
    const PIXI = await import("../vendor/pixi.min.mjs");
    this.PIXI = PIXI;
    this.layout = computeLayout(this.sim);

    const host = this.host;
    const cssW = (host && host.clientWidth) || this.layout.W;
    const cssH = (host && host.clientHeight) || this.layout.H;

    const app = new PIXI.Application();
    await app.init({
      width: cssW,
      height: cssH,
      background: "#84b95a",
      antialias: true,
      preference: "webgl",
      resolution: CONFIG.rendering.resolutionScale,
      autoDensity: CONFIG.rendering.autoDensity,
      powerPreference: "low-power",
    });
    this.app = app;
    const cv = app.canvas;
    cv.style.display = "block";
    cv.style.width = "100%";
    cv.style.height = "100%";
    host.appendChild(cv);

    // Everything lives in a "world" container the camera pans/zooms.
    this.world = new PIXI.Container();
    app.stage.addChild(this.world);

    // Shared camera: it sees the whole world and the host CSS box is the viewport.
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
    this.camera.attach(cv, {
      onTap: (sx, sy) => this._pickAt(sx, sy),
      // Route the camera's grab/grabbing/default through Pixi's own cursor system
      // (cursorStyles.default) so it isn't reset on pointer-move, while agents keep
      // their 'pointer' cursor on hover. Also set it inline for an immediate change.
      onCursor: (cur) => {
        if (cv && cv.style) cv.style.cursor = cur;
        const ev = this.app && this.app.renderer && this.app.renderer.events;
        if (ev && ev.cursorStyles) ev.cursorStyles.default = cur;
      },
    });

    this._buildScene();
    this._wire();
    this._onResize = () => this._resize();
    if (typeof window !== "undefined") window.addEventListener("resize", this._onResize);
    app.ticker.add(() => this._frame());
    return this;
  }

  _viewport() {
    const host = this.host;
    const w = (host && host.clientWidth) || this.layout.W;
    const h = (host && host.clientHeight) || this.layout.H;
    return { w, h };
  }

  _resize() {
    if (!this.app) return;
    const { w, h } = this._viewport();
    this.app.renderer.resize(w, h);
    // Re-clamp the camera to the new viewport (fit floor may have changed).
    this.camera.setWorld(this.layout.W, this.layout.H);
    this._invalidateCull();
  }

  _buildScene() {
    const PIXI = this.PIXI;
    const stage = this.world;
    stage.removeChildren();
    this.entries.clear();
    this._clearChunks();
    this.layout = computeLayout(this.sim);

    // Infinite grass beneath everything — covers the boundless area beyond the
    // town chunks so panning/zooming never reveals a hard edge.
    this.grassLayer = this._makeGrassLayer();
    if (this.grassLayer) stage.addChild(this.grassLayer);

    // Lazily-baked static world: chunk sprites added on demand by _cullChunks.
    this.chunkLayer = new PIXI.Container();
    stage.addChild(this.chunkLayer);

    // Agents layer (depth-sorted by y).
    this.agentsLayer = new PIXI.Container();
    this.agentsLayer.sortableChildren = true;
    stage.addChild(this.agentsLayer);

    for (const a of this.sim.agents) this._makeAgent(a);
    this._syncTargets(true);

    // Day/night overlay: one cheap full-world quad on top.
    this.overlay = new PIXI.Graphics().rect(0, 0, this.layout.W, this.layout.H).fill("#ffffff");
    this.overlay.alpha = 0;
    this.overlay.eventMode = "none";
    stage.addChild(this.overlay);

    // Shared group-conversation bubble (one, repositioned per active group).
    this.groupBubble = new PIXI.Container();
    this.groupBubble.visible = false;
    this.groupBubble.eventMode = "none";
    this._groupBg = new PIXI.Graphics();
    this._groupText = new PIXI.Text({
      text: "💬",
      style: { fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: 14, fontWeight: "700", fill: "#1e2330" },
    });
    this._groupText.anchor.set(0.5, 1);
    this.groupBubble.addChild(this._groupBg);
    this.groupBubble.addChild(this._groupText);
    stage.addChild(this.groupBubble);

    // Open at a game-like zoom centered on the selected agent (the whole 24×24
    // map is still reachable via the Fit button / zoom-out).
    this.camera.setWorld(this.layout.W, this.layout.H);
    this.defaultView();
    this._invalidateCull();
    this._built = true;
  }

  // Open centered on the MAP CENTER at a comfortable game zoom (~cellsAcross
  // cells across the viewport), snapping so there is no glide on first paint.
  defaultView(cellsAcross = 12) {
    const cam = this.camera;
    if (!cam) return;
    const CELL = this.layout.CELL || 176;
    const vp = this._viewport();
    const s = Math.min(cam.maxScale(), Math.max(cam.minScale(), vp.w / (cellsAcross * CELL)));
    cam.tscale = s;
    cam.centerOn(this.layout.W / 2, this.layout.H / 2);
    cam.scale = cam.tscale;
    cam.x = cam.tx;
    cam.y = cam.ty;
    this._invalidateCull && this._invalidateCull();
  }

  // Build the infinite-grass tiling layer from the grass tile (null if no tiles
  // are loaded — the app's green background then shows beyond the town instead).
  _makeGrassLayer() {
    const PIXI = this.PIXI;
    const g = this.sprites && this.sprites.grass;
    if (!g || !PIXI || !PIXI.TilingSprite) return null;
    let tex;
    try { tex = PIXI.Texture.from(g); if (tex.source && "scaleMode" in tex.source) tex.source.scaleMode = "nearest"; }
    catch (_) { return null; }
    const ts = new PIXI.TilingSprite({ texture: tex, width: this.layout.W, height: this.layout.H });
    ts.eventMode = "none";
    return ts;
  }

  // Resize/position a world-space node to cover the camera's visible rect (+pad),
  // keeping a TilingSprite's pattern anchored to world coords. Used for the
  // infinite grass and the day/night overlay so both fill the boundless view.
  _coverVisible(node, pad) {
    if (!node) return;
    const r = this.camera.visibleWorldRect();
    node.position.set(r.x - pad, r.y - pad);
    node.width = r.w + pad * 2;
    node.height = r.h + pad * 2;
    if (node.tilePosition) node.tilePosition.set(-(r.x - pad), -(r.y - pad));
  }

  // ---- static world chunks (lazy + culled) ---------------------------------

  _clearChunks() {
    for (const tex of this.chunkTex.values()) {
      try { tex.destroy(true); } catch (_) {}
    }
    this.chunkTex.clear();
    this.chunkSprite.clear();
    if (this.chunkLayer) this.chunkLayer.removeChildren();
  }

  _invalidateCull() {
    this._lastCull = { x: NaN, y: NaN, scale: NaN };
  }

  // Build (or reveal) the chunks the camera can see; hide the rest. Throttled to
  // when the camera moved >1px or the scale changed since the last cull.
  _cullChunks() {
    const cam = this.camera;
    const moved =
      !(Math.abs(cam.x - this._lastCull.x) <= 1 &&
        Math.abs(cam.y - this._lastCull.y) <= 1 &&
        cam.scale === this._lastCull.scale);
    if (!moved) return;
    this._lastCull = { x: cam.x, y: cam.y, scale: cam.scale };

    const PIXI = this.PIXI;
    const rect = cam.visibleWorldRect();
    const cell = this.layout.CELL;
    const expanded = { x: rect.x - cell, y: rect.y - cell, w: rect.w + cell * 2, h: rect.h + cell * 2 };
    const vis = visibleChunks(this.layout, expanded);
    const wanted = new Set(vis.map((c) => c.key));

    // Hide chunks no longer visible.
    for (const [key, sprite] of this.chunkSprite) {
      if (!wanted.has(key)) sprite.visible = false;
    }

    for (const { cx, cy, key } of vis) {
      let sprite = this.chunkSprite.get(key);
      if (!sprite) {
        const canvas = makeChunkCanvas(this.layout, this.sprites, cx, cy, { scale: TEXTURE_SCALE });
        if (!canvas) continue; // headless / no 2D context
        const tex = PIXI.Texture.from(canvas);
        this._cacheChunkTexture(key, tex);
        const wr = chunkWorldRect(this.layout, cx, cy);
        sprite = new PIXI.Sprite(tex);
        sprite.x = wr.x;
        sprite.y = wr.y;
        sprite.width = wr.w;
        sprite.height = wr.h;
        sprite.eventMode = "none";
        this.chunkSprite.set(key, sprite);
        this.chunkLayer.addChild(sprite);
      } else if (!sprite.texture || sprite.texture.destroyed) {
        // texture was evicted while the sprite was hidden — rebuild it.
        const canvas = makeChunkCanvas(this.layout, this.sprites, cx, cy, { scale: TEXTURE_SCALE });
        if (!canvas) continue;
        const tex = PIXI.Texture.from(canvas);
        this._cacheChunkTexture(key, tex);
        sprite.texture = tex;
      }
      sprite.visible = true;
      this._touchChunkTexture(key);
    }
  }

  // LRU cache of chunk textures: re-inserting marks "recently used"; once over
  // the cap, evict the oldest texture whose sprite is currently hidden.
  _cacheChunkTexture(key, tex) {
    this.chunkTex.set(key, tex);
    this._evictChunks();
  }
  _touchChunkTexture(key) {
    const tex = this.chunkTex.get(key);
    if (tex) { this.chunkTex.delete(key); this.chunkTex.set(key, tex); }
  }
  _evictChunks() {
    const cap = (CONFIG.rendering && CONFIG.rendering.chunkCacheMax) || 64;
    if (this.chunkTex.size <= cap) return;
    for (const key of this.chunkTex.keys()) {
      if (this.chunkTex.size <= cap) break;
      const sprite = this.chunkSprite.get(key);
      if (sprite && sprite.visible) continue; // never evict a visible chunk
      const tex = this.chunkTex.get(key);
      this.chunkTex.delete(key);
      if (sprite) {
        sprite.visible = false;
        if (sprite.parent) sprite.parent.removeChild(sprite);
        this.chunkSprite.delete(key);
      }
      try { tex && tex.destroy(true); } catch (_) {}
    }
  }

  // ---- agents --------------------------------------------------------------

  _makeAgent(a) {
    const PIXI = this.PIXI;
    const c = new PIXI.Container();
    c.eventMode = "static";
    c.cursor = "pointer";
    c.hitArea = new PIXI.Rectangle(-14, -34, 28, 50);
    c.on("pointertap", () => this.onSelect(a.id));

    // selection ring (sized from the avatar's footRadius once built)
    const ring = new PIXI.Graphics();
    ring.visible = false;
    c.addChild(ring);

    // avatar from the shared factory (or a procedural fallback if absent)
    const av = this.characters ? this.characters.makeAvatar(a) : this._fallbackAvatar(a);
    const built = av.pixiBuild(this.PIXI);
    built.node.scale.set(AVATAR_SCALE);
    c.addChild(built.node);

    // per-agent activity bubble
    const bubbleBg = new PIXI.Graphics();
    const bubble = new PIXI.Text({
      text: `${a.initials}: ${a.emoji}`,
      style: { fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: 12, fontWeight: "700", fill: "#1e2330" },
    });
    bubble.anchor.set(0.5, 1);
    bubble.y = -1;
    c.addChild(bubbleBg);
    c.addChild(bubble);

    const fr = (av.footRadius || 9) * AVATAR_SCALE;
    ring.ellipse(0, 1, fr + 3, (fr + 3) * 0.46).stroke({ color: "#ffd23f", width: 2.5 });

    this.agentsLayer.addChild(c);
    this.entries.set(a.id, {
      c, ring, av, built, bubble, bubbleBg,
      lastLabel: null, _sel: false,
      pos: { x: 0, y: 0, bob: 0, dir: "down" },
      waypoints: null, wpIndex: 0, lastLoc: a.currentLocationId,
    });
  }

  // Minimal procedural avatar used only when no CharacterFactory was supplied.
  _fallbackAvatar(a) {
    const color = a.color || "#4b6bdc";
    return {
      mode: "procedural",
      footRadius: 9,
      update() {},
      frameCanvas() { return null; },
      drawCanvas() {},
      pixiBuild: (PIXI) => {
        const node = new PIXI.Container();
        node.addChild(new PIXI.Graphics().ellipse(0, 9, 9, 4).fill({ color: 0x000000, alpha: 0.22 }));
        const g = new PIXI.Graphics();
        g.roundRect(-6, -6, 12, 13, 3).fill(color);
        g.circle(0, -10, 5.5).fill("#f1c9a5");
        node.addChild(g);
        return { node, refresh() {} };
      },
    };
  }

  _drawBubble(e) {
    const w = e.bubble.width + 12;
    const h = e.bubble.height + 4;
    const fr = ((e.av && e.av.footRadius) || 9) * AVATAR_SCALE;
    const topY = -(fr * 2 + 10); // above the head
    const x = -w / 2;
    const y = topY - h;
    e.bubble.y = topY;
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

  // ---- wiring --------------------------------------------------------------

  _wire() {
    const bus = this.sim.bus;
    bus.on("tick", () => this._syncTargets(false));
    bus.on("reset", () => this._buildScene());
    bus.on("load", () => this._buildScene());
    bus.on("timeline", (e) => this._onTimeline(e));
    // Clicking a resident (on the map or in the legend) pans to locate them.
    bus.on("select", () => this._focusSelected());
  }

  // Smoothly center the camera on the currently selected resident.
  _focusSelected() {
    const e = this.entries.get(this.sim.selectedAgentId);
    if (e && e.pos && this.camera) this.camera.centerOn(e.pos.x, e.pos.y);
  }

  _onTimeline(e) {
    if (!e || e.type !== "conversation" || typeof performance === "undefined") return;
    const until = performance.now() + SAY_MS;
    const ids = (e.participantIds && e.participantIds.length ? e.participantIds : e.agentIds) || [];
    for (const id of ids) this.say.set(id, { until });
    // One shared bubble near the group's centroid (uses the location door spot,
    // resolved at draw time from live agent positions for accuracy).
    if (ids.length) {
      this.groupSay.set(e.locationId || ids.join("|"), { until, ids: ids.slice() });
    }
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
        const e = this.entries.get(a.id);
        if (!e) return;
        const finalSpot = spotFor(this.layout, locId, i, group.length);
        const locationChanged = e.lastLoc !== a.currentLocationId || snap;
        if (locationChanged) {
          // Prefer the agent's planned A* world path; else a direct hop.
          const path = Array.isArray(a.path) && a.path.length ? a.path.slice() : null;
          let wps = path ? path.map((p) => ({ x: p.x, y: p.y })) : [{ x: finalSpot.x, y: finalSpot.y }];
          // The sim path starts at the PREVIOUS location's room centre. If the
          // avatar is still mid-walk (the common case at 1× speed — plan blocks
          // change faster than a cross-town walk finishes), walking straight to
          // that first waypoint would cut through walls. Re-plan a wall-legal
          // route from the avatar's ACTUAL position on the same grid the sim
          // routes on; keep the sim path only when the avatar is already at its
          // start (settled in the previous room — that hop stays inside the
          // open interior). Display-only: never touches the sim RNG or state.
          if (!snap && CONFIG.movement && CONFIG.movement.pathfindingEnabled) {
            const eps = ((this.layout && this.layout.CELL) || 176) * 0.24; // crowd-fan radius + slack, still inside the room interior
            if (Math.hypot(wps[0].x - e.pos.x, wps[0].y - e.pos.y) > eps) {
              const re = routeFrom(this.layout, { x: e.pos.x, y: e.pos.y }, { x: finalSpot.x, y: finalSpot.y });
              if (re && re.length) wps = re.map((p) => ({ x: p.x, y: p.y }));
            }
          }
          // ALWAYS override the final waypoint with crowd placement so co-located
          // agents fan out around the door rather than stacking.
          wps[wps.length - 1] = { x: finalSpot.x, y: finalSpot.y };
          e.waypoints = wps;
          e.wpIndex = 0;
          e.lastLoc = a.currentLocationId;
          if (snap) {
            const last = wps[wps.length - 1];
            e.pos.x = last.x; e.pos.y = last.y;
            e.wpIndex = wps.length; // already settled
          }
        } else {
          // Same location: keep walking, but refresh the settle target for crowd
          // re-balancing (when the last waypoint is the destination spot).
          if (e.waypoints && e.waypoints.length) {
            e.waypoints[e.waypoints.length - 1] = { x: finalSpot.x, y: finalSpot.y };
          } else {
            e.waypoints = [{ x: finalSpot.x, y: finalSpot.y }];
            e.wpIndex = 0;
          }
        }
      });
    }
  }

  // ---- hit-testing ---------------------------------------------------------

  _pickAt(sx, sy) {
    const wp = this.camera.screenToWorld(sx, sy);
    let best = null;
    let bestD = 28 * 28;
    for (const a of this.sim.agents) {
      const e = this.entries.get(a.id);
      if (!e) continue;
      const dx = e.pos.x - wp.x;
      const dy = (e.pos.y - 14) - wp.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = a.id; }
    }
    if (best) this.onSelect(best);
  }

  // ---- frame ---------------------------------------------------------------

  _frame() {
    if (!this._built) return;
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    this._t = (this._t || 0) + 1;

    // Advance + apply the camera, then cull static chunks.
    this.camera.tick(reduce);
    this.world.scale.set(this.camera.scale);
    this.world.position.set(this.camera.x, this.camera.y);
    if (this.grassLayer) this._coverVisible(this.grassLayer, this.layout.CELL || 176);
    this._cullChunks();

    const selId = this.sim.selectedAgentId;
    const viewRect = this.camera.visibleWorldRect();
    const speed = CONFIG.movement.walkSpeedPixelsPerFrame;

    for (const a of this.sim.agents) {
      const e = this.entries.get(a.id);
      if (!e) continue;
      e._id = a.id;
      const p = e.pos;

      // Walk along waypoints.
      let moving = false;
      let dir = p.dir || "down";
      if (e.waypoints && e.wpIndex < e.waypoints.length) {
        const wp = e.waypoints[e.wpIndex];
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
          e.wpIndex++;
        }
      }
      p.dir = dir;
      p.bob = reduce ? 0 : moving ? Math.sin(this._t * 0.4) * 2 : Math.sin(this._t * 0.08 + p.x) * 0.8;

      // Cull off-screen agents.
      const visible =
        p.x >= viewRect.x - AGENT_CULL_PAD && p.x <= viewRect.x + viewRect.w + AGENT_CULL_PAD &&
        p.y >= viewRect.y - AGENT_CULL_PAD && p.y <= viewRect.y + viewRect.h + AGENT_CULL_PAD;
      e.c.visible = visible;
      if (!visible) continue;

      // Animate + position the avatar.
      e.av.update({ dir, moving, dtFrames: 1 });
      if (e.built && e.built.refresh) e.built.refresh();
      e.c.x = p.x;
      e.c.y = p.y - p.bob;
      e.c.zIndex = p.y;

      // Selection ring.
      const sel = a.id === selId;
      e.ring.visible = sel;
      if (sel) e.ring.alpha = 0.6 + 0.4 * Math.sin(this._t * 0.15);

      // Per-agent activity bubble (shared group bubble handled separately).
      const emoji = this._isTalking(a.id) ? "💬" : activityEmoji(a.currentActivity, a.emoji);
      const label = `${a.initials}: ${emoji}`;
      if (label !== e.lastLabel || sel !== e._sel) {
        e.bubble.text = label;
        e.lastLabel = label;
        e._sel = sel;
        this._drawBubble(e);
      }
    }

    this._updateGroupBubble();

    this._coverVisible(this.overlay, this.layout.CELL || 176); // tint the boundless view too
    const amb = ambient(this.sim.time.minutesIntoDay);
    this.overlay.tint = (amb.r << 16) | (amb.g << 8) | amb.b;
    this.overlay.alpha = amb.a;
  }

  // One shared speech indicator at the centroid of the most recent live group.
  _updateGroupBubble() {
    const now = typeof performance !== "undefined" ? performance.now() : 0;
    let active = null;
    for (const [key, g] of this.groupSay) {
      if (g.until <= now) { this.groupSay.delete(key); continue; }
      active = g; // last wins (most recent)
    }
    if (!active) { this.groupBubble.visible = false; return; }

    let sx = 0, sy = 0, n = 0;
    for (const id of active.ids) {
      const e = this.entries.get(id);
      if (!e) continue;
      sx += e.pos.x; sy += e.pos.y; n++;
    }
    if (!n) { this.groupBubble.visible = false; return; }
    const cx = sx / n;
    const cy = sy / n;

    const t = this._groupText;
    const w = t.width + 14;
    const h = t.height + 6;
    this._groupBg.clear()
      .roundRect(-w / 2, -h, w, h, 8).fill("#fff6e2")
      .roundRect(-w / 2, -h, w, h, 8).stroke({ color: "#b8770a", width: 2 })
      .moveTo(-5, 0).lineTo(5, 0).lineTo(0, 6).fill("#b8770a");
    t.y = -4;
    this.groupBubble.x = cx;
    this.groupBubble.y = cy - 40;
    this.groupBubble.zIndex = 1e9;
    this.groupBubble.visible = true;
  }

  // ---- camera persistence handle (set by main.js) --------------------------
  // main.js may assign this._persist; camera.onChange invokes it.

  start() { /* the Pixi ticker auto-starts in init() */ }

  stop() {
    if (this.app) this.app.ticker.stop();
  }

  destroy() {
    if (this._onResize && typeof window !== "undefined") window.removeEventListener("resize", this._onResize);
    if (this.camera) this.camera.destroy();
    this._clearChunks();
    if (this.app) {
      this.app.destroy(true, { children: true });
      this.app = null;
    }
  }
}
