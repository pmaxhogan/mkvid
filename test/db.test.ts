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
