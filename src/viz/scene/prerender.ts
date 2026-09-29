import { createCanvas, type Canvas } from '@napi-rs/canvas'
import type { Layout } from './layout.js'
import { mulberry32 } from './rng.js'

/**
 * Static full-frame shading drawn above the artwork and below the text:
 * vignette, a top scrim for the header, a bottom scrim for the timeline and,
 * in the split layout, a soft scrim behind the track text.
 */
export function buildOverlay(l: Layout): Canvas {
  const { w, h, u } = l
  const c = createCanvas(w, h)
  const ctx = c.getContext('2d')
  const diag = Math.hypot(w / 2, h / 2)
  const v = ctx.createRadialGradient(l.cx, l.cy, h * 0.3, w / 2, h / 2, diag * 1.02)
  v.addColorStop(0, 'rgba(0,0,0,0)')
  v.addColorStop(0.6, 'rgba(0,0,0,0.22)')
  v.addColorStop(1, 'rgba(0,0,0,0.62)')
  ctx.fillStyle = v
  ctx.fillRect(0, 0, w, h)

  const top = ctx.createLinearGradient(0, 0, 0, 170 * u)
  top.addColorStop(0, 'rgba(0,0,0,0.42)')
  top.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = top
  ctx.fillRect(0, 0, w, 170 * u)

  const bottomH = 220 * u
  const bottom = ctx.createLinearGradient(0, h - bottomH, 0, h)
  bottom.addColorStop(0, 'rgba(0,0,0,0)')
  bottom.addColorStop(1, 'rgba(0,0,0,0.55)')
  ctx.fillStyle = bottom
  ctx.fillRect(0, h - bottomH, w, bottomH)

  if (l.mode === 'split') {
    const x0 = l.text.x - 180 * u
    const side = ctx.createLinearGradient(x0, 0, w, 0)
    side.addColorStop(0, 'rgba(0,0,0,0)')
    side.addColorStop(0.35, 'rgba(0,0,0,0.22)')
    side.addColorStop(1, 'rgba(0,0,0,0.38)')
    ctx.fillStyle = side
    ctx.fillRect(x0, 0, w - x0, h)
  }
  return c
}

/** Tiles of monochrome noise; one is picked per frame with a hashed offset. */
export function buildGrain(l: Layout, count: number): Canvas[] {
  const size = Math.max(16, Math.min(256, Math.round(256 * l.u)))
  const tiles: Canvas[] = []
  for (let k = 0; k < count; k++) {
    const rnd = mulberry32(0x5eed + k * 977)
    const c = createCanvas(size, size)
    const ctx = c.getContext('2d')
    const img = ctx.createImageData(size, size)
    const d = img.data
    for (let p = 0; p < d.length; p += 4) {
      // Mid-grey +- noise: under 'overlay', 128 leaves the image unchanged.
      const n = Math.round(128 + (rnd() + rnd() + rnd() - 1.5) * 150)
      const v = Math.max(0, Math.min(255, n))
      d[p] = v
      d[p + 1] = v
      d[p + 2] = v
      d[p + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    tiles.push(c)
  }
  return tiles
}

/** Soft white dot with a bright core, for particles and the playhead glow. */
export function buildDotSprite(size: number): Canvas {
  const c = createCanvas(size, size)
  const ctx = c.getContext('2d')
  const r = size / 2
  const g = ctx.createRadialGradient(r, r, 0, r, r, r)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.12, 'rgba(255,255,255,0.9)')
  g.addColorStop(0.3, 'rgba(255,255,255,0.35)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return c
}

/** Soft-edged disc for out-of-focus bokeh. */
export function buildBokehSprite(size: number): Canvas {
  const c = createCanvas(size, size)
  const ctx = c.getContext('2d')
  const r = size / 2
  const g = ctx.createRadialGradient(r, r, 0, r, r, r)
  g.addColorStop(0, 'rgba(255,255,255,0.55)')
  g.addColorStop(0.72, 'rgba(255,255,255,0.8)')
  g.addColorStop(0.86, 'rgba(255,255,255,0.35)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return c
}
