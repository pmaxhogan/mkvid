import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas'
import type { SceneModel, Slot } from './index.js'
import { formatClock } from './cues.js'
import { BG_SIZE, roundedRectPath } from './assets.js'
import { displayFont, textFont } from './fonts.js'
import { css, mixRgb, type Palette, type RGB } from './palette.js'
import { hash32, rand01 } from './rng.js'
import { slotAt } from './cues.js'
import { ellipsize } from './text.js'
import { activeLayers, drawFan, drawRows, fanAt, layerEntrance, rowsLayout, type Pose } from './layers.js'

export interface FrameState {
  i: number
  t: number
  fps: number
  slot: Slot
  slotIndex: number
  prev: Slot | null
  /** Cross-fade progress 0..1 since the current slot began (1 when settled). */
  p: number
  palette: Palette
  /** Energy averaged over ~0.6 s and ~3 s. */
  energy: number
  energySlow: number
  bass: number
  pulse: number
}

const TAU = Math.PI * 2

export function smooth(x: number): number {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

function easeOut(x: number): number {
  const t = Math.min(1, Math.max(0, x))
  return 1 - (1 - t) ** 3
}

// ---------------------------------------------------------------- background

function drawBgLayer(ctx: SKRSContext2D, m: SceneModel, slot: Slot, st: FrameState, alpha: number): void {
  if (alpha <= 0) return
  const { w, h } = m.layout
  const t = st.t
  const seed = slot.seed
  const ph = (k: number) => rand01(seed, k) * TAU
  // Slow, incommensurate drift so the motion never visibly loops.
  const cover = Math.max(w, h) / BG_SIZE
  const zoom = cover * (1.28 + 0.07 * Math.sin(t / 23 + ph(1)) + 0.03 * st.energySlow)
  const rot = 0.05 * Math.sin(t / 41 + ph(2))
  const dx = w * 0.035 * Math.sin(t / 29 + ph(3))
  const dy = h * 0.035 * Math.sin(t / 37 + ph(4))
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(w / 2 + dx, h / 2 + dy)
  ctx.rotate(rot)
  ctx.scale(zoom, zoom)
  ctx.drawImage(slot.art.bg, -BG_SIZE / 2, -BG_SIZE / 2)
  ctx.restore()
}

export function drawBackground(ctx: SKRSContext2D, m: SceneModel, st: FrameState): void {
  const { w, h, u, cx, cy } = m.layout
  ctx.fillStyle = css(st.palette.base)
  ctx.fillRect(0, 0, w, h)
  if (st.prev) drawBgLayer(ctx, m, st.prev, st, 1)
  drawBgLayer(ctx, m, st.slot, st, st.prev ? smooth(st.p) : 1)

  // Brightness follows the music: quiet passages sink, loud ones open up.
  const dim = 0.62 - 0.36 * st.energy - 0.06 * st.pulse
  if (dim > 0) {
    ctx.fillStyle = `rgba(0,0,0,${dim.toFixed(3)})`
    ctx.fillRect(0, 0, w, h)
  }

  // Coloured bloom behind the artwork, breathing with bass and beats.
  const bloom = (0.07 + 0.2 * st.bass + 0.05 * st.pulse) * (st.palette.mono ? 0.4 : 1) * (0.6 + 0.4 * st.energy)
  const r = m.layout.ringR * (2.1 + 0.25 * st.bass)
  ctx.globalCompositeOperation = 'lighter'
  const g = ctx.createRadialGradient(cx, cy, m.layout.ringR * 0.6, cx, cy, r)
  g.addColorStop(0, css(st.palette.accent, bloom))
  g.addColorStop(0.45, css(mixRgb(st.palette.accent, st.palette.accent2, 0.5), bloom * 0.35))
  g.addColorStop(1, css(st.palette.accent2, 0))
  ctx.fillStyle = g
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2)
  ctx.globalCompositeOperation = 'source-over'
  void u
}

// ---------------------------------------------------------------- particles

const PARTICLES = 260

export function drawParticles(ctx: SKRSContext2D, m: SceneModel, st: FrameState): void {
  const { cx, cy, u, ringR, w, h } = m.layout
  const f = m.features
  const fps = st.fps
  const bIntNow = f.bassIntegral(st.i)
  const maxR = Math.hypot(w, h) * 0.62
  ctx.globalCompositeOperation = 'lighter'
  drawBokeh(ctx, m, st)
  for (let k = 0; k < PARTICLES; k++) {
    // Each particle loops through lives of its own length; a life is a pure
    // function of (particle, life number), so any frame can be evaluated alone.
    const period = Math.round(fps * (4 + 5 * rand01(k, 1)))
    const offset = hash32(k, 2) % period
    const life = Math.floor((st.i + offset) / period)
    const birth = life * period - offset
    const age = (st.i - birth) / period
    const r1 = rand01(k, life, 3)
    const r2 = rand01(k, life, 4)
    const r3 = rand01(k, life, 5)
    const depth = 0.35 + 0.65 * r3
    const angle = r1 * TAU + (r2 - 0.5) * 0.6 * age
    // Distance: a steady drift plus a share of the bass heard since birth.
    const bassSince = bIntNow - f.bassIntegral(birth)
    const dist = ringR * (0.72 + 0.1 * r2) + u * (60 + 180 * r2) * age * depth + u * 9 * bassSince * depth
    if (dist > maxR) continue
    const x = cx + Math.cos(angle) * dist
    const y = cy + Math.sin(angle) * dist
    const fade = Math.sin(Math.PI * Math.min(1, age)) ** 1.5
    const alpha = fade * (0.18 + 0.5 * depth) * (0.55 + 0.9 * st.bass)
    if (alpha < 0.01) continue
    const size = u * (5 + 16 * depth * depth) * (1 + 0.5 * st.bass)
    // Colour from the palette of the track playing at the particle's birth.
    const birthSlot = m.slots[Math.max(0, slotAt(m.starts, Math.max(0, birth)))]!
    ctx.globalAlpha = Math.min(1, alpha)
    ctx.drawImage(tinted(m, birthSlot, r2 < 0.5 ? 0 : 1), x - size / 2, y - size / 2, size, size)
  }
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
}

const BOKEH = 22

/** Large, faint, out-of-focus discs drifting slowly across the whole frame. */
function drawBokeh(ctx: SKRSContext2D, m: SceneModel, st: FrameState): void {
  const { w, h, u, cx, cy } = m.layout
  for (let k = 0; k < BOKEH; k++) {
    const period = Math.round(st.fps * (14 + 10 * rand01(k, 21)))
    const offset = hash32(k, 22) % period
    const life = Math.floor((st.i + offset) / period)
    const birth = life * period - offset
    const age = (st.i - birth) / period
    const x0 = rand01(k, life, 23) * w
    const y0 = rand01(k, life, 24) * h
    // Drift away from the artwork, slowly.
    const dx = x0 - cx
    const dy = y0 - cy
    const d = Math.hypot(dx, dy) || 1
    const x = x0 + (dx / d) * age * 90 * u
    const y = y0 + (dy / d) * age * 90 * u
    const size = u * (50 + 110 * rand01(k, life, 25))
    const fade = Math.sin(Math.PI * age) ** 2
    const alpha = fade * (0.05 + 0.07 * st.energy) * (0.6 + 0.8 * rand01(k, life, 26))
    if (alpha < 0.004) continue
    const birthSlot = m.slots[Math.max(0, slotAt(m.starts, Math.max(0, birth)))]!
    ctx.globalAlpha = alpha
    ctx.drawImage(tintedBokeh(m, birthSlot, k & 1 ? 1 : 0), x - size / 2, y - size / 2, size, size)
  }
  ctx.globalAlpha = 1
}

const bokehCache = new WeakMap<Slot['art'], Canvas[]>()
function tintedBokeh(m: SceneModel, slot: Slot, which: 0 | 1): Canvas {
  let pair = bokehCache.get(slot.art)
  if (!pair) {
    pair = [slot.art.palette.accent, slot.art.palette.accent2].map((c: RGB) => {
      const s = m.bokeh.width
      const cv = createCanvas(s, s)
      const x = cv.getContext('2d')
      x.drawImage(m.bokeh, 0, 0)
      x.globalCompositeOperation = 'source-atop'
      x.fillStyle = css(c)
      x.fillRect(0, 0, s, s)
      return cv
    })
    bokehCache.set(slot.art, pair)
  }
  return pair[which]!
}

/** Dot sprites tinted once per artwork and colour. */
const tintCache = new WeakMap<Slot['art'], Canvas[]>()
function tinted(m: SceneModel, slot: Slot, which: 0 | 1): Canvas {
  let pair = tintCache.get(slot.art)
  if (!pair) {
    pair = [slot.art.palette.accent, slot.art.palette.accent2].map((c: RGB) => {
      const s = m.dot.width
      const cv = createCanvas(s, s)
      const x = cv.getContext('2d')
      x.drawImage(m.dot, 0, 0)
      x.globalCompositeOperation = 'source-atop'
      const g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
      g.addColorStop(0, css(mixRgb(c, [255, 255, 255], 0.7)))
      g.addColorStop(0.3, css(c))
      g.addColorStop(1, css(c))
      x.fillStyle = g
      x.fillRect(0, 0, s, s)
      return cv
    })
    tintCache.set(slot.art, pair)
  }
  return pair[which]!
}

// ---------------------------------------------------------------- spectrum ring

const HALF = 84
const specNow = new Float32Array(HALF)
const specHold = new Float32Array(HALF)

export function drawRing(ctx: SKRSContext2D, m: SceneModel, st: FrameState): void {
  const { cx, cy, u, ringR, ringAmp } = m.layout
  const f = m.features
  // Three-frame attack, slower release: measured on a real 62-minute set this
  // halves frame-to-frame jitter and cuts sharp jumps from ~4.5 to ~1.8 a second.
  f.spectrumAt(st.i, HALF, specNow, 9, 0.9, 0, 0.88, 1.0, 3)
  f.spectrumAt(st.i, HALF, specHold, 20, 0.93, 0, 0.88)
  const R = ringR * (1 + 0.012 * st.pulse * st.bass)
  const pal = st.palette
  const angleOf = (p: number, side: 1 | -1) => -Math.PI / 2 + side * Math.PI * ((p + 0.5) / HALF)
  const shape = (v: number) => Math.pow(v, 1.25)
  const monoDim = pal.mono ? 0.5 : 1

  // Held spectrum as a soft filled halo with a fine contour line.
  const pts: [number, number][] = []
  const holdR = (p: number) => R + 10 * u + ringAmp * 1.08 * shape(specHold[p]!)
  for (let p = 0; p < HALF; p++) pts.push(polar(cx, cy, holdR(p), angleOf(p, 1)))
  for (let p = HALF - 1; p >= 0; p--) pts.push(polar(cx, cy, holdR(p), angleOf(p, -1)))
  ctx.beginPath()
  smoothClosed(ctx, pts)
  ctx.globalCompositeOperation = 'lighter'
  const blob = ctx.createRadialGradient(cx, cy, R, cx, cy, R + ringAmp * 1.2)
  blob.addColorStop(0, css(pal.accent2, 0.0))
  blob.addColorStop(0.5, css(pal.accent2, 0.08 * monoDim))
  blob.addColorStop(1, css(pal.accent, 0.03 * monoDim))
  ctx.fillStyle = blob
  ctx.fill()
  ctx.lineWidth = Math.max(1, 1.6 * u)
  ctx.strokeStyle = css(mixRgb(pal.accent2, [255, 255, 255], 0.25), 0.55)
  ctx.stroke()

  // Radial bars, mirrored left and right: a wide faint pass for glow, then crisp.
  const barW = ((Math.PI * R) / HALF) * 0.42
  const barPath = () => {
    ctx.beginPath()
    for (const side of [1, -1] as const) {
      for (let p = 0; p < HALF; p++) {
        const a = angleOf(p, side)
        const len = 2 * u + ringAmp * shape(specNow[p]!)
        const [x0, y0] = polar(cx, cy, R + 4 * u + barW, a)
        const [x1, y1] = polar(cx, cy, R + 4 * u + barW + len, a)
        ctx.moveTo(x0, y0)
        ctx.lineTo(x1, y1)
      }
    }
  }
  const grad = ctx.createRadialGradient(cx, cy, R, cx, cy, R + ringAmp)
  grad.addColorStop(0, css(mixRgb(pal.accent, [255, 255, 255], 0.35)))
  grad.addColorStop(0.45, css(pal.accent))
  grad.addColorStop(1, css(pal.accent2))
  ctx.lineCap = 'round'
  barPath()
  ctx.strokeStyle = grad
  ctx.globalAlpha = (0.08 + 0.1 * st.bass) * monoDim
  ctx.lineWidth = barW * 3.2
  ctx.stroke()
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.lineWidth = barW
  ctx.stroke()

  // Thin inner circle.
  ctx.lineWidth = Math.max(1, 1.5 * u)
  ctx.strokeStyle = css(mixRgb(pal.accent, [255, 255, 255], 0.5), 0.35)
  ctx.beginPath()
  ctx.arc(cx, cy, R - 2 * u, 0, TAU)
  ctx.stroke()
}

function polar(cx: number, cy: number, r: number, a: number): [number, number] {
  return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]
}

/** Closed Catmull-Rom curve through the points, as cubic Beziers. */
function smoothClosed(ctx: SKRSContext2D, pts: [number, number][]): void {
  const n = pts.length
  ctx.moveTo(pts[0]![0], pts[0]![1])
  for (let k = 0; k < n; k++) {
    const p0 = pts[(k - 1 + n) % n]!
    const p1 = pts[k]!
    const p2 = pts[(k + 1) % n]!
    const p3 = pts[(k + 2) % n]!
    ctx.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1])
  }
  ctx.closePath()
}

// ---------------------------------------------------------------- card

function drawOneCard(ctx: SKRSContext2D, m: SceneModel, slot: Slot, scale: number, alpha: number): void {
  if (alpha <= 0.002) return
  const { cx, cy, card } = m.layout
  const s = card * scale
  const sh = m.shadow
  const k = s / card
  ctx.globalAlpha = alpha
  ctx.drawImage(sh.canvas, cx - (card / 2 + sh.pad) * k, cy - (card / 2 + sh.pad) * k, sh.canvas.width * k, sh.canvas.height * k)
  ctx.drawImage(slot.art.card, cx - s / 2, cy - s / 2, s, s)
  ctx.globalAlpha = 1
}

function hasActiveLayers(slot: Slot, i: number): boolean {
  return slot.layers.length > 0 && slot.layers[0]!.joinFrame <= i
}

/**
 * Cards of a slot fanned out for the centred layout. A layer that came with
 * its base is dealt out once the base's wipe is mostly done; a later one on
 * its own entrance.
 */
function fanState(m: SceneModel, slot: Slot, i: number) {
  const active = activeLayers(slot.layers, i)
  const deal = Math.round(m.crossfadeFrames * 0.5)
  const w = active.map((l) => smooth(l.withBase ? (i - slot.startFrame - deal) / m.joinFrames : layerEntrance(l, i, m.joinFrames)))
  return {
    arts: [slot.art, ...active.map((l) => l.art)],
    poses: fanAt(w),
    alphas: [1, ...w.map((x) => smooth(x * 4))],
  }
}

function drawFanCards(ctx: SKRSContext2D, m: SceneModel, st: FrameState, beat: number): void {
  const sp = { shadow: m.shadow, card: m.layout.card }
  const cur = fanState(m, st.slot, st.i)
  if (!st.prev) {
    drawFan(ctx, m.layout, sp, cur.arts, cur.poses, cur.alphas, beat)
    return
  }
  // Cue change: the old fan folds and fades while the new base is revealed by
  // the same growing circle as a single card, then its layers are dealt out.
  // Same artwork on both sides (an untrusted list shows the set artwork): no wipe.
  const q = st.prev.art === st.slot.art ? 1 : smooth(st.p / 0.8)
  const prevFan = hasActiveLayers(st.prev, st.i)
  const out = smooth(st.p / 0.6)
  const old = fanState(m, st.prev, st.i)
  const shrink = 1 - 0.03 * Math.sin(Math.PI * q)
  const oldPoses: Pose[] = old.poses.map((p) => ({ ...p, s: p.s * (prevFan ? 1 - 0.08 * out : shrink) }))
  const oldAlpha = old.alphas.map((a) => a * (prevFan ? 1 - out : 1))
  drawFan(ctx, m.layout, sp, old.arts, oldPoses, oldAlpha, beat)
  drawFan(ctx, m.layout, sp, cur.arts, cur.poses, cur.alphas, beat, true)
  if (q <= 0) return
  const { cx, cy, card, u } = m.layout
  const P = cur.poses[0]!
  const s = card * P.s * beat * shrink
  ctx.save()
  ctx.translate(cx + P.x * card, cy + P.y * card)
  if (P.rot) ctx.rotate(P.rot)
  if (prevFan) {
    const sh = m.shadow
    const k = s / card
    ctx.globalAlpha = q
    ctx.drawImage(sh.canvas, -(card / 2 + sh.pad) * k, -(card / 2 + sh.pad) * k, sh.canvas.width * k, sh.canvas.height * k)
    ctx.globalAlpha = 1
  }
  ctx.save()
  roundedRectPath(ctx, -s / 2, -s / 2, s, s, s * 0.045)
  ctx.clip()
  ctx.beginPath()
  ctx.arc(0, 0, q * s * 0.72, 0, TAU)
  ctx.clip()
  ctx.drawImage(st.slot.art.card, -s / 2, -s / 2, s, s)
  ctx.restore()
  if (q < 1) {
    roundedRectPath(ctx, -s / 2, -s / 2, s, s, s * 0.045)
    ctx.clip()
    ctx.globalCompositeOperation = 'lighter'
    ctx.strokeStyle = css(mixRgb(st.slot.art.palette.accent, [255, 255, 255], 0.5), 0.85 * Math.sin(Math.PI * q))
    ctx.lineWidth = 3 * u
    ctx.beginPath()
    ctx.arc(0, 0, q * s * 0.72, 0, TAU)
    ctx.stroke()
  }
  ctx.restore()
  ctx.globalCompositeOperation = 'source-over'
}

export function drawCard(ctx: SKRSContext2D, m: SceneModel, st: FrameState): void {
  const beat = 1 + 0.022 * st.pulse * (0.4 + 0.6 * st.bass) + 0.01 * st.bass
  if (m.layout.mode === 'centred' && (hasActiveLayers(st.slot, st.i) || (st.prev && hasActiveLayers(st.prev, st.i)))) {
    drawFanCards(ctx, m, st, beat)
    return
  }
  if (!st.prev || st.prev.art === st.slot.art) {
    drawOneCard(ctx, m, st.slot, beat, 1)
    return
  }
  // Cue change: the new artwork is revealed by a circle growing from the
  // centre of the old one, with a bright rim on the wipe edge.
  const q = smooth(st.p / 0.8)
  drawOneCard(ctx, m, st.prev, beat * (1 - 0.03 * Math.sin(Math.PI * q)), 1)
  if (q <= 0) return
  const { cx, cy, card, u } = m.layout
  const s = card * beat * (1 - 0.03 * Math.sin(Math.PI * q))
  const r = q * s * 0.72
  ctx.save()
  roundedRectPath(ctx, cx - s / 2, cy - s / 2, s, s, s * 0.045)
  ctx.clip()
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, TAU)
  ctx.clip()
  ctx.drawImage(st.slot.art.card, cx - s / 2, cy - s / 2, s, s)
  ctx.restore()
  if (q < 1) {
    ctx.save()
    roundedRectPath(ctx, cx - s / 2, cy - s / 2, s, s, s * 0.045)
    ctx.clip()
    ctx.globalCompositeOperation = 'lighter'
    ctx.strokeStyle = css(mixRgb(st.slot.art.palette.accent, [255, 255, 255], 0.5), 0.85 * Math.sin(Math.PI * q))
    ctx.lineWidth = 3 * u
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, TAU)
    ctx.stroke()
    ctx.restore()
  }
}

// ---------------------------------------------------------------- grain

export function drawGrain(ctx: SKRSContext2D, m: SceneModel, st: FrameState): void {
  const { w, h } = m.layout
  const tile = m.grain[st.i % m.grain.length]!
  const ts = tile.width
  const ox = -(hash32(st.i, 91) % ts)
  const oy = -(hash32(st.i, 92) % ts)
  ctx.globalCompositeOperation = 'overlay'
  ctx.globalAlpha = 0.09
  for (let y = oy; y < h; y += ts) for (let x = ox; x < w; x += ts) ctx.drawImage(tile, x, y)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
}

// ---------------------------------------------------------------- text

function shadowed(ctx: SKRSContext2D, u: number, blur = 14): void {
  ctx.shadowColor = 'rgba(0,0,0,0.45)'
  ctx.shadowBlur = blur * u
  ctx.shadowOffsetY = 2 * u
}

function noShadow(ctx: SKRSContext2D): void {
  ctx.shadowColor = 'rgba(0,0,0,0)'
  ctx.shadowBlur = 0
  ctx.shadowOffsetY = 0
}

function drawTextBlock(ctx: SKRSContext2D, m: SceneModel, slot: Slot, pal: Palette, alpha: number, dy: number, i: number): void {
  const tx = slot.text
  if (!tx || alpha <= 0.002) return
  const { u, text } = m.layout
  const x = text.x
  const titleH = tx.title.size * 1.08 * tx.title.lines.length
  const artistH = tx.artist ? tx.artist.size * 1.3 : 0
  const labelH = 26 * u
  const gap = 18 * u
  const total = labelH + gap + titleH + gap * 0.6 + artistH
  // Layered rows below the base; the whole block stays centred as they grow in.
  const rowsH = slot.plan && slot.layers.length ? rowsLayout(slot.layers, slot.plan, i, m.joinFrames).height : 0
  let y = text.cy - (total + rowsH) / 2 + dy
  const rowsY = y + total
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.globalAlpha = alpha

  // Label with an accent rule.
  ctx.fillStyle = css(pal.accent)
  ctx.fillRect(x, y + labelH * 0.5 - 1.5 * u, 36 * u, 3 * u)
  ctx.font = textFont(600, 20 * u)
  ctx.letterSpacing = `${(3 * u).toFixed(2)}px`
  ctx.fillStyle = css(mixRgb(pal.accent, [255, 255, 255], 0.35), 0.95)
  ctx.fillText(tx.label, x + 52 * u, y + labelH * 0.5 + 7 * u)
  ctx.letterSpacing = '0px'
  y += labelH + gap

  shadowed(ctx, u, 18)
  ctx.font = displayFont(tx.title.size)
  ctx.fillStyle = 'rgb(255,255,255)'
  for (const line of tx.title.lines) {
    y += tx.title.size * 1.08
    ctx.fillText(line, x - tx.title.size * 0.04, y - tx.title.size * 0.2)
  }
  y += gap * 0.6
  if (tx.artist) {
    ctx.font = textFont(500, tx.artist.size)
    ctx.fillStyle = tx.dimArtist ? 'rgba(255,255,255,0.5)' : css(mixRgb(pal.accent, [255, 255, 255], 0.2))
    y += tx.artist.size * 1.15
    ctx.fillText(tx.artist.lines[0] ?? '', x, y)
  }
  noShadow(ctx)
  ctx.globalAlpha = 1
  if (slot.plan && slot.layers.length) drawRows(ctx, m.layout, slot.layers, slot.plan, pal, i, m.joinFrames, rowsY, alpha)
}

export function drawTrackText(ctx: SKRSContext2D, m: SceneModel, st: FrameState): void {
  if (m.layout.mode !== 'split') return
  const u = m.layout.u
  if (st.prev) {
    // Out, then in: overlapping two lines of large type reads as a smear.
    const outP = st.p / 0.38
    if (outP < 1) drawTextBlock(ctx, m, st.prev, st.prev.art.palette, 1 - smooth(outP), -24 * u * smooth(outP), st.i)
    const inP = (st.p - 0.4) / 0.6
    if (inP > 0) drawTextBlock(ctx, m, st.slot, st.slot.art.palette, smooth(inP), 30 * u * (1 - easeOut(inP)), st.i)
  } else {
    drawTextBlock(ctx, m, st.slot, st.palette, 1, 0, st.i)
  }
  drawUpNext(ctx, m, st)
}

function drawUpNext(ctx: SKRSContext2D, m: SceneModel, st: FrameState): void {
  const next = st.slot.text?.next
  if (!next) return
  const { u, text, footer } = m.layout
  const alpha = st.prev ? smooth((st.p - 0.4) / 0.6) : 1
  if (alpha <= 0) return
  const y = footer.timeY - 64 * u
  ctx.globalAlpha = alpha * 0.9
  ctx.textAlign = 'left'
  ctx.font = textFont(600, 15 * u)
  ctx.letterSpacing = `${(2.5 * u).toFixed(2)}px`
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.fillText('UP NEXT', text.x, y)
  const labelW = ctx.measureText('UP NEXT').width
  ctx.letterSpacing = '0px'
  ctx.font = textFont(500, 20 * u)
  ctx.fillStyle = 'rgba(255,255,255,0.82)'
  const avail = text.maxWidth - labelW - 16 * u
  ctx.fillText(ellipsize(ctx, next, avail), text.x + labelW + 16 * u, y)
  ctx.globalAlpha = 1
}

export function drawHeader(ctx: SKRSContext2D, m: SceneModel, st: FrameState): void {
  const { u, header } = m.layout
  const x = header.x
  let y = header.y
  ctx.textAlign = 'left'
  shadowed(ctx, u, 8)
  // Small accent square as a brand mark.
  ctx.fillStyle = css(st.palette.accent)
  roundedRectPath(ctx, x, y + 4 * u, 6 * u, 6 * u + (m.setArtist ? 38 * u : 18 * u), 3 * u)
  ctx.fill()
  const tx = x + 22 * u
  if (m.setTitle.lines[0]) {
    ctx.font = textFont(600, m.setTitle.size)
    ctx.fillStyle = 'rgba(255,255,255,0.95)'
    y += m.setTitle.size
    ctx.fillText(m.setTitle.lines[0], tx, y)
  }
  if (m.setArtist?.lines[0]) {
    ctx.font = textFont(400, m.setArtist.size)
    ctx.fillStyle = 'rgba(255,255,255,0.66)'
    y += m.setArtist.size * 1.45
    ctx.fillText(m.setArtist.lines[0], tx, y)
  }
  noShadow(ctx)
}

export function drawFooter(ctx: SKRSContext2D, m: SceneModel, st: FrameState): void {
  const { u, footer } = m.layout
  const { x0, x1, barY, timeY } = footer
  const pal = st.palette
  const frac = Math.min(1, Math.max(0, st.i / m.totalFrames))
  const px = x0 + (x1 - x0) * frac
  const barH = Math.max(1, 4 * u)

  // Track.
  ctx.fillStyle = 'rgba(255,255,255,0.16)'
  roundedRectPath(ctx, x0, barY - barH / 2, x1 - x0, barH, barH / 2)
  ctx.fill()
  // Played part.
  if (px > x0) {
    const g = ctx.createLinearGradient(x0, 0, px, 0)
    g.addColorStop(0, css(pal.accent2, 0.9))
    g.addColorStop(1, css(pal.accent))
    ctx.fillStyle = g
    roundedRectPath(ctx, x0, barY - barH / 2, px - x0, barH, barH / 2)
    ctx.fill()
  }
  // Cue ticks.
  const tickH = 12 * u
  const tw = Math.max(1, 2 * u)
  for (const cx of m.cueXs) {
    ctx.fillStyle = cx <= px ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.38)'
    ctx.fillRect(Math.round(cx - tw / 2), barY - tickH / 2, tw, tickH)
  }
  // A layered track joining after its base: a small dot on the bar.
  for (const jx of m.joinXs) {
    ctx.fillStyle = jx <= px ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.45)'
    ctx.beginPath()
    ctx.arc(jx, barY, Math.max(1, 3.2 * u), 0, TAU)
    ctx.fill()
  }
  // Playhead.
  const glow = 34 * u * (1 + 0.35 * st.bass)
  ctx.globalCompositeOperation = 'lighter'
  ctx.globalAlpha = 0.55 + 0.3 * st.pulse
  ctx.drawImage(m.dot, px - glow / 2, barY - glow / 2, glow, glow)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = 'rgb(255,255,255)'
  ctx.beginPath()
  ctx.arc(px, barY, 6.5 * u, 0, TAU)
  ctx.fill()

  // Times.
  shadowed(ctx, u, 6)
  ctx.font = textFont(500, 19 * u)
  ctx.fillStyle = 'rgba(255,255,255,0.9)'
  ctx.textAlign = 'left'
  ctx.fillText(formatClock(st.t), x0, timeY)
  ctx.textAlign = 'right'
  ctx.fillStyle = 'rgba(255,255,255,0.6)'
  ctx.fillText(formatClock(m.totalSeconds), x1, timeY)
  ctx.textAlign = 'left'
  noShadow(ctx)
}
