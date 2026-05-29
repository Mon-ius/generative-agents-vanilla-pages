// random.js — deterministic, seedable pseudo-random number generation.
//
// The same seed always produces the same stream, so a given seed reproduces
// the same initial world and the same simulation behaviour. The generator is
// mulberry32 (fast, tiny, good enough for a toy simulation) seeded through an
// xfnv1a string hash so string seeds work too.

export function hashSeed(seed) {
  let h = 2166136261 >>> 0;
  const str = String(seed);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Returns an RNG function producing floats in [0, 1). The function also exposes
// getState()/setState() so the exact stream position can be saved and restored
// (this is what makes save/load fully deterministic).
export function seededRandom(seed) {
  let a = typeof seed === "number" ? seed >>> 0 : hashSeed(seed);
  const rng = function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.getState = () => a >>> 0;
  rng.setState = (s) => {
    a = s >>> 0;
  };
  return rng;
}

export function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function choice(array, rng) {
  if (!array || array.length === 0) return undefined;
  return array[Math.floor(rng() * array.length)];
}

// options: array of { item, weight }. Returns one item, biased by weight.
export function weightedChoice(options, rng) {
  if (!options || options.length === 0) return undefined;
  const total = options.reduce((s, o) => s + Math.max(0, o.weight || 0), 0);
  if (total <= 0) return options[0].item;
  let r = rng() * total;
  for (const o of options) {
    r -= Math.max(0, o.weight || 0);
    if (r <= 0) return o.item;
  }
  return options[options.length - 1].item;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function shuffle(array, rng) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
