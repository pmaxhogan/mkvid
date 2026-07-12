import type Database from 'better-sqlite3'
import { join } from 'node:path'
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

export interface AppContext {
  config: Config
  db: Database.Database
  jobs: ReturnType<typeof makeJobsRepo>
  tokens: TokenStore
  kv: KVCache
  push: ReturnType<typeof makePushRepo>
  hub: SseHub
  queue: JobQueue
}

export function buildContext(config: Config): AppContext {
  const db = openDb(config.dataDir === ':memory:' ? ':memory:' : join(config.dataDir, 'db', 'mkvid.sqlite'))
  const ctx = {
    config, db,
    jobs: makeJobsRepo(db), tokens: makeTokenStore(db), kv: makeKvCache(db), push: makePushRepo(db),
    hub: new SseHub(),
  } as AppContext
  ctx.queue = new JobQueue((jobId) => runJob(ctx, jobId))
  ctx.jobs.markRunningInterrupted() // recover from a crash mid-job
  return ctx
}
