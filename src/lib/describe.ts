import type { Job, TrackedTrack, TrackedTrackMeta } from '../types.js'
import { UPLOAD_PREFIX } from './upload.js'

const HEARTHIS_PAGE = /^https?:\/\/(?:www\.)?hearthis\.at\/(?!embed\/)[^/]+\/[^/]+/i

/**
 * The recording link a tracked job's video description shows: the page
 * yt-dlp named at download (`recordingUrl`, or `pageUrl` passed in), else
 * the hearthis.at track page the job downloaded (tracked hands mkvid the
 * embed player URL), else the URL as tracked found it (for SoundCloud the
 * `api.soundcloud.com/tracks/<id>` URL, which only resolves for software).
 */
export function recordingLink(job: Pick<Job, 'url' | 'meta'>, pageUrl?: string | null): string {
  const page = pageUrl || job.meta?.recordingUrl
  if (page) return page
  if (HEARTHIS_PAGE.test(job.url)) return job.url
  return job.meta?.sourceUrl ?? job.url
}

/**
 * Video description: where the audio came from, and for tracked jobs the set
 * page it belongs to. `pageUrl` = the recording's page when the job object
 * predates it being recorded (runJob loads the job once, before the download).
 */
export function describeJob(job: Pick<Job, 'url' | 'meta'>, pageUrl?: string | null): string {
  if (job.meta?.origin === 'tracked') {
    // Chapters from a verified list only (names go out to the public, like the scene renders).
    const chapters = job.meta.tracksTrusted === true ? chapterLines(job.meta.tracks) : []
    return [
      `Tracklist: ${job.meta.setUrl}`,
      `Recording: ${recordingLink(job, pageUrl)}`,
      ...(chapters.length ? ['', CHAPTERS_HEADING, ...chapters] : []),
    ].join('\n')
  }
  if (job.meta?.origin === 'tracked-track') return describeTrack(job.meta, recordingLink(job, pageUrl))
  return job.url.startsWith(UPLOAD_PREFIX) ? 'Uploaded by mkvid' : `Uploaded by mkvid from ${job.url}`
}

/**
 * A track upload's description: the 1001tracklists track page (when tracked
 * knows it), the page the audio was ripped from, and who uploaded it.
 */
export function describeTrack(meta: Pick<TrackedTrackMeta, 'trackUrl' | 'sourceName'>, source: string): string {
  return [
    ...(meta.trackUrl ? [`1001Tracklists: ${meta.trackUrl}`] : []),
    `Source${meta.sourceName ? ` (${meta.sourceName})` : ''}: ${source}`,
    '',
    'Uploaded by mkvid',
  ].join('\n')
}

export const TRACKLISTS_ORIGIN = 'https://www.1001tracklists.com'

/**
 * tracked's track page link as an absolute https URL: a path
 * (`/track/1hf79cg5/…`) is put on 1001tracklists; anything that is not a
 * 1001tracklists https URL is dropped (it ends up in a description and a link).
 */
export function absoluteTrackUrl(url: string | null | undefined): string | null {
  const raw = typeof url === 'string' ? url.trim() : ''
  if (!raw) return null
  try {
    const u = new URL(raw, TRACKLISTS_ORIGIN)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    if (!/(^|\.)1001tracklists\.com$/i.test(u.hostname)) return null
    u.protocol = 'https:'
    return u.toString()
  } catch {
    return null
  }
}

/** YouTube's title limit, counted here in UTF-16 units (stricter than characters; never splits a pair). */
export const YOUTUBE_TITLE_MAX = 100

/**
 * A track upload's video title: `<artist> - <title>`, whitespace and control
 * characters collapsed, `<` / `>` (which YouTube refuses in a title) swapped
 * for look-alikes, cut to 100 with an ellipsis.
 */
export function trackVideoTitle(artist: string | null | undefined, title: string | null | undefined, fallback = 'Untitled track'): string {
  const clean = (s: string | null | undefined) => String(s ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/</g, '‹').replace(/>/g, '›')
  const a = clean(artist)
  const t = clean(title)
  const full = a && t ? `${a} - ${t}` : (t || a || clean(fallback) || 'Untitled track')
  if (full.length <= YOUTUBE_TITLE_MAX) return full
  let out = ''
  for (const ch of full) {
    if (out.length + ch.length > YOUTUBE_TITLE_MAX - 1) break
    out += ch
  }
  return out.trimEnd() + '…'
}

/** The line above a set video's chapter list. */
export const CHAPTERS_HEADING = 'Tracks'
/** YouTube's rules for chapters: the first at 0:00, at least 3, each at least 10 s long. */
const MIN_CHAPTERS = 3
const MIN_CHAPTER_SECONDS = 10
const MAX_LABEL = 120
/** The chapter lines stop before the description passes this (YouTube allows 5000). */
const MAX_CHAPTER_CHARS = 4500

/** `m:ss`, or `h:mm:ss` from an hour on. */
export function chapterTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

function chapterText(s: string | null | undefined): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/</g, '‹').replace(/>/g, '›')
}

function trackLabel(t: TrackedTrack): string {
  const a = chapterText(t.artist)
  const ti = chapterText(t.title)
  if (!a && !ti) return 'ID'
  return `${a || 'ID'} - ${ti || 'ID'}`
}

function clipLabel(label: string): string {
  if (label.length <= MAX_LABEL) return label
  let out = ''
  for (const ch of label) {
    if (out.length + ch.length > MAX_LABEL - 1) break
    out += ch
  }
  return out.trimEnd() + '…'
}

/**
 * A set video's chapters, one line per track: `<time> <Artist - Title>`. A
 * "w/" row (layered) joins the track it plays over (`A - T w/ B - U`); a row
 * without a cue is left out (and so are the w/ rows on it). YouTube only shows
 * chapters that start at 0:00, number at least 3 and last at least 10 s each,
 * in order: a first track later than 0:10 gets an "Intro" chapter before it
 * (earlier, it starts at 0:00), and a track less than 10 s after the one
 * before (or out of order) joins that one (`A - T / B - U`). Fewer than 3
 * chapters: none ([]).
 */
export function chapterLines(tracks: readonly TrackedTrack[] | null | undefined): string[] {
  if (!Array.isArray(tracks)) return []
  const chapters: Array<{ at: number; label: string }> = []
  let baseSkipped = false
  for (const t of tracks) {
    if (!t) continue
    const cue = typeof t.cueSeconds === 'number' && Number.isFinite(t.cueSeconds) && t.cueSeconds >= 0 ? t.cueSeconds : null
    const last = chapters[chapters.length - 1]
    if (t.layered) {
      if (last && !baseSkipped) last.label += ` w/ ${trackLabel(t)}`
      continue
    }
    if (cue === null) { baseSkipped = true; continue }
    baseSkipped = false
    if (last && cue < last.at + MIN_CHAPTER_SECONDS) {
      last.label += ` / ${trackLabel(t)}`
      continue
    }
    chapters.push({ at: cue, label: trackLabel(t) })
  }
  if (chapters.length === 0) return []
  if (chapters[0]!.at < MIN_CHAPTER_SECONDS) chapters[0]!.at = 0
  else chapters.unshift({ at: 0, label: 'Intro' })
  if (chapters.length < MIN_CHAPTERS) return []
  const lines: string[] = []
  let chars = 0
  for (const c of chapters) {
    const line = `${chapterTime(c.at)} ${clipLabel(c.label)}`
    if (chars + line.length + 1 > MAX_CHAPTER_CHARS) break
    lines.push(line)
    chars += line.length + 1
  }
  return lines.length >= MIN_CHAPTERS ? lines : []
}

/**
 * Unix ms: when describeJob's output last changed (set videos got chapters).
 * A description synced before this is brought up to date again by the
 * backfill (db/jobs.ts descriptionBackfillPending).
 */
export const DESCRIPTION_FORMAT_SINCE = Date.parse('2026-10-09T15:30:00Z')
