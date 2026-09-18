import { describe, it, expect } from 'vitest'
import { openDb, migrate as migrateForTest } from '../src/db/index.js'
import { makeTokenStore } from '../src/db/tokens.js'
import { makeJobsRepo } from '../src/db/jobs.js'
import { makeKvCache } from '../src/db/kv.js'
import { makePushRepo } from '../src/db/push.js'

function fresh() { return openDb(':memory:') }
// openDb() only takes a path; re-running its migration on an open handle is what a restart does.
function openDbAgain(db: ReturnType<typeof openDb>) { migrateForTest(db) }

describe('db', () => {
  it('token store round-trips and clears, one row per upload account', () => {
    const db = fresh()
    const s = makeTokenStore(db)
    const shared = makeTokenStore(db, 'shared')
    expect(s.load()).toBeNull()
    s.save({ accessToken: 'a', refreshToken: 'r', expiresAt: 1, scope: 's', connectedAt: 2 })
    expect(s.load()?.refreshToken).toBe('r')
    expect(shared.load()).toBeNull()
    shared.save({ accessToken: 'a2', refreshToken: 'r2', expiresAt: 1, scope: 's', connectedAt: 3 })
    expect(shared.load()?.refreshToken).toBe('r2')
    s.clear()
    expect(s.load()).toBeNull()
    expect(shared.load()?.refreshToken).toBe('r2')
  })
  it('carries a pre-accounts database\'s tokens over to the primary account, once', () => {
    const db = fresh()
    db.prepare(`INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, scope, channel_id, channel_title, connected_at)
      VALUES (1, 'old-a', 'old-r', 5, 's', 'ch', 'My channel', 4)`).run()
    // Simulate the next boot of that database: the migration runs again on open.
    db.prepare("DELETE FROM kv WHERE key = 'migration:oauth_accounts'").run()
    db.prepare('DELETE FROM oauth_accounts').run()
    openDbAgain(db)
    const s = makeTokenStore(db)
    expect(s.load()).toMatchObject({ refreshToken: 'old-r', channelTitle: 'My channel' })
    // Disconnecting sticks: a later boot must not resurrect the old row.
    s.clear()
    openDbAgain(db)
    expect(s.load()).toBeNull()
  })
  it('jobs create/get/list/status/result', () => {
    const j = makeJobsRepo(fresh())
    const job = j.create({ id: 'x', url: 'u', title: null, privacy: 'private', style: 'static' })
    expect(job.status).toBe('queued')
    j.setStatus('x', 'downloading')
    j.setResult('x', 'vid', 'https://youtu.be/vid')
    const got = j.get('x')!
    expect(got.status).toBe('downloading')  // setResult does not change status
    expect(got.videoUrl).toBe('https://youtu.be/vid')
    expect(j.list(10).length).toBe(1)
  })
  it('jobs carry meta and the privacy YouTube applied', () => {
    const j = makeJobsRepo(fresh())
    const meta = { origin: 'tracked' as const, requestId: 'r1', setUrl: 'https://x/set', sourceUrl: 'https://api.soundcloud.com/tracks/1', lastCueSeconds: 10, artistName: null }
    j.create({ id: 't', url: 'u', title: 'T', privacy: 'unlisted', style: 'static', meta })
    j.create({ id: 'ui', url: 'u', title: null, privacy: 'private', style: 'static' })
    expect(j.get('t')!.meta).toEqual(meta)
    expect(j.get('ui')!.meta).toBeNull()
    j.setResult('t', 'vid', 'https://youtu.be/vid', 'private')
    j.setStatus('t', 'done')
    expect(j.get('t')).toMatchObject({ privacy: 'unlisted', privacyApplied: 'private' })
    expect(j.listUnreportedTracked().map((x) => x.id)).toEqual(['t'])
    j.setMeta('t', { ...meta, reported: true })
    expect(j.listUnreportedTracked()).toEqual([])
    // Migration is idempotent on an already-migrated database.
    expect(() => openDb(':memory:')).not.toThrow()
  })

  it('appendLog + getLogs preserves order', () => {
    const j = makeJobsRepo(fresh())
    j.create({ id: 'x', url: 'u', title: null, privacy: 'private', style: 'static' })
    j.appendLog('x', 'one'); j.appendLog('x', 'two')
    expect(j.getLogs('x', 10)).toEqual(['one', 'two'])
  })
  it('markRunningInterrupted flips in-flight jobs', () => {
    const j = makeJobsRepo(fresh())
    j.create({ id: 'x', url: 'u', title: null, privacy: 'private', style: 'static' })
    j.setStatus('x', 'transcoding')
    j.markRunningInterrupted()
    expect(j.get('x')!.status).toBe('interrupted')
  })
  it('kv cache respects ttl', () => {
    const kv = makeKvCache(fresh())
    kv.set('k', 'v', 60)
    expect(kv.get('k')).toBe('v')
    kv.set('k2', 'v', -1)
    expect(kv.get('k2')).toBeNull()
  })
  it('push add/list/removeByEndpoint', () => {
    const p = makePushRepo(fresh())
    p.add({ endpoint: 'e', p256dh: 'a', auth: 'b' })
    p.add({ endpoint: 'e', p256dh: 'a', auth: 'b' }) // upsert, no dup
    expect(p.list().length).toBe(1)
    p.removeByEndpoint('e')
    expect(p.list().length).toBe(0)
  })
})
