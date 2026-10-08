/**
 * The scene renderer: segment planning, a pool of drawing threads, ffmpeg
 * encodes per segment, resume, and the final assemble.
 *
 *   vizDir/
 *     manifest.json        fingerprint of the inputs + finished segments
 *     analysis.bin         per-frame audio features (analysis.ts)
 *     seg-00042.mp4        a finished segment (only ever appears by rename)
 *     seg-00042.mp4.partial  one being encoded; ignored and deleted on resume
 *
 * Why the encoding happens on the main thread and not in the workers: a job's
 * segments are joined with the concat demuxer and a stream copy, and an MP4
 * carries one set of H.264 parameter sets (SPS/PPS, the avcC box) for the
 * whole track, taken from the first file. A segment from h264_nvenc and one
 * from libx264 have different parameter sets, so mixing them per segment
 * produces a file that does not decode past the first switch. One job
 * therefore uses one encoder for every segment (pinned in the manifest). NVENC
 * allows only a few concurrent sessions on a consumer card, so instead of one
 * encoder per worker, `encodeSessions` segment encoders run at a time (default
 * 2) and every drawing worker feeds all of them, frame by frame. The scene
 * contract (drawFrame(i) depends only on i) is what allows that.
 */

import { Worker } from 'node:worker_threads'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { defaultWorkerCount } from '../lib/cpu.js'
import { promisify } from 'node:util'
import { pathToFileURL, fileURLToPath } from 'node:url'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { Segment, VizInput } from './types.js'
import { isNvencDisabled, markNvencDisabled } from '../lib/ffmpeg.js'

const pExecFile = promisify(execFile)

export type VizEncoder = 'nvenc' | 'x264'

export const DEFAULT_SEGMENT_SECONDS = 60
export const MANIFEST_VERSION = 1
/** Share of the progress bar spent drawing; the rest is the assemble. */
export const RENDER_SHARE = 0.97

export { defaultWorkerCount }

// ---------------------------------------------------------------------------
// planning

/**
 * Cut [0, frameCount) into segments of `segmentSeconds` (the last one
 * shorter). Segment boundaries depend only on these three numbers, so a
 * resumed render plans exactly the same segments.
 */
export function planSegments(frameCount: number, fps: number, segmentSeconds = DEFAULT_SEGMENT_SECONDS): Segment[] {
  if (!(fps > 0) || !Number.isFinite(fps)) throw new Error(`invalid fps ${fps}`)
  if (!(segmentSeconds > 0) || !Number.isFinite(segmentSeconds)) throw new Error(`invalid segment length ${segmentSeconds}`)
  const total = Math.max(0, Math.floor(frameCount))
  const per = Math.max(1, Math.round(fps * segmentSeconds))
  const out: Segment[] = []
  for (let start = 0, index = 0; start < total; start += per, index++) {
    out.push({ index, startFrame: start, endFrame: Math.min(total, start + per) })
  }
  return out
}

/** Frames needed to cover `durationSeconds` of audio. */
export function frameCountFor(durationSeconds: number, fps: number): number {
  return Math.max(1, Math.ceil(durationSeconds * fps - 1e-6))
}

export function segmentFileName(index: number): string {
  return `seg-${String(index).padStart(5, '0')}.mp4`
}
const PARTIAL_SUFFIX = '.partial'
const SEGMENT_RE = /^seg-\d{5}\.mp4$/
const PARTIAL_RE = /^seg-\d{5}\.mp4\.partial$/

// ---------------------------------------------------------------------------
// ffmpeg arguments

/** Quality settings for moving content: well above the old styles' cq 28 / crf 23. */
const VIZ_ENC: Record<VizEncoder, readonly string[]> = {
  nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', '19', '-b:v', '0',
    '-spatial-aq', '1', '-profile:v', 'high', '-bf', '2'],
  x264: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-profile:v', 'high'],
}

/** Encoder settings as one string, part of the fingerprint: a change re-renders rather than mixes. */
export function encodeSignature(encoder: VizEncoder, fps: number): string {
  return [...VIZ_ENC[encoder], '-g', String(gopFor(fps))].join(' ')
}

function gopFor(fps: number): number {
  return Math.max(1, Math.round(fps * 2))
}

/**
 * Raw RGBA frames on stdin -> one video-only H.264 segment. A fresh encoder
 * starts every segment on an IDR frame; `+cgop` keeps every GOP closed, so no
 * frame references across a segment boundary once they are joined.
 */
export function buildSegmentArgs(o: { width: number; height: number; fps: number; encoder: VizEncoder; outFile: string }): string[] {
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${o.width}x${o.height}`, '-r', String(o.fps), '-i', 'pipe:0',
    '-an',
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    ...VIZ_ENC[o.encoder], '-g', String(gopFor(o.fps)), '-flags', '+cgop',
    '-f', 'mp4', o.outFile,
  ]
}

/**
 * Join the segments (stream copy) and add the audio. `audioArgs` follows the
 * old styles' rule (chooseAudioArgs). A window (preview) seeks the audio and
 * must re-encode it, a copy would not start on the exact sample.
 */
export function buildAssembleArgs(o: {
  listFile: string; audioPath: string; audioArgs: string[]; outFile: string
  audioStart?: number; audioDuration?: number
}): string[] {
  const window = o.audioStart !== undefined
    ? ['-ss', o.audioStart.toFixed(3), ...(o.audioDuration !== undefined ? ['-t', o.audioDuration.toFixed(3)] : [])]
    : []
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', o.listFile,
    ...window, '-i', o.audioPath,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', ...o.audioArgs,
    '-movflags', '+faststart', '-f', 'mp4', o.outFile,
  ]
}

// ---------------------------------------------------------------------------
// encoder choice

/** A tiny encode with the real NVENC settings: does h264_nvenc open, and accept them? */
export async function probeNvenc(ffmpegPath: string): Promise<boolean> {
  try {
    await pExecFile(ffmpegPath, [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=black:s=320x240:r=30', '-frames:v', '5', '-vf', 'format=yuv420p',
      ...VIZ_ENC.nvenc, '-f', 'null', '-',
    ], { timeout: 30_000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

export async function chooseEncoder(ffmpegPath: string, requested: 'auto' | VizEncoder, onLog: (l: string) => void): Promise<VizEncoder> {
  if (requested !== 'auto') return requested
  if (isNvencDisabled()) return 'x264'
  if (await probeNvenc(ffmpegPath)) return 'nvenc'
  markNvencDisabled()
  onLog('mkvid: h264_nvenc did not open, rendering the scene with libx264')
  return 'x264'
}

export async function ffmpegVersion(ffmpegPath: string): Promise<string> {
  const { stdout } = await pExecFile(ffmpegPath, ['-hide_banner', '-version'], { windowsHide: true })
  return stdout.split('\n')[0].trim()
}

// ---------------------------------------------------------------------------
// ffprobe helpers

export interface SegmentInfo { frames: number; bytes: number; extradata: string }

/** Packet count (= frames, video only) and a hash of the parameter sets, used to refuse an unsafe concat. */
export async function probeSegment(ffprobePath: string, file: string): Promise<{ frames: number; extradata: string }> {
  const { stdout } = await pExecFile(ffprobePath, [
    '-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_data_hash', 'sha256',
    '-show_entries', 'stream=nb_read_packets,extradata_hash', '-of', 'json', file,
  ], { windowsHide: true, maxBuffer: 1 << 20 })
  const s = (JSON.parse(stdout).streams ?? [])[0] ?? {}
  return { frames: Number(s.nb_read_packets ?? 0), extradata: String(s.extradata_hash ?? '') }
}

/** Duration of the first video and audio streams (container duration as fallback). */
export async function probeMedia(ffprobePath: string, file: string): Promise<{ video: number | null; audio: number | null; format: number | null }> {
  const { stdout } = await pExecFile(ffprobePath, [
    '-v', 'error', '-show_entries', 'stream=codec_type,duration:format=duration', '-of', 'json', file,
  ], { windowsHide: true, maxBuffer: 1 << 20 })
  const j = JSON.parse(stdout)
  const num = (v: unknown) => (v === undefined || v === null || Number.isNaN(Number(v)) ? null : Number(v))
  const streams: Array<{ codec_type?: string; duration?: string }> = j.streams ?? []
  return {
    video: num(streams.find((s) => s.codec_type === 'video')?.duration),
    audio: num(streams.find((s) => s.codec_type === 'audio')?.duration),
    format: num(j.format?.duration),
  }
}

// ---------------------------------------------------------------------------
// fingerprint + manifest

export interface VizFingerprint {
  audioSize: number
  audioMtimeMs: number
  fps: number
  width: number
  height: number
  segmentSeconds: number
  /** Hash of everything the scene is given besides the audio: titles, tracks, artwork files. */
  inputHash: string
  /** Hash of the scene + analysis code and the fonts: new drawing code never mixes with old segments. */
  sceneVersion: string
  encoder: VizEncoder
  encodeArgs: string
  /** First line of `ffmpeg -version`: a rebuilt ffmpeg may write different parameter sets. */
  ffmpegVersion: string
}

export interface VizManifest {
  version: number
  fingerprint: VizFingerprint
  /** Keyed by segment index. */
  segments: Record<string, SegmentInfo>
}

/**
 * Fingerprint of what the scene draws besides the audio. No path is hashed,
 * only whether a picture is there and its bytes: a failed job's work dir is
 * renamed to the retry's id (adoptKeptWork), and the set artwork lives in it,
 * so a path would make the very same set look like new inputs.
 */
export function hashInput(input: VizInput): string {
  const { audioPath: _audio, setArtworkPath, tracks, ...rest } = input
  const h = createHash('sha256').update(JSON.stringify({
    ...rest,
    setArtwork: !!setArtworkPath,
    tracks: tracks.map(({ artworkPath, ...t }) => ({ ...t, artwork: !!artworkPath })),
  }))
  hashArtworkBytes(h, input, (p) => p)
  return h.digest('hex')
}

function hashArtworkBytes(h: ReturnType<typeof createHash>, input: VizInput, read: (p: string) => string): void {
  // Hash the bytes so a replaced file counts as a change.
  for (const p of [input.setArtworkPath, ...input.tracks.map((t) => t.artworkPath)]) {
    if (!p) continue
    try { h.update(readFileSync(read(p))) } catch { h.update('missing') }
  }
}

/**
 * hashInput as it was before paths were left out (the path strings were
 * hashed too). Only to recognise manifests and rendered.json stamps written
 * by that version; `read` maps a stored path to where the file is now.
 */
export function legacyHashInput(input: VizInput, read: (p: string) => string = (p) => p): string {
  const { audioPath: _audio, ...rest } = input
  const h = createHash('sha256').update(JSON.stringify(rest))
  for (const p of [input.setArtworkPath, ...input.tracks.map((t) => t.artworkPath)]) {
    if (!p) continue
    try { h.update(readFileSync(read(p))) } catch { h.update(`missing:${p}`) }
  }
  return h.digest('hex')
}

/** `p` moved from under `fromDir` to under `toDir`; any other path (the shared artwork cache) is left alone. */
export function rebasePath(p: string, fromDir: string, toDir: string): string {
  const from = fromDir.replace(/[\\/]+$/, '')
  return p === from ? toDir : p.startsWith(from + '/') || p.startsWith(from + '\\') ? join(toDir, p.slice(from.length + 1)) : p
}

/** The scene input with every path under `fromDir` moved to `toDir` (a work dir renamed to another job's id). */
export function rebaseVizInput(input: VizInput, fromDir: string, toDir: string): VizInput {
  const r = (p: string | null) => (p ? rebasePath(p, fromDir, toDir) : p)
  return {
    ...input,
    audioPath: rebasePath(input.audioPath, fromDir, toDir),
    setArtworkPath: r(input.setArtworkPath),
    tracks: input.tracks.map((t) => ({ ...t, artworkPath: r(t.artworkPath) })),
  }
}

function hashTree(h: ReturnType<typeof createHash>, root: string, dir = root): void {
  if (!existsSync(dir)) return
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) hashTree(h, root, p)
    else if (e.isFile()) h.update(relative(root, p).replace(/\\/g, '/')).update(readFileSync(p))
  }
}

let cachedSceneVersion: string | null = null
/**
 * Hash of the code and data that decide the pixels: scene/, analysis, and
 * the bundled fonts. Works from src/ (tsx) and dist/ (compiled) alike.
 */
export function sceneCodeVersion(): string {
  if (cachedSceneVersion) return cachedSceneVersion
  const here = dirname(fileURLToPath(import.meta.url))
  const h = createHash('sha256')
  hashTree(h, join(here, 'scene'))
  for (const f of ['analysis.ts', 'analysis.js']) {
    const p = join(here, f)
    if (existsSync(p)) h.update(f).update(readFileSync(p))
  }
  hashTree(h, process.env.MKVID_FONTS_DIR || join(here, '..', '..', 'assets', 'fonts'))
  cachedSceneVersion = h.digest('hex').slice(0, 16)
  return cachedSceneVersion
}

export function sameFingerprint(a: VizFingerprint, b: VizFingerprint): boolean {
  const keys = Object.keys(b) as Array<keyof VizFingerprint>
  return keys.length === Object.keys(a).length && keys.every((k) => a[k] === b[k])
}

export function manifestPath(vizDir: string): string { return join(vizDir, 'manifest.json') }

export function readManifest(vizDir: string): VizManifest | null {
  try {
    const m = JSON.parse(readFileSync(manifestPath(vizDir), 'utf8')) as VizManifest
    return m && m.version === MANIFEST_VERSION && m.fingerprint && m.segments ? m : null
  } catch {
    return null
  }
}

export function writeManifest(vizDir: string, m: VizManifest): void {
  const tmp = manifestPath(vizDir) + '.tmp'
  writeFileSync(tmp, JSON.stringify(m, null, 1))
  renameSync(tmp, manifestPath(vizDir))
}

const ANALYSIS_FILE = 'analysis.bin'

/**
 * Load the manifest for this fingerprint. A mismatch (or none) throws away
 * every segment and the saved analysis; partial files are always removed.
 * Recorded segments whose file is missing or has a different size are
 * forgotten (they will be rendered again).
 */
export function openManifest(vizDir: string, fp: VizFingerprint, onLog: (l: string) => void = () => {}): VizManifest {
  mkdirSync(vizDir, { recursive: true })
  const old = readManifest(vizDir)
  const keep = old !== null && sameFingerprint(old.fingerprint, fp)
  if (old && !keep) {
    const diff = (Object.keys(fp) as Array<keyof VizFingerprint>).filter((k) => old.fingerprint[k] !== fp[k])
    onLog(`viz: inputs changed (${diff.join(', ') || 'manifest format'}), discarding ${Object.keys(old.segments).length} finished segment(s)`)
  }
  for (const f of readdirSync(vizDir)) {
    const drop = PARTIAL_RE.test(f) || f.endsWith('.tmp') || (!keep && (SEGMENT_RE.test(f) || f === ANALYSIS_FILE))
    if (drop) rmSync(join(vizDir, f), { force: true })
  }
  const m: VizManifest = { version: MANIFEST_VERSION, fingerprint: fp, segments: {} }
  if (keep) {
    for (const [k, info] of Object.entries(old!.segments)) {
      const p = join(vizDir, segmentFileName(Number(k)))
      try {
        if (statSync(p).size === info.bytes) m.segments[k] = info
      } catch { /* missing: render again */ }
    }
  }
  writeManifest(vizDir, m)
  return m
}

// ---------------------------------------------------------------------------
// drawing workers

function workerSpec(): { url: URL; execArgv?: string[] } {
  if (!import.meta.url.endsWith('.ts')) return { url: new URL('./render-worker.js', import.meta.url) }
  // Running from source (tsx, vitest): the worker is TypeScript too. Under
  // the tsx CLI the loader is already in execArgv and workers inherit it;
  // otherwise (vitest) register tsx explicitly.
  const url = new URL('./render-worker.ts', import.meta.url)
  if (process.execArgv.some((a) => a.includes('tsx'))) return { url }
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
  return { url, execArgv: ['--import', tsx] }
}

interface Deferred { resolve: (b: Buffer) => void; reject: (e: Error) => void }

/** N workers, each drawing at most two frames ahead; frames are requested by index and delivered as Buffers. */
class DrawPool {
  private workers: Array<{ w: Worker; inflight: number; ready: boolean }> = []
  private queue: number[] = []
  private waiting = new Map<number, Deferred>()
  private failure: Error | null = null
  private closed = false
  readonly ready: Promise<void>

  constructor(count: number, init: { input: VizInput; analysisPath: string | null; sceneModule: string | null }) {
    const spec = workerSpec()
    const readies: Promise<void>[] = []
    for (let i = 0; i < count; i++) {
      const w = new Worker(spec.url, { workerData: init, execArgv: spec.execArgv })
      const slot = { w, inflight: 0, ready: false }
      this.workers.push(slot)
      readies.push(new Promise<void>((resolve, reject) => {
        w.on('message', (m: any) => {
          if (m.type === 'ready') { slot.ready = true; resolve(); this.pump() }
          else if (m.type === 'frame') {
            slot.inflight--
            const d = this.waiting.get(m.frame)
            this.waiting.delete(m.frame)
            d?.resolve(Buffer.from(m.data as ArrayBuffer))
            this.pump()
          } else if (m.type === 'error') {
            const e = new Error(`render worker: ${m.message}`)
            reject(e); this.fail(e)
          }
        })
        w.on('error', (e: any) => { const err = new Error(`render worker crashed: ${e?.stack || e}`); reject(err); this.fail(err) })
        w.on('exit', (code) => {
          if (!this.closed) { const err = new Error(`render worker exited (code ${code})`); reject(err); this.fail(err) }
        })
      }))
    }
    this.ready = Promise.all(readies).then(() => undefined)
    this.ready.catch(() => {})
  }

  request(frame: number): Promise<Buffer> {
    if (this.failure) return Promise.reject(this.failure)
    const p = new Promise<Buffer>((resolve, reject) => this.waiting.set(frame, { resolve, reject }))
    this.queue.push(frame)
    this.pump()
    return p
  }

  private pump(): void {
    while (this.queue.length && !this.failure) {
      let best: (typeof this.workers)[number] | null = null
      for (const s of this.workers) if (s.ready && s.inflight < 2 && (!best || s.inflight < best.inflight)) best = s
      if (!best) return
      best.inflight++
      best.w.postMessage({ type: 'draw', frame: this.queue.shift()! })
    }
  }

  fail(e: Error): void {
    if (this.failure) return
    this.failure = e
    for (const d of this.waiting.values()) d.reject(e)
    this.waiting.clear()
    this.queue = []
  }

  get error(): Error | null { return this.failure }

  async close(): Promise<void> {
    this.closed = true
    await Promise.all(this.workers.map((s) => s.w.terminate().catch(() => 0)))
  }
}

// ---------------------------------------------------------------------------
// segment encoding

export interface RenderSegmentsOptions {
  input: VizInput
  analysisPath: string | null
  /** file:// URL of a module exporting createScene (tests); default is the real scene. */
  sceneModule?: string | null
  segments: Segment[]
  /** Where seg-*.mp4 are written. */
  dir: string
  ffmpegPath: string
  ffprobePath: string
  encoder: VizEncoder
  workers: number
  encodeSessions: number
  /** Called after a segment's file is in place (renamed from .partial). */
  onSegmentDone?: (seg: Segment, info: SegmentInfo) => void
  /** Called for every frame handed to an encoder. */
  onFrame?: () => void
  /** Fail when no frame reaches an encoder for this long (a hung ffmpeg or driver). Default 10 min. */
  stallMs?: number
}

/** Render + encode the given segments, `encodeSessions` at a time, drawing on every worker. */
export async function renderSegments(o: RenderSegmentsOptions): Promise<void> {
  if (o.segments.length === 0) return
  const totalFrames = o.segments.reduce((n, s) => n + s.endFrame - s.startFrame, 0)
  const workers = Math.max(1, Math.min(o.workers, totalFrames))
  const lanes = Math.max(1, Math.min(o.encodeSessions, o.segments.length))
  // Frames requested ahead per encoder: enough to keep every worker busy, bounded memory (~2 frames per worker).
  const lookahead = Math.max(2, Math.ceil((workers * 2 + 2) / lanes))
  mkdirSync(o.dir, { recursive: true })

  const pool = new DrawPool(workers, { input: o.input, analysisPath: o.analysisPath, sceneModule: o.sceneModule ?? null })
  const procs = new Set<ReturnType<typeof spawn>>()
  const todo = [...o.segments].sort((a, b) => a.index - b.index)

  async function encode(seg: Segment): Promise<SegmentInfo> {
    const final = join(o.dir, segmentFileName(seg.index))
    const partial = final + PARTIAL_SUFFIX
    const proc = spawn(o.ffmpegPath, buildSegmentArgs({ width: o.input.width, height: o.input.height, fps: o.input.fps, encoder: o.encoder, outFile: partial }),
      { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    procs.add(proc)
    let stderr = ''
    let exited = false
    let exitCode: number | null = null
    let spawnError: Error | null = null
    proc.stderr!.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000) })
    proc.stdin!.on('error', () => { /* EPIPE: reported through the exit code */ })
    const exit = new Promise<void>((resolve) => {
      proc.on('error', (e) => { spawnError = e; exited = true; resolve() })
      proc.on('close', (code) => { exitCode = code; exited = true; resolve() })
    })
    const died = () => new Error(spawnError ? `ffmpeg: ${spawnError.message}` : `ffmpeg exit ${exitCode} (segment ${seg.index}): ${stderr.trim().slice(-1500)}`)
    const drain = () => new Promise<void>((resolve) => {
      const done = () => { proc.stdin!.off('drain', done); proc.off('close', done); resolve() }
      proc.stdin!.on('drain', done)
      proc.on('close', done)
    })
    try {
      const pending: Promise<Buffer>[] = []
      let next = seg.startFrame
      for (let f = seg.startFrame; f < seg.endFrame; f++) {
        while (next < seg.endFrame && next - f < lookahead) {
          const p = pool.request(next++)
          p.catch(() => {})
          pending.push(p)
        }
        const buf = await pending.shift()!
        if (exited) throw died()
        if (!proc.stdin!.write(buf)) await drain()
        if (exited) throw died()
        lastProgress = Date.now()
        o.onFrame?.()
      }
      proc.stdin!.end()
      await exit
      if (spawnError || exitCode !== 0) throw died()
      const probed = await probeSegment(o.ffprobePath, partial)
      const want = seg.endFrame - seg.startFrame
      if (probed.frames !== want) throw new Error(`segment ${seg.index}: encoded ${probed.frames} frames, expected ${want}`)
      renameSync(partial, final)
      return { ...probed, bytes: statSync(final).size }
    } catch (e) {
      if (!exited) proc.kill('SIGKILL')
      await exit
      rmSync(partial, { force: true })
      throw e
    } finally {
      procs.delete(proc)
    }
  }

  let firstError: Error | null = null
  let lastProgress = Date.now()
  const stallMs = o.stallMs ?? 10 * 60_000
  const watchdog = setInterval(() => {
    if (Date.now() - lastProgress <= stallMs) return
    const e = new Error(`viz: render stalled, no frame encoded for ${Math.round(stallMs / 1000)}s`)
    firstError ??= e
    pool.fail(e)
    for (const p of procs) p.kill('SIGKILL')
  }, Math.max(50, Math.min(30_000, stallMs / 4)))
  watchdog.unref()

  async function lane(): Promise<void> {
    while (todo.length && !firstError) {
      const seg = todo.shift()!
      try {
        const info = await encode(seg)
        o.onSegmentDone?.(seg, info)
      } catch (e: any) {
        const err = pool.error ?? (e instanceof Error ? e : new Error(String(e)))
        firstError ??= err
        pool.fail(err)
      }
    }
  }

  try {
    await pool.ready
    await Promise.all(Array.from({ length: lanes }, () => lane()))
  } catch (e: any) {
    firstError ??= e instanceof Error ? e : new Error(String(e))
  } finally {
    clearInterval(watchdog)
    for (const p of procs) p.kill('SIGKILL')
    await pool.close()
  }
  if (firstError) throw firstError
}

// ---------------------------------------------------------------------------
// assemble

/** Concat list next to the segments, with relative names (no path quoting issues on Windows). */
export function writeConcatList(dir: string, segments: Segment[]): string {
  const listFile = join(dir, 'concat.txt')
  const body = [...segments].sort((a, b) => a.index - b.index).map((s) => `file '${segmentFileName(s.index)}'`).join('\n') + '\n'
  writeFileSync(listFile, body)
  return listFile
}

export function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let stderr = ''
    p.stderr!.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000) })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.trim().slice(-2000)}`))))
  })
}

/** Join `segments` from `dir` with the audio into `outFile` (via a temp name). */
export async function assemble(o: {
  dir: string; segments: Segment[]; infos: Record<string, SegmentInfo>
  audioPath: string; audioArgs: string[]; outFile: string; ffmpegPath: string
  audioStart?: number; audioDuration?: number
}): Promise<void> {
  const hashes = new Set(o.segments.map((s) => o.infos[String(s.index)]?.extradata))
  if (hashes.size > 1) throw new Error('viz: segments have different H.264 parameter sets and cannot be joined; delete the work dir to re-render')
  const listFile = writeConcatList(o.dir, o.segments)
  const tmp = join(o.dir, 'assembled.mp4.partial')
  try {
    await runFfmpeg(o.ffmpegPath, buildAssembleArgs({ listFile, audioPath: o.audioPath, audioArgs: o.audioArgs, outFile: tmp, audioStart: o.audioStart, audioDuration: o.audioDuration }))
    rmSync(o.outFile, { force: true })
    renameSync(tmp, o.outFile)
  } finally {
    rmSync(tmp, { force: true })
  }
}

/**
 * The result must be as long as the audio: a missing or truncated segment
 * would show here. The video may run a frame or two past the audio (the
 * analysis covers the last partial frame), hence the tolerance.
 */
export async function verifyDuration(ffprobePath: string, file: string, audioSeconds: number, fps: number): Promise<void> {
  const d = await probeMedia(ffprobePath, file)
  const video = d.video ?? d.format
  const tolerance = 0.5 + 2 / fps
  if (video === null || Math.abs(video - audioSeconds) > tolerance) {
    throw new Error(`viz: rendered video is ${video?.toFixed(2) ?? '?'}s, audio is ${audioSeconds.toFixed(2)}s`)
  }
  if (d.audio !== null && Math.abs(d.audio - audioSeconds) > tolerance) {
    throw new Error(`viz: muxed audio is ${d.audio.toFixed(2)}s, expected ${audioSeconds.toFixed(2)}s`)
  }
}

// ---------------------------------------------------------------------------
// colour self-test

/**
 * Draw four known colours with the real canvas (@napi-rs/canvas), encode them
 * exactly like a segment, decode one frame and compare. Catches a platform
 * whose canvas hands out BGRA instead of RGBA, or a wrong colour matrix.
 * Runs anywhere ffmpeg does: `node dist/viz/preview.js --selftest` in the container.
 */
export async function colourSelfTest(o: { ffmpegPath: string; encoder?: VizEncoder; dir: string }): Promise<{ ok: boolean; details: string[] }> {
  const { createCanvas } = await import('@napi-rs/canvas')
  const W = 256, H = 144
  const colours: Array<[string, [number, number, number]]> = [
    ['red', [220, 30, 30]], ['green', [30, 200, 60]], ['blue', [40, 60, 220]], ['yellow', [230, 210, 40]],
  ]
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  colours.forEach(([, [r, g, b]], i) => {
    ctx.fillStyle = `rgb(${r},${g},${b})`
    ctx.fillRect((i % 2) * (W / 2), Math.floor(i / 2) * (H / 2), W / 2, H / 2)
  })
  const rgba = Buffer.from(canvas.data())
  mkdirSync(o.dir, { recursive: true })
  const file = join(o.dir, 'colour-selftest.mp4')
  await new Promise<void>((resolve, reject) => {
    const p = spawn(o.ffmpegPath, buildSegmentArgs({ width: W, height: H, fps: 30, encoder: o.encoder ?? 'x264', outFile: file }), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    let err = ''
    p.stderr!.on('data', (d) => { err += d.toString() })
    p.stdin!.on('error', () => {})
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-500)}`))))
    for (let i = 0; i < 5; i++) p.stdin!.write(rgba)
    p.stdin!.end()
  })
  const { stdout } = await pExecFile(o.ffmpegPath, ['-v', 'error', '-i', file, '-frames:v', '1',
    '-vf', 'scale=in_color_matrix=bt709:in_range=tv,format=rgb24', '-f', 'rawvideo', 'pipe:1'],
  { encoding: 'buffer', windowsHide: true, maxBuffer: 1 << 22 })
  rmSync(file, { force: true })
  const px = stdout as unknown as Buffer
  const details: string[] = []
  let ok = px.length === W * H * 3
  if (!ok) details.push(`decoded ${px.length} bytes, expected ${W * H * 3}`)
  colours.forEach(([name, want], i) => {
    if (!ok && px.length !== W * H * 3) return
    const x = (i % 2) * (W / 2) + W / 4, y = Math.floor(i / 2) * (H / 2) + H / 4
    const got = [...px.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)]
    const good = got.every((v, c) => Math.abs(v - want[c]) <= 20)
    ok &&= good
    details.push(`${name}: drew ${want.join(',')} got ${got.join(',')} ${good ? 'ok' : 'WRONG'}`)
  })
  return { ok, details }
}

// ---------------------------------------------------------------------------
// the whole job

export interface PreparedAnalysis {
  /** Saved analysis the workers load; null only for injected test scenes. */
  path: string | null
  frameCount: number
}

/**
 * Default analysis step: reuse vizDir/analysis.bin when the manifest kept it,
 * else analyse the audio and save it (via a temp name).
 */
export async function prepareAnalysis(o: { input: VizInput; vizDir: string; ffmpegPath: string; onLog: (l: string) => void }): Promise<PreparedAnalysis> {
  const mod = await import('./analysis.js')
  const path = join(o.vizDir, ANALYSIS_FILE)
  if (existsSync(path)) {
    try {
      const a = await mod.loadAnalysis(path)
      if (a.fps === o.input.fps) return { path, frameCount: a.frameCount }
    } catch (e: any) {
      o.onLog(`viz: saved analysis unreadable (${String(e?.message || e)}), analysing again`)
    }
  }
  o.onLog('viz: analysing audio')
  const t0 = Date.now()
  const a = await mod.analyzeAudio(o.input.audioPath, { fps: o.input.fps, ffmpegPath: o.ffmpegPath })
  const tmp = path + '.tmp'
  await mod.saveAnalysis(a, tmp)
  renameSync(tmp, path)
  o.onLog(`viz: analysis done in ${((Date.now() - t0) / 1000).toFixed(1)}s (${a.frameCount} frames)`)
  return { path, frameCount: a.frameCount }
}

export interface RenderSceneOptions {
  input: VizInput
  /** Segments, manifest and analysis live here; kept across restarts. */
  vizDir: string
  outFile: string
  /** From chooseAudioArgs(codec): the same rule as the old styles. */
  audioArgs: string[]
  ffmpegPath: string
  ffprobePath: string
  workers?: number
  encodeSessions?: number
  segmentSeconds?: number
  encoder?: 'auto' | VizEncoder
  /** Tests: a fake scene module and a stand-in for the analysis step. */
  sceneModule?: string | null
  sceneVersion?: string
  analyze?: (o: { input: VizInput; vizDir: string; ffmpegPath: string; onLog: (l: string) => void }) => Promise<PreparedAnalysis>
  /**
   * Runs each stage (analyse, render, assemble) of this job; the pipeline
   * passes its stage gate so no two jobs run the same stage at once.
   * Default: run it.
   */
  gate?: <T>(stage: 'analyse' | 'render' | 'assemble', fn: () => Promise<T>) => Promise<T>
}

const ungated = <T>(_stage: string, fn: () => Promise<T>): Promise<T> => fn()

/**
 * Render the whole set to `outFile`, resuming from whatever segments a
 * previous run of the same inputs finished. `onProgress` gets a 0..1 fraction.
 */
export async function renderScene(o: RenderSceneOptions, onProgress: (fraction: number) => void, onLog: (line: string) => void): Promise<void> {
  const { input } = o
  const segmentSeconds = o.segmentSeconds ?? DEFAULT_SEGMENT_SECONDS
  mkdirSync(o.vizDir, { recursive: true })
  const gate = o.gate ?? ungated

  const { encoder, manifest, analysis } = await gate('analyse', async () => {
    const encoder = await chooseEncoder(o.ffmpegPath, o.encoder ?? 'auto', onLog)
    const st = statSync(input.audioPath)
    const fp: VizFingerprint = {
      audioSize: st.size, audioMtimeMs: Math.round(st.mtimeMs), fps: input.fps, width: input.width, height: input.height,
      segmentSeconds, inputHash: hashInput(input), sceneVersion: o.sceneVersion ?? sceneCodeVersion(),
      encoder, encodeArgs: encodeSignature(encoder, input.fps), ffmpegVersion: await ffmpegVersion(o.ffmpegPath),
    }
    const manifest = openManifest(o.vizDir, fp, onLog)

    const analysis = await (o.analyze ?? prepareAnalysis)({ input, vizDir: o.vizDir, ffmpegPath: o.ffmpegPath, onLog })
    return { encoder, manifest, analysis }
  })
  const segments = planSegments(analysis.frameCount, input.fps, segmentSeconds)
  const isDone = (s: Segment) => manifest.segments[String(s.index)]?.frames === s.endFrame - s.startFrame
  const todo = segments.filter((s) => !isDone(s))
  // Forget anything recorded that is not part of this plan.
  for (const k of Object.keys(manifest.segments)) if (!segments.some((s) => String(s.index) === k && isDone(s))) delete manifest.segments[k]
  writeManifest(o.vizDir, manifest)

  const total = analysis.frameCount
  let framesDone = segments.filter(isDone).reduce((n, s) => n + s.endFrame - s.startFrame, 0)
  const workers = o.workers ?? defaultWorkerCount()
  const sessions = o.encodeSessions ?? 2
  await gate('render', async () => {
    onLog(`viz: ${segments.length} segment(s), ${segments.length - todo.length} already done; ${encoder}, ${workers} drawing worker(s), ${sessions} encode session(s)`)

    let lastPermille = -1
    const report = () => {
      const f = total > 0 ? (framesDone / total) * RENDER_SHARE : RENDER_SHARE
      const permille = Math.floor(f * 1000)
      if (permille !== lastPermille) { lastPermille = permille; onProgress(f) }
    }
    report()

    const t0 = Date.now()
    let framesThisRun = 0
    await renderSegments({
      input, analysisPath: analysis.path, sceneModule: o.sceneModule, segments: todo, dir: o.vizDir,
      ffmpegPath: o.ffmpegPath, ffprobePath: o.ffprobePath, encoder, workers, encodeSessions: sessions,
      onFrame: () => { framesDone++; framesThisRun++; report() },
      onSegmentDone: (seg, info) => {
        manifest.segments[String(seg.index)] = info
        writeManifest(o.vizDir, manifest)
        const secs = (Date.now() - t0) / 1000
        const fps = framesThisRun / Math.max(secs, 1e-3)
        const eta = fps > 0 ? (total - framesDone) / fps : 0
        onLog(`viz: segment ${seg.index + 1}/${segments.length} done (${fps.toFixed(1)} fps, ~${Math.round(eta / 60)} min left)`)
      },
    })
  })

  await gate('assemble', async () => {
    onLog('viz: assembling')
    await assemble({ dir: o.vizDir, segments, infos: manifest.segments, audioPath: input.audioPath, audioArgs: o.audioArgs, outFile: o.outFile, ffmpegPath: o.ffmpegPath })
    await verifyDuration(o.ffprobePath, o.outFile, input.durationSeconds, input.fps)
  })
  onProgress(1)
}
