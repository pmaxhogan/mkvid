/**
 * Renders PNG stills of the visualizer scene for review.
 *
 *   npx tsx scripts/viz-stills.ts [--round r1] [--case main,cue,...] [--analysis file.bin] [--bench]
 *     [--sheet [--layered] [--start frame] [--step n]] [--crops]
 *
 * Output goes to the research folder, never into the repo. Artwork comes from
 * a scratch folder of downloaded covers (VIZ_ART_DIR overrides it).
 */
import { createCanvas } from '@napi-rs/canvas'
import { mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { createScene } from '../src/viz/scene/index.js'
import type { AnalysisData, VizInput, VizTrack } from '../src/viz/types.js'

const PREVIEWS = 'C:/Users/pmaxh/Documents/node-projects/_research/1001tl-2026-09-28/viz-previews'
const ART = process.env.VIZ_ART_DIR ?? path.join(PREVIEWS, 'art')
const W = 1920
const H = 1080
const FPS = 30

function arg(name: string): string | undefined {
  const k = process.argv.indexOf(`--${name}`)
  return k >= 0 ? process.argv[k + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

const round = arg('round') ?? 'latest'
const outDir = path.join(PREVIEWS, 'stills', round)
mkdirSync(outDir, { recursive: true })

const art = (name: string) => {
  const p = path.join(ART, `${name}.jpg`)
  return existsSync(p) ? p : null
}

async function loadAnalysisData(durationSeconds: number): Promise<AnalysisData> {
  const file = arg('analysis')
  const mod = (await import('../src/viz/analysis.js')) as Record<string, unknown>
  if (file) {
    const load = mod.loadAnalysis as (f: string) => Promise<AnalysisData>
    return load(file)
  }
  const synth = mod.syntheticAnalysis as (o: { fps: number; durationSeconds: number; bands?: number }) => AnalysisData
  return synth({ fps: FPS, durationSeconds, bands: 64 })
}

const T = (startSeconds: number, artist: string | null, title: string | null, artwork: string | null, layered = false): VizTrack => ({
  startSeconds,
  artist,
  title,
  artworkPath: artwork ? art(artwork) : null,
  ...(layered ? { layered: true } : {}),
})
/** A layered ("w/") track. */
const L = (startSeconds: number, artist: string | null, title: string | null, artwork: string | null) => T(startSeconds, artist, title, artwork, true)

const MAIN_TRACKS: VizTrack[] = [
  T(0, 'Rüfüs Du Sol', 'Innerbloom (What So Not Remix)', 'rufus'),
  T(300, 'FISHER', 'Losing It', 'yellow_fisher'),
  T(600, 'Anyma', 'Eternity', 'anyma'),
  T(900, 'Daft Punk', 'Give Life Back to Music', 'dark_ram'),
  T(1200, 'The Beatles', 'Back in the U.S.S.R.', 'white_beatles'),
  T(1500, null, null, null),
  T(1800, 'KAYTRANADA', 'Lite Spots', 'busy_kaytranada'),
  T(2100, 'Tame Impala', 'Let It Happen', 'tame'),
  T(2400, 'Nine Inch Nails', 'Hurt', 'dark_nin'),
  T(2700, 'Peggy Gou', 'It Goes Like Nanana (Edit)', 'peggy'),
  T(3000, 'Fred again..', 'Delilah (pull me out of this)', 'fred'),
  T(3300, 'Gorillaz', 'Stylo (feat. Mos Def & Bobby Womack)', 'busy_gorillaz'),
]

/**
 * Layered tracks: every shape the scene has to handle, in input order (the
 * order decides which base a layered track belongs to).
 */
const LAYERED_TRACKS: VizTrack[] = [
  L(0, 'Rüfüs Du Sol', 'Innerbloom (What So Not Remix)', 'rufus'), // wrongly flagged first track: a base
  T(300, 'FISHER', 'Losing It', 'yellow_fisher'),
  L(300, 'Chris Lake', 'Turn Off The Lights (Acapella)', 'anyma'), // joins with its base
  T(600, 'Anyma', 'Eternity', 'anyma'),
  L(590, 'Kx5, deadmau5 & Kaskade', 'Escape (feat. Hayla) [Extended Club Mix Acapella]', 'tame'), // earlier than its base: clamped
  L(640, 'Swedish House Mafia & The Weeknd', "Moth To A Flame (Chris Lake Remix) [Instrumental Version]", 'fred'),
  L(700, 'Above & Beyond, Andrew Bayer & Zoë Johnston', 'Sun & Moon (Above & Beyond Club Mix) [Live at the Hollywood Bowl]', 'busy_gorillaz'),
  T(900, 'Daft Punk', 'Give Life Back to Music', 'dark_ram'),
  L(1000, 'Fred again..', 'Delilah (pull me out of this)', 'fred'), // joins mid-slot
  T(1200, 'The Beatles', 'Back in the U.S.S.R.', 'white_beatles'),
  L(1250, null, null, null), // a layered ID without artwork
  T(1500, 'KAYTRANADA', 'Lite Spots', 'busy_kaytranada'),
  L(1500, 'Disclosure', 'Latch (Acapella)', null), // named, no artwork
  T(1800, 'Tame Impala', 'Let It Happen', 'tame'),
  L(1800, 'Peggy Gou', 'It Goes Like Nanana (Edit)', 'peggy'),
  L(1810, 'Nine Inch Nails', 'Hurt', 'dark_nin'),
  L(1820, 'Gorillaz', 'Stylo', 'busy_gorillaz'),
  L(1830, 'Anyma', 'Eternity', 'anyma'),
  L(1840, 'FISHER', 'Losing It', 'yellow_fisher'),
  T(2100, 'Peggy Gou', 'It Goes Like Nanana (Edit)', 'peggy'),
  T(2400, 'Fred again..', 'Delilah (pull me out of this)', 'fred'),
]

interface Case {
  name: string
  input: VizInput
  frames: number[]
}

function input(tracks: VizTrack[], over: Partial<VizInput> = {}): VizInput {
  return {
    audioPath: 'none',
    durationSeconds: 3600,
    setTitle: 'Boiler Room: Live from Printworks London',
    setArtist: 'Example DJ b2b Another DJ',
    setArtworkPath: art('setart'),
    tracks,
    width: W,
    height: H,
    fps: FPS,
    ...over,
  }
}

const s = (sec: number) => Math.round(sec * FPS)

const CASES: Case[] = [
  {
    name: 'main',
    input: input(MAIN_TRACKS),
    frames: MAIN_TRACKS.map((t) => s(t.startSeconds + 95.4)),
  },
  {
    name: 'cue',
    input: input(MAIN_TRACKS),
    frames: [-2, 3, 8, 13, 18, 23, 28, 34].map((d) => s(600) + d),
  },
  { name: 'notracks', input: input([], { setArtworkPath: art('setart') }), frames: [s(10), s(1800)] },
  { name: 'noart', input: input([], { setArtworkPath: null, setArtist: null, setTitle: 'Untitled Mix 2026' }), frames: [s(42)] },
  {
    name: 'untrusted',
    input: input(MAIN_TRACKS.map((t) => ({ ...t, artist: null, title: null }))),
    frames: [s(700), s(2200)],
  },
  { name: 'layered-one', input: input(LAYERED_TRACKS), frames: [s(395)] },
  { name: 'layered-three', input: input(LAYERED_TRACKS), frames: [s(760), s(645)] },
  { name: 'layered-join', input: input(LAYERED_TRACKS), frames: [-3, 3, 7, 11, 15, 19, 24, 32].map((d) => s(1000) + d) },
  { name: 'layered-cue', input: input(LAYERED_TRACKS), frames: [-2, 4, 9, 14, 19, 25, 33].map((d) => s(1200) + d) },
  { name: 'layered-cue-in', input: input(LAYERED_TRACKS), frames: [4, 9, 14, 19, 25, 33].map((d) => s(300) + d) },
  { name: 'layered-edge', input: input(LAYERED_TRACKS), frames: [s(1300), s(1560), s(1900), s(2150)] },
  {
    name: 'layered-untrusted',
    input: input(LAYERED_TRACKS.map((t) => ({ ...t, artist: null, title: null }))),
    frames: [s(395), s(760), s(1300), s(1900), ...[-3, 5, 12, 20, 30].map((d) => s(1000) + d), ...[4, 12, 20, 30, 45].map((d) => s(1200) + d)],
  },
  {
    name: 'long',
    input: input([
      T(0, 'Above & Beyond, Andrew Bayer, Richard Bedford, Zoë Johnston and The Anjunabeats Orchestra', 'Sun & Moon (Above & Beyond Club Mix) [Live at the Hollywood Bowl 2026 Extended Version With Very Long Suffix]', 'anyma'),
      T(600, 'Artist', 'Supercalifragilisticexpialidociousextraordinarilylongwordwithoutanyspaces', 'tame'),
    ]),
    frames: [s(100), s(700)],
  },
  {
    name: 'intl',
    input: input(
      [
        T(0, 'YOASOBI', '夜に駆ける (Racing Into The Night)', 'peggy'),
        T(300, '뉴진스 NewJeans', '슈퍼 샤이 Super Shy', 'busy_kaytranada'),
        T(600, 'Фёдор Кузнецов', 'Ночной город', 'dark_nin'),
        T(900, 'عمرو دياب', 'تملّي معاك', 'yellow_fisher'),
        T(1200, 'ศิลปิน', 'เพลงไทย ทดสอบ', 'rufus'),
      ],
      { setTitle: '東京 Boiler Room 2026', setArtist: 'DJ 空' },
    ),
    frames: [s(100), s(400), s(700), s(1000), s(1300)],
  },
]

function rgbaToPng(rgba: Uint8Array | Buffer, w: number, h: number, crop?: [number, number, number, number]): Buffer {
  const c = createCanvas(w, h)
  const ctx = c.getContext('2d')
  const img = ctx.createImageData(w, h)
  img.data.set(rgba)
  ctx.putImageData(img, 0, 0)
  if (!crop) return c.toBuffer('image/png')
  const [x, y, cw, ch] = crop
  const o = createCanvas(cw, ch)
  o.getContext('2d').drawImage(c, x, y, cw, ch, 0, 0, cw, ch)
  return o.toBuffer('image/png')
}

async function main() {
  const wanted = arg('case')?.split(',')
  const analysis = await loadAnalysisData(3600)
  if (flag('bench')) {
    const scene = await createScene(input(MAIN_TRACKS), analysis)
    for (let i = 0; i < 20; i++) scene.drawFrame(s(600) + i)
    const n = 150
    const t0 = performance.now()
    for (let i = 0; i < n; i++) scene.drawFrame(s(595) + i)
    const ms = (performance.now() - t0) / n
    console.log(`bench: ${ms.toFixed(2)} ms/frame, ${(1000 / ms).toFixed(1)} fps (1920x1080, one thread, through a cue change)`)
    scene.dispose()
    // Layered: through a mid-slot join, then inside a three-layer slot.
    const ls = await createScene(input(LAYERED_TRACKS), analysis)
    for (let i = 0; i < 20; i++) ls.drawFrame(s(990) + i)
    const t1 = performance.now()
    for (let i = 0; i < n; i++) ls.drawFrame(s(995) + i)
    for (let i = 0; i < n; i++) ls.drawFrame(s(760) + i)
    const lms = (performance.now() - t1) / (2 * n)
    console.log(`bench: ${lms.toFixed(2)} ms/frame, ${(1000 / lms).toFixed(1)} fps (1920x1080, one thread, layered tracks on screen)`)
    ls.dispose()
    return
  }
  if (flag('sheet')) {
    // Contact sheet of consecutive frames, to judge motion without a video.
    const start = Number(arg('start') ?? s(1790))
    const step = Number(arg('step') ?? 3)
    const cols = 4
    const rows = 4
    const tw = 480
    const th = 270
    const scene = await createScene(input(flag('layered') ? LAYERED_TRACKS : MAIN_TRACKS), analysis)
    const sheet = createCanvas(tw * cols, th * rows)
    const sctx = sheet.getContext('2d')
    const tmp = createCanvas(W, H)
    const tctx = tmp.getContext('2d')
    for (let k = 0; k < cols * rows; k++) {
      const img = tctx.createImageData(W, H)
      img.data.set(scene.drawFrame(start + k * step))
      tctx.putImageData(img, 0, 0)
      sctx.drawImage(tmp, (k % cols) * tw, Math.floor(k / cols) * th, tw, th)
    }
    const file = path.join(outDir, `sheet-${start}-step${step}.png`)
    writeFileSync(file, sheet.toBuffer('image/png'))
    console.log(file)
    return
  }
  for (const c of CASES) {
    if (wanted && !wanted.includes(c.name)) continue
    const scene = await createScene(c.input, analysis)
    for (const f of c.frames) {
      const frame = Math.max(0, f)
      const rgba = scene.drawFrame(frame)
      const base = path.join(outDir, `${c.name}-${String(frame).padStart(6, '0')}`)
      writeFileSync(`${base}.png`, rgbaToPng(rgba, W, H))
      if (flag('crops') && c.name !== 'cue') {
        writeFileSync(`${base}-crop-text.png`, rgbaToPng(rgba, W, H, [960, 240, 960, 560]))
        writeFileSync(`${base}-crop-footer.png`, rgbaToPng(rgba, W, H, [0, 840, 960, 240]))
      }
      console.log(`${base}.png`)
    }
    scene.dispose()
  }
  console.log(`stills in ${outDir}: ${readdirSync(outDir).length} files`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
