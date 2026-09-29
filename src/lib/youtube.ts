import { createReadStream, statSync } from 'node:fs'
import { Transform } from 'node:stream'
import { google } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import type { Job, Privacy, TokenStore, UploadAccount } from '../types.js'
import type { Config } from '../config.js'
import { getValidAccessToken } from './google-oauth.js'

export async function uploadVideo(
  opts: { accessToken: string; filePath: string; title: string; description: string; privacy: Privacy; categoryId: string },
  onProgress: (percent: number) => void,
): Promise<{ videoId: string; videoUrl: string; privacyApplied: Privacy | null }> {
  const auth = new OAuth2Client()
  auth.setCredentials({ access_token: opts.accessToken })
  // Cast: see note in google-oauth.ts's makeOAuthClient — googleapis-common
  // pins its own nested google-auth-library version distinct from the
  // top-level install this file imports OAuth2Client from, so the two
  // OAuth2Client classes are structurally (but not runtime-) incompatible.
  const yt = google.youtube({ version: 'v3', auth: auth as any })
  const total = statSync(opts.filePath).size
  // gaxios (googleapis v173's HTTP layer) is fetch-based and its `onUploadProgress`
  // option is deprecated/ignored, so progress is tracked manually by counting bytes
  // as they flow through a pass-through Transform stream piped in front of the upload.
  let bytesRead = 0
  const progressTracker = new Transform({
    transform(chunk, _enc, callback) {
      bytesRead += chunk.length
      onProgress(total > 0 ? Math.min(100, (bytesRead / total) * 100) : -1)
      callback(null, chunk)
    },
  })
  const fileStream = createReadStream(opts.filePath)
  const body = fileStream.pipe(progressTracker)
  let res
  try {
    res = await yt.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: { title: opts.title.slice(0, 100), description: opts.description, categoryId: opts.categoryId },
        status: { privacyStatus: opts.privacy, selfDeclaredMadeForKids: false },
      },
      media: { body },
    })
  } catch (e) {
    fileStream.destroy()  // release the fd if the upload fails early
    throw e
  }
  const videoId = res.data.id
  if (!videoId) throw new Error('youtube: no video id returned')
  // What YouTube actually set: an OAuth app that hasn't passed Google's audit
  // has its uploads forced to private no matter what was requested.
  const applied = res.data.status?.privacyStatus
  const privacyApplied: Privacy | null = applied === 'private' || applied === 'unlisted' || applied === 'public' ? applied : null
  return { videoId, videoUrl: `https://youtu.be/${videoId}`, privacyApplied }
}

export async function addToPlaylist(accessToken: string, videoId: string, playlistId: string): Promise<void> {
  const auth = new OAuth2Client()
  auth.setCredentials({ access_token: accessToken })
  // Cast: googleapis-common pins its own nested google-auth-library; runtime-identical. See uploadVideo.
  const yt = google.youtube({ version: 'v3', auth: auth as any })
  await yt.playlistItems.insert({
    part: ['snippet'],
    requestBody: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } },
  })
}

/** What `videos.delete` did: deleted it, or it was already gone (404 = deleted earlier, by hand or by us). */
export type DeleteOutcome = 'deleted' | 'already_gone'

/** The raw YouTube call, injectable for tests. */
export type VideosDeleteApi = (accessToken: string, videoId: string) => Promise<void>

const youtubeVideosDelete: VideosDeleteApi = async (accessToken, videoId) => {
  const auth = new OAuth2Client()
  auth.setCredentials({ access_token: accessToken })
  // Cast: googleapis-common pins its own nested google-auth-library; runtime-identical. See uploadVideo.
  const yt = google.youtube({ version: 'v3', auth: auth as any })
  await yt.videos.delete({ id: videoId })
}

/** Why deleteVideo would not touch a video: none of these can change on a retry. */
export class DeleteRefused extends Error {
  constructor(public readonly code: 'unknown_video' | 'not_tracked' | 'request_mismatch', message: string) {
    super(message)
    this.name = 'DeleteRefused'
  }
}

/**
 * Delete one of mkvid's own uploads from YouTube (`videos.delete`, 50 units;
 * the `youtube` scope mkvid already holds covers it). Used when tracked
 * recreates a set: the new video is up and in the playlists, the old one goes.
 *
 * Guarded: only a video id that mkvid's database recorded as uploaded by a
 * job that came from tracked — and, when `requestId` is given, by a job for
 * that tracked request — and always through the account (Google project)
 * that uploaded it, whose token owns the video. Throws DeleteRefused when the
 * video is not ours to delete; anything else thrown is worth retrying.
 */
export async function deleteVideo(
  videoId: string,
  deps: {
    jobs: { findByVideoId(videoId: string): Job[]; markVideoDeleted(id: string): void }
    accountFor(account: UploadAccount | undefined): { store: TokenStore; google: Config['google'] }
    requestId?: string | null
    api?: VideosDeleteApi
    getToken?: (store: TokenStore, google: Config['google']) => Promise<string>
  },
): Promise<{ outcome: DeleteOutcome; jobId: string; account: UploadAccount }> {
  const uploads = deps.jobs.findByVideoId(videoId)
  if (!uploads.length) throw new DeleteRefused('unknown_video', `mkvid has no record of uploading ${videoId}`)
  const tracked = uploads.filter((j) => j.meta?.origin === 'tracked')
  if (!tracked.length) throw new DeleteRefused('not_tracked', `${videoId} was not uploaded for tracked`)
  const job = deps.requestId ? tracked.find((j) => j.meta?.requestId === deps.requestId) : tracked[0]
  if (!job) throw new DeleteRefused('request_mismatch', `${videoId} was not uploaded for request ${deps.requestId}`)
  const account: UploadAccount = job.meta?.account === 'shared' ? 'shared' : 'primary'
  if (job.videoDeletedAt) return { outcome: 'already_gone', jobId: job.id, account }
  const acct = deps.accountFor(account)
  const accessToken = await (deps.getToken ?? getValidAccessToken)(acct.store, acct.google)
  let outcome: DeleteOutcome = 'deleted'
  try {
    await (deps.api ?? youtubeVideosDelete)(accessToken, videoId)
  } catch (e: any) {
    const status = Number(e?.status ?? e?.code ?? e?.response?.status)
    if (status !== 404) throw e
    outcome = 'already_gone'
  }
  deps.jobs.markVideoDeleted(job.id)
  return { outcome, jobId: job.id, account }
}
