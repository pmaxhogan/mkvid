/**
 * Render a short window of a local audio file with the real scene, to review
 * the look before an overnight render:
 *
 *   npx tsx src/viz/preview.ts --audio set.m4a --from 1800 --seconds 20 --out preview.mp4 \
 *     [--tracks tracks.json] [--artwork cover.jpg] [--title "Set title"] [--artist "DJ"] \
 *     [--stills dir] [--still-count 4] [--workers 10] [--encoder auto|nvenc|x264] [--size 1920x1080] [--fps 30] [--keep] [--untrusted]
 *   npx tsx src/viz/preview.ts --selftest [--encoder nvenc]    (in the image: node dist/viz/preview.js --selftest)
 *
 * The whole file is analysed (features are normalised over the recording, as
 * in a real render), then only the window is drawn, encoded exactly like a
 * job's segments, and muxed with the matching audio. --stills writes --still-count (4) evenly spaced PNGs
 * straight from the scene (no compression). --tracks takes tracked's wire
 * format: an array of { cueSeconds, artist, title, artworkUrl, isId, layered? }, or
 * { tracks: [...], tracksTrusted }. artworkUrl may also be a local file. --untrusted
 * (developer only) hides every name, to preview what a list without names looks like.
 *
 * ffmpeg/ffprobe come from FFMPEG_PATH / FFPROBE_PATH (read from ./.env too),
 * falling back to PATH.
 */

import { parseArgs } from 'node:util'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type { AnalysisData, Segment, VizInput, VizTrack } from './types.js'
import type { TrackedTrack } from '../types.js'
import { probeAudio } from '../lib/probe.js'
import { vizTracksFromTracked, fetchArtwork } from './assets.js'
import {
  planSegments, renderSegments, assemble, chooseEncoder, defaultWorkerCount, verifyDuration, colourSelfTest, VIZ_AUDIO_ARGS,
  type SegmentInfo, type VizEncoder,
} from './render.js'

const USAGE = 'usage: npx tsx src/viz/preview.ts --audio <file> --from <seconds> --seconds <n> --out <file.mp4> ' +
  '[--tracks <tracks.json>] [--artwork <image>] [--title ...] [--artist ...] [--stills <dir>] [--still-count n] ' +
  '[--workers n] [--encoder auto|nvenc|x264] [--size WxH] [--fps n] [--keep] [--untrusted]\n' +
  '       npx tsx src/viz/preview.ts --selftest [--encoder auto|nvenc|x264]   (canvas -> encoder colour check)'

class UsageError extends Error {}

function fail(msg: string): never { throw new UsageError(msg) }

async function loadTracks(file: string, cacheDir: string, untrusted: boolean, durationSeconds: number): Promise<VizTrack[]> {
  let raw: unknown
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch (e: any) { fail(`--tracks ${file}: ${e?.message || e}`) }
  const list = (Array.isArray(raw) ? raw : (raw as any)?.tracks) as TrackedTrack[] | undefined
  if (!Array.isArray(list)) fail(`--tracks ${file}: expected an array of tracks or { tracks, tracksTrusted }`)
  // Developer flag only (--untrusted): preview a list with every name hidden. The tracked
  // job path has no such mode — it renders a verified list or nothing.
  const trusted = !untrusted
  if (!Array.isArray(raw) && (raw as any).tracksTrusted === false && trusted) console.warn('tracks file says tracksTrusted: false — names are shown anyway; pass --untrusted to hide them')
  // Local artwork files are allowed here (never on the wire). The converter only keeps
  // http(s) URLs, so a local file travels through it as a placeholder URL.
  const LOCAL = 'http://local.invalid/'
  const locals: string[] = []
  const wire = list.map((t0) => {
    const t = t0 && !trusted ? { ...t0, artist: null, title: null } : t0
    if (!t || typeof t.artworkUrl !== 'string' || /^https?:\/\//i.test(t.artworkUrl)) return t
    locals.push(resolve(dirname(file), t.artworkUrl))
    return { ...t, artworkUrl: LOCAL + (locals.length - 1) }
  })
  const out: VizTrack[] = []
  for (const t of vizTracksFromTracked(wire, { durationSeconds })) {
    let artworkPath: string | null = null
    if (t.artworkUrl?.startsWith(LOCAL)) {
      const p = locals[Number(t.artworkUrl.slice(LOCAL.length))]
      if (existsSync(p)) artworkPath = p
      else console.warn(`artwork file not found: ${p}`)
    } else if (t.artworkUrl) {
      artworkPath = await fetchArtwork(t.artworkUrl, cacheDir, { onLog: (l) => console.warn(l) })
    }
    out.push({ startSeconds: t.startSeconds, artist: t.artist, title: t.title, artworkPath, ...(t.layered ? { layered: true } : {}) })
  }
  const named = out.filter((t) => t.artist || t.title).length
  const layered = out.filter((t) => t.layered).length
  console.log(`tracks: ${out.length} (${named} named, ${layered} layered${trusted ? '' : ', untrusted list: names hidden'}), ${out.filter((t) => t.artworkPath).length} with artwork`)
  return out
}

/** One RGBA frame -> PNG via ffmpeg (exact scene pixels, no video compression). */
function writePng(ffmpegPath: string, rgba: Uint8Array, width: number, height: number, file: string): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', 'pipe:0', '-frames:v', '1', '-update', '1', file],
    { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    let err = ''
    p.stderr!.on('data', (d) => { err += d.toString() })
    p.on('error', rej)
    p.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg (png) exit ${code}: ${err.slice(-500)}`))))
    p.stdin!.end(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength))
  })
}

async function main(): Promise<void> {
  try { process.loadEnvFile() } catch { /* no .env: PATH binaries */ }
  const { values: a } = parseArgs({
    options: {
      audio: { type: 'string' }, from: { type: 'string' }, seconds: { type: 'string' }, out: { type: 'string' },
      tracks: { type: 'string' }, artwork: { type: 'string' }, title: { type: 'string' }, artist: { type: 'string' },
      stills: { type: 'string' }, 'still-count': { type: 'string' }, workers: { type: 'string' }, encoder: { type: 'string' }, size: { type: 'string' },
      fps: { type: 'string' }, keep: { type: 'boolean' }, selftest: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      untrusted: { type: 'boolean' },
    },
    allowPositionals: false,
  })
  if (a.help) { console.log(USAGE); return }
  if (a.selftest) {
    // Canvas channel order + colour matrix check; needs no audio. Exit code 1 on a mismatch.
    const dir = mkdtempSync(join(tmpdir(), 'mkvid-selftest-'))
    try {
      const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'
      const encoder = await chooseEncoder(ffmpegPath, (a.encoder ?? 'x264') as 'auto' | VizEncoder, (l) => console.log(l))
      const r = await colourSelfTest({ ffmpegPath, encoder, dir })
      console.log(`colour self-test (${encoder}):\n  ${r.details.join('\n  ')}`)
      if (!r.ok) throw new Error('colour self-test failed: the encoded video does not show what the canvas drew')
      return
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  if (!a.audio || !a.out || a.from === undefined || a.seconds === undefined) fail('--audio, --from, --seconds and --out are required')
  const audioPath = resolve(a.audio)
  if (!existsSync(audioPath)) fail(`audio file not found: ${audioPath}`)
  const from = Number(a.from)
  const seconds = Number(a.seconds)
  if (!(from >= 0) || !(seconds > 0)) fail('--from must be >= 0 and --seconds > 0')
  const [width, height] = (a.size ?? '1920x1080').split('x').map(Number)
  if (!(width > 0 && height > 0)) fail(`bad --size ${a.size}`)
  const fps = a.fps ? Number(a.fps) : 30
  if (!(fps > 0)) fail(`bad --fps ${a.fps}`)
  const encoderArg = (a.encoder ?? 'auto') as 'auto' | VizEncoder
  if (!['auto', 'nvenc', 'x264'].includes(encoderArg)) fail(`bad --encoder ${a.encoder}`)
  const workers = a.workers ? Number(a.workers) : defaultWorkerCount()
  if (a.artwork && !existsSync(a.artwork)) fail(`--artwork file not found: ${a.artwork}`)
  const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'
  const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe'
  const outFile = resolve(a.out)
  mkdirSync(dirname(outFile), { recursive: true })

  const t0 = Date.now()
  const { duration } = await probeAudio(ffprobePath, audioPath).catch((e) => fail(`ffprobe could not read ${audioPath} (${ffprobePath}): ${e?.message || e}`))
  if (from >= duration) fail(`--from ${from} is past the end of the audio (${duration.toFixed(1)}s)`)

  const work = mkdtempSync(join(tmpdir(), 'mkvid-preview-'))
  try {
    // 1. analysis of the whole recording
    let analysisMod: typeof import('./analysis.js')
    let analysis: AnalysisData
    try {
      analysisMod = await import('./analysis.js')
      process.stdout.write('analysing audio… ')
      analysis = await analysisMod.analyzeAudio(audioPath, { fps, ffmpegPath })
    } catch (e: any) {
      throw new Error(`audio analysis failed (src/viz/analysis.ts, ffmpeg ${ffmpegPath}): ${e?.stack || e?.message || e}`)
    }
    const analysisPath = join(work, 'analysis.bin')
    await analysisMod.saveAnalysis(analysis, analysisPath)
    console.log(`${analysis.frameCount} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

    // 2. scene input
    const cacheDir = join(tmpdir(), 'mkvid-artwork-cache')
    const tracks = a.tracks ? await loadTracks(resolve(a.tracks), cacheDir, a.untrusted === true, duration) : []
    const input: VizInput = {
      audioPath, durationSeconds: duration,
      setTitle: a.title ?? basename(audioPath, extname(audioPath)), setArtist: a.artist ?? null,
      setArtworkPath: a.artwork ? resolve(a.artwork) : null, tracks, width, height, fps,
    }

    // 3. the window, cut into 10 s segments so it exercises the same concat as a job
    const f0 = Math.min(Math.round(from * fps), analysis.frameCount - 1)
    const f1 = Math.min(analysis.frameCount, f0 + Math.max(1, Math.round(seconds * fps)))
    const segments: Segment[] = planSegments(f1 - f0, fps, 10).map((s) => ({ ...s, startFrame: s.startFrame + f0, endFrame: s.endFrame + f0 }))
    const encoder = await chooseEncoder(ffmpegPath, encoderArg, (l) => console.log(l))
    console.log(`rendering frames ${f0}..${f1 - 1} (${f1 - f0}) at ${width}x${height}@${fps}, ${encoder}, ${workers} worker(s)`)
    const infos: Record<string, SegmentInfo> = {}
    let frames = 0
    const tr = Date.now()
    await renderSegments({
      input, analysisPath, segments, dir: work, ffmpegPath, ffprobePath, encoder, workers, encodeSessions: 2,
      onFrame: () => {
        frames++
        if (frames % 30 === 0 || frames === f1 - f0) process.stdout.write(`\r  ${frames}/${f1 - f0} frames, ${(frames / ((Date.now() - tr) / 1000)).toFixed(1)} fps   `)
      },
      onSegmentDone: (s, info) => { infos[String(s.index)] = info },
    })
    const renderSecs = (Date.now() - tr) / 1000
    process.stdout.write('\n')

    // 4. mux the matching audio window
    const winSeconds = (f1 - f0) / fps
    await assemble({
      dir: work, segments, infos, audioPath, audioArgs: [...VIZ_AUDIO_ARGS], outFile, ffmpegPath,
      audioStart: f0 / fps, audioDuration: winSeconds,
    })
    await verifyDuration(ffprobePath, outFile, Math.min(winSeconds, duration - f0 / fps), fps)

    // 5. stills straight from the scene
    if (a.stills) {
      const dir = resolve(a.stills)
      mkdirSync(dir, { recursive: true })
      const { createScene } = await import('./scene/index.js')
      const scene = await createScene(input, analysis)
      try {
        const count = Math.max(1, Math.floor(Number(a['still-count'] ?? 4)) || 4)
        for (let k = 0; k < count; k++) {
          const f = f0 + Math.min(f1 - f0 - 1, Math.round(((k + 0.5) / count) * (f1 - f0)))
          const file = join(dir, `${basename(outFile, extname(outFile))}-${String(f).padStart(6, '0')}.png`)
          await writePng(ffmpegPath, scene.drawFrame(f), width, height, file)
          console.log(`still: ${file}`)
        }
      } finally {
        scene.dispose()
      }
    }

    const fpsRate = (f1 - f0) / renderSecs
    console.log(`wrote ${outFile}`)
    console.log(`render: ${renderSecs.toFixed(1)}s for ${winSeconds.toFixed(1)}s of video = ${fpsRate.toFixed(1)} fps (${(fpsRate / fps).toFixed(2)}x realtime); ` +
      `a 1 h set would take ~${((3600 * fps) / fpsRate / 60).toFixed(0)} min on this machine`)
    console.log(`total: ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  } finally {
    if (a.keep) console.log(`kept work dir ${work}`)
    else rmSync(work, { recursive: true, force: true })
  }
}

main().catch((e: any) => {
  if (e instanceof UsageError) console.error(`preview: ${e.message}\n${USAGE}`)
  else console.error(`preview failed: ${e?.stack || e?.message || e}`)
  process.exit(1)
})
