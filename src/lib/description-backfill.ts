/**
 * Bring the YouTube descriptions of mkvid's past tracked uploads up to the
 * current describeJob(): no "Rendered by mkvid for tracked …" paragraph, and
 * a Recording link a listener can open (soundcloud.com/<user>/<track>, not
 * api.soundcloud.com/tracks/<id>).
 *
 * Quota: `videos.list` costs 1 unit per call (50 ids), `videos.update` 50.
 * Each account is its own Google project with its own 10 000-unit day, which
 * also carries that project's other calls (tracked-youtube = the shared
 * account carries tracked's sync and playlist inserts). So a run spends at
 * most `limit` updates per account and never more than `budget` units per
 * account and quota day (midnight Pacific), counted in kv across runs. A job
 * is marked (jobs.description_synced_at) only after YouTube took the update,
 * or when its description was already current or the video is gone, so the
 * next run carries on where this one stopped.
 *
 * Only descriptions mkvid wrote are rewritten: one that a person edited
 * (anything but the old or the new template) is left alone and reported.
 */
import type { Job, KVCache, UploadAccount } from '../types.js'
import { describeJob, recordingLink } from './describe.js'
import { withAuthRetry, YouTubeHttpError, type TokenGetter } from './youtube.js'

export const LIST_COST = 1
export const UPDATE_COST = 50
const LIST_BATCH = 50
const API = 'https://www.googleapis.com/youtube/v3/videos'

/** The snippet fields videos.update takes back (everything else in a listed snippet is read-only). */
export interface VideoSnippet {
  title: string
  description: string
  categoryId: string
  tags?: string[]
  defaultLanguage?: string
  defaultAudioLanguage?: string
}

export interface VideosApi {
  /** videos.list part=snippet for up to 50 ids; ids YouTube does not return are gone. */
  list(accessToken: string, ids: string[]): Promise<Map<string, VideoSnippet>>
  update(accessToken: string, id: string, snippet: VideoSnippet): Promise<void>
}

async function failure(res: Response, what: string): Promise<YouTubeHttpError> {
  const text = await res.text().catch(() => '')
  let message = ''
  let reason = ''
  try {
    const err = JSON.parse(text)?.error
    message = err?.message ?? ''
    reason = err?.errors?.[0]?.reason ?? ''
  } catch { /* not JSON */ }
  return new YouTubeHttpError(res.status, `${what}: HTTP ${res.status}${reason ? ` ${reason}` : ''}${message ? ` — ${message}` : ''}`)
}

export function youtubeVideosApi(http: typeof fetch = fetch): VideosApi {
  return {
    async list(accessToken, ids) {
      const res = await http(`${API}?part=snippet&maxResults=50&id=${ids.map(encodeURIComponent).join(',')}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) throw await failure(res, 'videos.list')
      const data = await res.json() as { items?: Array<{ id: string; snippet?: Record<string, any> }> }
      const out = new Map<string, VideoSnippet>()
      for (const item of data.items ?? []) {
        const s = item.snippet ?? {}
        out.set(item.id, {
          title: String(s.title ?? ''), description: String(s.description ?? ''), categoryId: String(s.categoryId ?? ''),
          ...(Array.isArray(s.tags) ? { tags: s.tags.map(String) } : {}),
          ...(s.defaultLanguage ? { defaultLanguage: String(s.defaultLanguage) } : {}),
          ...(s.defaultAudioLanguage ? { defaultAudioLanguage: String(s.defaultAudioLanguage) } : {}),
        })
      }
      return out
    },
    async update(accessToken, id, snippet) {
      const res = await http(`${API}?part=snippet`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ id, snippet }),
      })
      if (!res.ok) throw await failure(res, 'videos.update')
      await res.body?.cancel().catch(() => {})
    },
  }
}

/** Unix ms of the most recent midnight in America/Los_Angeles, where the YouTube quota day starts. */
export function quotaDayStart(nowMs = Date.now()): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(nowMs))
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return (Math.floor(nowMs / 1000) - (get('hour') * 3600 + get('minute') * 60 + get('second'))) * 1000
}

const LEGACY_PARAGRAPH = 'Rendered by mkvid for tracked'

/**
 * Did mkvid write this description (any version of describeJob for this
 * job)? Anything else was edited by a person and is not ours to overwrite.
 */
export function isMkvidDescription(description: string, job: Pick<Job, 'url' | 'meta'>): boolean {
  const text = description.replace(/\r\n/g, '\n').trim()
  if (text === `Uploaded by mkvid from ${job.url}` || text === 'Uploaded by mkvid') return true
  const lines = text.split('\n')
  if (lines[0] !== `Tracklist: ${job.meta?.setUrl}` || !lines[1]?.startsWith('Recording: ')) return false
  const rest = lines.slice(2).join('\n').trim()
  return rest === '' || (rest.startsWith(LEGACY_PARAGRAPH) && !rest.includes('\n'))
}

const SOUNDCLOUD_API = /^https?:\/\/api\.soundcloud\.com\/tracks\/\d+/i
const PAGE_CACHE_TTL = 10 * 365 * 86400

/** Can yt-dlp turn this recording URL into a better page link? (Only SoundCloud API URLs need it.) */
export function needsPageLookup(job: Pick<Job, 'url' | 'meta'>): boolean {
  return !job.meta?.recordingUrl && SOUNDCLOUD_API.test(recordingLink(job))
}

/** A page URL for a SoundCloud API URL is only taken when it is a soundcloud.com page. */
function acceptablePage(url: string | null): url is string {
  return !!url && /^https:\/\/(?:www\.|m\.)?soundcloud\.com\/[^/]+\/[^/]/i.test(url)
}

export interface BackfillDeps {
  jobs: {
    descriptionBackfillPending(account: UploadAccount): Job[]
    markDescriptionSynced(id: string): void
    get(id: string): Job | null
    setMeta(id: string, meta: NonNullable<Job['meta']>): void
  }
  kv: KVCache
  tokenFor(account: UploadAccount): TokenGetter
  api: VideosApi
  /** yt-dlp's webpage_url for a recording URL; null or a throw = unknown. */
  probePage(url: string): Promise<string | null>
  log(line: string): void
  now?: () => number
}

export interface BackfillOptions {
  /** false = dry run: no YouTube writes, no job changes (reads only). */
  apply: boolean
  accounts: UploadAccount[]
  /** Most updates per account in this run. */
  limit: Record<UploadAccount, number>
  /** Most units per account and quota day, this backfill's own spend (kv ledger across runs). */
  budget: Record<UploadAccount, number>
  /** Dry run: how many videos to show old vs new for (per account). */
  sample: number
  /** Dry run: read the live descriptions (1 unit per 50); false = offline, only the new text. */
  readYouTube: boolean
  /** Rewrite descriptions that do not look like mkvid's (a person edited them). */
  force?: boolean
  /** When yt-dlp cannot name the SoundCloud page: write the api URL instead of leaving the video for a later run. */
  allowFallback?: boolean
}

export interface AccountReport {
  account: UploadAccount
  pending: number
  /** Units the whole backlog needs: an update each plus the list calls. */
  unitsNeeded: number
  /** Runs (quota days) at this run's limit/budget. */
  days: number
  spentToday: number
  updated: number
  alreadyCurrent: number
  gone: number
  handEdited: number
  unresolved: number
  stoppedBy: null | 'limit' | 'budget' | 'quota' | 'error'
  error?: string
}

export function unitsFor(videos: number): number {
  return videos * UPDATE_COST + Math.ceil(videos / LIST_BATCH) * LIST_COST
}

function ledgerKey(account: UploadAccount, now: number): string {
  return `descbackfill:units:${account}:${quotaDayStart(now)}`
}

function isQuotaError(e: unknown): boolean {
  return e instanceof YouTubeHttpError && e.status === 403 && /quota|rateLimit/i.test(e.message)
}

/** The page link for a job: recorded, cached, or asked of yt-dlp (and cached). null = unknown. */
async function pageFor(job: Job, deps: BackfillDeps): Promise<string | null> {
  if (!needsPageLookup(job)) return null
  const source = recordingLink(job)
  const key = `pageurl:${source}`
  const cached = deps.kv.get(key)
  if (cached) return cached
  let page: string | null = null
  try { page = await deps.probePage(source) } catch (e: any) {
    deps.log(`  yt-dlp could not resolve ${source}: ${String(e?.message || e).split('\n').pop()?.slice(0, 160)}`)
  }
  if (!acceptablePage(page)) return null
  deps.kv.set(key, page, PAGE_CACHE_TTL)
  return page
}

export async function runDescriptionBackfill(deps: BackfillDeps, opts: BackfillOptions): Promise<AccountReport[]> {
  const now = deps.now ?? Date.now
  const reports: AccountReport[] = []
  for (const account of opts.accounts) {
    const pending = deps.jobs.descriptionBackfillPending(account)
    const perDay = Math.max(0, Math.min(opts.limit[account], Math.floor((opts.budget[account] - LIST_COST) / UPDATE_COST)))
    const ledger = ledgerKey(account, now())
    const spentToday = Number(deps.kv.get(ledger) ?? 0)
    const r: AccountReport = {
      account, pending: pending.length, unitsNeeded: unitsFor(pending.length),
      days: pending.length === 0 ? 0 : perDay > 0 ? Math.ceil(pending.length / perDay) : Infinity,
      spentToday, updated: 0, alreadyCurrent: 0, gone: 0, handEdited: 0, unresolved: 0, stoppedBy: null,
    }
    reports.push(r)
    deps.log(`[${account}] ${pending.length} video(s) to bring up to date: ${r.unitsNeeded} units; at ${perDay} a day, ${r.days} day(s). Spent today by this backfill: ${spentToday}/${opts.budget[account]} units.`)
    if (!pending.length) continue

    if (!opts.apply) {
      const sample = pending.slice(0, Math.max(0, opts.sample))
      let live = new Map<string, VideoSnippet>()
      if (opts.readYouTube && sample.length) {
        try {
          live = await withAuthRetry(deps.tokenFor(account), (t) => deps.api.list(t, sample.map((j) => j.videoId!)))
        } catch (e: any) {
          r.stoppedBy = 'error'
          r.error = String(e?.message || e).slice(0, 300)
          deps.log(`  could not read the live descriptions: ${r.error}`)
        }
      }
      for (const job of sample) {
        const page = await pageFor(job, deps)
        const next = describeJob(job, page)
        deps.log(`\n  ${job.videoId}  (job ${job.id}${job.title ? `, "${job.title}"` : ''})`)
        const cur = live.get(job.videoId!)
        if (opts.readYouTube && !r.error) {
          if (!cur) deps.log('  (not on YouTube any more: would be marked done)')
          else {
            const owned = isMkvidDescription(cur.description, job)
            deps.log(`  --- now${owned ? '' : '  [edited by a person: left alone without --force]'}\n${indent(cur.description)}`)
            if (cur.description.trim() === next) deps.log('  (already current: would be marked done, no update)')
          }
        }
        deps.log(`  +++ new${needsPageLookup(job) && !page ? '  [SoundCloud page unresolved: api URL kept]' : ''}\n${indent(next)}`)
      }
      continue
    }

    const getToken = deps.tokenFor(account)
    let spent = spentToday
    const spend = (units: number) => { spent += units; deps.kv.set(ledger, String(spent), 2 * 86400) }
    outer: for (let i = 0; i < pending.length; i += LIST_BATCH) {
      if (r.updated >= opts.limit[account]) { r.stoppedBy = 'limit'; break }
      if (spent + LIST_COST + UPDATE_COST > opts.budget[account]) { r.stoppedBy = 'budget'; break }
      const batch = pending.slice(i, i + LIST_BATCH)
      let live: Map<string, VideoSnippet>
      try {
        live = await withAuthRetry(getToken, (t) => deps.api.list(t, batch.map((j) => j.videoId!)))
        spend(LIST_COST)
      } catch (e: any) {
        r.stoppedBy = isQuotaError(e) ? 'quota' : 'error'
        r.error = String(e?.message || e).slice(0, 300)
        break
      }
      for (const job of batch) {
        const cur = live.get(job.videoId!)
        if (!cur) {
          deps.log(`  ${job.videoId}: not on YouTube any more, skipped for good`)
          deps.jobs.markDescriptionSynced(job.id)
          r.gone++
          continue
        }
        if (!opts.force && !isMkvidDescription(cur.description, job)) {
          deps.log(`  ${job.videoId}: description was edited by a person, left alone (--force rewrites it)`)
          r.handEdited++
          continue
        }
        const page = await pageFor(job, deps)
        if (needsPageLookup(job) && !page && !opts.allowFallback) {
          deps.log(`  ${job.videoId}: SoundCloud page unknown for ${recordingLink(job)}, left for a later run (--allow-fallback writes the api URL)`)
          r.unresolved++
          continue
        }
        if (page) {
          // Keep it on the job: describeJob uses it from now on, and the next run need not ask yt-dlp.
          const fresh = deps.jobs.get(job.id)?.meta ?? job.meta!
          deps.jobs.setMeta(job.id, { ...fresh, recordingUrl: page })
        }
        const next = describeJob(job, page)
        if (cur.description.trim() === next) {
          deps.jobs.markDescriptionSynced(job.id)
          r.alreadyCurrent++
          continue
        }
        if (r.updated >= opts.limit[account]) { r.stoppedBy = 'limit'; break outer }
        if (spent + UPDATE_COST > opts.budget[account]) { r.stoppedBy = 'budget'; break outer }
        try {
          await withAuthRetry(getToken, (t) => deps.api.update(t, job.videoId!, { ...cur, description: next }))
        } catch (e: any) {
          // A refused update may still have been billed: count it.
          spend(UPDATE_COST)
          r.stoppedBy = isQuotaError(e) ? 'quota' : 'error'
          r.error = `${job.videoId}: ${String(e?.message || e).slice(0, 300)}`
          break outer
        }
        spend(UPDATE_COST)
        deps.jobs.markDescriptionSynced(job.id)
        r.updated++
        deps.log(`  ${job.videoId}: updated`)
      }
    }
    r.spentToday = spent
    const left = deps.jobs.descriptionBackfillPending(account).length
    deps.log(`[${account}] updated ${r.updated}, already current ${r.alreadyCurrent}, gone ${r.gone}, edited by a person ${r.handEdited}, page unresolved ${r.unresolved}; ${left} left; ${spent} units spent today${r.stoppedBy ? `; stopped: ${r.stoppedBy}${r.error ? ` (${r.error})` : ''}` : ''}`)
  }
  return reports
}

function indent(text: string): string {
  return text.split('\n').map((l) => `    ${l}`).join('\n')
}
