import { createCanvas, type Canvas, type Image, type SKRSContext2D } from '@napi-rs/canvas'
import type { ArtAssets } from './assets.js'
import { roundedRectPath } from './assets.js'
import { displayFont, textFont } from './fonts.js'
import type { Layout } from './layout.js'
import { css, mixRgb, type Palette, type RGB } from './palette.js'
import { fitText, type FitResult, type Measurer } from './text.js'

/**
 * Layered ("w/") tracks: tracks that play on top of a base track.
 *
 * Split layout: the base track keeps the artwork card in the ring and the
 * large title; each layered track gets a row under it, introduced by 'w/',
 * with a thumbnail, title and artist. Centred layout (no names): the
 * artworks are fanned inside the ring, base card in front.
 *
 * A layered track that starts with its base arrives in the base's cue
 * transition; one that joins later animates in on its own over JOIN_SECONDS
 * while the block around it re-centres. Everything leaves at the next base cue.
 */

/** Seconds a later-joining layered track takes to animate in. */
export const JOIN_SECONDS = 0.9

/** Rows shown before the rest collapse into '+k more'. */
export const MAX_ROWS = 3

export interface RowText {
  title: FitResult
  artist: FitResult
  dimTitle: boolean
  dimArtist: boolean
}

export interface RowStyle {
  thumb: number
  /** Width of the 'w/' gutter left of the thumbnail. */
  gutter: number
  /** Space between the thumbnail and the text. */
  pad: number
  /** Space between rows. */
  gap: number
  /** Space between the base block and the first row. */
  sep: number
  moreH: number
  titleMax: number
  titleMin: number
  artistMax: number
  artistMin: number
}

export interface LayerSlot {
  /** Index into the input track list. */
  index: number
  joinFrame: number
  /** Joins on its base's cue frame: arrives in the cue transition. */
  withBase: boolean
  art: ArtAssets
  /** Rounded thumbnail with its shadow baked in, `pad` px of margin per side. */
  thumb: { canvas: Canvas; pad: number } | null
  /** Its accent may tint the ring (not for greyscale or generated artwork). */
  tints: boolean
  row: RowText | null
}

export interface BlockPlan {
  baseTitle: FitResult
  style: RowStyle
  /** Rows drawn before the rest collapse into '+k more'. */
  maxRows: number
}

export interface BaseTextSizes {
  labelH: number
  gap: number
  artistSize: number
}

function style(u: number, compact: boolean): RowStyle {
  return compact
    ? { thumb: 64 * u, gutter: 46 * u, pad: 18 * u, gap: 12 * u, sep: 30 * u, moreH: 38 * u, titleMax: 30 * u, titleMin: 22 * u, artistMax: 22 * u, artistMin: 17 * u }
    : { thumb: 84 * u, gutter: 52 * u, pad: 22 * u, gap: 18 * u, sep: 40 * u, moreH: 44 * u, titleMax: 36 * u, titleMin: 26 * u, artistMax: 26 * u, artistMin: 20 * u }
}

export function rowTextWidth(layout: Layout, st: RowStyle): number {
  return Math.max(10, layout.text.maxWidth - st.gutter - st.thumb - st.pad)
}

/** Title and artist of one row, shrunk then ellipsized to the row width. */
export function fitRow(m: Measurer, layout: Layout, st: RowStyle, artist: string | null, title: string | null): RowText {
  const w = rowTextWidth(layout, st)
  const unnamed = !artist && !title
  return {
    title: fitText(m, title ?? 'ID', { maxWidth: w, maxSize: st.titleMax, minSize: Math.max(4, st.titleMin), font: (px) => textFont(600, px) }),
    artist: fitText(m, artist ?? (unnamed ? 'Unidentified' : 'ID'), { maxWidth: w, maxSize: st.artistMax, minSize: Math.max(4, st.artistMin), font: (px) => textFont(500, px) }),
    dimTitle: !title,
    dimArtist: !artist,
  }
}

export function rowHeight(st: RowStyle): number {
  return st.thumb
}

/** Height of the base block (label, title, artist) as drawTextBlock lays it out. */
export function baseBlockHeight(title: FitResult, artistSize: number, u: number): number {
  const labelH = 26 * u
  const gap = 18 * u
  return labelH + gap + title.size * 1.08 * title.lines.length + gap * 0.6 + artistSize * 1.3
}

/** Height the rows add once every layer has joined. */
export function rowsHeight(st: RowStyle, layers: number, maxRows: number): number {
  if (layers <= 0) return 0
  const shown = Math.min(layers, maxRows)
  let h = st.sep + shown * rowHeight(st) + (shown - 1) * st.gap
  if (layers > maxRows) h += st.gap + st.moreH
  return h
}

/** Vertical room for the whole text block, centred on the ring's centre line. */
export function blockBudget(layout: Layout): number {
  const { u, text, footer } = layout
  const top = 170 * u
  const bottom = footer.timeY - 64 * u - 52 * u
  return 2 * Math.max(0, Math.min(text.cy - top, bottom - text.cy))
}

/**
 * Sizes for a base track with `layers` layered tracks, fixed for the whole
 * slot so nothing resizes when a layer joins. In order, until everything
 * fits: the base title drops to one line, rows go compact, the base title
 * shrinks further, and finally rows collapse into '+k more'.
 */
export function planBlock(m: Measurer, layout: Layout, baseTitle: string, artistSize: number, layers: number): BlockPlan {
  const u = layout.u
  const budget = blockBudget(layout)
  const tw = layout.text.maxWidth
  const title = (maxLines: number, maxSize: number) =>
    fitText(m, baseTitle, { maxWidth: tw, maxSize, minSize: Math.max(6, Math.min(maxSize, 50 * u)), maxLines, lineHeight: 1.08, font: displayFont })
  const attempts: [number, number, boolean][] = [
    [2, 92 * u, false],
    [1, 92 * u, false],
    [1, 92 * u, true],
    [1, 72 * u, true],
    [1, 60 * u, true],
  ]
  let last: BlockPlan | null = null
  for (const [lines, size, compact] of attempts) {
    const st = style(u, compact)
    const t = title(lines, size)
    last = { baseTitle: t, style: st, maxRows: MAX_ROWS }
    if (baseBlockHeight(t, artistSize, u) + rowsHeight(st, layers, MAX_ROWS) <= budget) return last
  }
  // Still too tall: fewer rows, the rest summarised.
  const plan = last!
  const baseH = baseBlockHeight(plan.baseTitle, artistSize, u)
  let rows = MAX_ROWS
  while (rows > 1 && baseH + rowsHeight(plan.style, layers, rows) > budget) rows--
  plan.maxRows = rows
  return plan
}

// ---------------------------------------------------------------- assets

export function buildThumb(card: Canvas | Image, size: number): { canvas: Canvas; pad: number } {
  const s = Math.max(4, Math.round(size))
  const pad = Math.round(s * 0.3)
  const c = createCanvas(s + pad * 2, s + pad * 2)
  const ctx = c.getContext('2d')
  ctx.shadowColor = 'rgba(0,0,0,0.6)'
  ctx.shadowBlur = s * 0.18
  ctx.shadowOffsetY = s * 0.05
  ctx.fillStyle = 'rgb(0,0,0)'
  roundedRectPath(ctx, pad, pad, s, s, s * 0.08)
  ctx.fill()
  ctx.shadowColor = 'rgba(0,0,0,0)'
  ctx.shadowBlur = 0
  ctx.shadowOffsetY = 0
  ctx.save()
  roundedRectPath(ctx, pad, pad, s, s, s * 0.08)
  ctx.clip()
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(card, pad, pad, s, s)
  ctx.restore()
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'
  ctx.lineWidth = Math.max(1, s / 90)
  roundedRectPath(ctx, pad + ctx.lineWidth / 2, pad + ctx.lineWidth / 2, s - ctx.lineWidth, s - ctx.lineWidth, s * 0.08)
  ctx.stroke()
  return { canvas: c, pad }
}

// ---------------------------------------------------------------- timing

export function smooth(x: number): number {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

function easeOut(x: number): number {
  const t = Math.min(1, Math.max(0, x))
  return 1 - (1 - t) ** 3
}

/** Entrance progress 0..1 of a layer at frame i; 1 for a layer that came with its base. */
export function layerEntrance(l: LayerSlot, i: number, joinFrames: number): number {
  if (i < l.joinFrame) return 0
  if (l.withBase) return 1
  return Math.min(1, (i - l.joinFrame) / joinFrames)
}

/** Layers on screen at frame i, in join order. */
export function activeLayers(layers: readonly LayerSlot[], i: number): LayerSlot[] {
  let n = 0
  while (n < layers.length && layers[n]!.joinFrame <= i) n++
  return n === layers.length ? (layers as LayerSlot[]) : layers.slice(0, n)
}

/**
 * The base palette with the ring's second colour leaning towards the layered
 * tracks' accents, eased in with each entrance so a join never jumps.
 * Returns the base palette itself when nothing tints it.
 */
export function layeredPalette(base: Palette, layers: readonly LayerSlot[], i: number, joinFrames: number): Palette {
  let w = 0
  let acc: RGB = [0, 0, 0]
  for (const l of layers) {
    if (!l.tints || l.joinFrame > i) continue
    const e = smooth(layerEntrance(l, i, joinFrames))
    if (e <= 0) continue
    acc = [acc[0] + l.art.palette.accent[0] * e, acc[1] + l.art.palette.accent[1] * e, acc[2] + l.art.palette.accent[2] * e]
    w += e
  }
  if (w <= 0) return base
  const target: RGB = [acc[0] / w, acc[1] / w, acc[2] / w]
  return { ...base, accent2: mixRgb(base.accent2, target, 0.6 * Math.min(1, w)) }
}

// ---------------------------------------------------------------- rows

function shadowed(ctx: SKRSContext2D, u: number, blur: number): void {
  ctx.shadowColor = 'rgba(0,0,0,0.45)'
  ctx.shadowBlur = blur * u
  ctx.shadowOffsetY = 2 * u
}

function noShadow(ctx: SKRSContext2D): void {
  ctx.shadowColor = 'rgba(0,0,0,0)'
  ctx.shadowBlur = 0
  ctx.shadowOffsetY = 0
}

/**
 * Current height the rows add (animated) and what to draw: rows beyond
 * maxRows fold into one '+k more' row that enters with the first of them.
 */
export function rowsLayout(layers: readonly LayerSlot[], plan: BlockPlan, i: number, joinFrames: number) {
  const st = plan.style
  const active = activeLayers(layers, i)
  const shown = active.slice(0, plan.maxRows)
  const hidden = active.slice(plan.maxRows)
  const grow = (l: LayerSlot) => smooth(layerEntrance(l, i, joinFrames))
  let h = 0
  shown.forEach((l, k) => (h += ((k === 0 ? st.sep : st.gap) + rowHeight(st)) * grow(l)))
  const moreE = hidden.length ? grow(hidden[0]!) : 0
  if (hidden.length) h += (st.gap + st.moreH) * moreE
  return { shown, hidden, height: h, moreE }
}

export function drawRows(
  ctx: SKRSContext2D,
  layout: Layout,
  layers: readonly LayerSlot[],
  plan: BlockPlan,
  basePal: Palette,
  i: number,
  joinFrames: number,
  y0: number,
  alpha: number,
): void {
  const { u } = layout
  const st = plan.style
  const x = layout.text.x
  const { shown, hidden, moreE } = rowsLayout(layers, plan, i, joinFrames)
  let y = y0
  shown.forEach((l, k) => {
    const e = layerEntrance(l, i, joinFrames)
    const g = smooth(e)
    y += (k === 0 ? st.sep : st.gap) * g
    const a = alpha * smooth((e - 0.3) / 0.7)
    if (a > 0.002 && l.row) drawRow(ctx, u, x, y, st, l, basePal, a, 26 * u * (1 - easeOut((e - 0.3) / 0.7)), 0.86 + 0.14 * easeOut(e / 0.8))
    y += rowHeight(st) * g
  })
  if (hidden.length) {
    y += st.gap * smooth(moreE)
    const a = alpha * smooth((moreE - 0.3) / 0.7)
    if (a > 0.002) drawMore(ctx, u, x, y, st, hidden, i, joinFrames, a)
  }
}

function drawRow(ctx: SKRSContext2D, u: number, x: number, y: number, st: RowStyle, l: LayerSlot, basePal: Palette, alpha: number, dx: number, scale: number): void {
  const row = l.row!
  const th = st.thumb
  const pal = l.art.palette
  ctx.globalAlpha = alpha
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'

  // 'w/' in the gutter, on the thumbnail's centre line.
  const mid = y + th / 2
  ctx.font = displayFont(th * 0.34)
  ctx.fillStyle = css(mixRgb(basePal.accent, [255, 255, 255], 0.3), 0.9)
  shadowed(ctx, u, 8)
  ctx.fillText('w/', x + dx * 0.5, mid + th * 0.12)
  noShadow(ctx)

  if (l.thumb) {
    const t = l.thumb
    const k = (th * scale) / (t.canvas.width - t.pad * 2)
    const s = t.canvas.width * k
    const tx = x + st.gutter + dx + th / 2
    ctx.drawImage(t.canvas, tx - s / 2, mid - s / 2, s, s)
  }

  const tx = x + st.gutter + th + st.pad + dx
  const ts = row.title.size
  const as = row.artist.size
  const lineGap = 6 * u
  const contentH = ts * 0.74 + lineGap + as * 0.95
  const top = mid - contentH / 2
  shadowed(ctx, u, 12)
  ctx.font = textFont(600, ts)
  ctx.fillStyle = row.dimTitle ? 'rgba(255,255,255,0.72)' : 'rgb(255,255,255)'
  ctx.fillText(row.title.lines[0] ?? '', tx, top + ts * 0.74)
  ctx.font = textFont(500, as)
  ctx.fillStyle = row.dimArtist ? 'rgba(255,255,255,0.5)' : css(mixRgb(pal.accent, [255, 255, 255], 0.2))
  ctx.fillText(row.artist.lines[0] ?? '', tx, top + ts * 0.74 + lineGap + as * 0.95)
  noShadow(ctx)
  ctx.globalAlpha = 1
}

function drawMore(ctx: SKRSContext2D, u: number, x: number, y: number, st: RowStyle, hidden: readonly LayerSlot[], i: number, joinFrames: number, alpha: number): void {
  const mh = st.moreH
  const mini = mh * 0.82
  const mid = y + mh / 2
  let mx = x + st.gutter
  // Up to four overlapping mini thumbnails, then the count.
  const list = hidden.slice(0, 4)
  list.forEach((l, k) => {
    const a = alpha * (k === 0 ? 1 : smooth(layerEntrance(l, i, joinFrames) / 0.6))
    if (!l.thumb || a <= 0.002) return
    const t = l.thumb
    const kk = mini / (t.canvas.width - t.pad * 2)
    const s = t.canvas.width * kk
    ctx.globalAlpha = a
    ctx.drawImage(t.canvas, mx + k * mini * 0.62 + mini / 2 - s / 2, mid - s / 2, s, s)
  })
  mx += (list.length - 1) * mini * 0.62 + mini + st.pad * 0.8
  ctx.globalAlpha = alpha
  ctx.textAlign = 'left'
  ctx.font = textFont(600, mh * 0.5)
  ctx.letterSpacing = `${(1 * u).toFixed(2)}px`
  ctx.fillStyle = 'rgba(255,255,255,0.74)'
  shadowed(ctx, u, 8)
  ctx.fillText(`+${hidden.length} more`, mx, mid + mh * 0.18)
  noShadow(ctx)
  ctx.letterSpacing = '0px'
  ctx.globalAlpha = 1
}

// ---------------------------------------------------------------- fan (centred layout)

export interface Pose {
  x: number
  y: number
  s: number
  rot: number
}

const DEG = Math.PI / 180

/**
 * Card poses for a base plus m layered cards, in units of the card size and
 * relative to the ring's centre. The base sits in front; layers alternate
 * right and left of it, each tilted away and slightly lower, like a hand of
 * cards. Index 0 is the base, then layers in join order.
 */
export function fanPoses(m: number): Pose[] {
  if (m <= 0) return [{ x: 0, y: 0, s: 1, rot: 0 }]
  const cached = fanCache.get(m)
  if (cached) return cached.map((p) => ({ ...p }))
  const n = m + 1
  const sl = 0.82
  // Slot order left to right: ..., L4, L2, B, L1, L3, ...
  const right = Math.ceil(m / 2)
  const baseSlot = m - right
  // Each layer shows well over half of its artwork beside its neighbour.
  const dx = sl * (m === 1 ? 0.78 : 0.66)
  const centre = (n - 1) / 2
  const out: Pose[] = []
  const at = (slot: number, s: number): Pose => {
    const d = slot - baseSlot
    return { x: (slot - centre) * dx, y: 0.06 * d * d, s, rot: d * 8 * DEG }
  }
  out.push(at(baseSlot, 1))
  for (let k = 1; k <= m; k++) {
    const side = k % 2 === 1 ? 1 : -1
    out.push(at(baseSlot + side * Math.ceil(k / 2), sl))
  }
  // Centre the bounding box on the ring, then scale the fan so every corner
  // stays inside the ring's inner circle.
  const corners = (p: Pose) =>
    [-1, 1].flatMap((sx) =>
      [-1, 1].map((sy) => {
        const hx = (sx * p.s) / 2
        const hy = (sy * p.s) / 2
        return [p.x + hx * Math.cos(p.rot) - hy * Math.sin(p.rot), p.y + hx * Math.sin(p.rot) + hy * Math.cos(p.rot)] as const
      }),
    )
  const all = out.flatMap(corners)
  const midX = (Math.min(...all.map((c) => c[0])) + Math.max(...all.map((c) => c[0]))) / 2
  const midY = (Math.min(...all.map((c) => c[1])) + Math.max(...all.map((c) => c[1]))) / 2
  const reach = Math.max(...all.map((c) => Math.hypot(c[0] - midX, c[1] - midY)))
  const f = Math.min(1, FAN_REACH / reach)
  for (const p of out) {
    p.x = (p.x - midX) * f
    p.y = (p.y - midY) * f
    p.s *= f
  }
  fanCache.set(m, out)
  return out.map((p) => ({ ...p }))
}

/** Furthest a fanned card corner may reach from the ring centre, in card sizes. */
const FAN_REACH = 0.72
const fanCache = new Map<number, Pose[]>()

function lerpPose(a: Pose, b: Pose, t: number): Pose {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, s: a.s + (b.s - a.s) * t, rot: a.rot + (b.rot - a.rot) * t }
}

/**
 * Poses of the base and each active layer for entrance weights w (in join
 * order): every entrance moves the fan from the layout with k-1 layers to
 * the one with k, and the new card slides out from behind the base.
 */
export function fanAt(weights: readonly number[]): Pose[] {
  const poses: Pose[] = [fanPoses(0)[0]!]
  weights.forEach((w, j) => {
    const target = fanPoses(j + 1)
    for (let c = 0; c < poses.length; c++) poses[c] = lerpPose(poses[c]!, target[c]!, w)
    const from = { ...poses[0]!, s: poses[0]!.s * 0.96 }
    poses.push(lerpPose(from, target[j + 1]!, w))
  })
  return poses
}

export interface CardSprites {
  shadow: { canvas: Canvas; pad: number }
  card: number
}

export function drawPosedCard(ctx: SKRSContext2D, layout: Layout, sp: CardSprites, art: ArtAssets, p: Pose, beat: number, alpha: number): void {
  if (alpha <= 0.002) return
  const { cx, cy } = layout
  const C = sp.card
  const s = C * p.s * beat
  const k = s / C
  const sh = sp.shadow
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(cx + p.x * C, cy + p.y * C)
  if (p.rot) ctx.rotate(p.rot)
  ctx.drawImage(sh.canvas, -(C / 2 + sh.pad) * k, -(C / 2 + sh.pad) * k, sh.canvas.width * k, sh.canvas.height * k)
  ctx.drawImage(art.card, -s / 2, -s / 2, s, s)
  ctx.restore()
}

/** Draws a fan: layers furthest from the base first, the base last (in front). */
export function drawFan(ctx: SKRSContext2D, layout: Layout, sp: CardSprites, arts: readonly ArtAssets[], poses: readonly Pose[], alphas: readonly number[], beat: number, skipBase = false): void {
  const order = poses.map((_, k) => k).slice(1)
  order.sort((a, b) => Math.abs(poses[b]!.x - poses[0]!.x) - Math.abs(poses[a]!.x - poses[0]!.x) || b - a)
  for (const k of order) drawPosedCard(ctx, layout, sp, arts[k]!, poses[k]!, beat, alphas[k]!)
  if (!skipBase) drawPosedCard(ctx, layout, sp, arts[0]!, poses[0]!, beat, alphas[0]!)
}

