// storage.js — a tiny, safe wrapper around localStorage.
//
// All persistence in this app is client-side only (no backend), so it works on
// GitHub Pages. Every call is guarded: in environments without localStorage
// (e.g. running the core under Node for tests) the wrapper degrades gracefully
// instead of throwing.

function backend() {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch (_) {
    // Access to localStorage can throw in some sandboxed contexts.
  }
  return null;
}

export const storage = {
  available() {
    return backend() !== null;
  },

  save(key, value) {
    const b = backend();
    if (!b) return false;
    try {
      b.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn("storage.save failed:", e);
      return false;
    }
  },

  load(key, fallback = null) {
    const b = backend();
    if (!b) return fallback;
    try {
      const raw = b.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
      console.warn("storage.load failed:", e);
      return fallback;
    }
  },

  remove(key) {
    const b = backend();
    if (!b) return false;
    try {
      b.removeItem(key);
      return true;
    } catch (_) {
      return false;
    }
  },
};
