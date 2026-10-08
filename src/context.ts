import type Database from 'better-sqlite3'
import { join } from 'node:path'
import { readdirSync, rmSync } from 'node:fs'
import type { Config } from './config.js'
import type { TokenStore, KVCache, UploadAccount } from './types.js'
import { openDb } from './db/index.js'
import { makeTokenStore } from './db/tokens.js'
import { makeJobsRepo } from './db/jobs.js'
import { makeKvCache } from './db/kv.js'
import { makePushRepo } from './db/push.js'
import { SseHub } from './lib/sse.js'
import { JobQueue } from './lib/queue.js'
import { StageGate } from './lib/stage-gate.js'
import { runJob, claimSceneResume, isKeptWork, pruneKeptWork } from './lib/pipeline.js'
import { log } from './lib/log.js'
import { makeTrackedClient, reportJobToTracked, type TrackedClient } from './lib/tracked.js'

export interface AppContext {
  config: Config
  db: Database.Database
  jobs: ReturnType<typeof makeJobsRepo>
  /** The primary account's YouTube tokens (mkvid's own Google project). */
  tokens: TokenStore
  /** Tokens for the shared account (the tracked sync's project); null unless SHARED_GOOGLE_OAUTH_CLIENT_* is set. */
  tokensShared: TokenStore | null
  /** The token store + OAuth client for an account; the shared one only when configured. */
  accountFor(account: UploadAccount | undefined): { store: TokenStore; google: Config['google'] }
  /** Accounts that can upload right now: configured and with a connected YouTube token. Fill order. */
  connectedAccounts(): UploadAccount[]
  kv: KVCache
  push: ReturnType<typeof makePushRepo>
  hub: SseHub
  queue: JobQueue
  /** One job per stage at a time (download, analyse, render, assemble), UPLOAD_CONCURRENCY in upload. */
  gate: StageGate
  /** Client for tracked's mkvid queue; null when TRACKED_URL/TRACKED_TOKEN are unset. */
  tracked: TrackedClient | null
}

/**
 * Jobs in flight at once: no limit. The stage gate allows one job per stage
 * (UPLOAD_CONCURRENCY in upload), and the tracked poller claims a set only
 * when it can start downloading right away (tracked.ts canClaim), so this
 * many is about one per stage slot.
 */
export const JOB_SLOTS = Number.POSITIVE_INFINITY

export function buildContext(config: Config, opts: { tracked?: TrackedClient | null } = {}): AppContext {
  const db = openDb(config.dataDir === ':memory:' ? ':memory:' : join(config.dataDir, 'db', 'mkvid.sqlite'))
  const ctx = {
    config, db,
    jobs: makeJobsRepo(db), tokens: makeTokenStore(db, 'primary'), tokensShared: config.googleShared ? makeTokenStore(db, 'shared') : null,
    kv: makeKvCache(db), push: makePushRepo(db),
    hub: new SseHub(),
    gate: new StageGate({ upload: config.uploadConcurrency }),
    tracked: opts.tracked !== undefined ? opts.tracked : config.tracked ? makeTrackedClient(config.tracked) : null,
  } as AppContext
  ctx.accountFor = (account) =>
    account === 'shared' && ctx.tokensShared && config.googleShared
      ? { store: ctx.tokensShared, google: config.googleShared }
      : { store: ctx.tokens, google: config.google }
  ctx.connectedAccounts = () => {
    const out: UploadAccount[] = []
    if (ctx.tokens.load()) out.push('primary')
    if (ctx.tokensShared?.load()) out.push('shared')
    return out
  }
  // After every job, hand its outcome to tracked if it came from there (a
  // no-op for UI jobs). Reads the job row, so it is the durable status that
  // gets reported, not an in-memory event. No job limit: the stage gate
  // keeps every job in a different stage (one renders while others download,
  // analyse, assemble or upload).
  ctx.queue = new JobQueue(async (jobId) => {
    try {
      await runJob(ctx, jobId)
    } catch (e: any) {
      // runJob handles its own failures; this is the rare throw before its
      // try (e.g. the work dir could not be created). Still a final state.
      ctx.jobs.setError(jobId, `job setup failed: ${String(e?.message || e)}`)
    }
    const job = ctx.jobs.get(jobId)
    if (job) await reportJobToTracked(ctx, job, ctx.tracked)
  }, JOB_SLOTS)
  // Recover from a crash/restart mid-job. Jobs of the old styles become
  // `interrupted`; a scene job whose audio was downloaded goes back on the
  // queue and resumes from its finished segments (hours of rendering that a
  // Watchtower restart must not throw away).
  const workRoot = join(config.dataDir, 'work')
  const resumed = config.dataDir === ':memory:'
    ? (ctx.jobs.markRunningInterrupted(), [])
    : ctx.jobs.recoverAfterRestart((job) => claimSceneResume(job, join(workRoot, job.id), config.viz.maxResumes))
  // Reclaim disk from work dirs orphaned by a crash/kill (each can hold a ~0.3 GB mp4), except the resumed ones.
  if (config.dataDir !== ':memory:') {
    let entries: string[] = []
    try { entries = readdirSync(workRoot) } catch { /* no work dir yet */ }
    for (const name of entries) {
      // Resumed jobs, and failed scene jobs keeping their work for a retry.
      if (resumed.includes(name) || isKeptWork(ctx, name)) continue
      try { rmSync(join(workRoot, name), { recursive: true, force: true }) } catch { /* ignore */ }
    }
    pruneKeptWork(ctx)
  }
  for (const id of resumed) {
    log('info', 'resuming scene job after restart', { jobId: id })
    ctx.queue.enqueue(id)
  }
  return ctx
}
