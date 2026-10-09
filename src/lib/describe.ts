import type { Job, TrackedTrackMeta } from '../types.js'
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
    return [
      `Tracklist: ${job.meta.setUrl}`,
      `Recording: ${recordingLink(job, pageUrl)}`,
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
