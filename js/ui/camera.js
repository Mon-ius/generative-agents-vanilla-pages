// camera.js — one shared 2D camera controller for BOTH renderers.
//
// The Pixi renderer (PixiMapView) and the canvas-2D fallback (MapView) used to
// each carry their own pan/zoom logic — Pixi had an inline _setupCamera and the
// canvas fallback had none at all. This module unifies them so behaviour is
// identical regardless of backend: Pixi applies the camera to its world
// Container (scale.set + position.set); canvas applies it via ctx.setTransform.
//
// The controller is renderer-agnostic. It owns world bounds, a viewport getter
// (CSS px of the canvas/app), and the math for zoom-toward-cursor, drag pan,
// fit-to-screen, clamp-to-bounds, smoothing (target vs current with easing),
// optional inertia, worldToScreen/screenToWorld, and a visibleWorldRect() used
// for chunk + agent culling. Input wiring (wheel / pointer / pinch) is optional:
// call attach(domEl) to bind listeners, or drive the camera manually from a
// renderer's own handlers via zoomAt / panBy.
//
// Node-safe: with no DOM it still constructs and all the pure math (minScale,
// worldToScreen, visibleWorldRect, clampToBounds, …) works for tests.

// Default tuning. Renderers may override per-instance via the constructor.
export const CAMERA_CONFIG = {
  minZoom: null, // null = auto-fit (minScale); a number forces a hard floor
  maxZoom: 4,
  zoomStep: 1.12, // wheel/button multiplicative step
  easing: 0.18, // lerp factor of current toward target per tick (0..1)
  inertia: true, // keep gliding after a flick
  friction: 0.9, // velocity decay per tick when inertia is on (0..1)
  minVelocity: 0.05, // px/tick below which inertia stops
  doubleTapZoom: 2, // wheel-equivalent factor on double-tap/click (0 disables)
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const approxEq = (a, b, eps = 0.001) => Math.abs(a - b) <= eps;

export class Camera {
  /**
   * @param {object} opts
   * @param {number} opts.worldW            world width in world units (px)
   * @param {number} opts.worldH            world height in world units (px)
   * @param {() => {w:number,h:number}} opts.getViewport  viewport size in CSS px
   * @param {() => void} [opts.onChange]    called when the (target) transform changes
   * @param {object} [opts.config]          partial override of CAMERA_CONFIG
   */
  constructor({ worldW, worldH, getViewport, onChange, config } = {}) {
    this.worldW = Math.max(1, worldW || 1);
    this.worldH = Math.max(1, worldH || 1);
    this.getViewport = typeof getViewport === "function" ? getViewport : () => ({ w: this.worldW, h: this.worldH });
    this.onChange = typeof onChange === "function" ? onChange : null;
    this.config = { ...CAMERA_CONFIG, ...(config || {}) };

    // current (rendered) transform — world-space offset + uniform scale.
    this.x = 0;
    this.y = 0;
    this.scale = 1;

    // target transform the current state eases toward.
    this.tx = 0;
    this.ty = 0;
    this.tscale = 1;

    // inertia velocity, in screen px/tick, applied to the target offset.
    this.vx = 0;
    this.vy = 0;

    // input bookkeeping (only used when attach() wires a DOM element)
    this._el = null;
    this._listeners = [];
    this._dragging = false;
    this._lastX = 0;
    this._lastY = 0;
    this._moved = 0;
    this._pointers = new Map(); // pointerId -> {x,y} for pinch
    this._pinchDist = 0;
    this._lastTapAt = 0;

    // user-supplied callbacks fired by the pointer wiring (attach()).
    this.onTap = null; // (screenX, screenY) => void  (a click that wasn't a drag)

    this.fit();
    // fit() centers the target; snap current to it so the first frame is stable.
    this.x = this.tx;
    this.y = this.ty;
    this.scale = this.tscale;
  }

  // ---- viewport ------------------------------------------------------------

  _vp() {
    const v = this.getViewport() || {};
    return { w: Math.max(1, v.w || 1), h: Math.max(1, v.h || 1) };
  }

  /** Resize the world bounds (e.g. after a layout rebuild) and re-clamp. */
  setWorld(worldW, worldH) {
    this.worldW = Math.max(1, worldW || this.worldW);
    this.worldH = Math.max(1, worldH || this.worldH);
    this.tscale = clamp(this.tscale, this.minScale(), this.maxScale());
    this._clampTarget();
  }

  // ---- scale limits --------------------------------------------------------

  /**
   * The smallest scale at which the whole map still fits the viewport.
   * Acts as the zoom floor so you can always pull all the way out (~0.18 for a
   * 24×24 / large world in a ~900px viewport).
   */
  minScale() {
    const { w, h } = this._vp();
    const fit = Math.min(w / this.worldW, h / this.worldH);
    const floor = this.config.minZoom; // explicit hard floor, if any
    if (typeof floor === "number" && floor > 0) return Math.min(fit, floor);
    return fit;
  }

  maxScale() {
    return Math.max(this.minScale(), this.config.maxZoom || 4);
  }

  // ---- imperative controls -------------------------------------------------

  /** Fit the entire world to the viewport and center it. Sets the target. */
  fit() {
    const { w, h } = this._vp();
    const s = this.minScale();
    this.tscale = s;
    // center: leftover viewport space split evenly around the scaled world.
    this.tx = (w - this.worldW * s) / 2;
    this.ty = (h - this.worldH * s) / 2;
    this.vx = this.vy = 0;
    this._emit();
  }

  /**
   * Zoom toward a screen-space anchor (keeps the world point under the cursor
   * fixed). factor > 1 zooms in, < 1 zooms out. Clamped to [minScale,maxScale].
   */
  zoomAt(screenX, screenY, factor) {
    const old = this.tscale;
    const next = clamp(old * factor, this.minScale(), this.maxScale());
    if (approxEq(next, old)) return;
    // world point under the anchor must stay put: sx = wx*scale + offset.
    this.tx = screenX - ((screenX - this.tx) / old) * next;
    this.ty = screenY - ((screenY - this.ty) / old) * next;
    this.tscale = next;
    this._clampTarget();
    this._emit();
  }

  /** Zoom in/out centered on the viewport, by one config step. */
  zoomIn(factor) {
    const { w, h } = this._vp();
    this.zoomAt(w / 2, h / 2, factor || this.config.zoomStep);
  }
  zoomOut(factor) {
    const { w, h } = this._vp();
    this.zoomAt(w / 2, h / 2, 1 / (factor || this.config.zoomStep));
  }
  /** Alias matching the toolbar plan (app.zoomFit). */
  zoomFit() {
    this.fit();
  }

  /** Pan by a screen-space delta (px). Used by drag handlers. */
  panBy(dxScreen, dyScreen) {
    if (!dxScreen && !dyScreen) return;
    this.tx += dxScreen;
    this.ty += dyScreen;
    this._clampTarget();
    this._emit();
  }

  /** Center the camera on a world point (keeps current scale). */
  centerOn(wx, wy) {
    const { w, h } = this._vp();
    this.tx = w / 2 - wx * this.tscale;
    this.ty = h / 2 - wy * this.tscale;
    this._clampTarget();
    this._emit();
  }

  // ---- clamping ------------------------------------------------------------

  /**
   * Keep the world covering the viewport when zoomed in; center on the
   * short axis when the scaled world is smaller than the viewport (i.e. at/near
   * the fit scale). Operates on the *target* transform.
   */
  _clampTarget() {
    const { w, h } = this._vp();
    const sw = this.worldW * this.tscale;
    const sh = this.worldH * this.tscale;

    if (sw <= w) this.tx = (w - sw) / 2; // world narrower than viewport: center
    else this.tx = clamp(this.tx, w - sw, 0); // else keep edges within view

    if (sh <= h) this.ty = (h - sh) / 2;
    else this.ty = clamp(this.ty, h - sh, 0);
  }

  /** Public clamp helper (plan name: clampToBounds). Clamps the target. */
  clampToBounds() {
    this._clampTarget();
  }

  // ---- smoothing / animation ----------------------------------------------

  /**
   * Advance the current transform toward the target by the configured easing,
   * applying inertia to the target first. With reduce-motion the current state
   * snaps to the target and inertia is skipped. Call once per render frame.
   * Returns true while still animating (renderers may use this to flag dirty).
   */
  tick(reduceMotion) {
    // inertia nudges the target offset, then friction decays it.
    if (this.config.inertia && !reduceMotion && (this.vx || this.vy) && !this._dragging) {
      this.tx += this.vx;
      this.ty += this.vy;
      this._clampTarget();
      this.vx *= this.config.friction;
      this.vy *= this.config.friction;
      if (Math.hypot(this.vx, this.vy) < this.config.minVelocity) this.vx = this.vy = 0;
      this._emit();
    } else if (reduceMotion) {
      this.vx = this.vy = 0;
    }

    if (reduceMotion) {
      this.x = this.tx;
      this.y = this.ty;
      this.scale = this.tscale;
      return false;
    }

    const e = this.config.easing;
    this.x = lerp(this.x, this.tx, e);
    this.y = lerp(this.y, this.ty, e);
    this.scale = lerp(this.scale, this.tscale, e);

    const settled =
      approxEq(this.x, this.tx, 0.05) &&
      approxEq(this.y, this.ty, 0.05) &&
      approxEq(this.scale, this.tscale, 0.0005);
    if (settled) {
      this.x = this.tx;
      this.y = this.ty;
      this.scale = this.tscale;
      return this.vx !== 0 || this.vy !== 0;
    }
    return true;
  }

  // ---- coordinate transforms ----------------------------------------------

  /** World point -> screen (CSS px), using the *current* (rendered) transform. */
  worldToScreen(wx, wy) {
    return { x: wx * this.scale + this.x, y: wy * this.scale + this.y };
  }

  /** Screen (CSS px) -> world point, using the *current* (rendered) transform. */
  screenToWorld(sx, sy) {
    return { x: (sx - this.x) / this.scale, y: (sy - this.y) / this.scale };
  }

  // ---- culling helpers -----------------------------------------------------

  /**
   * The rectangle of world currently visible in the viewport, in world units.
   * Callers typically expand it by one cell before testing chunk/agent
   * intersection. Uses the current transform so it tracks the smooth motion.
   */
  visibleWorldRect() {
    const { w, h } = this._vp();
    const tl = this.screenToWorld(0, 0);
    const br = this.screenToWorld(w, h);
    return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
  }

  /** Is a world point within the visible rect, expanded by `pad` world units? */
  isVisible(wx, wy, pad = 0) {
    const r = this.visibleWorldRect();
    return wx >= r.x - pad && wx <= r.x + r.w + pad && wy >= r.y - pad && wy <= r.y + r.h + pad;
  }

  // ---- persistence ---------------------------------------------------------

  /** Serialize the target transform for settings.camera persistence. */
  toJSON() {
    return { x: this.tx, y: this.ty, scale: this.tscale };
  }

  /** Restore a previously serialized transform (clamped to current limits). */
  applyState(state) {
    if (!state || typeof state !== "object") return;
    if (typeof state.scale === "number") this.tscale = clamp(state.scale, this.minScale(), this.maxScale());
    if (typeof state.x === "number") this.tx = state.x;
    if (typeof state.y === "number") this.ty = state.y;
    this.vx = this.vy = 0;
    this._clampTarget();
    // snap current to target so a restored view doesn't visibly glide in.
    this.x = this.tx;
    this.y = this.ty;
    this.scale = this.tscale;
    this._emit();
  }

  _emit() {
    if (this.onChange) this.onChange();
  }

  // ---- input wiring (optional) --------------------------------------------

  /**
   * Bind wheel + pointer (drag/pinch) listeners to a DOM element. The element's
   * bounding rect maps client coords -> viewport CSS px. Pass { onTap } to be
   * notified of clean clicks (no drag) for hit-testing. Renderers that prefer
   * to own their own handlers can skip this and call zoomAt/panBy directly.
   */
  attach(el, { onTap } = {}) {
    if (!el || typeof el.addEventListener !== "function") return this;
    this.detach();
    this._el = el;
    if (onTap) this.onTap = onTap;

    const localXY = (clientX, clientY) => {
      const r = el.getBoundingClientRect();
      // map from CSS-displayed size to the viewport coordinate space.
      const vp = this._vp();
      const scaleX = r.width ? vp.w / r.width : 1;
      const scaleY = r.height ? vp.h / r.height : 1;
      return { x: (clientX - r.left) * scaleX, y: (clientY - r.top) * scaleY };
    };

    const onWheel = (e) => {
      e.preventDefault();
      const { x, y } = localXY(e.clientX, e.clientY);
      const factor = e.deltaY < 0 ? this.config.zoomStep : 1 / this.config.zoomStep;
      this.zoomAt(x, y, factor);
    };

    const onPointerDown = (e) => {
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pointers.size === 2) {
        // begin pinch
        this._pinchDist = this._twoPointerDist();
        this._dragging = false;
      } else {
        this._dragging = true;
        this._lastX = e.clientX;
        this._lastY = e.clientY;
        this._moved = 0;
        this.vx = this.vy = 0;
      }
      if (typeof el.setPointerCapture === "function") {
        try { el.setPointerCapture(e.pointerId); } catch (_) {}
      }
    };

    const onPointerMove = (e) => {
      if (!this._pointers.has(e.pointerId)) return;
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this._pointers.size === 2) {
        const d = this._twoPointerDist();
        if (this._pinchDist > 0 && d > 0) {
          const mid = this._twoPointerMid();
          const { x, y } = localXY(mid.x, mid.y);
          this.zoomAt(x, y, d / this._pinchDist);
        }
        this._pinchDist = d;
        return;
      }
      if (!this._dragging) return;
      const r = el.getBoundingClientRect();
      const vp = this._vp();
      const scaleX = r.width ? vp.w / r.width : 1;
      const scaleY = r.height ? vp.h / r.height : 1;
      const dx = (e.clientX - this._lastX) * scaleX;
      const dy = (e.clientY - this._lastY) * scaleY;
      this.panBy(dx, dy);
      // record flick velocity (screen px/tick) for inertia.
      this.vx = dx;
      this.vy = dy;
      this._moved += Math.abs(dx) + Math.abs(dy);
      this._lastX = e.clientX;
      this._lastY = e.clientY;
    };

    const endPointer = (e) => {
      const wasDragging = this._dragging;
      this._pointers.delete(e.pointerId);
      if (this._pointers.size < 2) this._pinchDist = 0;
      if (this._pointers.size === 0) {
        this._dragging = false;
        // a small total movement counts as a tap (click hit-test / double-tap).
        if (wasDragging && this._moved < 6) {
          this.vx = this.vy = 0;
          this._handleTap(e, localXY);
        } else if (!this.config.inertia) {
          this.vx = this.vy = 0;
        }
      }
    };

    const onPointerLeave = (e) => {
      // pointercancel / leave without a clean up: stop dragging, keep inertia.
      if (this._pointers.has(e.pointerId)) this._pointers.delete(e.pointerId);
      if (this._pointers.size === 0) this._dragging = false;
    };

    const add = (type, fn, opts) => {
      el.addEventListener(type, fn, opts);
      this._listeners.push([type, fn, opts]);
    };
    add("wheel", onWheel, { passive: false });
    add("pointerdown", onPointerDown);
    add("pointermove", onPointerMove);
    add("pointerup", endPointer);
    add("pointercancel", onPointerLeave);
    add("pointerleave", onPointerLeave);
    return this;
  }

  _handleTap(e, localXY) {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const { x, y } = localXY(e.clientX, e.clientY);
    if (this.config.doubleTapZoom && now - this._lastTapAt < 320) {
      this.zoomAt(x, y, this.config.doubleTapZoom);
      this._lastTapAt = 0;
      return;
    }
    this._lastTapAt = now;
    if (this.onTap) this.onTap(x, y, e);
  }

  _twoPointerDist() {
    const pts = [...this._pointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }
  _twoPointerMid() {
    const pts = [...this._pointers.values()];
    if (pts.length < 2) return { x: 0, y: 0 };
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  }

  /** Remove all DOM listeners bound by attach(). */
  detach() {
    if (this._el) {
      for (const [type, fn, opts] of this._listeners) {
        this._el.removeEventListener(type, fn, opts);
      }
    }
    this._listeners = [];
    this._el = null;
    this._pointers.clear();
    this._dragging = false;
    this._pinchDist = 0;
  }

  destroy() {
    this.detach();
    this.onChange = null;
    this.onTap = null;
  }
}

export default Camera;
