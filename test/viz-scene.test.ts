import { describe, expect, it } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createScene,
  cueFrame,
  extractPalette,
  contrastRatio,
  fitText,
  ellipsize,
  formatClock,
  slotAt,
  trackIndexAt,
  groupTracks,
  activeTracksAt,
  computeLayout,
  planBlock,
  fitRow,
  blockBudget,
  baseBlockHeight,
  rowsHeight,
  rowTextWidth,
  fanPoses,
  MAX_ROWS,
} from '../src/viz/scene/index.js'
import { displayFont, registerFonts, textFont } from '../src/viz/scene/fonts.js'
import type { AnalysisData, VizInput, VizTrack } from '../src/viz/types.js'

const W = 320
const H = 180
const FPS = 30

/** Small deterministic analysis, independent of analysis.ts. */
function analysis(seconds: number, bands = 16): AnalysisData {
  const frameCount = Math.ceil(seconds * FPS) + 1
  const spectrum = new Float32Array(frameCount * bands)
  const energy = new Float32Array(frameCount)
  const bass = new Float32Array(frameCount)
  const onset = new Float32Array(frameCount)
  for (let i = 0; i < frameCount; i++) {
    const t = i / FPS
    const beat = (t * 2) % 1
    onset[i] = Math.exp(-beat * 5)
    energy[i] = 0.6 + 0.3 * Math.sin(t / 3)
    bass[i] = 0.5 + 0.45 * onset[i]!
    for (let b = 0; b < bands; b++) spectrum[i * bands + b] = 0.5 + 0.4 * Math.sin(t * 3 + b * 0.7)
  }
  return { fps: FPS, frameCount, bands, spectrum, energy, bass, onset }
}

/** Writes a tiny PNG with two colour blocks so the palette has something to find. */
function fixtureImage(dir: string, name: string, a: string, b: string): string {
  const c = createCanvas(64, 64)
  const ctx = c.getContext('2d')
  ctx.fillStyle = a
  ctx.fillRect(0, 0, 64, 64)
  ctx.fillStyle = b
  ctx.fillRect(16, 16, 32, 32)
  const file = path.join(dir, name)
  writeFileSync(file, c.toBuffer('image/png'))
  return file
}

const dir = mkdtempSync(path.join(tmpdir(), 'viz-scene-'))
const artA = fixtureImage(dir, 'a.png', '#1b2a6b', '#ff4fa0')
const artB = fixtureImage(dir, 'b.png', '#f4f1ea', '#2f8f5b')

function input(tracks: VizTrack[], over: Partial<VizInput> = {}): VizInput {
  return {
    audioPath: 'unused',
    durationSeconds: 20,
    setTitle: 'Test Set',
    setArtist: 'Test DJ',
    setArtworkPath: artA,
    tracks,
    width: W,
    height: H,
    fps: FPS,
    ...over,
  }
}

const TRACKS: VizTrack[] = [
  { startSeconds: 0, artist: 'Alpha', title: 'First', artworkPath: artA },
  { startSeconds: 5, artist: 'Beta', title: 'Second', artworkPath: artB },
  { startSeconds: 10, artist: null, title: null, artworkPath: null },
  { startSeconds: 15, artist: 'Gamma', title: '夜に駆ける', artworkPath: path.join(dir, 'missing.jpg') },
]

const copy = (b: Uint8Array) => Buffer.from(b)

describe('scene determinism', () => {
  it('draws the same bytes for a frame regardless of order and instance', async () => {
    const a = analysis(20)
    const s1 = await createScene(input(TRACKS), a)
    const s2 = await createScene(input(TRACKS), a)
    const frames = [0, 149, 150, 155, 163, 301, 450, 599]
    const forward = frames.map((f) => copy(s1.drawFrame(f)))
    const again = frames.map((f) => copy(s1.drawFrame(f)))
    const reversed = [...frames].reverse().map((f) => copy(s2.drawFrame(f))).reverse()
    for (let k = 0; k < frames.length; k++) {
      expect(again[k]!.equals(forward[k]!)).toBe(true)
      expect(reversed[k]!.equals(forward[k]!)).toBe(true)
    }
    // Different frames really differ (the scene is animated).
    expect(forward[0]!.equals(forward[1]!)).toBe(false)
    s1.dispose()
    s2.dispose()
  }, 60_000)

  it('returns width*height*4 opaque RGBA bytes', async () => {
    const scene = await createScene(input(TRACKS), analysis(20))
    const buf = scene.drawFrame(42)
    expect(buf.length).toBe(W * H * 4)
    for (let p = 3; p < buf.length; p += 4 * 97) expect(buf[p]).toBe(255)
    scene.dispose()
  })

  it('tolerates frames past the end of the analysis', async () => {
    const scene = await createScene(input(TRACKS), analysis(2))
    expect(scene.drawFrame(10_000).length).toBe(W * H * 4)
    scene.dispose()
  })
})

describe('scene creation edge cases', () => {
  it('works with zero tracks and no set artwork', async () => {
    const scene = await createScene(input([], { setArtworkPath: null, setArtist: null }), analysis(5))
    expect(scene.drawFrame(30).length).toBe(W * H * 4)
    scene.dispose()
  })

  it('works when every artwork file is missing', async () => {
    const tracks = TRACKS.map((t) => ({ ...t, artworkPath: path.join(dir, 'nope.png') }))
    const scene = await createScene(input(tracks, { setArtworkPath: path.join(dir, 'also-missing.png') }), analysis(20))
    expect(scene.drawFrame(200).length).toBe(W * H * 4)
    scene.dispose()
  })

  it('works when all names are null (untrusted list)', async () => {
    const tracks = TRACKS.map((t) => ({ ...t, artist: null, title: null }))
    const scene = await createScene(input(tracks), analysis(20))
    expect(scene.drawFrame(160).length).toBe(W * H * 4)
    scene.dispose()
  })
})

describe('cue lookup', () => {
  it('switches track exactly on the cue frame', () => {
    const f5 = cueFrame(5, FPS)
    expect(f5).toBe(150)
    expect(trackIndexAt(TRACKS, f5 - 1, FPS)).toBe(0)
    expect(trackIndexAt(TRACKS, f5, FPS)).toBe(1)
    expect(trackIndexAt(TRACKS, 0, FPS)).toBe(0)
    expect(trackIndexAt(TRACKS, 99_999, FPS)).toBe(3)
  })

  it('returns -1 before the first cue and handles empty lists', () => {
    const late: VizTrack[] = [{ startSeconds: 2, artist: 'a', title: 'b', artworkPath: null }]
    expect(trackIndexAt(late, 59, FPS)).toBe(-1)
    expect(trackIndexAt(late, 60, FPS)).toBe(0)
    expect(slotAt([], 10)).toBe(-1)
  })

  it('formats clock times as h:mm:ss', () => {
    expect(formatClock(0)).toBe('0:00:00')
    expect(formatClock(59.9)).toBe('0:00:59')
    expect(formatClock(3725)).toBe('1:02:05')
  })
})

describe('text fitting', () => {
  registerFonts()
  const ctx = createCanvas(8, 8).getContext('2d')
  const titles = [
    'Short',
    'Innerbloom (What So Not Remix)',
    'Sun & Moon (Above & Beyond Club Mix) [Live at the Hollywood Bowl 2026 Extended Version]',
    'Supercalifragilisticexpialidociousextraordinarilylongwordwithoutanyspacesatall',
    '夜に駆ける (Racing Into The Night) 夜に駆ける 夜に駆ける 夜に駆ける',
    'تملّي معاك تملّي معاك تملّي معاك تملّي معاك',
  ]
  for (const maxWidth of [120, 400, 818]) {
    for (const t of titles) {
      it(`fits "${t.slice(0, 20)}" in ${maxWidth}px`, () => {
        const r = fitText(ctx, t, { maxWidth, maxSize: 92, minSize: 40, maxLines: 2, lineHeight: 1.08, font: displayFont })
        expect(r.size).toBeGreaterThanOrEqual(40 - 1e-9)
        expect(r.size).toBeLessThanOrEqual(92)
        expect(r.lines.length).toBeGreaterThan(0)
        expect(r.lines.length).toBeLessThanOrEqual(2)
        ctx.font = displayFont(r.size)
        for (const line of r.lines) expect(ctx.measureText(line).width).toBeLessThanOrEqual(maxWidth + 0.01)
      })
    }
  }

  it('respects a height budget', () => {
    const r = fitText(ctx, titles[2]!, { maxWidth: 300, maxSize: 60, minSize: 20, maxLines: 3, lineHeight: 1.2, maxHeight: 80, font: displayFont })
    expect(r.height).toBeLessThanOrEqual(80 + 0.01)
  })

  it('keeps short text at the maximum size', () => {
    const r = fitText(ctx, 'ID', { maxWidth: 500, maxSize: 92, minSize: 40, font: displayFont })
    expect(r.size).toBe(92)
    expect(r.lines).toEqual(['ID'])
  })

  it('ellipsizes with a real ellipsis and never splits a character', () => {
    ctx.font = textFont(500, 20)
    const out = ellipsize(ctx, '🎧🎧🎧🎧🎧🎧🎧🎧🎧🎧🎧🎧 long long long', 80)
    expect(out.endsWith('…')).toBe(true)
    expect(ctx.measureText(out).width).toBeLessThanOrEqual(80)
    expect(out).not.toMatch(/[\uD800-\uDBFF]…/)
  })
})

describe('palette', () => {
  it('finds a vivid accent that reads on dark and a dark base', () => {
    const px = new Uint8Array(32 * 32 * 4)
    for (let i = 0; i < 32 * 32; i++) {
      const hot = i % 3 === 0
      px.set(hot ? [240, 40, 120, 255] : [20, 30, 90, 255], i * 4)
    }
    const p = extractPalette(px)
    expect(p.mono).toBe(false)
    expect(contrastRatio(p.accent, [12, 12, 16])).toBeGreaterThanOrEqual(6.5)
    expect(Math.max(...p.base)).toBeLessThan(60)
  })

  it('treats greyscale art as mono', () => {
    const px = new Uint8Array(16 * 16 * 4)
    for (let i = 0; i < 256; i++) px.set([i % 2 ? 250 : 30, i % 2 ? 250 : 30, i % 2 ? 250 : 30, 255], i * 4)
    expect(extractPalette(px).mono).toBe(true)
  })
})

// ---------------------------------------------------------------- layered tracks

const tr = (startSeconds: number, name: string | null, layered = false, artworkPath: string | null = artB): VizTrack => ({
  startSeconds,
  artist: name,
  title: name,
  artworkPath,
  ...(layered ? { layered: true } : {}),
})

describe('grouping layered tracks', () => {
  it('attaches layered tracks to the base before them', () => {
    const g = groupTracks([tr(0, 'a'), tr(0, 'a1', true), tr(5, 'b'), tr(6, 'b1', true), tr(7, 'b2', true), tr(10, 'c')], FPS)
    expect(g.map((x) => x.base)).toEqual([0, 2, 5])
    expect(g[0]!.layers).toEqual([{ index: 1, joinFrame: 0 }])
    expect(g[1]!.layers).toEqual([
      { index: 3, joinFrame: 180 },
      { index: 4, joinFrame: 210 },
    ])
    expect(g[2]!.layers).toEqual([])
  })

  it('treats a layered first track as a base', () => {
    const g = groupTracks([tr(0, 'a', true), tr(3, 'a1', true)], FPS)
    expect(g).toEqual([{ base: 0, startFrame: 0, layers: [{ index: 1, joinFrame: 90 }] }])
  })

  it('clamps a layered cue earlier than its base to the base start, without regrouping it', () => {
    const g = groupTracks([tr(0, 'a'), tr(5, 'b'), tr(4, 'b1', true)], FPS)
    expect(g[1]!.layers).toEqual([{ index: 2, joinFrame: 150 }])
    expect(g[0]!.layers).toEqual([])
  })

  it('drops a layered track that would join at or after the next base', () => {
    const g = groupTracks([tr(0, 'a'), tr(5, 'a1', true), tr(5, 'b'), tr(9, 'b1', true), tr(10, 'c')], FPS)
    expect(g[0]!.layers).toEqual([])
    expect(g[1]!.layers.map((l) => l.index)).toEqual([3])
  })

  it('without layered tracks, is one group per track sorted by start', () => {
    const g = groupTracks([tr(10, 'c'), tr(0, 'a'), tr(5, 'b')], FPS)
    expect(g.map((x) => [x.base, x.startFrame, x.layers.length])).toEqual([
      [1, 0, 0],
      [2, 150, 0],
      [0, 300, 0],
    ])
  })

  it('makes the next base track, not a layered one, the next group (UP NEXT)', () => {
    const list = [tr(0, 'a'), tr(2, 'a1', true), tr(5, 'b')]
    const g = groupTracks(list, FPS)
    expect(g).toHaveLength(2)
    expect(list[g[1]!.base]!.title).toBe('b')
  })
})

describe('tracks on screen at a frame', () => {
  const list = [tr(2, 'a'), tr(2, 'a1', true), tr(4, 'a2', true), tr(1, 'a3', true), tr(10, 'b'), tr(12, 'b1', true)]
  const g = groupTracks(list, FPS)

  it('is empty before the first cue', () => {
    expect(activeTracksAt(g, 59)).toEqual([])
    expect(activeTracksAt([], 0)).toEqual([])
  })

  it('brings layers joining with their base (or clamped to it) on the cue frame', () => {
    expect(activeTracksAt(g, 60)).toEqual([0, 1, 3])
  })

  it('adds a later layer exactly on its join frame', () => {
    expect(activeTracksAt(g, 119)).toEqual([0, 1, 3])
    expect(activeTracksAt(g, 120)).toEqual([0, 1, 3, 2])
  })

  it('removes every layer on the next base cue frame', () => {
    expect(activeTracksAt(g, 299)).toEqual([0, 1, 3, 2])
    expect(activeTracksAt(g, 300)).toEqual([4])
    expect(activeTracksAt(g, 359)).toEqual([4])
    expect(activeTracksAt(g, 360)).toEqual([4, 5])
    expect(activeTracksAt(g, 99_999)).toEqual([4, 5])
  })
})

describe('layered text fitting', () => {
  registerFonts()
  const ctx = createCanvas(8, 8).getContext('2d')
  const layout = computeLayout(1920, 1080, true)
  const long = [
    ['Kx5, deadmau5 & Kaskade', 'Escape (feat. Hayla) [Extended Club Mix Acapella] [Hollywood Bowl Edit]'],
    ['Swedish House Mafia & The Weeknd & Many More Featured Artists', 'Moth To A Flame (Chris Lake Remix) [Instrumental Version]'],
    ['Above & Beyond, Andrew Bayer & Zoë Johnston', 'Sun & Moon (Above & Beyond Club Mix) [Live at the Hollywood Bowl 2026]'],
  ] as const
  const baseTitle = 'Sun & Moon (Above & Beyond Club Mix) [Live at the Hollywood Bowl 2026 Extended]'

  it('fits a base plus three long layered tracks inside the budget, shrinking then ellipsizing', () => {
    const plan = planBlock(ctx, layout, baseTitle, 44 * layout.u, 3)
    expect(plan.maxRows).toBe(3)
    const total = baseBlockHeight(plan.baseTitle, 44 * layout.u, layout.u) + rowsHeight(plan.style, 3, plan.maxRows)
    expect(total).toBeLessThanOrEqual(blockBudget(layout) + 0.01)
    const w = rowTextWidth(layout, plan.style)
    for (const [artist, title] of long) {
      const row = fitRow(ctx, layout, plan.style, artist, title)
      expect(row.title.lines).toHaveLength(1)
      expect(row.title.size).toBeLessThanOrEqual(plan.style.titleMax)
      expect(row.title.size).toBeGreaterThanOrEqual(plan.style.titleMin - 1e-9)
      ctx.font = textFont(600, row.title.size)
      expect(ctx.measureText(row.title.lines[0]!).width).toBeLessThanOrEqual(w + 0.01)
      ctx.font = textFont(500, row.artist.size)
      expect(ctx.measureText(row.artist.lines[0]!).width).toBeLessThanOrEqual(w + 0.01)
    }
    // Too long even at the minimum size: shrunk to it, then cut.
    const row = fitRow(ctx, layout, plan.style, long[0][0], long[0][1])
    expect(row.title.size).toBeCloseTo(plan.style.titleMin, 6)
    expect(row.title.lines[0]!.endsWith('…')).toBe(true)
    // A short one keeps the full size.
    expect(fitRow(ctx, layout, plan.style, 'A', 'Hurt').title.size).toBe(plan.style.titleMax)
  })

  it('labels a layered ID as ID / Unidentified, dimmed', () => {
    const plan = planBlock(ctx, layout, 'Base', 44 * layout.u, 1)
    const row = fitRow(ctx, layout, plan.style, null, null)
    expect(row.title.lines).toEqual(['ID'])
    expect(row.artist.lines).toEqual(['Unidentified'])
    expect(row.dimTitle && row.dimArtist).toBe(true)
  })

  it('folds rows past MAX_ROWS into one +k more row', () => {
    const plan = planBlock(ctx, layout, 'Base', 44 * layout.u, 5)
    expect(plan.maxRows).toBe(MAX_ROWS)
    expect(rowsHeight(plan.style, 5, plan.maxRows)).toBeCloseTo(rowsHeight(plan.style, 3, 3) + plan.style.gap + plan.style.moreH, 6)
  })

  it('shrinks, then collapses three rows into +k more when the room is too small', () => {
    // Squeeze the budget: the text column centre pushed down towards the footer.
    const tight = { ...layout, text: { ...layout.text, cy: layout.footer.timeY - 116 * layout.u - 170 * layout.u } }
    const plan = planBlock(ctx, tight, baseTitle, 44 * tight.u, 3)
    expect(plan.baseTitle.lines).toHaveLength(1)
    expect(plan.style.thumb).toBeLessThan(84 * tight.u)
    expect(plan.maxRows).toBeLessThan(3)
  })

  it('keeps every fanned card inside the ring for up to six layers', () => {
    for (let m = 1; m <= 6; m++) {
      const poses = fanPoses(m)
      for (const p of poses) {
        const e = (p.s / 2) * (Math.abs(Math.cos(p.rot)) + Math.abs(Math.sin(p.rot)))
        expect(Math.hypot(Math.abs(p.x) + e, Math.abs(p.y) + e)).toBeLessThan(1.05)
      }
      expect(poses[0]!.s).toBeGreaterThan(poses[1]!.s)
    }
    expect(fanPoses(0)).toEqual([{ x: 0, y: 0, s: 1, rot: 0 }])
  })
})

describe('layered scene', () => {
  const artC = fixtureImage(dir, 'c.png', '#101010', '#e0b040')
  const LAYERED: VizTrack[] = [
    { startSeconds: 0, artist: 'Alpha', title: 'First', artworkPath: artA, layered: true },
    { startSeconds: 0, artist: 'Acap', title: 'Vocal', artworkPath: artB, layered: true },
    { startSeconds: 5, artist: 'Beta', title: 'Second', artworkPath: artB },
    { startSeconds: 7, artist: null, title: null, artworkPath: null, layered: true },
    { startSeconds: 8, artist: 'Gamma', title: 'A very long layered title that has to be cut somewhere', artworkPath: artC, layered: true },
    { startSeconds: 8.5, artist: 'Delta', title: 'Third layer', artworkPath: null, layered: true },
    { startSeconds: 12, artist: 'Eps', title: 'Last', artworkPath: artA },
  ]
  // Around the start, the cue at 5 s (150), the join at 7 s (210) and the cue at 12 s (360).
  const frames = [0, 5, 149, 150, 170, 209, 210, 215, 227, 239, 240, 255, 359, 360, 372, 599]

  for (const [name, list] of [
    ['split', LAYERED],
    ['centred, untrusted', LAYERED.map((t) => ({ ...t, artist: null, title: null }))],
  ] as const) {
    it(`draws the same bytes regardless of order and instance (${name})`, async () => {
      const a = analysis(20)
      const s1 = await createScene(input(list), a)
      const s2 = await createScene(input(list), a)
      const forward = frames.map((f) => copy(s1.drawFrame(f)))
      const reversed = [...frames].reverse().map((f) => copy(s2.drawFrame(f))).reverse()
      for (let k = 0; k < frames.length; k++) expect(reversed[k]!.equals(forward[k]!)).toBe(true)
      s1.dispose()
      s2.dispose()
    }, 60_000)
  }

  it('renders a list without layered tracks exactly as one with layered: false everywhere', async () => {
    const a = analysis(20)
    const s1 = await createScene(input(TRACKS), a)
    const s2 = await createScene(input(TRACKS.map((t) => ({ ...t, layered: false }))), a)
    for (const f of [0, 150, 163, 450]) expect(copy(s1.drawFrame(f)).equals(copy(s2.drawFrame(f)))).toBe(true)
    s1.dispose()
    s2.dispose()
  })

  for (const [name, named] of [
    ['split', true],
    ['centred', false],
  ] as const) {
    it(`a later layered track changes the picture from its join frame on, not before (${name})`, async () => {
      const a = analysis(20)
      const strip = (t: VizTrack) => (named ? t : { ...t, artist: null, title: null })
      const s1 = await createScene(input([LAYERED[2]!, LAYERED[6]!].map(strip)), a)
      const s2 = await createScene(input([LAYERED[2]!, LAYERED[4]!, LAYERED[6]!].map(strip)), a)
      // Only the timeline dot differs before the join (8 s = frame 240): compare above the footer.
      const top = (b: Buffer) => b.subarray(0, W * 4 * Math.floor(H * 0.8))
      expect(top(copy(s1.drawFrame(239))).equals(top(copy(s2.drawFrame(239))))).toBe(true)
      expect(top(copy(s1.drawFrame(245))).equals(top(copy(s2.drawFrame(245))))).toBe(false)
      s1.dispose()
      s2.dispose()
    })
  }
})

describe('palette of mostly grey artwork', () => {
  it('uses a small saturated area as the accent', () => {
    const px = new Uint8Array(48 * 48 * 4)
    for (let i = 0; i < 48 * 48; i++) {
      const x = i % 48
      const y = Math.floor(i / 48)
      const gold = x >= 30 && x < 38 && y >= 20 && y < 30 // 3.5% of the image
      const g = (x * 5 + y * 3) % 200
      px.set(gold ? [224, 170, 40, 255] : [g, g, g + 4, 255], i * 4)
    }
    const p = extractPalette(px)
    expect(p.mono).toBe(false)
    expect(p.accent[0]).toBeGreaterThan(p.accent[2] + 60)
  })

  it('stays greyscale when colour is only scattered noise', () => {
    const px = new Uint8Array(48 * 48 * 4)
    for (let i = 0; i < 48 * 48; i++) {
      const g = 60 + ((i * 37) % 120)
      const h = (i * 97) % 3
      const c = (k: number) => (h === k ? 200 : 60)
      px.set(i % 29 === 0 ? [c(0), c(1), c(2), 255] : [g, g, g, 255], i * 4)
    }
    expect(extractPalette(px).mono).toBe(true)
  })
})

describe('artwork of unnamed tracks', () => {
  const one = (t: Partial<VizTrack>): VizTrack[] => [{ startSeconds: 0, artist: null, title: null, artworkPath: null, ...t }]

  it("shows an unnamed track's own artwork (untrusted list)", async () => {
    const a = analysis(5)
    const own = await createScene(input(one({ artworkPath: artB })), a)
    const none = await createScene(input(one({})), a)
    expect(copy(own.drawFrame(60)).equals(copy(none.drawFrame(60)))).toBe(false)
    own.dispose()
    none.dispose()
  })

  it('falls back to the set artwork when an unnamed track has none or it is unreadable', async () => {
    const a = analysis(5)
    const none = await createScene(input(one({})), a)
    const missing = await createScene(input(one({ artworkPath: path.join(dir, 'gone.png') })), a)
    const setArtAsOwn = await createScene(input(one({ artworkPath: artA })), a)
    const f = copy(none.drawFrame(60))
    expect(copy(missing.drawFrame(60)).equals(f)).toBe(true)
    // The set artwork is artA, so pointing the track at artA looks the same.
    expect(copy(setArtAsOwn.drawFrame(60)).equals(f)).toBe(true)
    for (const s of [none, missing, setArtAsOwn]) s.dispose()
  })
})
