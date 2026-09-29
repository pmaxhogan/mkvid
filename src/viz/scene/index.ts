import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas'
import type { AnalysisData, Scene, VizInput } from '../types.js'
import type { Image } from '@napi-rs/canvas'
import { buildArtAssets, buildCardShadow, generatedArtwork, tryLoadImage, type ArtAssets } from './assets.js'
import { groupTracks, hasTrackNames, slotAt } from './cues.js'
import { Features } from './features.js'
import { displayFont, registerFonts, textFont } from './fonts.js'
import { computeLayout, type Layout } from './layout.js'
import { buildThumb, fitRow, JOIN_SECONDS, layeredPalette, planBlock, type BlockPlan, type LayerSlot } from './layers.js'
import { mixPalette, type Palette } from './palette.js'
import { buildOverlay, buildGrain, buildDotSprite, buildBokehSprite } from './prerender.js'
import { fitText, type FitResult } from './text.js'
import { drawBackground, drawCard, drawFooter, drawGrain, drawHeader, drawParticles, drawRing, drawTrackText, smooth, type FrameState } from './draw.js'

export { fitText, ellipsize } from './text.js'
export { cueFrame, slotAt, trackIndexAt, formatClock, hasTrackNames, groupTracks, activeTracksAt, type TrackGroup, type GroupLayer } from './cues.js'
export { extractPalette, contrastRatio } from './palette.js'
export { computeLayout } from './layout.js'
export { planBlock, fitRow, blockBudget, baseBlockHeight, rowsHeight, rowTextWidth, fanPoses, fanAt, MAX_ROWS, JOIN_SECONDS } from './layers.js'

/** Seconds a cue change takes to cross-fade. */
export const CROSSFADE_SECONDS = 1.1

export interface TrackText {
  label: string
  title: FitResult
  artist: FitResult | null
  /** The artist line is a placeholder ('Unidentified' or 'ID'), drawn quieter. */
  dimArtist: boolean
  next: string | null
}

/** One stretch of the video with a single artwork and (optionally) one text block. */
export interface Slot {
  startFrame: number
  art: ArtAssets
  text: TrackText | null
  /** Per-slot seed so every track's background drifts differently. */
  seed: number
  /** Layered tracks on top of this slot's base track, in join order. */
  layers: LayerSlot[]
  /** Text sizes for the base plus its rows; null without layers or names. */
  plan: BlockPlan | null
}

export interface SceneModel {
  input: VizInput
  layout: Layout
  features: Features
  slots: Slot[]
  starts: Int32Array
  totalFrames: number
  totalSeconds: number
  cueXs: number[]
  /** Timeline marks where a layered track joins after its base started. */
  joinXs: number[]
  crossfadeFrames: number
  joinFrames: number
  setTitle: FitResult
  setArtist: FitResult | null
  shadow: { canvas: Canvas; pad: number }
  overlay: Canvas
  grain: Canvas[]
  dot: Canvas
  bokeh: Canvas
}

function displayName(v: string | null): string | null {
  const s = v?.replace(/\s+/g, ' ').trim()
  return s ? s : null
}

function trackLine(artist: string | null, title: string | null): string {
  const a = displayName(artist)
  const t = displayName(title)
  if (!a && !t) return 'ID'
  return `${a ?? 'ID'} — ${t ?? 'ID'}`
}

export async function createScene(input: VizInput, analysis: AnalysisData): Promise<Scene> {
  registerFonts()
  const model = await buildModel(input, analysis)
  const canvas = createCanvas(input.width, input.height)
  const ctx = canvas.getContext('2d')
  let disposed = false
  return {
    drawFrame(frameIndex: number) {
      if (disposed) throw new Error('scene disposed')
      renderFrame(ctx, model, Math.max(0, Math.floor(frameIndex)))
      return canvas.data()
    },
    dispose() {
      disposed = true
      model.slots.length = 0
    },
  }
}

async function buildModel(input: VizInput, analysis: AnalysisData): Promise<SceneModel> {
  const W = Math.max(2, Math.round(input.width))
  const H = Math.max(2, Math.round(input.height))
  const fps = input.fps > 0 ? input.fps : 30
  const tracks = input.tracks ?? []
  // Base tracks and the layered ("w/") tracks on top of them, sorted by base start.
  const groups = groupTracks(tracks, fps)
  const withText = hasTrackNames(tracks)
  const layout = computeLayout(W, H, withText)
  const features = new Features(analysis, fps)

  // Artwork: decode each distinct file once; anything unreadable falls back to the set artwork.
  const setImage = await tryLoadImage(input.setArtworkPath)
  const setArt = buildArtAssets('set', setImage ?? generatedArtwork(input.setTitle + (input.setArtist ?? '')), layout.card)
  const arts = new Map<string, ArtAssets>()
  const loaded = new Map<string, Image | null>()
  for (const g of groups) {
    for (const idx of [g.base, ...g.layers.map((l) => l.index)]) {
      const t = tracks[idx]!
      if (!t.artworkPath || arts.has(t.artworkPath)) continue
      const img = await tryLoadImage(t.artworkPath)
      loaded.set(t.artworkPath, img)
      arts.set(t.artworkPath, img ? buildArtAssets(t.artworkPath, img, layout.card) : setArt)
    }
  }

  const measure = createCanvas(8, 8).getContext('2d')
  const u = layout.u
  const tw = layout.text.maxWidth
  const joinFrames = Math.max(1, Math.round(JOIN_SECONDS * fps))

  const slots: Slot[] = []
  const firstCue = groups.length ? groups[0]!.startFrame : 0
  if (groups.length === 0 || firstCue > 0) slots.push({ startFrame: 0, art: setArt, text: null, seed: 7, layers: [], plan: null })
  groups.forEach((g, k) => {
    const t = tracks[g.base]!
    const artist = displayName(t.artist)
    const title = displayName(t.title)
    const unnamed = !artist && !title
    // A track's own artwork whenever it has one (an untrusted list loses its
    // names but keeps real artwork); the set artwork only as the fallback.
    const art = (t.artworkPath && arts.get(t.artworkPath)) || setArt
    let text: TrackText | null = null
    let plan: BlockPlan | null = null
    if (withText) {
      const next = groups[k + 1] ? tracks[groups[k + 1]!.base]! : undefined
      const artistFit = fitText(measure, artist ?? (unnamed ? 'Unidentified' : 'ID'), {
        maxWidth: tw,
        maxSize: 44 * u,
        minSize: Math.max(5, 30 * u),
        font: (px) => textFont(500, px),
      })
      if (g.layers.length) plan = planBlock(measure, layout, title ?? 'ID', artistFit.size, g.layers.length)
      text = {
        label: `TRACK ${String(k + 1).padStart(2, '0')} / ${String(groups.length).padStart(2, '0')}`,
        title:
          plan?.baseTitle ??
          fitText(measure, title ?? 'ID', {
            maxWidth: tw,
            maxSize: 92 * u,
            minSize: Math.max(6, 50 * u),
            maxLines: 2,
            lineHeight: 1.08,
            font: displayFont,
          }),
        artist: artistFit,
        dimArtist: !artist,
        next: next ? trackLine(next.artist, next.title) : null,
      }
    }
    const layers: LayerSlot[] = g.layers.map((l) => {
      const lt = tracks[l.index]!
      const img = lt.artworkPath ? (loaded.get(lt.artworkPath) ?? null) : null
      // A layered track shows its own artwork even without names (an untrusted
      // list keeps real artwork); without any, a generated card stands in so
      // it is never mistaken for the set artwork.
      const lart = img ? arts.get(lt.artworkPath!)! : buildArtAssets(`gen:${l.index}`, generatedArtwork(`layer:${l.index}:${lt.title ?? ''}:${lt.artist ?? ''}`), layout.card)
      const la = displayName(lt.artist)
      const ltitle = displayName(lt.title)
      return {
        index: l.index,
        joinFrame: l.joinFrame,
        withBase: l.joinFrame === g.startFrame,
        art: lart,
        thumb: plan ? buildThumb(lart.card, plan.style.thumb) : null,
        tints: !!img && !lart.palette.mono,
        row: plan ? fitRow(measure, layout, plan.style, la, ltitle) : null,
      }
    })
    const start = g.startFrame
    // Two cues on the same frame: the later one wins.
    if (slots.length && slots[slots.length - 1]!.startFrame === start) slots.pop()
    slots.push({ startFrame: start, art, text, seed: k + 11, layers, plan })
  })

  const totalFrames = Math.max(1, Math.round((input.durationSeconds > 0 ? input.durationSeconds : features.frames / fps) * fps))
  const totalSeconds = totalFrames / fps
  const { x0, x1 } = layout.footer
  const xAt = (sec: number) => x0 + (x1 - x0) * Math.min(1, Math.max(0, sec / totalSeconds))
  const cueXs = groups.map((g) => xAt(tracks[g.base]!.startSeconds))
  // One dot for joins too close to tell apart on the bar.
  const joinXs: number[] = []
  for (const g of groups)
    for (const l of g.layers) {
      if (l.joinFrame <= g.startFrame) continue
      const x = xAt(l.joinFrame / fps)
      if (!joinXs.length || x - joinXs[joinXs.length - 1]! > 8 * u) joinXs.push(x)
    }

  const setTitle = fitText(measure, displayName(input.setTitle) ?? '', {
    maxWidth: layout.header.maxWidth,
    maxSize: 30 * u,
    minSize: Math.max(5, 24 * u),
    font: (px) => textFont(600, px),
  })
  const setArtistName = displayName(input.setArtist)
  const setArtist = setArtistName
    ? fitText(measure, setArtistName, {
        maxWidth: layout.header.maxWidth,
        maxSize: 22 * u,
        minSize: Math.max(5, 18 * u),
        font: (px) => textFont(400, px),
      })
    : null

  return {
    input,
    layout,
    features,
    slots,
    starts: Int32Array.from(slots.map((s) => s.startFrame)),
    totalFrames,
    totalSeconds,
    cueXs,
    joinXs,
    crossfadeFrames: Math.max(1, Math.round(CROSSFADE_SECONDS * fps)),
    joinFrames,
    setTitle,
    setArtist,
    shadow: buildCardShadow(layout.card),
    overlay: buildOverlay(layout),
    grain: buildGrain(layout, 4),
    dot: buildDotSprite(Math.max(8, Math.round(48 * u))),
    bokeh: buildBokehSprite(Math.max(8, Math.round(128 * u))),
  }
}

function renderFrame(ctx: SKRSContext2D, m: SceneModel, i: number): void {
  const s = Math.max(0, slotAt(m.starts, i))
  const slot = m.slots[s]!
  const since = i - slot.startFrame
  const p = s > 0 ? Math.min(1, since / m.crossfadeFrames) : 1
  const prev = p < 1 ? m.slots[s - 1]! : null
  // The base track drives colour; layered tracks only lean the ring's second colour.
  const pal = (x: Slot) => (x.layers.length ? layeredPalette(x.art.palette, x.layers, i, m.joinFrames) : x.art.palette)
  const palette: Palette = prev ? mixPalette(pal(prev), pal(slot), smooth(p)) : pal(slot)
  const fps = m.input.fps > 0 ? m.input.fps : 30
  const f = m.features
  const state: FrameState = {
    i,
    t: i / fps,
    fps,
    slot,
    slotIndex: s,
    prev,
    p,
    palette,
    energy: f.level(i),
    energySlow: f.levelSlow(i),
    bass: f.bassDrive(i),
    pulse: f.pulse(i),
  }
  // Opaque base first: canvas.data() is premultiplied, which equals straight
  // RGBA only while every pixel stays at alpha 255.
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  drawBackground(ctx, m, state)
  drawParticles(ctx, m, state)
  drawRing(ctx, m, state)
  drawCard(ctx, m, state)
  ctx.drawImage(m.overlay, 0, 0)
  drawGrain(ctx, m, state)
  drawTrackText(ctx, m, state)
  drawHeader(ctx, m, state)
  drawFooter(ctx, m, state)
}
