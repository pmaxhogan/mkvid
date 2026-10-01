/**
 * Everything the scene shows besides the audio, turned into local files:
 * per-track artwork (downloaded once into a content-addressed cache shared by
 * all jobs), the set's own artwork (the source page's thumbnail via yt-dlp),
 * and the track list as tracked delivered it, reduced to what may be shown.
 *
 * Nothing here throws for a missing picture: the scene falls back to the set
 * artwork, and then to a generated gradient.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { TrackedTrack } from '../types.js'
import type { VizTrack } from './types.js'

// ---------------------------------------------------------------------------
// track list

/** A track as the scene will see it, before its artwork is downloaded. */
export interface PlannedTrack {
  startSeconds: number
  artist: string | null
  title: string | null
  artworkUrl: string | null
  /** Plays on top of the preceding non-layered track (see VizTrack.layered). Present only when true. */
  layered?: true
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** Options for {@link vizTracksFromTracked}. */
export interface VizTracksOptions {
  /** Length of the audio in seconds: lets untimed rows after the last cue be spread up to the end. */
  durationSeconds?: number
}

/**
 * tracked's track list -> what the video may show. List order is kept.
 *   - the first entry of the list starts at 0 when it has no cue time;
 *   - a non-layered track whose cue is earlier than the previous kept cued
 *     non-layered track's is bad data and dropped (never reordered), and so
 *     is one whose cue is present but unusable (negative, not finite);
 *   - a run of k consecutive non-layered tracks without a cue between two
 *     kept cued ones (anchors at a and b) is spread evenly between them:
 *     the j-th starts at a + (b - a) * j / (k + 1). Bad-data rows inside the
 *     run stay dropped and are not counted. A run after the last anchor is
 *     spread the same way up to `durationSeconds` (as b) when that is given
 *     and later than the anchor, and dropped otherwise. A run with no anchor
 *     before it (only possible when the first entry is junk) is dropped;
 *   - a layered track (a "w/" row) belongs to its base, the nearest preceding
 *     non-layered entry: dropped when that base was dropped; without a cue it
 *     starts with its base (cued or spread), and a cue earlier than the base
 *     is clamped to it;
 *   - a layered track that would start at or after the next kept base could
 *     never be on screen (it leaves with its base) and is dropped, which also
 *     keeps the list sorted by start as VizTrack requires;
 *   - the first kept track is never layered (a layered first entry has no
 *     base and is treated as an ordinary track);
 *   - an ID track has no names (the scene shows "ID").
 *
 * Only a verified list gets here: tracked hands out verified lists only, and
 * a tracked scene job refuses anything else before downloading
 * (`unverified_tracklist`, lib/tracked.ts + lib/pipeline.ts). There is no
 * names-hidden render of an untrusted list any more: wrong names burned into
 * a video cannot be corrected later, and a video without them is not made.
 */
export function vizTracksFromTracked(
  tracks: readonly TrackedTrack[] | null | undefined,
  opts: VizTracksOptions = {},
): PlannedTrack[] {
  if (!Array.isArray(tracks)) return []
  /** One usable entry; `start` of a base is null while unknown (untimed) or when dropped. */
  interface Row { t: TrackedTrack; cue: number | null; base: number | null; start: number | null; bad?: true }
  const rows: Row[] = []
  /** Index (in rows) of the current base, or null before the first non-layered entry. */
  let base: number | null = null
  let prevAnchor: number | null = null
  tracks.forEach((t, i) => {
    if (!t || typeof t !== 'object') return
    const cue = typeof t.cueSeconds === 'number' && Number.isFinite(t.cueSeconds) && t.cueSeconds >= 0 ? t.cueSeconds : null
    if (t.layered === true && base !== null) {
      rows.push({ t, cue, base, start: null })
      return
    }
    // A base track (or a layered entry with nothing before it to layer on).
    let start = cue
    if (start === null && i === 0) start = 0
    base = rows.length
    // A cue that is present but not a usable time (negative, NaN) is bad data, not "untimed".
    const malformed = start === null && t.cueSeconds !== null && t.cueSeconds !== undefined
    if (malformed || (start !== null && prevAnchor !== null && start < prevAnchor)) {
      rows.push({ t, cue, base: null, start: null, bad: true })
      return
    }
    if (start !== null) prevAnchor = start
    rows.push({ t, cue, base: null, start })
  })
  // Spread each run of untimed bases evenly between its anchors (or the anchor and the end).
  let anchor: number | null = null
  let run: Row[] = []
  const spread = (a: number, b: number) => run.forEach((r, j) => { r.start = a + ((b - a) * (j + 1)) / (run.length + 1) })
  for (const r of rows) {
    if (r.base !== null || r.bad) continue
    if (r.start === null) { if (anchor !== null) run.push(r); continue }
    if (anchor !== null) spread(anchor, r.start)
    anchor = r.start
    run = []
  }
  const end = opts.durationSeconds
  if (anchor !== null && run.length && typeof end === 'number' && Number.isFinite(end) && end > anchor) spread(anchor, end)

  const out: PlannedTrack[] = []
  for (const r of rows) {
    const named = r.t.isId !== true
    const url = text(r.t.artworkUrl)
    const planned = (startSeconds: number, layered: boolean): PlannedTrack => ({
      startSeconds,
      artist: named ? text(r.t.artist) : null,
      title: named ? text(r.t.title) : null,
      artworkUrl: url && /^https?:\/\//i.test(url) ? url : null,
      ...(layered ? { layered: true as const } : {}),
    })
    if (r.base !== null) {
      const baseStart = rows[r.base].start
      if (baseStart === null) continue
      out.push(planned(r.cue === null ? baseStart : Math.max(r.cue, baseStart), true))
    } else if (r.start !== null) {
      out.push(planned(r.start, false))
    }
  }
  // Layered tracks that start at/after the next base's start would never be shown.
  let nextBase = Number.POSITIVE_INFINITY
  for (let k = out.length - 1; k >= 0; k--) {
    if (!out[k].layered) nextBase = out[k].startSeconds
    else if (out[k].startSeconds >= nextBase) out.splice(k, 1)
  }
  return out
}

// ---------------------------------------------------------------------------
// artwork download

export const ARTWORK_MAX_BYTES = 15 * 1024 * 1024
export const ARTWORK_TIMEOUT_MS = 20_000

const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg', 'image/png': 'png',
  'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
}

/** The format the bytes actually are (a server's content-type is only a hint). */
export function sniffImage(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif'
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to))
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp'
  if (b.length >= 12 && ascii(4, 8) === 'ftyp' && /^avi[fs]$/.test(ascii(8, 12))) return 'avif'
  return null
}

export function artworkCacheKey(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 32)
}

function cached(cacheDir: string, key: string): string | null {
  if (!existsSync(cacheDir)) return null
  const hit = readdirSync(cacheDir).find((f) => f.startsWith(key + '.') && !f.endsWith('.tmp'))
  return hit ? join(cacheDir, hit) : null
}

export interface FetchArtworkOptions {
  fetcher?: typeof fetch
  timeoutMs?: number
  maxBytes?: number
  onLog?: (line: string) => void
}

/**
 * Download one artwork URL into `cacheDir` (file name = hash of the URL) and
 * return its path; a cached copy is returned without a request. Only http(s),
 * only image content types that really are images, at most `maxBytes`.
 * Every failure returns null.
 */
export async function fetchArtwork(url: string, cacheDir: string, opts: FetchArtworkOptions = {}): Promise<string | null> {
  const log = opts.onLog ?? (() => {})
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const key = artworkCacheKey(url)
  const hit = cached(cacheDir, key)
  if (hit) return hit

  const maxBytes = opts.maxBytes ?? ARTWORK_MAX_BYTES
  try {
    const res = await (opts.fetcher ?? fetch)(url, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? ARTWORK_TIMEOUT_MS),
      headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8' },
      redirect: 'follow',
    })
    if (!res.ok) { log(`artwork: HTTP ${res.status} for ${url}`); return null }
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (!IMAGE_TYPES[type]) { log(`artwork: not an image (${type || 'no content-type'}) at ${url}`); return null }
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) { log(`artwork: too large (${declared} bytes) at ${url}`); return null }
    if (!res.body) return null
    const chunks: Uint8Array[] = []
    let size = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => {})
        log(`artwork: too large (over ${maxBytes} bytes) at ${url}`)
        return null
      }
      chunks.push(value)
    }
    const bytes = Buffer.concat(chunks)
    const kind = sniffImage(bytes)
    if (!kind) { log(`artwork: ${url} claims ${type} but is not an image`); return null }
    mkdirSync(cacheDir, { recursive: true })
    const file = join(cacheDir, `${key}.${kind}`)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, bytes)
    renameSync(tmp, file)
    return file
  } catch (e: any) {
    log(`artwork: ${url} failed: ${String(e?.message || e).slice(0, 200)}`)
    return null
  }
}

/** Download every track's artwork (each distinct URL once, a few at a time). */
export async function resolveVizTracks(tracks: readonly PlannedTrack[], cacheDir: string, opts: FetchArtworkOptions & { concurrency?: number } = {}): Promise<VizTrack[]> {
  const urls = [...new Set(tracks.map((t) => t.artworkUrl).filter((u): u is string => !!u))]
  const paths = new Map<string, string | null>()
  let next = 0
  const lane = async () => {
    while (next < urls.length) {
      const url = urls[next++]
      paths.set(url, await fetchArtwork(url, cacheDir, opts))
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, urls.length)) }, lane))
  return tracks.map((t) => ({
    startSeconds: t.startSeconds, artist: t.artist, title: t.title,
    artworkPath: t.artworkUrl ? paths.get(t.artworkUrl) ?? null : null,
    ...(t.layered ? { layered: true } : {}),
  }))
}

// ---------------------------------------------------------------------------
// set artwork (the source page's thumbnail)

export const SET_ARTWORK_BASENAME = 'set-artwork'
const THUMB_EXT = /\.(jpe?g|png|webp|gif|avif)$/i

export function buildThumbnailArgs(o: { url: string; outDir: string; ffmpegPath?: string }): string[] {
  // --ffmpeg-location only for a real path; a bare "ffmpeg" is found on PATH anyway.
  const ff = o.ffmpegPath && (isAbsolute(o.ffmpegPath) || /[\\/]/.test(o.ffmpegPath)) ? ['--ffmpeg-location', o.ffmpegPath] : []
  return ['--no-playlist', '--skip-download', '--write-thumbnail', '--convert-thumbnails', 'jpg', ...ff,
    '-o', join(o.outDir, `${SET_ARTWORK_BASENAME}.%(ext)s`), '--', o.url]
}

/**
 * The set artwork from the audio source (SoundCloud cover etc.) via yt-dlp's
 * thumbnail. Writes `<outDir>/set-artwork.<ext>`; pass a directory of its own
 * (the job's viz/ dir), never the download dir, whose file picker takes the
 * first file it finds as the audio. Returns null on any failure.
 */
export function downloadSetArtwork(
  opts: { ytdlpPath: string; url: string; outDir: string; ffmpegPath?: string; timeoutMs?: number },
  onLog: (line: string) => void = () => {},
): Promise<string | null> {
  return new Promise((resolve) => {
    let parsed: URL
    try { parsed = new URL(opts.url) } catch { return resolve(null) }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return resolve(null)
    mkdirSync(opts.outDir, { recursive: true })
    for (const f of readdirSync(opts.outDir)) if (f.startsWith(SET_ARTWORK_BASENAME + '.')) rmSync(join(opts.outDir, f), { force: true })
    let err = ''
    let p: ReturnType<typeof spawn>
    try {
      p = spawn(opts.ytdlpPath, buildThumbnailArgs(opts), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    } catch (e: any) {
      onLog(`set artwork: ${String(e?.message || e)}`)
      return resolve(null)
    }
    const timer = setTimeout(() => p.kill(), opts.timeoutMs ?? 90_000)
    p.stderr!.on('data', (d) => { err = (err + d.toString()).slice(-2000) })
    // A failed spawn emits 'error' and then 'close': settle once, and never throw from a handler.
    let settled = false
    p.on('error', (e) => { clearTimeout(timer); if (settled) return; settled = true; onLog(`set artwork: ${e.message}`); resolve(null) })
    p.on('close', (code) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      let hit: string | undefined
      try { hit = readdirSync(opts.outDir).find((f) => f.startsWith(SET_ARTWORK_BASENAME + '.') && THUMB_EXT.test(f)) } catch { /* dir gone */ }
      if (hit) return resolve(join(opts.outDir, hit))
      onLog(`set artwork: none (yt-dlp exit ${code}${err.trim() ? `: ${err.trim().split('\n').pop()!.slice(0, 200)}` : ''})`)
      resolve(null)
    })
  })
}
