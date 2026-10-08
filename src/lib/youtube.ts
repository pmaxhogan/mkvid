import { open, stat } from 'node:fs/promises'
import { google } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import type { Job, Privacy, TokenStore, UploadAccount } from '../types.js'
import type { Config } from '../config.js'
import { getValidAccessToken, type TokenOptions } from './google-oauth.js'

/**
 * Hands out an access token for one account (Google project). `force` mints
 * a new one (after a 401); `minValidMs` refreshes early when less is left.
 */
export type TokenGetter = (o?: TokenOptions) => Promise<string>

/** The HTTP status of a failed googleapis / fetch call, or NaN. */
function statusOf(e: any): number {
  return Number(e?.status ?? e?.code ?? e?.response?.status)
}

/**
 * Run `fn` with a token; when YouTube answers 401 (the token expired or was
 * revoked early), mint a new token and run it once more.
 */
export async function withAuthRetry<T>(getToken: TokenGetter, fn: (accessToken: string) => Promise<T>): Promise<T> {
  try {
    return await fn(await getToken())
  } catch (e) {
    if (statusOf(e) !== 401) throw e
    return fn(await getToken({ force: true }))
  }
}

/** A YouTube answer that is not a success, carrying the API's own message (quota, auth, ...). */
export class YouTubeHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'YouTubeHttpError'
  }
}

async function httpError(res: Response, what: string): Promise<YouTubeHttpError> {
  const text = await res.text().catch(() => '')
  let message = ''
  try { message = JSON.parse(text)?.error?.message ?? '' } catch { /* not JSON */ }
  return new YouTubeHttpError(res.status, message || `youtube ${what}: HTTP ${res.status} ${text.slice(0, 200)}`.trim())
}

function drain(res: Response): Promise<void> {
  return res.body ? res.body.cancel().catch(() => {}) : Promise.resolve()
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504])
/** Upload chunks must be a multiple of 256 KiB (all but the last). */
const CHUNK_UNIT = 256 * 1024
export const DEFAULT_UPLOAD_CHUNK_BYTES = 128 * CHUNK_UNIT // 32 MiB
export const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status'

export interface UploadOptions {
  getToken: TokenGetter
  filePath: string
  title: string
  description: string
  privacy: Privacy
  categoryId: string
  onLog?: (line: string) => void
  /** Tests: a stand-in for fetch, smaller chunks, no waiting. */
  fetch?: typeof fetch
  chunkBytes?: number
  /** Failed attempts in a row without progress (5xx, dropped connections) before giving up. */
  maxRetries?: number
  retryDelayMs?: (attempt: number) => number
}

type Req = { method: string; headers: Record<string, string>; body?: string | Uint8Array }

/**
 * Upload a video with YouTube's resumable protocol: open a session, then send
 * the file in chunks. A 5xx or a dropped connection asks the session how much
 * it already holds and goes on from there instead of sending gigabytes again;
 * a 401 mints a new token and sends the same chunk again. Each request takes
 * its token just before it is sent, so an upload may outlive any one token.
 */
export async function uploadVideo(
  opts: UploadOptions,
  onProgress: (percent: number) => void,
): Promise<{ videoId: string; videoUrl: string; privacyApplied: Privacy | null }> {
  const http = opts.fetch ?? fetch
  const chunkBytes = Math.max(1, Math.floor((opts.chunkBytes ?? DEFAULT_UPLOAD_CHUNK_BYTES) / CHUNK_UNIT)) * CHUNK_UNIT
  const maxRetries = opts.maxRetries ?? 8
  const delay = opts.retryDelayMs ?? ((n: number) => Math.min(60_000, 1000 * 2 ** n))
  const onLog = opts.onLog ?? (() => {})
  const total = (await stat(opts.filePath)).size
  if (total === 0) throw new Error(`upload: ${opts.filePath} is empty`)
  const metadata = JSON.stringify({
    snippet: { title: opts.title.slice(0, 100), description: opts.description, categoryId: opts.categoryId },
    status: { privacyStatus: opts.privacy, selfDeclaredMadeForKids: false },
  })

  let retries = 0
  /** After a 5xx or a network error: wait and return true, or false once maxRetries in a row failed. */
  const backoff = async (why: string): Promise<boolean> => {
    if (retries >= maxRetries) return false
    const ms = delay(retries++)
    onLog(`upload: ${why}; retrying in ${Math.round(ms / 1000)}s (${retries}/${maxRetries})`)
    await new Promise((r) => setTimeout(r, ms))
    return true
  }
  const why = (e: any) => String(e?.cause?.code || e?.message || e)
  /** One request with a current token; a 401 is answered once with a newly minted token. */
  const send = async (url: string, req: Req): Promise<Response> => {
    // 308 is YouTube's "resume incomplete", never a redirect to follow.
    const go = async (token: string) => http(url, { ...req, redirect: 'manual', headers: { ...req.headers, Authorization: `Bearer ${token}` } } as RequestInit)
    const res = await go(await opts.getToken())
    if (res.status !== 401) return res
    await drain(res)
    onLog('upload: token rejected (401), refreshing it')
    return go(await opts.getToken({ force: true }))
  }

  const startSession = async (): Promise<string> => {
    for (;;) {
      let res: Response
      try {
        res = await send(UPLOAD_URL, {
          method: 'POST', body: metadata,
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Length': String(total), 'X-Upload-Content-Type': 'video/mp4',
          },
        })
      } catch (e) {
        if (await backoff(`starting the upload failed (${why(e)})`)) continue
        throw e
      }
      const location = res.headers.get('location')
      if (res.ok && location) { await drain(res); return location }
      const err = await httpError(res, 'videos.insert')
      if (RETRYABLE.has(res.status) && await backoff(`starting the upload got HTTP ${res.status}`)) continue
      throw err
    }
  }

  /** Bytes the session holds, from a 308's Range header ("bytes=0-N"; none = nothing yet). */
  const held = (res: Response): number => {
    const m = /bytes=0-(\d+)/.exec(res.headers.get('range') ?? '')
    return m ? Number(m[1]) + 1 : 0
  }
  /** Ask the session how much it holds. null: the question failed too. */
  const queryStatus = async (session: string): Promise<Response | null> => {
    try {
      const res = await send(session, { method: 'PUT', headers: { 'Content-Range': `bytes */${total}` } })
      if (res.status === 308 || res.status === 200 || res.status === 201) return res
      await drain(res)
      return null
    } catch {
      return null
    }
  }
  const finish = async (res: Response) => {
    const data = await res.json() as { id?: string; status?: { privacyStatus?: string } }
    if (!data.id) throw new Error('youtube: no video id returned')
    onProgress(100)
    // What YouTube actually set: an OAuth app that hasn't passed Google's audit
    // has its uploads forced to private no matter what was requested.
    const applied = data.status?.privacyStatus
    const privacyApplied: Privacy | null = applied === 'private' || applied === 'unlisted' || applied === 'public' ? applied : null
    return { videoId: data.id, videoUrl: `https://youtu.be/${data.id}`, privacyApplied }
  }

  const fh = await open(opts.filePath, 'r')
  try {
    let session = await startSession()
    let offset = 0
    let restarts = 0
    onProgress(0)
    for (;;) {
      let res: Response | null
      try {
        if (offset < total) {
          const end = Math.min(offset + chunkBytes, total)
          const buf = Buffer.alloc(end - offset)
          const { bytesRead } = await fh.read(buf, 0, buf.length, offset)
          if (bytesRead !== buf.length) throw new Error(`upload: short read of ${opts.filePath} at byte ${offset}`)
          res = await send(session, {
            method: 'PUT', body: buf,
            headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${offset}-${end - 1}/${total}` },
          })
        } else {
          // Everything was sent but no answer came back: ask for the result.
          res = await send(session, { method: 'PUT', headers: { 'Content-Range': `bytes */${total}` } })
        }
      } catch (e: any) {
        if (/short read/.test(String(e?.message))) throw e
        if (!(await backoff(`sending from byte ${offset} failed (${why(e)})`))) throw e
        res = await queryStatus(session)
        if (!res) continue
      }
      if (res.status === 200 || res.status === 201) return await finish(res)
      if (res.status === 308) {
        await drain(res)
        const next = held(res)
        if (next > offset) retries = 0
        else if (!(await backoff(`no progress at byte ${offset}`))) throw new Error(`upload: YouTube stopped taking bytes at ${offset} of ${total}`)
        offset = next
        onProgress(total > 0 ? Math.min(100, (offset / total) * 100) : -1)
        continue
      }
      if (res.status === 404 || res.status === 410) {
        // The session is gone (they last about a week): open a new one and start from byte 0.
        await drain(res)
        // Worded without the status: tracked parks a request whose error says 404 for good.
        if (restarts >= 2) throw new Error('upload: YouTube dropped the upload session three times; retry later')
        restarts++
        onLog(`upload: the upload session is gone (HTTP ${res.status}), starting over`)
        session = await startSession()
        offset = 0
        continue
      }
      const err = await httpError(res, 'upload')
      if (!RETRYABLE.has(res.status) || !(await backoff(`sending from byte ${offset} got HTTP ${res.status}`))) throw err
      const st = await queryStatus(session)
      if (!st) continue
      if (st.status === 308) { await drain(st); offset = held(st); continue }
      return await finish(st)
    }
  } finally {
    await fh.close().catch(() => {})
  }
}

export async function addToPlaylist(getToken: TokenGetter, videoId: string, playlistId: string): Promise<void> {
  await withAuthRetry(getToken, async (accessToken) => {
    const auth = new OAuth2Client()
    auth.setCredentials({ access_token: accessToken })
    // Cast: googleapis-common pins its own nested google-auth-library version,
    // distinct from the top-level install this file imports OAuth2Client from,
    // so the two OAuth2Client classes are structurally (but not runtime-) incompatible.
    const yt = google.youtube({ version: 'v3', auth: auth as any })
    await yt.playlistItems.insert({
      part: ['snippet'],
      requestBody: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } },
    })
  })
}

/** What `videos.delete` did: deleted it, or it was already gone (404 = deleted earlier, by hand or by us). */
export type DeleteOutcome = 'deleted' | 'already_gone'

/** The raw YouTube call, injectable for tests. */
export type VideosDeleteApi = (accessToken: string, videoId: string) => Promise<void>

const youtubeVideosDelete: VideosDeleteApi = async (accessToken, videoId) => {
  const auth = new OAuth2Client()
  auth.setCredentials({ access_token: accessToken })
  // Cast: googleapis-common pins its own nested google-auth-library; runtime-identical. See addToPlaylist.
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
    getToken?: (store: TokenStore, google: Config['google'], o?: TokenOptions) => Promise<string>
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
  const getToken: TokenGetter = (o) => (deps.getToken ?? getValidAccessToken)(acct.store, acct.google, o)
  let outcome: DeleteOutcome = 'deleted'
  try {
    await withAuthRetry(getToken, (accessToken) => (deps.api ?? youtubeVideosDelete)(accessToken, videoId))
  } catch (e: any) {
    if (statusOf(e) !== 404) throw e
    outcome = 'already_gone'
  }
  deps.jobs.markVideoDeleted(job.id)
  return { outcome, jobId: job.id, account }
}
