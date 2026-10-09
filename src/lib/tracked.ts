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
 *   2. renew tracked's claim on every set queued or running here (`/mkvid/job`
 *      again): with several jobs in flight a set can wait for a stage,
 *      and a claim older than tracked's claim TTL is handed out again;
 *   3. if a new set could start downloading now (canClaim: download free,
 *      every job here holding a stage, fewer sets waiting for upload than
 *      upload slots — see stage-gate.ts), claim one request, telling tracked
 *      which upload accounts (Google projects) currently have a connected
 *      YouTube token — it fills its own project's quota day first, then the
 *      sync's, unless TRACKED_SPREAD_ACCOUNTS names the one to prefer — and
 *      gets back the request stamped with the account to upload through;
 *   4. resolve the source (hearthis embed → track page), probe its duration
 *      and refuse a recording shorter than the tracklist's last cue
 *      (`incomplete_recording`, permanent — a clip is not the set);
 *   5. create the job (style `TRACKED_STYLE`, default static; the track list
 *      rides along in the job meta for the scene style) and hand it to the
 *      normal pipeline. The scene style refuses, before any download, a
 *      request whose list is not verified (`tracksTrusted` not exactly true)
 *      or is empty: `unverified_tracklist`, not permanent — tracked puts it
 *      back to pending. It never renders with names hidden.
 *
 * tracked also calls in: `POST /api/videos/:id/delete` (routes/videos.ts)
 * deletes an upload a "Delete and recreate" replaced.
 *
 * Track uploads (`pollTrackUploads`, same tick, after the sets): tracked also
 * queues single pre-saved tracks that 1001tracklists has no YouTube link for
 * but a link yt-dlp can rip. Their own endpoints (`/mkvid/track/*`), their own
 * job kind (`meta.origin = 'tracked-track'`, style `track`), and their own
 * claim rule — see pollTrackUploads.
 */

import { randomUUID } from 'node:crypto'
import type { AppContext } from '../context.js'
import type { Config } from '../config.js'
import type { Job, Privacy, TrackedSetMeta, TrackedTrack, TrackedTrackMeta, UploadAccount } from '../types.js'
import { probeDuration } from './ytdlp.js'
import { resolveSourceUrl } from './sources.js'
import { log } from './log.js'
import { absoluteTrackUrl, trackVideoTitle } from './describe.js'

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
  /** true = the list is verified (two fetches by different accounts agreed). The scene style renders nothing else. */
  tracksTrusted?: boolean
}

/**
 * One of tracked's track uploads, as `POST /mkvid/track/claim` hands it out
 * (tracked's track_uploads row).
 */
export interface TrackRequest {
  /** track_uploads.id (an integer); sent back as received. */
  id: number
  presaveId: number | null
  artist: string | null
  title: string | null
  artworkUrl: string | null
  /** The 1001tracklists track page (absolute, or a path on 1001tracklists). */
  trackUrl: string | null
  /** soundcloud, bandcamp, ... */
  sourceName: string | null
  /** Handed to yt-dlp as-is (a hearthis embed is resolved to its track page first). */
  sourceUrl: string
  expectedDurationSeconds: number | null
  minDurationRatio: number | null
  privacy: string | null
  account?: UploadAccount | null
  attempts: number
}

export type TrackedHealth = { ok: boolean; counts?: Record<string, number>; verifiedLists?: boolean; trackUploads?: boolean }

export interface TrackedClient {
  /**
   * `style` = the style tracked jobs are rendered with (TRACKED_STYLE); tracked refuses recreations unless it is scene.
   * `preferAccount` = upload through this account if it has claims left today (TRACKED_SPREAD_ACCOUNTS); an older tracked ignores it.
   */
  claim(accounts: readonly UploadAccount[], style?: string, preferAccount?: UploadAccount): Promise<TrackedRequest | null>
  job(id: string, jobId: string): Promise<void>
  complete(input: { id: string; videoId: string; videoUrl: string; privacy: string | null; jobId: string; style: string }): Promise<{ status: string }>
  fail(input: { id: string; error: string; permanent: boolean; jobId: string | null }): Promise<void>
  /**
   * `verifiedLists: true` = this tracked hands out verified lists only and treats `unverified_tracklist` as retryable.
   * `trackUploads: true` = it has the `/mkvid/track/*` endpoints.
   */
  health(): Promise<TrackedHealth>
  /** Track uploads (`/mkvid/track/*`): claim one for these accounts (null = nothing claimable). */
  trackClaim(accounts: readonly UploadAccount[]): Promise<TrackRequest | null>
  /** Attach the job to the claim, and renew the claim. */
  trackJob(id: number, jobId: string): Promise<void>
  trackComplete(input: { id: number; videoId: string; videoUrl: string; privacy: string | null; jobId: string }): Promise<{ status?: string }>
  trackFail(input: { id: number; error: string; permanent: boolean; jobId: string | null }): Promise<void>
}

export class TrackedHttpError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`tracked HTTP ${status}: ${body.slice(0, 200)}`)
    this.name = 'TrackedHttpError'
  }
}

/** The longest failure report sent to tracked (it cuts at 2000; an older tracked answered 400 over that). */
export const MAX_REPORTED_ERROR = 1900

/** `error` cut to MAX_REPORTED_ERROR: its head (what failed) and its tail (the end of stderr, usually the cause). */
export function clipError(error: string): string {
  if (error.length <= MAX_REPORTED_ERROR) return error
  const sep = ' [...] '
  const head = 300
  return error.slice(0, head) + sep + error.slice(-(MAX_REPORTED_ERROR - head - sep.length))
}

/**
 * A rejection of a report that sending it again cannot fix: any 4xx but 401/403
 * (a wrong or rotated TRACKED_TOKEN: keep the outcome until the token is
 * fixed), 408 (timeout) and 429 (rate limit). 404/409 = tracked no longer knows the
 * request (retried, superseded, claimed by another job); 400 = the body itself
 * was refused. Retrying those forever would also keep a track's outcome
 * "undelivered", which stops pollTrackUploads from claiming anything else.
 */
export function isFinalRejection(e: unknown): e is TrackedHttpError {
  return e instanceof TrackedHttpError && e.status >= 400 && e.status < 500 && ![401, 403, 408, 429].includes(e.status)
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
    async claim(accounts, style, preferAccount) {
      const body = { accounts, ...(style ? { style } : {}), ...(preferAccount ? { preferAccount } : {}) }
      return (await call<{ request: TrackedRequest | null }>('POST', '/mkvid/claim', body)).request
    },
    async job(id, jobId) {
      await call('POST', '/mkvid/job', { id, jobId })
    },
    async complete(input) {
      return call<{ status: string }>('POST', '/mkvid/complete', input)
    },
    async fail(input) {
      await call('POST', '/mkvid/fail', { ...input, error: clipError(input.error) })
    },
    async health() {
      return call<TrackedHealth>('GET', '/mkvid/health')
    },
    async trackClaim(accounts) {
      return (await call<{ request?: TrackRequest | null }>('POST', '/mkvid/track/claim', { accounts })).request ?? null
    },
    async trackJob(id, jobId) {
      await call('POST', '/mkvid/track/job', { id, jobId })
    },
    async trackComplete(input) {
      return call<{ status?: string }>('POST', '/mkvid/track/complete', input)
    },
    async trackFail(input) {
      await call('POST', '/mkvid/track/fail', { ...input, error: clipError(input.error) })
    },
  }
}

/**
 * The scene visualizer only ever renders a verified track list: names are
 * burned into the video and a decoy list cannot be corrected afterwards, and
 * there is no names-hidden fallback. Returns the refusal (an error starting
 * `unverified_tracklist`, which tracked treats as "back to pending, no attempt
 * used") or null when the job may render.
 */
export function unverifiedTrackedScene(job: Pick<Job, 'style' | 'meta'>): string | null {
  if (job.style !== 'scene' || job.meta?.origin !== 'tracked') return null
  return unverifiedList(job.meta.tracks, job.meta.tracksTrusted)
}

function unverifiedList(tracks: unknown, trusted: unknown): string | null {
  if (trusted !== true) return 'unverified_tracklist: the track list is not verified (tracksTrusted is not true); not rendering'
  if (!Array.isArray(tracks) || tracks.length === 0) return 'unverified_tracklist: the track list is empty; not rendering'
  return null
}

/** Errors that another attempt cannot fix: the recording is gone, private, unsupported, or not the full set (for a track: a preview clip). */
const PERMANENT_RE = /incomplete_recording|preview_clip|unsupported url|not available|is private|private (?:track|video)|removed|does not exist|404|403|geo[- ]?restricted|no video formats|requested format is not available/i

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
  if (!client || !meta || meta.reported) return false
  if (meta.origin !== 'tracked' && meta.origin !== 'tracked-track') return false
  const ref = meta.origin === 'tracked' ? { requestId: meta.requestId } : { trackRequestId: meta.trackRequestId }
  try {
    // A job interrupted between the upload and its final status still has
    // the video: deliver it, or tracked would requeue and the set would be
    // uploaded twice.
    if ((job.status === 'done' || job.status === 'interrupted') && job.videoId && job.videoUrl) {
      const privacy = job.privacyApplied ?? job.privacy
      const r = meta.origin === 'tracked'
        ? await client.complete({
          id: meta.requestId, videoId: job.videoId, videoUrl: job.videoUrl, privacy, jobId: job.id,
          // The style the video was made with: tracked's "Recreate all old-style videos" goes by it.
          style: job.uploadStyle ?? job.style,
        })
        : await client.trackComplete({ id: meta.trackRequestId, videoId: job.videoId, videoUrl: job.videoUrl, privacy, jobId: job.id })
      log('info', 'tracked: delivered', { jobId: job.id, ...ref, videoId: job.videoId, result: r.status ?? null })
    } else {
      const error = job.status === 'interrupted' ? 'mkvid restarted mid-job' : (job.error || 'failed')
      const permanent = isPermanentFailure(error)
      if (meta.origin === 'tracked') await client.fail({ id: meta.requestId, error, permanent, jobId: job.id })
      else await client.trackFail({ id: meta.trackRequestId, error, permanent, jobId: job.id })
      log('info', 'tracked: reported failure', { jobId: job.id, ...ref, permanent, error: error.slice(0, 200) })
    }
  } catch (e: any) {
    // 404/409: tracked no longer knows this request (retried from the panel,
    // superseded, or reset); 400: it refused the report itself. Sending it
    // again changes nothing — stop trying (isFinalRejection).
    if (isFinalRejection(e)) {
      log('warn', 'tracked: outcome not accepted, dropping', { jobId: job.id, ...ref, status: e.status, body: e.body.slice(0, 200) })
    } else {
      log('warn', 'tracked: delivery failed, will retry', { jobId: job.id, ...ref, err: String(e?.message || e) })
      return false
    }
  }
  ctx.jobs.setMeta(job.id, { ...meta, reported: true })
  return true
}

/**
 * A claimed set could start downloading right away and would not queue behind
 * another on its way to render: download is free, no job waits for download,
 * analyse or render, fewer sets wait for upload than there are upload slots
 * (UPLOAD_CONCURRENCY), and every job in flight holds or waits for a stage
 * (none is between stages or not started yet). A set or two waiting for
 * upload or assemble is no reason to idle the render slot, but a full batch of
 * finished videos waiting for upload is: each is several GB on disk and a
 * claim spent from tracked's daily cap, and retried sets whose video is
 * already rendered go straight there. There is no job limit; this keeps the
 * sets here to about one per stage slot instead of claiming every pending
 * request and parking them in front of a stage.
 */
export function canClaim(ctx: Pick<AppContext, 'queue' | 'gate'>): boolean {
  const g = ctx.gate
  return ctx.queue.hasFreeSlot && g.hasRoom('download') && g.waiting(CLAIM_BLOCKING_STAGES) === 0 &&
    g.waiting(['upload']) < g.slotsOf('upload') &&
    ctx.queue.running === g.held() + g.waiting()
}

/**
 * TRACKED_SPREAD_ACCOUNTS: the connected account with the fewest sets in
 * flight here, so the sets that reach the upload stage together tend to go
 * through different Google projects (a throttle per project, if that is what
 * slows uploads, then halves). On a tie, the one the newest set in flight
 * does not use. Undefined (tracked's own fill order) with fewer than two
 * connected accounts or nothing in flight.
 */
export function preferredAccount(connected: readonly UploadAccount[], inFlight: readonly Pick<Job, 'meta'>[]): UploadAccount | undefined {
  if (connected.length < 2 || inFlight.length === 0) return undefined
  const accountOf = (j: Pick<Job, 'meta'>): UploadAccount => j.meta?.account === 'shared' ? 'shared' : 'primary'
  const count = (a: UploadAccount) => inFlight.filter((j) => accountOf(j) === a).length
  const fewest = Math.min(...connected.map(count))
  const tied = connected.filter((a) => count(a) === fewest)
  if (tied.length === 1) return tied[0]
  const newest = accountOf(inFlight[inFlight.length - 1]!)
  return tied.find((a) => a !== newest)
}
const CLAIM_BLOCKING_STAGES = ['download', 'analyse', 'render'] as const

/**
 * One poll: retry undelivered outcomes, renew the claims of the sets in
 * flight, then claim + start one request if a job slot is free. Returns what
 * it did (for tests / logs).
 */
export async function pollTracked(ctx: AppContext, client: TrackedClient, opts: { probe?: typeof probeDuration; resolve?: typeof resolveSourceUrl } = {}): Promise<
  { action: 'idle' } | { action: 'busy' } | { action: 'already_running'; jobId: string; requestId: string } | { action: 'not_connected' } | { action: 'waiting_for_tracked' } | { action: 'started'; jobId: string; requestId: string } | { action: 'refused'; requestId: string; reason: string }
> {
  const cfg = ctx.config.tracked!
  for (const job of ctx.jobs.listUnreportedTracked()) await reportJobToTracked(ctx, job, client)
  await retryRefusals(ctx, client)
  const inFlight = ctx.jobs.inFlightTracked()
  for (const job of inFlight) {
    await client.job(job.meta.requestId, job.id)
      .catch((e: any) => log('warn', 'tracked: could not renew the claim', { jobId: job.id, requestId: job.meta.requestId, err: String(e?.message || e) }))
  }

  if (!canClaim(ctx)) return { action: 'busy' }
  // Staggered deploys: a tracked from before verified lists hands out
  // unverified ones and counts every refusal as a used attempt (three and the
  // request is parked as failed). So the scene style claims nothing until
  // tracked says, on /mkvid/health, that it hands out verified lists only.
  if (cfg.style === 'scene') {
    const h = await client.health()
    if (h.verifiedLists !== true) return { action: 'waiting_for_tracked' }
  }
  const accounts = ctx.connectedAccounts()
  const prefer = cfg.spreadAccounts ? preferredAccount(accounts, inFlight) : undefined
  // Still poll with no accounts: tracked records the outcome so its panel can
  // say "reconnect YouTube on mkvid" instead of "mkvid is not polling".
  const req = await client.claim(accounts, cfg.style, prefer)
  if (accounts.length === 0) return { action: 'not_connected' }
  if (!req) return { action: 'idle' }
  // Handed out again while a job here still has it (its claim lapsed before
  // a renewal landed): keep that job, point tracked back at it, start nothing.
  const twin = inFlight.find((j) => j.meta.requestId === req.id)
  if (twin) {
    await client.job(req.id, twin.id).catch(() => {})
    log('warn', 'tracked: claimed a set already in flight here, kept the running job', { requestId: req.id, jobId: twin.id })
    return { action: 'already_running', jobId: twin.id, requestId: req.id }
  }
  // Claimed again: a refusal saved for an earlier claim of this request is stale, and retrying it would reset a request that is now rendering.
  ctx.db.prepare('DELETE FROM tracked_refusals WHERE request_id = ?').run(req.id)
  const account: UploadAccount = req.account === 'shared' ? 'shared' : 'primary'
  log('info', 'tracked: claimed', { requestId: req.id, slug: req.slug, setUrl: req.setUrl, source: req.source, attempt: req.attempts, account, ...(prefer ? { preferAccount: prefer } : {}) })

  // The scene style renders verified lists only: refuse before downloading
  // anything. Not permanent — tracked puts the request back to pending.
  if (cfg.style === 'scene') {
    const refusal = unverifiedList(req.tracks, req.tracksTrusted)
    if (refusal) {
      await reportRefusal(ctx, client, req.id, refusal)
      log('warn', 'tracked: refused unverified track list', { requestId: req.id, setUrl: req.setUrl, tracksTrusted: req.tracksTrusted ?? null, tracks: Array.isArray(req.tracks) ? req.tracks.length : null })
      return { action: 'refused', requestId: req.id, reason: refusal }
    }
  }

  let url: string
  try {
    url = await (opts.resolve ?? resolveSourceUrl)(req.sourceUrl)
  } catch (e: any) {
    const error = `source: ${String(e?.message || e)}`
    await client.fail({ id: req.id, error, permanent: isPermanentFailure(error), jobId: null }).catch(() => {})
    log('warn', 'tracked: refused, source lookup failed', { requestId: req.id, setUrl: req.setUrl, permanent: isPermanentFailure(error), error: error.slice(0, 300) })
    return { action: 'refused', requestId: req.id, reason: error }
  }

  let duration: number | null = null
  try {
    duration = await (opts.probe ?? probeDuration)({ ytdlpPath: ctx.config.ytdlpPath, url })
  } catch (e: any) {
    const error = `probe: ${String(e?.message || e)}`
    await client.fail({ id: req.id, error, permanent: isPermanentFailure(error), jobId: null }).catch(() => {})
    log('warn', 'tracked: refused, probe failed', { requestId: req.id, setUrl: req.setUrl, permanent: isPermanentFailure(error), error: error.slice(0, 300) })
    return { action: 'refused', requestId: req.id, reason: error }
  }
  if (isIncompleteRecording(duration, req.lastCueSeconds)) {
    const error = `incomplete_recording: source is ${Math.round(duration!)}s but the tracklist's last cue is at ${req.lastCueSeconds}s`
    await client.fail({ id: req.id, error, permanent: true, jobId: null }).catch(() => {})
    log('warn', 'tracked: refused incomplete recording', { requestId: req.id, setUrl: req.setUrl, duration, lastCue: req.lastCueSeconds })
    return { action: 'refused', requestId: req.id, reason: error }
  }

  const meta: TrackedSetMeta = {
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

/**
 * Report an unverified-list refusal; if tracked cannot be reached, keep it in
 * `tracked_refusals` and retry on every poll, so a network blip does not
 * leave the request claimed until tracked's claim TTL (which uses an attempt).
 */
async function reportRefusal(ctx: AppContext, client: TrackedClient, requestId: string, error: string): Promise<boolean> {
  try {
    await client.fail({ id: requestId, error, permanent: false, jobId: null })
    ctx.db.prepare('DELETE FROM tracked_refusals WHERE request_id = ?').run(requestId)
    return true
  } catch (e: any) {
    // tracked no longer knows the request (retried, superseded), or refused the report: nothing to deliver.
    if (isFinalRejection(e)) {
      ctx.db.prepare('DELETE FROM tracked_refusals WHERE request_id = ?').run(requestId)
      return true
    }
    ctx.db.prepare('INSERT INTO tracked_refusals (request_id, error, created_at) VALUES (?, ?, ?) ON CONFLICT(request_id) DO UPDATE SET error = excluded.error')
      .run(requestId, error, Date.now())
    log('warn', 'tracked: refusal not delivered, will retry', { requestId, err: String(e?.message || e) })
    return false
  }
}

/** Retry refusals tracked has not acknowledged yet (oldest first). */
export async function retryRefusals(ctx: AppContext, client: TrackedClient): Promise<number> {
  const rows = ctx.db.prepare('SELECT request_id, error FROM tracked_refusals ORDER BY created_at ASC').all() as Array<{ request_id: string; error: string }>
  let delivered = 0
  for (const r of rows) if (await reportRefusal(ctx, client, r.request_id, r.error)) delivered++
  return delivered
}

// ---------------------------------------------------------------------------
// track uploads (/mkvid/track/*)

/** A rip shorter than expected x this is a preview clip when tracked sends no ratio. */
export const DEFAULT_MIN_DURATION_RATIO = 0.8

/**
 * The `preview_clip` refusal for a rip of `durationSeconds`, or null when it
 * is long enough or the expected length is unknown. tracked counts it as
 * permanent (isPermanentFailure): 1001tracklists' players often only have a
 * 30-90 s preview, and ripping it again gets the same preview.
 */
export function previewClipError(durationSeconds: number, expectedSeconds: number | null | undefined, ratio: number | null | undefined): string | null {
  const expected = Number(expectedSeconds)
  if (!(expected > 0) || !(durationSeconds > 0)) return null
  const r = Number(ratio) > 0 && Number(ratio) <= 1 ? Number(ratio) : DEFAULT_MIN_DURATION_RATIO
  if (durationSeconds >= expected * r) return null
  return `preview_clip: the rip is ${Math.round(durationSeconds)}s but the track is ${Math.round(expected)}s (needs at least ${Math.round(r * 100)}%, ${Math.round(expected * r)}s)`
}

const PRIVACIES: readonly Privacy[] = ['private', 'unlisted', 'public']

/** The job meta for a claimed track request (normalised: absolute track page, a valid ratio, ids as given). */
export function trackMetaFrom(req: TrackRequest): TrackedTrackMeta {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const ratio = num(req.minDurationRatio)
  return {
    origin: 'tracked-track',
    account: req.account === 'shared' ? 'shared' : 'primary',
    trackRequestId: req.id,
    presaveId: num(req.presaveId),
    sourceUrl: req.sourceUrl,
    sourceName: str(req.sourceName),
    expectedDurationSeconds: num(req.expectedDurationSeconds),
    minDurationRatio: ratio !== null && ratio > 0 && ratio <= 1 ? ratio : DEFAULT_MIN_DURATION_RATIO,
    artist: str(req.artist),
    title: str(req.title),
    artworkUrl: str(req.artworkUrl),
    trackUrl: absoluteTrackUrl(req.trackUrl),
  }
}

/**
 * The claim rule for track uploads: at most one track job here at a time
 * (queued or running), claimed on any tick when there is none. Deliberately
 * not canClaim: that one waits until every stage slot a set needs is free,
 * and a scene render holds the render slot for hours. A track job instead
 * runs through
 *   - download: the shared slot (a set's download is a minute or two; a
 *     track waits for it at most that long, and the other way round);
 *   - render: its own `track-render` slot (stage-gate.ts), never the set
 *     render slot, so it runs beside a scene render. It costs one ffmpeg
 *     (a couple of cores and one NVENC session, ~5x real time) for a few
 *     minutes; with one track at a time it never takes more than that;
 *   - upload: the shared UPLOAD_CONCURRENCY slots (a track's video is
 *     ~100-300 MB, a minute at most; a third upload beside two sets would
 *     only split the same uplink).
 * A set claim (canClaim) sees the track job like any other job holding a
 * stage, so a track does not let sets pile up either.
 */
export function canClaimTrack(inFlightTracks: readonly unknown[]): boolean {
  return inFlightTracks.length === 0
}

/** How long a `trackUploads: true` from /mkvid/health is trusted before asking again. */
export const TRACK_HEALTH_TTL_MS = 10 * 60_000
const trackHealth = new WeakMap<TrackedClient, number>()

async function trackUploadsAdvertised(client: TrackedClient, now: number): Promise<boolean> {
  const at = trackHealth.get(client)
  if (at !== undefined && now - at < TRACK_HEALTH_TTL_MS) return true
  const h = await client.health()
  if (h.trackUploads === true) { trackHealth.set(client, now); return true }
  trackHealth.delete(client)
  return false
}

export type TrackPollResult =
  | { action: 'disabled' } | { action: 'busy'; jobId: string } | { action: 'reporting' } | { action: 'not_connected' }
  | { action: 'waiting_for_tracked' } | { action: 'idle' }
  | { action: 'started'; jobId: string; requestId: number } | { action: 'refused'; requestId: number; reason: string }

/**
 * One poll of tracked's track uploads: renew the claim of the track job in
 * flight, then — TRACKED_TRACKS on, no track job here (canClaimTrack), every
 * finished one delivered, a YouTube account connected, and tracked saying
 * `trackUploads: true` on /mkvid/health — claim one and start it as a `track`
 * job. Outcomes are delivered by pollTracked's reporting step (reportJobToTracked
 * picks the endpoint by the job's origin). A request that cannot even become
 * a job (no source URL, hearthis lookup failed) is turned into a failed job,
 * so that refusal is delivered as durably as any other outcome.
 */
export async function pollTrackUploads(ctx: AppContext, client: TrackedClient, opts: { resolve?: typeof resolveSourceUrl; now?: () => number } = {}): Promise<TrackPollResult> {
  const cfg = ctx.config.tracked!
  const inFlight = ctx.jobs.inFlightTrackedTracks()
  for (const job of inFlight) {
    await client.trackJob(job.meta.trackRequestId, job.id)
      .catch((e: any) => log('warn', 'tracked: could not renew the track claim', { jobId: job.id, trackRequestId: job.meta.trackRequestId, err: String(e?.message || e) }))
  }
  if (!cfg.tracks) return { action: 'disabled' }
  if (!canClaimTrack(inFlight)) return { action: 'busy', jobId: inFlight[0]!.id }
  // A finished track whose outcome tracked has not acknowledged: deliver that first (its claim may lapse and come back).
  if (ctx.jobs.listUnreportedTracked().some((j) => j.meta?.origin === 'tracked-track')) return { action: 'reporting' }
  const accounts = ctx.connectedAccounts()
  if (accounts.length === 0) return { action: 'not_connected' }
  if (!(await trackUploadsAdvertised(client, (opts.now ?? Date.now)()))) return { action: 'waiting_for_tracked' }

  const req = await client.trackClaim(accounts)
  if (!req) return { action: 'idle' }
  const meta = trackMetaFrom(req)
  // Neither name known: no title here, so the pipeline takes the one yt-dlp reports.
  const title = meta.artist || meta.title ? trackVideoTitle(meta.artist, meta.title) : null
  const privacy: Privacy = PRIVACIES.includes(req.privacy as Privacy) ? req.privacy as Privacy : cfg.privacy
  log('info', 'tracked: claimed track', { trackRequestId: req.id, presaveId: meta.presaveId, title, source: meta.sourceName, sourceUrl: req.sourceUrl, expected: meta.expectedDurationSeconds, attempt: req.attempts, account: meta.account })

  const id = randomUUID()
  let url: string
  let refusal: string | null = null
  if (typeof req.sourceUrl !== 'string' || !/^https?:\/\//i.test(req.sourceUrl)) {
    url = String(req.sourceUrl ?? '')
    refusal = 'source: not an http(s) URL — unsupported url'
  } else {
    url = req.sourceUrl
    try {
      url = await (opts.resolve ?? resolveSourceUrl)(req.sourceUrl)
    } catch (e: any) {
      refusal = `source: ${String(e?.message || e)}`
    }
  }
  ctx.jobs.create({ id, url, title, privacy, style: 'track', meta })
  await client.trackJob(req.id, id).catch((e: any) => log('warn', 'tracked: could not attach job id to the track', { trackRequestId: req.id, err: String(e?.message || e) }))
  if (refusal) {
    ctx.jobs.setError(id, refusal)
    await reportJobToTracked(ctx, ctx.jobs.get(id)!, client)
    log('warn', 'tracked: refused track', { trackRequestId: req.id, jobId: id, permanent: isPermanentFailure(refusal), error: refusal.slice(0, 300) })
    return { action: 'refused', requestId: req.id, reason: refusal }
  }
  ctx.queue.enqueue(id)
  log('info', 'tracked: track job started', { jobId: id, trackRequestId: req.id, url })
  return { action: 'started', jobId: id, requestId: req.id }
}

/** Start the interval poller. Returns a stop function. */
export function startTrackedPoller(ctx: AppContext, client: TrackedClient): () => void {
  const cfg = ctx.config.tracked!
  let running = false
  let warnedNotConnected = false
  let warnedWaiting = false
  let warnedTracks = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const r = await pollTracked(ctx, client)
      if (r.action === 'waiting_for_tracked') {
        if (!warnedWaiting) log('warn', 'tracked: TRACKED_STYLE=scene but tracked does not advertise verified lists (/mkvid/health verifiedLists) — not claiming until it does')
        warnedWaiting = true
      } else warnedWaiting = false
      if (r.action === 'not_connected') {
        if (!warnedNotConnected) log('warn', 'tracked: YouTube not connected — not claiming work until it is')
        warnedNotConnected = true
      } else warnedNotConnected = false
    } catch (e: any) {
      log('warn', 'tracked: poll failed', { err: String(e?.message || e) })
    }
    // Track uploads: after the sets (their outcomes were just delivered), and never held up by a set-side failure.
    try {
      const t = await pollTrackUploads(ctx, client)
      if (t.action === 'waiting_for_tracked') {
        if (!warnedTracks) log('info', 'tracked: not claiming track uploads, tracked does not advertise them (/mkvid/health trackUploads)')
        warnedTracks = true
      } else warnedTracks = false
    } catch (e: any) {
      log('warn', 'tracked: track poll failed', { err: String(e?.message || e) })
    } finally {
      running = false
    }
  }
  client.health()
    .then((h) => log('info', 'tracked: connected', { url: cfg.url, counts: h.counts ?? null, trackUploads: h.trackUploads === true, claimTracks: cfg.tracks }))
    .catch((e: any) => log('error', 'tracked: health check failed (check TRACKED_URL / TRACKED_TOKEN)', { url: cfg.url, err: String(e?.message || e) }))
  const timer = setInterval(() => void tick(), cfg.pollSeconds * 1000)
  timer.unref()
  void tick()
  return () => clearInterval(timer)
}
