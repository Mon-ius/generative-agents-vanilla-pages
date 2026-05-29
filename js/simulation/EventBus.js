// EventBus.js — a tiny publish/subscribe bus.
//
// The simulation emits events ("tick", "timeline", "select", "reset", "load",
// "init") and the UI subscribes to them. This keeps domain logic decoupled from
// rendering: the Simulation never references the DOM.

export class EventBus {
  constructor() {
    this._listeners = new Map();
  }

  on(type, cb) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(cb);
    return () => this.off(type, cb);
  }

  off(type, cb) {
    const set = this._listeners.get(type);
    if (set) set.delete(cb);
  }

  emit(type, payload) {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const cb of Array.from(set)) {
      try {
        cb(payload);
      } catch (e) {
        console.error(`EventBus listener for "${type}" threw:`, e);
      }
    }
  }
}
