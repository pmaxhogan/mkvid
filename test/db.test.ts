import { describe, it, expect } from 'vitest'
import { openDb } from '../src/db/index.js'
import { makeTokenStore } from '../src/db/tokens.js'
import { makeJobsRepo } from '../src/db/jobs.js'
import { makeKvCache } from '../src/db/kv.js'
import { makePushRepo } from '../src/db/push.js'

function fresh() { return openDb(':memory:') }

describe('db', () => {
  it('token store round-trips and clears', () => {
    const s = makeTokenStore(fresh())
    expect(s.load()).toBeNull()
    s.save({ accessToken: 'a', refreshToken: 'r', expiresAt: 1, scope: 's', connectedAt: 2 })
    expect(s.load()?.refreshToken).toBe('r')
    s.clear()
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
