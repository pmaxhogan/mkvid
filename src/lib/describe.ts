import type { Job } from '../types.js'
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
  return job.url.startsWith(UPLOAD_PREFIX) ? 'Uploaded by mkvid' : `Uploaded by mkvid from ${job.url}`
}
