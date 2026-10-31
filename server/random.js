// Seeded PRNG so the same workflow + seed always produces the same data.
// mulberry32: small, fast, good enough for test data (not for crypto).

export function createRandom(seed = Date.now()) {
  let state = hashSeed(seed) >>> 0;

  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  const rng = {
    seed,
    next,
    /** Float in [min, max). */
    float(min = 0, max = 1) {
      return min + next() * (max - min);
    },
    /** Integer in [min, max] (inclusive). */
    int(min, max) {
      const lo = Math.ceil(Math.min(min, max));
      const hi = Math.floor(Math.max(min, max));
      return lo + Math.floor(next() * (hi - lo + 1));
    },
    bool(probability = 0.5) {
      return next() < probability;
    },
    pick(list) {
      if (!list.length) return undefined;
      return list[Math.floor(next() * list.length)];
    },
    /** Pick using parallel weights array; falls back to uniform when weights are missing. */
    weighted(list, weights) {
      if (!weights || weights.length !== list.length) return rng.pick(list);
      const total = weights.reduce((a, w) => a + Math.max(0, Number(w) || 0), 0);
      if (total <= 0) return rng.pick(list);
      let r = next() * total;
      for (let i = 0; i < list.length; i++) {
        r -= Math.max(0, Number(weights[i]) || 0);
        if (r < 0) return list[i];
      }
      return list[list.length - 1];
    },
    /** k distinct items, order preserved from the source list. */
    sample(list, k) {
      const idx = list.map((_, i) => i);
      for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }
      return idx.slice(0, Math.min(k, list.length)).sort((a, b) => a - b).map((i) => list[i]);
    },
    /**
     * The first `k` items of a seeded shuffle of `list` (design 0013 C, Lặp `each` "Xáo trộn"):
     * a partial Fisher–Yates on a copy that draws exactly min(k, length) numbers. `list` is not
     * changed.
     */
    shuffleTake(list, k) {
      const a = Array.from(list);
      const len = a.length;
      const n = Math.min(Math.max(0, Math.trunc(Number(k)) || 0), len);
      for (let i = 0; i < n; i++) {
        const j = i + Math.floor(next() * (len - i));
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
      }
      a.length = n;
      return a;
    },
    digits(n) {
      let s = '';
      for (let i = 0; i < n; i++) s += Math.floor(next() * 10);
      return s;
    },
  };
  return rng;
}

function hashSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed;
  const str = String(seed);
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h;
}
