/**
 * Stateless randomness. Every "random" value in the scene is a hash of
 * integers (particle index, cycle number, a salt), so any frame can be drawn
 * on its own and two scenes built from the same input agree bit for bit.
 */

/** 32-bit integer hash of up to three integers (lowbias32 finaliser). */
export function hash32(a: number, b = 0, c = 0): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ Math.imul(c | 0, 0xc2b2ae3d)
  h ^= h >>> 16
  h = Math.imul(h, 0x7feb352d)
  h ^= h >>> 15
  h = Math.imul(h, 0x846ca68b)
  h ^= h >>> 16
  return h >>> 0
}

/** Uniform float in [0, 1) from up to three integers. */
export function rand01(a: number, b = 0, c = 0): number {
  return hash32(a, b, c) / 4294967296
}

/** Hash of a string, for seeding per-set or per-artwork variation. */
export function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Small seeded generator for one-off setup work (never used per frame). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
