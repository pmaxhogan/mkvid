import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, renameSync, statSync, statfsSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import type { AppContext } from '../context.js'
import type { Job, SseMessage, TrackedTrackMeta, UploadAccount } from '../types.js'
import type { VizInput } from '../viz/types.js'
import { renderScene, hashInput, legacyHashInput, rebasePath, rebaseVizInput, readManifest, writeManifest, sceneCodeVersion, VIZ_AUDIO_ARGS } from '../viz/render.js'
import { downloadSetArtwork, fetchArtwork, resolveVizTracks, vizTracksFromTracked } from '../viz/assets.js'
import { previewClipError, unverifiedTrackedScene } from './tracked.js'
import { renderTrackVideo } from './track-render.js'
import { downloadAudio } from './ytdlp.js'
import { probeAudio } from './probe.js'
import { chooseFps, chooseAudioArgs, renderVideo } from './ffmpeg.js'
import { getValidAccessToken, UPLOAD_MIN_VALID_MS } from './google-oauth.js'
import { uploadVideo, addToPlaylist, type TokenGetter, type UploadThroughput } from './youtube.js'
import { sendPush } from './push.js'
import { UPLOAD_PREFIX, sanitizeUploadName } from './upload.js'
import { log } from './log.js'
import { describeJob } from './describe.js'
import type { GateStage } from './stage-gate.js'

export { describeJob, recordingLink } from './describe.js'

// ---------------------------------------------------------------------------
// scene style: resumable state in <workDir>/viz

/**
 * Everything the scene renderer keeps lives in this subdirectory of the job's
 * work dir, never next to the audio: yt-dlp's file picker takes the first
 * file in the work dir as the download. It is only created after the
 * download, and a resumed job skips the download.
 */
export const VIZ_DIR = 'viz'

interface SourceRecord { file: string; title: string; size: number; pageUrl?: string | null }

/** The downloaded audio of a scene job, recorded so a resumed job (or a retry adopting its work) can skip the download. */
export function readSourceRecord(workDir: string): { file: string; title: string; pageUrl: string | null } | null {
  try {
    const r = JSON.parse(readFileSync(join(workDir, VIZ_DIR, 'source.json'), 'utf8')) as SourceRecord
    // A bare file name inside the work dir, still the same size as when it was downloaded.
    if (typeof r.file !== 'string' || r.file !== basename(r.file) || typeof r.title !== 'string') return null
    const file = join(workDir, r.file)
    const pageUrl = typeof r.pageUrl === 'string' && r.pageUrl ? r.pageUrl : null
    return statSync(file).size === r.size ? { file, title: r.title, pageUrl } : null
  } catch {
    return null
  }
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file + '.tmp', JSON.stringify(value, null, 1))
  renameSync(file + '.tmp', file)
}

export function writeSourceRecord(workDir: string, file: string, title: string, pageUrl: string | null = null): void {
  mkdirSync(join(workDir, VIZ_DIR), { recursive: true })
  writeJson(join(workDir, VIZ_DIR, 'source.json'), { file: basename(file), title, size: statSync(file).size, pageUrl } satisfies SourceRecord)
}

/**
 * Boot-time check (context.ts): should this job, found mid-run after a
 * restart, go back on the queue instead of becoming `interrupted`? Only a
 * scene job whose audio is downloaded and that has no video yet. A job that
 * keeps killing the process must not loop, but a long render may see many
 * image updates: only resumes after which no new segment was finished count,
 * and `maxResumes` of those in a row end it. Counts the attempt.
 *
 * A job whose render is complete (out.mp4 matches rendered.json: it was
 * waiting for or running the upload) is always resumed and never counted:
 * it cannot finish a new segment, so the rule would otherwise end it — and
 * delete hours of rendering — after a few deploys while it waits to upload.
 */
export function claimSceneResume(job: Job, workDir: string, maxResumes: number): boolean {
  if (job.style !== 'scene' || job.videoId) return false
  const source = readSourceRecord(workDir)
  if (!source) return false
  if (isRenderComplete(workDir, source.file)) return true
  const counter = join(workDir, VIZ_DIR, 'resumes.json')
  let done = 0
  try { done = Object.keys(JSON.parse(readFileSync(join(workDir, VIZ_DIR, 'manifest.json'), 'utf8')).segments ?? {}).length } catch { /* none yet */ }
  let count = 0
  let lastDone = -1
  try {
    const r = JSON.parse(readFileSync(counter, 'utf8'))
    count = Number(r.count) || 0
    lastDone = Number.isInteger(r.segments) ? r.segments : -1
  } catch { /* first resume */ }
  if (done > lastDone && lastDone >= 0) count = 0 // progress since the last resume
  if (count >= maxResumes) return false
  writeJson(counter, { count: count + 1, segments: done })
  return true
}

/** The scene's input as first resolved: reused on resume so a flaky artwork download cannot change the pixels. */
export function loadVizInput(vizDir: string, audioPath: string): VizInput | null {
  try {
    const input = JSON.parse(readFileSync(join(vizDir, 'input.json'), 'utf8')) as VizInput
    if (input.audioPath !== audioPath) return null
    const pics = [input.setArtworkPath, ...input.tracks.map((t) => t.artworkPath)].filter((p): p is string => !!p)
    return pics.every((p) => existsSync(p)) ? input : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// scene style: failures keep the work, retries resume it

/**
 * Free space on the volume holding `dir`, in bytes. A 4 h scene render needs
 * about 30 GB of segments plus as much again while they are joined.
 */
export function freeBytes(dir: string): number {
  const s = statfsSync(dir)
  return Number(s.bavail) * Number(s.bsize)
}

/** Refuse to start a scene render on a nearly full data volume. The message is retryable for tracked (no "not available"/404-like words). */
export function ensureFreeSpace(dir: string, minGb: number, free: (d: string) => number = freeBytes): void {
  if (!(minGb > 0)) return
  const have = free(dir)
  if (have < minGb * 1e9) {
    throw new Error(`insufficient disk space: ${(have / 1e9).toFixed(1)} GB free on the data volume, a scene render needs at least ${minGb} GB (VIZ_MIN_FREE_GB); retry once space is freed`)
  }
}

const KEPT_FILE = 'kept.json'
const RENDERED_FILE = 'rendered.json'

/**
 * Is the scene job's out.mp4 a finished render of its saved input (the stamp
 * renderSceneForJob writes once the video is assembled)? Then a resume skips
 * straight to the upload.
 */
export function isRenderComplete(workDir: string, audioPath: string): boolean {
  const vizDir = join(workDir, VIZ_DIR)
  try {
    const r = JSON.parse(readFileSync(join(vizDir, RENDERED_FILE), 'utf8'))
    const input = loadVizInput(vizDir, audioPath)
    if (!input || r?.sceneVersion !== sceneCodeVersion()) return false
    if (r.inputHash !== hashInput(input) && r.inputHash !== legacyHashInput(input)) return false
    return statSync(join(workDir, 'out.mp4')).size === r.bytes
  } catch {
    return false
  }
}

/**
 * Stamps (manifest fingerprint, rendered.json) written with an input hash
 * from before hashInput left paths out are moved to the current hash, so an
 * upgrade does not throw away finished segments or a finished out.mp4.
 */
export function migrateInputStamps(vizDir: string, legacyHash: string, currentHash: string): void {
  if (legacyHash === currentHash) return
  const m = readManifest(vizDir)
  if (m && m.fingerprint.inputHash === legacyHash) writeManifest(vizDir, { ...m, fingerprint: { ...m.fingerprint, inputHash: currentHash } })
  try {
    const file = join(vizDir, RENDERED_FILE)
    const r = JSON.parse(readFileSync(file, 'utf8'))
    if (r?.inputHash === legacyHash) writeJson(file, { ...r, inputHash: currentHash })
  } catch { /* none */ }
}

/**
 * A kept work dir was renamed from `oldDir` to `workDir`: point the saved
 * scene input (audio, set artwork in viz/) at the new dir, so loadVizInput
 * takes it and its hash (hence the segments and out.mp4) still matches.
 */
export function rebaseKeptInput(oldDir: string, workDir: string): void {
  const file = join(workDir, VIZ_DIR, 'input.json')
  let stored: VizInput
  try { stored = JSON.parse(readFileSync(file, 'utf8')) as VizInput } catch { return }
  const moved = rebaseVizInput(stored, oldDir, workDir)
  migrateInputStamps(join(workDir, VIZ_DIR), legacyHashInput(stored, (p) => rebasePath(p, oldDir, workDir)), hashInput(moved))
  writeJson(file, moved)
}

/** Mark a failed scene job's work dir as kept for a retry (pruneKeptWork decides how long). */
export function markKept(workDir: string, stage: string): void {
  mkdirSync(join(workDir, VIZ_DIR), { recursive: true })
  writeJson(join(workDir, VIZ_DIR, KEPT_FILE), { keptAt: Date.now(), stage })
}

function keptAt(workDir: string): number | null {
  try {
    const t = Number(JSON.parse(readFileSync(join(workDir, VIZ_DIR, KEPT_FILE), 'utf8')).keptAt)
    return Number.isFinite(t) ? t : null
  } catch {
    return null
  }
}

function dirBytes(dir: string): number {
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    try { n += e.isDirectory() ? dirBytes(p) : statSync(p).size } catch { /* vanished */ }
  }
  return n
}

/** Is this work dir one that a failed scene job keeps for a retry? */
export function isKeptWork(ctx: AppContext, id: string): boolean {
  const job = ctx.jobs.get(id)
  return !!job && job.status === 'failed' && job.style === 'scene' && keptAt(join(ctx.config.dataDir, 'work', id)) !== null
}

/**
 * Drop kept work dirs of failed scene jobs that are older than
 * VIZ_KEEP_HOURS, then the oldest ones until all kept dirs together fit in
 * VIZ_KEEP_GB. Never touches the dir of a job that is not failed.
 * Returns the ids whose dirs were removed.
 */
export function pruneKeptWork(ctx: AppContext, nowMs = Date.now()): string[] {
  const root = join(ctx.config.dataDir, 'work')
  const { keepHours, keepGb } = ctx.config.viz
  let names: string[] = []
  try { names = readdirSync(root) } catch { return [] }
  const kept = names.filter((id) => isKeptWork(ctx, id))
    .map((id) => ({ id, at: keptAt(join(root, id))!, bytes: dirBytes(join(root, id)) }))
    .sort((a, b) => b.at - a.at)
  const removed: string[] = []
  let total = 0
  for (const k of kept) {
    total += k.bytes
    if (nowMs - k.at > keepHours * 3_600_000 || total > keepGb * 1e9) {
      try { rmSync(join(root, k.id), { recursive: true, force: true }) } catch { /* ignore */ }
      removed.push(k.id)
      total -= k.bytes
      log('info', 'dropped kept scene work', { jobId: k.id, gb: +(k.bytes / 1e9).toFixed(2) })
    }
  }
  return removed
}

/**
 * tracked retries a failed request as a new job. When the last failed scene
 * job for the same request (and the same audio URL) kept its work, move it
 * over, so the new job resumes its segments or re-uploads its finished video.
 * A changed track list keeps the segments' audio but rebuilds the scene input
 * (the manifest fingerprint then decides what is still valid).
 */
export function adoptKeptWork(ctx: AppContext, job: Job, workDir: string, logLine: (l: string) => void): boolean {
  const requestId = job.meta?.origin === 'tracked' ? job.meta.requestId : null
  if (job.style !== 'scene' || !requestId || readSourceRecord(workDir)) return false
  for (const old of ctx.jobs.failedSceneJobsForRequest(requestId, job.id)) {
    const oldDir = join(ctx.config.dataDir, 'work', old.id)
    if (old.url !== job.url || keptAt(oldDir) === null || !readSourceRecord(oldDir)) continue
    rmSync(workDir, { recursive: true, force: true })
    renameSync(oldDir, workDir)
    rmSync(join(workDir, VIZ_DIR, KEPT_FILE), { force: true })
    rmSync(join(workDir, VIZ_DIR, 'resumes.json'), { force: true })
    const listOf = (j: Job) => j.meta?.origin === 'tracked' ? [j.meta.tracks ?? null, j.meta.tracksTrusted ?? null] : [null, null]
    const sameTracks = JSON.stringify(listOf(old)) === JSON.stringify(listOf(job))
    if (!sameTracks) rmSync(join(workDir, VIZ_DIR, 'input.json'), { force: true })
    else rebaseKeptInput(oldDir, workDir)
    logLine(`reusing the kept work of failed job ${old.id}${sameTracks ? '' : ' (track list changed: scene input rebuilt)'}`)
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// upload throughput: what one upload gets, and how many ran beside it

const MB = 1e6

/** Uploads running now and how many share each account (for the throughput logs). */
export function uploadConcurrency(ctx: Pick<AppContext, 'gate' | 'jobs'>, account: UploadAccount): { total: number; sameAccount: number } {
  const ids = ctx.gate.holders('upload')
  const sameAccount = ids.filter((id) => accountOf(ctx.jobs.get(id)?.meta?.account) === account).length
  return { total: ids.length, sameAccount }
}

function accountOf(a: UploadAccount | undefined): UploadAccount {
  return a === 'shared' ? 'shared' : 'primary'
}

/**
 * Watches one upload for the logs: concurrency at the start and at its peak
 * (sampled on every chunk), a line every few minutes, and a summary when it
 * ends — `docker logs mkvid | grep 'upload: '` gives MB/s per upload next to
 * how many ran at once and how many of those on the same Google project.
 */
export function makeUploadMeter(
  ctx: Pick<AppContext, 'gate' | 'jobs'>, a: { jobId: string; account: UploadAccount; bytes: number; logLine: (l: string) => void; now?: () => number },
) {
  const now = a.now ?? Date.now
  const startedAt = now()
  const atStart = uploadConcurrency(ctx, a.account)
  let peak = atStart.total
  let peakSameAccount = atStart.sameAccount
  let held = 0
  const observe = () => {
    const c = uploadConcurrency(ctx, a.account)
    peak = Math.max(peak, c.total)
    peakSameAccount = Math.max(peakSameAccount, c.sameAccount)
    return c
  }
  const base = () => ({ jobId: a.jobId, account: a.account, uploadSlots: ctx.gate.slotsOf('upload'), concurrentAtStart: atStart.total, concurrentPeak: peak, sameAccountPeak: peakSameAccount })
  return {
    progress(percent: number) {
      if (percent >= 0) held = Math.round((percent / 100) * a.bytes)
      observe()
    },
    throughput(t: UploadThroughput) {
      held = t.heldBytes
      const c = observe()
      const mbps = t.intervalSeconds > 0 ? t.intervalBytes / MB / t.intervalSeconds : 0
      const avg = t.elapsedSeconds > 0 ? t.heldBytes / MB / t.elapsedSeconds : 0
      a.logLine(`upload: ${(t.heldBytes / 1e9).toFixed(2)} of ${(t.totalBytes / 1e9).toFixed(2)} GB, ${mbps.toFixed(1)} MB/s over the last ${Math.round(t.intervalSeconds)} s (${avg.toFixed(1)} MB/s so far; ${c.total} upload(s) running, ${c.sameAccount} on ${a.account})`)
      log('info', 'upload: progress', { ...base(), heldBytes: t.heldBytes, totalBytes: t.totalBytes, intervalMBps: +mbps.toFixed(2), avgMBps: +avg.toFixed(2), concurrentNow: c.total, sameAccountNow: c.sameAccount })
    },
    end(ok: boolean, err?: string) {
      const seconds = Math.max(0.001, (now() - startedAt) / 1000)
      const bytes = ok ? a.bytes : held
      const mbps = bytes / MB / seconds
      const fields = { ...base(), bytes, totalBytes: a.bytes, seconds: Math.round(seconds), MBps: +mbps.toFixed(2) }
      if (ok) {
        a.logLine(`upload: ${(bytes / 1e9).toFixed(2)} GB in ${Math.round(seconds)} s = ${mbps.toFixed(1)} MB/s (${a.account}; ${peak} upload(s) at once at the peak, ${peakSameAccount} on ${a.account})`)
        log('info', 'upload: done', fields)
      } else {
        log('warn', 'upload: failed', { ...fields, err: (err ?? '').slice(0, 200) })
      }
    },
  }
}

/** Runs `fn` holding one stage of the job (ctx.gate), so no two jobs run the same stage at once. */
type Gated = <T>(stage: GateStage, fn: () => Promise<T>) => Promise<T>

async function renderSceneForJob(
  ctx: AppContext, job: Job,
  a: { workDir: string; audioPath: string; duration: number; codec: string; title: string; outFile: string },
  onProgress: (percent: number) => void, logLine: (line: string) => void, gated: Gated,
): Promise<void> {
  const { config } = ctx
  const vizDir = join(a.workDir, VIZ_DIR)
  mkdirSync(vizDir, { recursive: true })
  let input = loadVizInput(vizDir, a.audioPath)
  if (input) {
    logLine('viz: resuming with the saved track list and artwork')
    migrateInputStamps(vizDir, legacyHashInput(input), hashInput(input))
  } else input = await gated('analyse', async () => {
    const [width, height] = config.viz.size.split('x').map(Number)
    const setArtworkPath = job.url.startsWith(UPLOAD_PREFIX)
      ? null
      : await downloadSetArtwork({ ytdlpPath: config.ytdlpPath, ffmpegPath: config.ffmpegPath, url: job.url, outDir: vizDir }, logLine)
    const setMeta = job.meta?.origin === 'tracked' ? job.meta : null
    const planned = vizTracksFromTracked(setMeta?.tracks, { durationSeconds: a.duration })
    const tracks = await resolveVizTracks(planned, config.viz.artworkCacheDir, { onLog: logLine })
    const withArt = tracks.filter((t) => t.artworkPath).length
    const named = tracks.filter((t) => t.artist || t.title).length
    logLine(`viz: ${tracks.length} track(s), ${named} named, ${withArt} with artwork; set artwork ${setArtworkPath ? 'found' : 'none'}`)
    const fresh: VizInput = {
      audioPath: a.audioPath, durationSeconds: a.duration, setTitle: a.title, setArtist: setMeta?.artistName ?? null,
      setArtworkPath, tracks, width, height, fps: config.viz.fps,
    }
    writeJson(join(vizDir, 'input.json'), fresh)
    return fresh
  })
  // A finished video from an earlier attempt whose upload failed: do not render 30 GB again.
  const stamp = { inputHash: hashInput(input), sceneVersion: sceneCodeVersion() }
  try {
    const r = JSON.parse(readFileSync(join(vizDir, RENDERED_FILE), 'utf8'))
    if (r.inputHash === stamp.inputHash && r.sceneVersion === stamp.sceneVersion && statSync(a.outFile).size === r.bytes) {
      logLine('viz: out.mp4 from an earlier attempt is complete, skipping the render')
      onProgress(100)
      return
    }
  } catch { /* none */ }
  rmSync(join(vizDir, RENDERED_FILE), { force: true })
  await renderScene({
    input, vizDir, outFile: a.outFile, audioArgs: [...VIZ_AUDIO_ARGS],
    ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath,
    workers: config.viz.workers, encodeSessions: config.viz.encodeSessions, segmentSeconds: config.viz.segmentSeconds,
    // Free space is checked once this job holds the render slot: the other job's segments are on the same volume.
    gate: (stage, fn) => gated(stage, stage === 'render'
      ? async () => { ensureFreeSpace(config.dataDir, config.viz.minFreeGb); return fn() }
      : fn),
  }, (f) => onProgress(f * 100), logLine)
  writeJson(join(vizDir, RENDERED_FILE), { ...stamp, bytes: statSync(a.outFile).size })
}

/** The render stage of a scene job: resumes from finished segments, retried VIZ_RENDER_RETRIES times. */
async function renderSceneWithRetries(
  ctx: AppContext, job: Job, a: Parameters<typeof renderSceneForJob>[2],
  onProgress: (percent: number) => void, logLine: (line: string) => void, gated: Gated,
): Promise<void> {
  const { renderRetries, retryDelaySeconds } = ctx.config.viz
  for (let attempt = 0; ; attempt++) {
    try {
      await renderSceneForJob(ctx, job, a, onProgress, logLine, gated)
      return
    } catch (e: any) {
      if (attempt >= renderRetries) throw e
      logLine(`render failed: ${String(e?.message || e).slice(0, 300)}; retrying in ${retryDelaySeconds}s from the finished segments (retry ${attempt + 1}/${renderRetries})`)
      await new Promise((r) => setTimeout(r, retryDelaySeconds * 1000))
    }
  }
}

// ---------------------------------------------------------------------------
// track style: one track upload from tracked

/**
 * Where a track job's own files go: a subdirectory, never the work dir
 * itself (yt-dlp's file picker takes the first file there as the download).
 */
export const TRACK_DIR = 'track'

/**
 * The artwork a track video is drawn with: the source's thumbnail (yt-dlp,
 * converted to jpg), else the 1001tracklists artwork tracked sent, else none
 * (track-render draws a solid background).
 */
async function trackArtwork(ctx: AppContext, job: Job, meta: TrackedTrackMeta, dir: string, logLine: (l: string) => void): Promise<string | null> {
  const { config } = ctx
  const thumb = await downloadSetArtwork({ ytdlpPath: config.ytdlpPath, ffmpegPath: config.ffmpegPath, url: job.url, outDir: dir }, logLine)
  if (thumb) { logLine('track: artwork from the source thumbnail'); return thumb }
  if (meta.artworkUrl) {
    const art = await fetchArtwork(meta.artworkUrl, config.viz.artworkCacheDir, { onLog: logLine })
    if (art) { logLine('track: artwork from 1001tracklists'); return art }
  }
  logLine('track: no artwork, solid background')
  return null
}

// ---------------------------------------------------------------------------

export async function runJob(ctx: AppContext, jobId: string): Promise<void> {
  const { jobs, config, hub } = ctx
  const job = jobs.get(jobId)
  if (!job) return
  const workDir = join(config.dataDir, 'work', jobId)
  mkdirSync(workDir, { recursive: true })

  const emit = (m: SseMessage) => hub.publish(jobId, m)
  const logLine = (line: string) => { jobs.appendLog(jobId, line); emit({ type: 'log', line }) }
  const setStatus = (status: SseMessage['status']) => { jobs.setStatus(jobId, status!); emit({ type: 'status', status }) }
  const scene = job.style === 'scene'
  /** A tracked track upload (style `track`): a duration check, its own renderer, its own render slot. */
  const track = job.meta?.origin === 'tracked-track' ? job.meta : null
  const gated: Gated = (stage, fn) => ctx.gate.run(stage, jobId, fn, (holders) => {
    const names = holders.map((h) => { const other = jobs.get(h); return other?.title ? `"${other.title}"` : `job ${h}` })
    logLine(holders.length > 1
      ? `waiting for the ${stage} stage: all ${holders.length} slots are taken (${names.join(', ')})`
      : `waiting for the ${stage} stage: ${names[0] ?? 'another job'} is in it`)
  })
  /** How far the job got: a scene job that fails while rendering or uploading keeps its work dir. */
  let stage: 'download' | 'render' | 'upload' | 'done' = 'download'

  try {
    // A tracked scene job renders a verified track list or nothing (also
    // catches a job queued, or resumed, from before this rule).
    const unverified = unverifiedTrackedScene(job)
    if (unverified) throw new Error(unverified)
    if (job.style === 'track' && !track) throw new Error('the track style renders tracked track uploads only')
    if (scene) {
      rmSync(join(workDir, VIZ_DIR, KEPT_FILE), { force: true }) // running again (retry): not a kept dir any more
      adoptKeptWork(ctx, job, workDir, logLine)
    }
    // 1. download (or pick up a directly-uploaded file already in workDir)
    setStatus('downloading')
    let file: string, title: string
    let pageUrl: string | null = null
    const resumed = job.style === 'scene' ? readSourceRecord(workDir) : null
    if (resumed) {
      ({ file, title, pageUrl } = resumed)
      logLine(`resuming after a restart: audio ${basename(file)} is already here`)
      emit({ type: 'progress', phase: 'download', percent: 100 })
    } else if (job.url.startsWith(UPLOAD_PREFIX)) {
      const name = job.url.slice(UPLOAD_PREFIX.length)
      // Defense in depth: the route sanitizes the name, but never let a stored
      // marker resolve outside this job's work dir.
      if (name !== sanitizeUploadName(name)) throw new Error('invalid uploaded file name')
      file = join(workDir, name)
      if (!existsSync(file)) throw new Error('uploaded file is missing (removed or lost on restart) — re-upload and retry')
      title = basename(name, extname(name))
      logLine(`using uploaded file ${name}`)
      emit({ type: 'progress', phase: 'download', percent: 100 })
    } else {
      ({ file, title, pageUrl } = await gated('download', () => downloadAudio(
        { ytdlpPath: config.ytdlpPath, url: job.url, workDir },
        (p) => emit({ type: 'progress', phase: 'download', percent: p }), logLine,
      )))
    }
    if (job.style === 'scene' && !resumed) writeSourceRecord(workDir, file, title, pageUrl)
    // The recording's page goes in the description; kept on the job for the description backfill too.
    if (pageUrl && job.meta && job.meta.recordingUrl !== pageUrl) {
      const current = jobs.get(jobId)?.meta ?? job.meta
      jobs.setMeta(jobId, { ...current, recordingUrl: pageUrl })
    }
    const finalTitle = job.title || title
    jobs.setTitle(jobId, finalTitle)

    // 2. probe
    const { codec, duration } = await probeAudio(config.ffprobePath, file)
    // 1001tracklists' players often carry only a preview: refuse a rip much shorter than the track (permanent for tracked).
    if (track) {
      const clip = previewClipError(duration, track.expectedDurationSeconds, track.minDurationRatio)
      if (clip) throw new Error(clip)
    }
    const width = Number(config.size.split('x')[0])
    const fps = chooseFps(job.style, width, duration)

    // 3. render
    setStatus('transcoding')
    const outFile = join(workDir, 'out.mp4')
    if (scene) {
      stage = 'render'
      await renderSceneWithRetries(ctx, job, { workDir, audioPath: file, duration, codec, title: finalTitle, outFile },
        (p) => emit({ type: 'progress', phase: 'transcode', percent: p }), logLine, gated)
    } else if (track) {
      const dir = join(workDir, TRACK_DIR)
      const artworkPath = await trackArtwork(ctx, job, track, dir, logLine)
      // Its own slot: a track never waits behind a scene render (stage-gate.ts, tracked.ts pollTrackUploads).
      const r = await gated('track-render', () => renderTrackVideo(
        { ffmpegPath: config.ffmpegPath, audioPath: file, durationSeconds: duration, artworkPath, artist: track.artist, title: track.title, dir, outFile },
        (p) => emit({ type: 'progress', phase: 'transcode', percent: p }), logLine,
      ))
      logLine(`track: rendered with ${r.encoder}`)
    } else {
      await gated('render', () => renderVideo(
        {
          ffmpegPath: config.ffmpegPath, style: job.style, mode: 'line', size: config.size,
          fps, durSec: duration, audioInput: file, audioArgs: chooseAudioArgs(codec),
          outFile, workDir, cpu: false,
        },
        (p) => emit({ type: 'progress', phase: 'transcode', percent: p }), logLine,
      ))
    }

    // 4. upload
    if (scene) stage = 'upload'
    setStatus('uploading')
    // A tracked job names the Google project (account) it was handed out for; UI jobs use the primary.
    const acct = ctx.accountFor(job.meta?.account)
    // The account whose token this upload really uses (a shared job falls back to the primary when no shared client is set).
    const account: UploadAccount = acct.store === ctx.tokensShared ? 'shared' : 'primary'
    const getToken: TokenGetter = (o) => getValidAccessToken(acct.store, acct.google, o)
    const { videoId, videoUrl, privacyApplied } = await gated('upload', async () => {
      // Start with a token good for most of an hour (fails fast if the account is disconnected);
      // the upload takes a current token for every chunk after that.
      await getToken({ minValidMs: UPLOAD_MIN_VALID_MS })
      const meter = makeUploadMeter(ctx, { jobId, account, bytes: statSync(outFile).size, logLine })
      try {
        const r = await uploadVideo(
          {
            getToken, filePath: outFile, title: finalTitle,
            description: describeJob(job, pageUrl),
            privacy: job.privacy, categoryId: config.youtubeCategoryId, onLog: logLine,
            onThroughput: (t) => meter.throughput(t),
          },
          (p) => { meter.progress(p); emit({ type: 'progress', phase: 'upload', percent: p }) },
        )
        meter.end(true)
        return r
      } catch (e: any) {
        meter.end(false, String(e?.message || e))
        throw e
      }
    })
    jobs.setResult(jobId, videoId, videoUrl, privacyApplied, job.style)
    jobs.markDescriptionSynced(jobId) // uploaded with today's description: nothing for the backfill to do
    stage = 'done'
    if (privacyApplied && privacyApplied !== job.privacy) {
      logLine(`warning: requested ${job.privacy} but YouTube set ${privacyApplied} (unverified OAuth apps are forced to private)`)
    }
    // Best-effort: add the upload to the configured playlist. A failure here (e.g.
    // token lacks the playlist scope) must not fail an already-successful upload.
    // Sets and track uploads from tracked go into tracked's own playlists
    // instead — tracked adds them, and paying 50 units here as well would be a waste.
    if (config.youtubePlaylistId && !job.meta) {
      try {
        await addToPlaylist(getToken, videoId, config.youtubePlaylistId)
        logLine(`added to playlist ${config.youtubePlaylistId}`)
      } catch (e: any) {
        logLine(`warning: could not add to playlist — ${String(e?.message || e).slice(0, 140)}`)
      }
    }
    setStatus('done')
    emit({ type: 'done', videoUrl })
    void sendPush(config.vapid, ctx.push.list(), { title: 'Upload complete', body: finalTitle, url: videoUrl },
      (endpoint) => ctx.push.removeByEndpoint(endpoint))
  } catch (e: any) {
    const msg = e?.message === 'reconnect_youtube'
      ? `YouTube not connected (${job.meta?.account === 'shared' ? 'shared' : 'primary'} account) — reconnect and retry.`
      : String(e?.message || e)
    jobs.setError(jobId, msg)
    emit({ type: 'error', error: msg })
    void sendPush(config.vapid, ctx.push.list(), { title: 'Upload failed', body: msg.slice(0, 120), url: '/' },
      (endpoint) => ctx.push.removeByEndpoint(endpoint))
    log('error', 'pipeline failed', { jobId, err: msg })
    // A scene job that failed while rendering or uploading keeps its audio,
    // segments and (after an upload failure) out.mp4: a retry resumes instead
    // of starting hours of work over. Kept for VIZ_KEEP_HOURS / VIZ_KEEP_GB.
    if (scene && (stage === 'render' || stage === 'upload') && readSourceRecord(workDir)) {
      try {
        markKept(workDir, stage)
        logLine(`keeping the work dir for a retry (failed while ${stage === 'render' ? 'rendering' : 'uploading'})`)
        pruneKeptWork(ctx)
        return
      } catch { /* fall through: remove it */ }
    }
  } finally {
    if (!(scene && isKeptWork(ctx, jobId))) {
      try { rmSync(workDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
}
