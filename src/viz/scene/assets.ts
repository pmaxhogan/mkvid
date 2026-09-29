import { createCanvas, loadImage, type Canvas, type Image, type SKRSContext2D } from '@napi-rs/canvas'
import { readFile } from 'node:fs/promises'
import { css, extractPalette, hslToRgb, type Palette } from './palette.js'
import { hashString, mulberry32 } from './rng.js'

/** Everything the scene needs from one artwork, pre-rendered once. */
export interface ArtAssets {
  key: string
  /** Heavily blurred, tinted, luminance-clamped square for the background. */
  bg: Canvas
  /** Artwork clipped to a rounded square at card size. */
  card: Canvas
  palette: Palette
}

export const BG_SIZE = 512

/** Decodes an image file, or null when it is missing or unreadable. */
export async function tryLoadImage(file: string | null): Promise<Image | null> {
  if (!file) return null
  try {
    const buf = await readFile(file)
    const img = await loadImage(buf)
    return img.width > 0 && img.height > 0 ? img : null
  } catch {
    return null
  }
}

/** A deterministic stand-in for missing set artwork: soft blobs of colour on a dark field. */
export function generatedArtwork(seedText: string, size = 600): Canvas {
  const rnd = mulberry32(hashString(seedText || 'mkvid'))
  const c = createCanvas(size, size)
  const ctx = c.getContext('2d')
  const hue = rnd() * 360
  const grad = ctx.createLinearGradient(0, 0, size, size)
  grad.addColorStop(0, css(hslToRgb(hue, 0.55, 0.16)))
  grad.addColorStop(1, css(hslToRgb(hue + 60, 0.6, 0.08)))
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  ctx.globalCompositeOperation = 'lighter'
  for (let k = 0; k < 5; k++) {
    const x = size * (0.15 + rnd() * 0.7)
    const y = size * (0.15 + rnd() * 0.7)
    const r = size * (0.25 + rnd() * 0.35)
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    const col = hslToRgb(hue + (rnd() - 0.5) * 120, 0.55, 0.42)
    g.addColorStop(0, css(col, 0.45))
    g.addColorStop(1, css(col, 0))
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
  }
  ctx.globalCompositeOperation = 'source-over'
  // Fine concentric rings so the card does not look like an empty gradient.
  ctx.strokeStyle = 'rgba(255,255,255,0.07)'
  ctx.lineWidth = size / 300
  for (let r = size * 0.08; r < size * 0.75; r += size * 0.045) {
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, r, 0, Math.PI * 2)
    ctx.stroke()
  }
  return c
}

type Source = Image | Canvas

/** Draws a source cropped to a centred square of the given size. */
function drawCover(ctx: SKRSContext2D, src: Source, x: number, y: number, w: number, h: number): void {
  const sw = src.width
  const sh = src.height
  const s = Math.min(sw, sh)
  ctx.drawImage(src, (sw - s) / 2, (sh - s) / 2, s, s, x, y, w, h)
}

export function roundedRectPath(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

export function buildArtAssets(key: string, src: Source, cardSize: number): ArtAssets {
  // Palette from a 48 px thumbnail.
  const thumb = createCanvas(48, 48)
  const tctx = thumb.getContext('2d')
  tctx.imageSmoothingEnabled = true
  tctx.imageSmoothingQuality = 'high'
  drawCover(tctx, src, 0, 0, 48, 48)
  const palette = extractPalette(tctx.getImageData(0, 0, 48, 48).data)

  // Background: shrink to a few pixels and scale back up (a guaranteed, very
  // heavy blur), then a real blur pass to remove any blockiness. Drawn
  // oversized over a base fill so the blur never pulls in a dark border.
  const tiny = createCanvas(24, 24)
  const tiny2 = tiny.getContext('2d')
  tiny2.imageSmoothingEnabled = true
  tiny2.imageSmoothingQuality = 'high'
  drawCover(tiny2, src, 0, 0, 24, 24)

  const bg = createCanvas(BG_SIZE, BG_SIZE)
  const b = bg.getContext('2d')
  b.fillStyle = css(palette.base)
  b.fillRect(0, 0, BG_SIZE, BG_SIZE)
  b.imageSmoothingEnabled = true
  b.imageSmoothingQuality = 'high'
  b.filter = `blur(${Math.round(BG_SIZE / 28)}px)`
  const over = BG_SIZE * 0.12
  b.drawImage(tiny, -over, -over, BG_SIZE + 2 * over, BG_SIZE + 2 * over)
  b.filter = 'none'

  // Clamp brightness: white covers are pulled down hard so text stays legible,
  // dark ones are left dark (the centre glow lifts them per frame).
  const target = 0.1
  const lum = palette.luminance
  if (lum > target) {
    b.fillStyle = `rgba(0,0,0,${Math.min(0.82, 1 - Math.sqrt(target / lum)).toFixed(3)})`
    b.fillRect(0, 0, BG_SIZE, BG_SIZE)
  }
  // Tint towards the palette so the whole frame shares one colour story.
  b.globalCompositeOperation = 'soft-light'
  b.fillStyle = css(palette.accent, 0.35)
  b.fillRect(0, 0, BG_SIZE, BG_SIZE)
  b.globalCompositeOperation = 'multiply'
  const tint = b.createLinearGradient(0, 0, BG_SIZE, BG_SIZE)
  tint.addColorStop(0, css(palette.accent, 0.35))
  tint.addColorStop(1, css(palette.accent2, 0.35))
  b.fillStyle = tint
  b.fillRect(0, 0, BG_SIZE, BG_SIZE)
  b.globalCompositeOperation = 'source-over'

  // Card: artwork clipped to a rounded square, with a faint inner edge.
  const size = Math.max(8, Math.round(cardSize))
  const card = createCanvas(size, size)
  const c = card.getContext('2d')
  c.imageSmoothingEnabled = true
  c.imageSmoothingQuality = 'high'
  roundedRectPath(c, 0, 0, size, size, size * 0.045)
  c.save()
  c.clip()
  drawCover(c, src, 0, 0, size, size)
  const sheen = c.createLinearGradient(0, 0, size, size)
  sheen.addColorStop(0, 'rgba(255,255,255,0.10)')
  sheen.addColorStop(0.45, 'rgba(255,255,255,0)')
  c.fillStyle = sheen
  c.fillRect(0, 0, size, size)
  c.restore()
  c.strokeStyle = 'rgba(255,255,255,0.14)'
  c.lineWidth = Math.max(1, size / 400)
  roundedRectPath(c, c.lineWidth / 2, c.lineWidth / 2, size - c.lineWidth, size - c.lineWidth, size * 0.045)
  c.stroke()

  return { key, bg, card, palette }
}

/** Soft rounded shadow sprite shared by every card of one size. */
export function buildCardShadow(cardSize: number): { canvas: Canvas; pad: number } {
  const pad = Math.round(cardSize * 0.28)
  const size = Math.round(cardSize) + pad * 2
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  ctx.shadowColor = 'rgba(0,0,0,0.75)'
  ctx.shadowBlur = cardSize * 0.14
  ctx.shadowOffsetY = cardSize * 0.05
  ctx.fillStyle = 'rgba(0,0,0,1)'
  roundedRectPath(ctx, pad, pad, cardSize, cardSize, cardSize * 0.045)
  ctx.fill()
  return { canvas, pad }
}
