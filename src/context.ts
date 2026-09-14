import type Database from 'better-sqlite3'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import type { Config } from './config.js'
import type { TokenStore, KVCache } from './types.js'
import { openDb } from './db/index.js'
import { makeTokenStore } from './db/tokens.js'
import { makeJobsRepo } from './db/jobs.js'
import { makeKvCache } from './db/kv.js'
import { makePushRepo } from './db/push.js'
import { SseHub } from './lib/sse.js'
import { JobQueue } from './lib/queue.js'
import { runJob } from './lib/pipeline.js'
import { makeTrackedClient, reportJobToTracked, type TrackedClient } from './lib/tracked.js'

export interface AppContext {
  config: Config
  db: Database.Database
  jobs: ReturnType<typeof makeJobsRepo>
  tokens: TokenStore
  kv: KVCache
  push: ReturnType<typeof makePushRepo>
  hub: SseHub
  queue: JobQueue
  /** Client for tracked's mkvid queue; null when TRACKED_URL/TRACKED_TOKEN are unset. */
  tracked: TrackedClient | null
}

export function buildContext(config: Config, opts: { tracked?: TrackedClient | null } = {}): AppContext {
  const db = openDb(config.dataDir === ':memory:' ? ':memory:' : join(config.dataDir, 'db', 'mkvid.sqlite'))
  const ctx = {
    config, db,
    jobs: makeJobsRepo(db), tokens: makeTokenStore(db), kv: makeKvCache(db), push: makePushRepo(db),
    hub: new SseHub(),
    tracked: opts.tracked !== undefined ? opts.tracked : config.tracked ? makeTrackedClient(config.tracked) : null,
  } as AppContext
  // After every job, hand its outcome to tracked if it came from there (a
  // no-op for UI jobs). Reads the job row, so it is the durable status that
  // gets reported, not an in-memory event.
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
  })
  ctx.jobs.markRunningInterrupted() // recover from a crash mid-job
  // Reclaim disk from work dirs orphaned by a crash/kill (each can hold a ~0.3 GB mp4).
  if (config.dataDir !== ':memory:') {
    try { rmSync(join(config.dataDir, 'work'), { recursive: true, force: true }) } catch { /* ignore */ }
  }
  return ctx
}
