/**
 * The tracked bridge. tracked (the Cloudflare Worker that keeps YouTube
 * playlists of every set a followed DJ has on 1001tracklists) queues sets that
 * have no YouTube recording but a SoundCloud / hearthis.at one; we poll that
 * queue, render + upload each set unlisted, and report the video id back so
 * tracked can add it to its playlists.
 *
 * Pull, not push: the Worker cannot reach this box (Cloudflare Access sits in
 * front of the tunnel), but we can reach the Worker with a bearer token.
 *
 * One tick of the poller (`TRACKED_POLL_SECONDS`, default 60):
 *   1. deliver any outcome not yet acknowledged by tracked (kept on the job
 *      row as `meta.reported`, so a report that failed — or a restart between
 *      upload and report — is retried instead of the set being rendered twice
 *      once tracked's claim expires);
 *   2. if the render slot is free, claim one request, telling tracked which
 *      upload accounts (Google projects) currently have a connected YouTube
 *      token — it fills its own project's quota day first, then the sync's —
 *      and gets back the request stamped with the account to upload through;
 *   3. resolve the source (hearthis embed → track page), probe its duration
 *      and refuse a recording shorter than the tracklist's last cue
 *      (`incomplete_recording`, permanent — a clip is not the set);
 *   4. create the job (style `TRACKED_STYLE`, default static; the track list
 *      rides along in the job meta for the scene style) and hand it to the
 *      normal pipeline.
 */

import { randomUUID } from 'node:crypto'
import type { AppContext } from '../context.js'
import type { Config } from '../config.js'
import type { Job, JobMeta, TrackedTrack, UploadAccount } from '../types.js'
import { probeDuration } from './ytdlp.js'
import { resolveSourceUrl } from './sources.js'
import { log } from './log.js'

export interface TrackedRequest {
  id: string
  slug: string
  setUrl: string
  artistName: string | null
  setTitle: string | null
  source: 'soundcloud' | 'hearthis'
  sourceUrl: string
  lastCueSeconds: number | null
  trackCount: number | null
  idedCount: number | null
  attempts: number
  /** Which account (Google project) to upload through; a Worker from before accounts existed sends none = primary. */
  account?: UploadAccount
  /** The set's track list for the `scene` style; absent from Workers that predate it. */
  tracks?: TrackedTrack[]
  /** false when the names may be 1001tracklists decoys (then only cues + artwork are shown). */
  tracksTrusted?: boolean
}

export interface TrackedClient {
  claim(accounts: readonly UploadAccount[]): Promise<TrackedRequest | null>
  job(id: string, jobId: string): Promise<void>
  complete(input: { id: string; videoId: string; videoUrl: string; privacy: string | null; jobId: string }): Promise<{ status: string }>
  fail(input: { id: string; error: string; permanent: boolean; jobId: string | null }): Promise<void>
  health(): Promise<{ ok: boolean; counts?: Record<string, number> }>
}

export class TrackedHttpError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`tracked HTTP ${status}: ${body.slice(0, 200)}`)
    this.name = 'TrackedHttpError'
  }
}

export function makeTrackedClient(cfg: NonNullable<Config['tracked']>, fetcher: typeof fetch = fetch): TrackedClient {
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetcher(`${cfg.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new TrackedHttpError(res.status, text)
    return (text ? JSON.parse(text) : {}) as T
  }
  return {
    async claim(accounts) {
      return (await call<{ request: TrackedRequest | null }>('POST', '/mkvid/claim', { accounts })).request
    },
    async job(id, jobId) {
      await call('POST', '/mkvid/job', { id, jobId })
    },
    async complete(input) {
      return call<{ status: string }>('POST', '/mkvid/complete', input)
    },
    async fail(input) {
      await call('POST', '/mkvid/fail', input)
    },
    async health() {
      return call<{ ok: boolean; counts?: Record<string, number> }>('GET', '/mkvid/health')
    },
  }
}

/** Errors that another attempt cannot fix: the recording is gone, private, unsupported, or not the full set. */
const PERMANENT_RE = /incomplete_recording|unsupported url|not available|is private|private (?:track|video)|removed|does not exist|404|403|geo[- ]?restricted|no video formats|requested format is not available/i

export function isPermanentFailure(error: string): boolean {
  // Quota exhaustion is a 403 too, but tomorrow fixes it: never park for it.
  if (/quota/i.test(error)) return false
  return PERMANENT_RE.test(error)
}

/** A recording is "complete" when it runs at least to the tracklist's last cue (with a little slack for trimmed intros). */
export const COMPLETENESS_SLACK_SECONDS = 90

export function isIncompleteRecording(durationSeconds: number | null, lastCueSeconds: number | null): boolean {
  if (durationSeconds === null || lastCueSeconds === null) return false
  return durationSeconds + COMPLETENESS_SLACK_SECONDS < lastCueSeconds
}

/**
 * After the pipeline finishes a job (success or failure): deliver the outcome
 * to tracked if the job came from there. Wired into the queue processor in
 * context.ts. Never throws — a delivery failure is retried on the next tick.
 */
export async function reportJobToTracked(ctx: AppContext, job: Job, client: TrackedClient | null): Promise<boolean> {
  const meta = job.meta
  if (!client || !meta || meta.origin !== 'tracked' || meta.reported) return false
  try {
    // A job interrupted between the upload and its final status still has
    // the video: deliver it, or tracked would requeue and the set would be
    // uploaded twice.
    if ((job.status === 'done' || job.status === 'interrupted') && job.videoId && job.videoUrl) {
      const r = await client.complete({
        id: meta.requestId, videoId: job.videoId, videoUrl: job.videoUrl,
        privacy: job.privacyApplied ?? job.privacy, jobId: job.id,
      })
      log('info', 'tracked: delivered', { jobId: job.id, requestId: meta.requestId, videoId: job.videoId, result: r.status })
    } else {
      const error = job.status === 'interrupted' ? 'mkvid restarted mid-job' : (job.error || 'failed')
      await client.fail({ id: meta.requestId, error, permanent: isPermanentFailure(error), jobId: job.id })
      log('info', 'tracked: reported failure', { jobId: job.id, requestId: meta.requestId, error: error.slice(0, 200) })
    }
  } catch (e: any) {
    // 404/409: tracked no longer knows this request (retried from the panel,
    // superseded, or reset) — nothing more to deliver, stop trying.
    if (e instanceof TrackedHttpError && (e.status === 404 || e.status === 409)) {
      log('warn', 'tracked: outcome not accepted, dropping', { jobId: job.id, requestId: meta.requestId, status: e.status, body: e.body.slice(0, 200) })
    } else {
      log('warn', 'tracked: delivery failed, will retry', { jobId: job.id, requestId: meta.requestId, err: String(e?.message || e) })
      return false
    }
  }
  ctx.jobs.setMeta(job.id, { ...meta, reported: true })
  return true
}

/**
 * One poll: retry undelivered outcomes, then claim + start one request if the
 * render slot is free. Returns what it did (for tests / logs).
 */
export async function pollTracked(ctx: AppContext, client: TrackedClient, opts: { probe?: typeof probeDuration; resolve?: typeof resolveSourceUrl } = {}): Promise<
  { action: 'idle' } | { action: 'busy' } | { action: 'not_connected' } | { action: 'started'; jobId: string; requestId: string } | { action: 'refused'; requestId: string; reason: string }
> {
  const cfg = ctx.config.tracked!
  for (const job of ctx.jobs.listUnreportedTracked()) await reportJobToTracked(ctx, job, client)

  if (ctx.queue.size > 0) return { action: 'busy' }
  const accounts = ctx.connectedAccounts()
  // Still poll with no accounts: tracked records the outcome so its panel can
  // say "reconnect YouTube on mkvid" instead of "mkvid is not polling".
  const req = await client.claim(accounts)
  if (accounts.length === 0) return { action: 'not_connected' }
  if (!req) return { action: 'idle' }
  const account: UploadAccount = req.account === 'shared' ? 'shared' : 'primary'
  log('info', 'tracked: claimed', { requestId: req.id, slug: req.slug, setUrl: req.setUrl, source: req.source, attempt: req.attempts, account })

  let url: string
  try {
    url = await (opts.resolve ?? resolveSourceUrl)(req.sourceUrl)
  } catch (e: any) {
    const error = `source: ${String(e?.message || e)}`
    await client.fail({ id: req.id, error, permanent: isPermanentFailure(error), jobId: null }).catch(() => {})
    return { action: 'refused', requestId: req.id, reason: error }
  }

  let duration: number | null = null
  try {
    duration = await (opts.probe ?? probeDuration)({ ytdlpPath: ctx.config.ytdlpPath, url })
  } catch (e: any) {
    const error = `probe: ${String(e?.message || e)}`
    await client.fail({ id: req.id, error, permanent: isPermanentFailure(error), jobId: null }).catch(() => {})
    return { action: 'refused', requestId: req.id, reason: error }
  }
  if (isIncompleteRecording(duration, req.lastCueSeconds)) {
    const error = `incomplete_recording: source is ${Math.round(duration!)}s but the tracklist's last cue is at ${req.lastCueSeconds}s`
    await client.fail({ id: req.id, error, permanent: true, jobId: null }).catch(() => {})
    log('warn', 'tracked: refused incomplete recording', { requestId: req.id, setUrl: req.setUrl, duration, lastCue: req.lastCueSeconds })
    return { action: 'refused', requestId: req.id, reason: error }
  }

  const meta: JobMeta = {
    origin: 'tracked', account, requestId: req.id, setUrl: req.setUrl, sourceUrl: req.sourceUrl,
    lastCueSeconds: req.lastCueSeconds, artistName: req.artistName,
    ...(Array.isArray(req.tracks) ? { tracks: req.tracks, tracksTrusted: req.tracksTrusted === true } : {}),
    trackCount: req.trackCount ?? null,
  }
  const id = randomUUID()
  ctx.jobs.create({ id, url, title: req.setTitle, privacy: cfg.privacy, style: cfg.style, meta })
  await client.job(req.id, id).catch((e: any) => log('warn', 'tracked: could not attach job id', { requestId: req.id, err: String(e?.message || e) }))
  ctx.queue.enqueue(id)
  log('info', 'tracked: job started', { jobId: id, requestId: req.id, url, duration, lastCue: req.lastCueSeconds })
  return { action: 'started', jobId: id, requestId: req.id }
}

/** Start the interval poller. Returns a stop function. */
export function startTrackedPoller(ctx: AppContext, client: TrackedClient): () => void {
  const cfg = ctx.config.tracked!
  let running = false
  let warnedNotConnected = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const r = await pollTracked(ctx, client)
      if (r.action === 'not_connected') {
        if (!warnedNotConnected) log('warn', 'tracked: YouTube not connected — not claiming work until it is')
        warnedNotConnected = true
      } else warnedNotConnected = false
    } catch (e: any) {
      log('warn', 'tracked: poll failed', { err: String(e?.message || e) })
    } finally {
      running = false
    }
  }
  client.health()
    .then((h) => log('info', 'tracked: connected', { url: cfg.url, counts: h.counts ?? null }))
    .catch((e: any) => log('error', 'tracked: health check failed (check TRACKED_URL / TRACKED_TOKEN)', { url: cfg.url, err: String(e?.message || e) }))
  const timer = setInterval(() => void tick(), cfg.pollSeconds * 1000)
  timer.unref()
  void tick()
  return () => clearInterval(timer)
}
