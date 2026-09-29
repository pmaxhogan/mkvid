/**
 * Colour palette from artwork: k-means on a downscaled RGBA image, then the
 * clusters are pushed into ranges that stay readable next to white text on a
 * dark background.
 */

export type RGB = [number, number, number]

export interface Palette {
  /** Very dark tone of the dominant colour: page base and background tint. */
  base: RGB
  /** Vivid, light colour: spectrum, playhead, artist name. */
  accent: RGB
  /** Second vivid colour, a different hue when the artwork has one. */
  accent2: RGB
  /** Mean luminance of the artwork, 0..1. */
  luminance: number
  /** True when the artwork is essentially greyscale. */
  mono: boolean
}

export function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return [h * 60, s, l]
}

export function hslToRgb(h: number, s: number, l: number): RGB {
  const hh = (((h % 360) + 360) % 360) / 360
  if (s === 0) {
    const v = Math.round(l * 255)
    return [v, v, v]
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t: number) => {
    let x = t
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  return [Math.round(f(hh + 1 / 3) * 255), Math.round(f(hh) * 255), Math.round(f(hh - 1 / 3) * 255)]
}

/** WCAG relative luminance. */
export function relativeLuminance([r, g, b]: RGB): number {
  const c = (v: number) => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b)
}

export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

export function mixPalette(a: Palette, b: Palette, t: number): Palette {
  if (t <= 0) return a
  if (t >= 1) return b
  return {
    base: mixRgb(a.base, b.base, t),
    accent: mixRgb(a.accent, b.accent, t),
    accent2: mixRgb(a.accent2, b.accent2, t),
    luminance: a.luminance + (b.luminance - a.luminance) * t,
    mono: t < 0.5 ? a.mono : b.mono,
  }
}

export function css(c: RGB, alpha = 1): string {
  const r = Math.round(Math.min(255, Math.max(0, c[0])))
  const g = Math.round(Math.min(255, Math.max(0, c[1])))
  const b = Math.round(Math.min(255, Math.max(0, c[2])))
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${Math.max(0, alpha).toFixed(3)})`
}

interface Cluster {
  rgb: RGB
  share: number
  h: number
  s: number
  l: number
}

/** k-means with deterministic seeding (luminance quantiles), so every thread agrees. */
function kmeans(pixels: RGB[], k: number, iterations = 10): Cluster[] {
  const sorted = [...pixels].sort((a, b) => a[0] * 0.3 + a[1] * 0.59 + a[2] * 0.11 - (b[0] * 0.3 + b[1] * 0.59 + b[2] * 0.11))
  let centres: RGB[] = []
  for (let c = 0; c < k; c++) centres.push([...sorted[Math.floor(((c + 0.5) / k) * sorted.length)]!] as RGB)
  const assign = new Int32Array(pixels.length)
  for (let it = 0; it < iterations; it++) {
    for (let p = 0; p < pixels.length; p++) {
      const px = pixels[p]!
      let best = 0
      let bestD = Infinity
      for (let c = 0; c < centres.length; c++) {
        const ce = centres[c]!
        const d = (px[0] - ce[0]) ** 2 + (px[1] - ce[1]) ** 2 + (px[2] - ce[2]) ** 2
        if (d < bestD) {
          bestD = d
          best = c
        }
      }
      assign[p] = best
    }
    const sums = centres.map(() => [0, 0, 0, 0])
    for (let p = 0; p < pixels.length; p++) {
      const s = sums[assign[p]!]!
      const px = pixels[p]!
      s[0]! += px[0]
      s[1]! += px[1]
      s[2]! += px[2]
      s[3]! += 1
    }
    centres = centres.map((ce, c) => {
      const s = sums[c]!
      return s[3]! > 0 ? ([s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!] as RGB) : ce
    })
  }
  const counts = new Array<number>(centres.length).fill(0)
  for (let p = 0; p < pixels.length; p++) counts[assign[p]!]! += 1
  return centres
    .map((rgb, c) => {
      const [h, s, l] = rgbToHsl(rgb)
      return { rgb, share: counts[c]! / pixels.length, h, s, l }
    })
    .filter((c) => c.share > 0)
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/** Pushes a colour into a vivid, light band that reads on a dark background. */
function vivid(h: number, s: number, mono: boolean): RGB {
  if (mono) return hslToRgb(h, Math.min(s, 0.12), 0.86)
  let c = hslToRgb(h, Math.min(1, Math.max(s, 0.62)), 0.64)
  // Blue and violet stay dark at the same HSL lightness; lift until contrast holds.
  for (let l = 0.64; contrastRatio(c, [12, 12, 16]) < 7 && l < 0.85; l += 0.03) c = hslToRgb(h, Math.max(s, 0.62), l)
  return c
}

export const DEFAULT_PALETTE: Palette = {
  base: [14, 12, 24],
  accent: [120, 200, 255],
  accent2: [220, 120, 255],
  luminance: 0.2,
  mono: false,
}

/**
 * Hue and saturation of a coloured minority, or null. Saturated pixels (not
 * near black or white) go into a 10-degree hue histogram weighted by
 * saturation squared; the strongest 40-degree window must hold at least 2%
 * of all pixels and half of the saturated weight, so a real coloured area
 * wins while scattered JPEG noise (every hue a little) never does.
 */
function colouredMinority(pixels: readonly RGB[]): [number, number] | null {
  const weight = new Float64Array(36)
  const count = new Float64Array(36)
  const hx = new Float64Array(36)
  const hy = new Float64Array(36)
  const sat = new Float64Array(36)
  let total = 0
  for (const px of pixels) {
    const [h, s, l] = rgbToHsl(px)
    if (s < 0.3 || l < 0.15 || l > 0.9) continue
    const b = Math.floor(h / 10) % 36
    const w = s * s
    weight[b]! += w
    count[b]! += 1
    hx[b]! += Math.cos((h * Math.PI) / 180) * w
    hy[b]! += Math.sin((h * Math.PI) / 180) * w
    sat[b]! += s
    total += w
  }
  if (total <= 0) return null
  let best = -1
  let bestW = 0
  for (let b = 0; b < 36; b++) {
    let w = 0
    for (let k = -2; k <= 1; k++) w += weight[(b + k + 36) % 36]!
    if (w > bestW) {
      bestW = w
      best = b
    }
  }
  let n = 0
  let x = 0
  let y = 0
  let s = 0
  for (let k = -2; k <= 1; k++) {
    const b = (best + k + 36) % 36
    n += count[b]!
    x += hx[b]!
    y += hy[b]!
    s += sat[b]!
  }
  if (n < Math.max(4, pixels.length * 0.02) || bestW < total * 0.5) return null
  return [((Math.atan2(y, x) * 180) / Math.PI + 360) % 360, s / n]
}

/**
 * Palette of an RGBA image (any size; keep it small, 32 to 64 px square).
 * Fully transparent pixels are ignored.
 */
export function extractPalette(rgba: Uint8Array | Uint8ClampedArray, k = 6): Palette {
  const pixels: RGB[] = []
  let lum = 0
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3]! < 16) continue
    const px: RGB = [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!]
    pixels.push(px)
    lum += relativeLuminance(px)
  }
  if (pixels.length === 0) return DEFAULT_PALETTE
  const luminance = lum / pixels.length
  const clusters = kmeans(pixels, Math.min(k, pixels.length))

  const weightedSat = clusters.reduce((a, c) => a + c.s * c.share * (1 - Math.abs(c.l - 0.5) * 1.6), 0)
  const maxSat = Math.max(...clusters.map((c) => (c.l > 0.08 && c.l < 0.95 ? c.s : 0)))
  const mono = weightedSat < 0.06 && maxSat < 0.2

  // Mostly grey artwork with one small coloured area (a gold helmet on
  // black): k-means folds the area into a grey cluster, so look at the
  // saturated pixels directly and use their colour when they agree on a hue.
  if (mono) {
    const minority = colouredMinority(pixels)
    if (minority) {
      const [h, s] = minority
      return {
        base: hslToRgb(h, 0.12, 0.075),
        accent: vivid(h, s, false),
        accent2: hslToRgb(h, 0.28, 0.8),
        luminance,
        mono: false,
      }
    }
  }

  // Accent: saturated, not too dark or washed out, reasonably present.
  const score = (c: Cluster) => c.s * Math.sqrt(c.share + 0.02) * (1 - Math.min(1, Math.abs(c.l - 0.55) * 1.5))
  const byScore = [...clusters].sort((a, b) => score(b) - score(a))
  const main = byScore[0]!
  const accent = vivid(main.h, main.s, mono)

  // Second accent: best-scoring cluster with a clearly different hue.
  const other = byScore.slice(1).find((c) => c.s > 0.18 && hueDistance(c.h, main.h) > 35)
  const accent2 = mono
    ? hslToRgb(main.h, 0.08, 0.7)
    : other
      ? vivid(other.h, other.s, false)
      : vivid(main.h + 38, main.s, false)

  // Base: the dominant colour, very dark and a little desaturated.
  const dominant = [...clusters].sort((a, b) => b.share - a.share)[0]!
  const baseHue = dominant.s > 0.12 ? dominant.h : main.h
  const baseSat = mono ? 0.04 : Math.min(0.55, Math.max(0.25, dominant.s * 0.8))
  const base = hslToRgb(baseHue, baseSat, 0.085)

  return { base, accent, accent2, luminance, mono }
}
