import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.js'
import { buildContext } from '../src/context.js'
import {
  canClaim,
  clipError,
  isFinalRejection,
  isPermanentFailure,
  MAX_REPORTED_ERROR,
  makeTrackedClient,
  pollTrackUploads,
  previewClipError,
  reportJobToTracked,
  trackMetaFrom,
  TrackedHttpError,
  type TrackedClient,
  type TrackRequest,
} from '../src/lib/tracked.js'
import { absoluteTrackUrl, describeJob, trackVideoTitle } from '../src/lib/describe.js'
import { describeProgress, STAGES_PLAIN } from '../src/lib/render-progress.js'
import type { Job, TrackedSetMeta } from '../src/types.js'

const cfg = loadConfig({ DATA_DIR: ':memory:', TRACKED_URL: 'https://tracked.example/', TRACKED_TOKEN: 'mk', YTDLP_PATH: 'definitely-not-a-binary' } as any)
const tmp = mkdtempSync(join(tmpdir(), 'mkvid-track-test-'))
const diskCfg = { ...cfg, dataDir: tmp }
const openContexts: Array<ReturnType<typeof buildContext>> = []
afterAll(() => {
  for (const c of openContexts) c.db.close()
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
})

type Calls = Array<[string, unknown]>
function fakeClient(tracks: TrackRequest[] = [], health: Awaited<ReturnType<TrackedClient['health']>> = { ok: true, trackUploads: true }): TrackedClient & { calls: Calls } {
  const calls: Calls = []
  return {
    calls,
    async claim(accounts) { calls.push(['claim', [...accounts]]); return null },
    async job(id, jobId) { calls.push(['job', { id, jobId }]) },
    async complete(input) { calls.push(['complete', input]); return { status: 'done' } },
    async fail(input) { calls.push(['fail', input]) },
    async health() { calls.push(['health', null]); return health },
    async trackClaim(accounts) { calls.push(['trackClaim', [...accounts]]); return tracks.shift() ?? null },
    async trackJob(id, jobId) { calls.push(['trackJob', { id, jobId }]) },
    async trackComplete(input) { calls.push(['trackComplete', input]); return { status: 'done' } },
    async trackFail(input) { calls.push(['trackFail', input]) },
  }
}

const track: TrackRequest = {
  id: 7, presaveId: 42, artist: 'Odd Mob', title: 'Tobehonest (Where Ya At)', artworkUrl: 'https://img.example/a.jpg',
  trackUrl: '/track/1hf79cg5/odd-mob-tobehonest/index.html', sourceName: 'soundcloud', sourceUrl: 'https://api.soundcloud.com/tracks/123',
  expectedDurationSeconds: 210, minDurationRatio: 0.8, privacy: 'public', account: 'primary', attempts: 0,
}

const connected = (ctx: ReturnType<typeof buildContext>) =>
  ctx.tokens.save({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, scope: 's', connectedAt: 1 })

const setMeta: TrackedSetMeta = {
  origin: 'tracked', requestId: 'req-1', setUrl: 'https://www.1001tracklists.com/tracklist/x/set.html', sourceUrl: 'https://api.soundcloud.com/tracks/9',
  lastCueSeconds: 100, artistName: 'DJ',
}

describe('config', () => {
  it('TRACKED_TRACKS is on by default; 0/false turns it off', () => {
    const env = { TRACKED_URL: 'x', TRACKED_TOKEN: 't' }
    expect(loadConfig(env as any).tracked!.tracks).toBe(true)
    expect(loadConfig({ ...env, TRACKED_TRACKS: '' } as any).tracked!.tracks).toBe(true)
    expect(loadConfig({ ...env, TRACKED_TRACKS: '1' } as any).tracked!.tracks).toBe(true)
    expect(loadConfig({ ...env, TRACKED_TRACKS: '0' } as any).tracked!.tracks).toBe(false)
    expect(loadConfig({ ...env, TRACKED_TRACKS: 'false' } as any).tracked!.tracks).toBe(false)
  })
  it('the track style is never a set style (TRACKED_STYLE=track falls back to static)', () => {
    expect(loadConfig({ TRACKED_URL: 'x', TRACKED_TOKEN: 't', TRACKED_STYLE: 'track' } as any).tracked!.style).toBe('static')
  })
})

describe('makeTrackedClient: track endpoints', () => {
  it('POSTs /mkvid/track/claim|job|complete|fail with the bearer and JSON bodies', async () => {
    const seen: Array<{ url: string; method: string; body: unknown; auth: string }> = []
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : null, auth: (init.headers as Record<string, string>).authorization })
      if (url.endsWith('/mkvid/track/claim')) return new Response(JSON.stringify({ request: track }), { status: 200 })
      if (url.endsWith('/mkvid/health')) return new Response(JSON.stringify({ ok: true, trackUploads: true }), { status: 200 })
      if (url.endsWith('/mkvid/track/fail')) return new Response('{"error":"not_found"}', { status: 404 })
      return new Response('{"ok":true}', { status: 200 })
    }) as unknown as typeof fetch
    const client = makeTrackedClient(cfg.tracked!, fetcher)
    expect(await client.trackClaim(['primary', 'shared'])).toEqual(track)
    await client.trackJob(7, 'job-1')
    await client.trackComplete({ id: 7, videoId: 'abcdefghijk', videoUrl: 'https://youtu.be/abcdefghijk', privacy: 'public', jobId: 'job-1' })
    await expect(client.trackFail({ id: 7, error: 'x', permanent: false, jobId: 'job-1' })).rejects.toBeInstanceOf(TrackedHttpError)
    expect((await client.health()).trackUploads).toBe(true)
    expect(seen.map((s) => [s.method, s.url, s.body])).toEqual([
      ['POST', 'https://tracked.example/mkvid/track/claim', { accounts: ['primary', 'shared'] }],
      ['POST', 'https://tracked.example/mkvid/track/job', { id: 7, jobId: 'job-1' }],
      ['POST', 'https://tracked.example/mkvid/track/complete', { id: 7, videoId: 'abcdefghijk', videoUrl: 'https://youtu.be/abcdefghijk', privacy: 'public', jobId: 'job-1' }],
      ['POST', 'https://tracked.example/mkvid/track/fail', { id: 7, error: 'x', permanent: false, jobId: 'job-1' }],
      ['GET', 'https://tracked.example/mkvid/health', null],
    ])
    expect(seen.every((s) => s.auth === 'Bearer mk')).toBe(true)
  })
  it('a claim answering { request: null } is null', async () => {
    const client = makeTrackedClient(cfg.tracked!, (async () => new Response('{"request":null}')) as unknown as typeof fetch)
    expect(await client.trackClaim(['primary'])).toBeNull()
  })
})

describe('duration check', () => {
  it('refuses a rip shorter than expected x ratio as a permanent preview_clip', () => {
    expect(previewClipError(30, 210, 0.8)).toMatch(/^preview_clip: the rip is 30s but the track is 210s/)
    expect(isPermanentFailure(previewClipError(30, 210, 0.8)!)).toBe(true)
    expect(previewClipError(168, 210, 0.8)).toBeNull() // exactly 80 %
    expect(previewClipError(167, 210, 0.8)).not.toBeNull()
    expect(previewClipError(500, 210, 0.8)).toBeNull()
  })
  it('lets it through when the expected length is unknown; a missing or bad ratio means 0.8', () => {
    expect(previewClipError(30, null, 0.8)).toBeNull()
    expect(previewClipError(30, 0, 0.8)).toBeNull()
    expect(previewClipError(160, 210, null)).not.toBeNull()
    expect(previewClipError(170, 210, 5)).toBeNull()
    expect(previewClipError(100, 210, 0.4)).toBeNull()
  })
})

describe('trackMetaFrom', () => {
  it('normalises the request into the job meta', () => {
    expect(trackMetaFrom(track)).toEqual({
      origin: 'tracked-track', account: 'primary', trackRequestId: 7, presaveId: 42,
      sourceUrl: track.sourceUrl, sourceName: 'soundcloud', expectedDurationSeconds: 210, minDurationRatio: 0.8,
      artist: 'Odd Mob', title: 'Tobehonest (Where Ya At)', artworkUrl: 'https://img.example/a.jpg',
      trackUrl: 'https://www.1001tracklists.com/track/1hf79cg5/odd-mob-tobehonest/index.html',
    })
    const m = trackMetaFrom({ ...track, account: 'shared', minDurationRatio: null, expectedDurationSeconds: '200' as any, trackUrl: null, artist: '  ' })
    expect(m).toMatchObject({ account: 'shared', minDurationRatio: 0.8, expectedDurationSeconds: 200, trackUrl: null, artist: null })
  })
})

describe('descriptions and titles', () => {
  it('trackVideoTitle: "<artist> - <title>", at most 100, no < or >', () => {
    expect(trackVideoTitle('Odd Mob', 'Tobehonest')).toBe('Odd Mob - Tobehonest')
    expect(trackVideoTitle(null, 'Only')).toBe('Only')
    expect(trackVideoTitle('Only Artist', null)).toBe('Only Artist')
    expect(trackVideoTitle(null, null)).toBe('Untitled track')
    expect(trackVideoTitle('A <3', 'B > C')).toBe('A ‹3 - B › C')
    expect(trackVideoTitle('A\nB', ' C\t ')).toBe('A B - C')
    const long = trackVideoTitle('Artist', 'x'.repeat(200))
    expect(long.length).toBe(100)
    expect(long.endsWith('…')).toBe(true)
    // Never splits a surrogate pair.
    const emoji = trackVideoTitle('A', '😀'.repeat(80))
    expect(emoji.length).toBeLessThanOrEqual(100)
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji)).toBe(false)
  })
  it('absoluteTrackUrl puts a path on 1001tracklists and drops anything else', () => {
    expect(absoluteTrackUrl('/track/abc/x/index.html')).toBe('https://www.1001tracklists.com/track/abc/x/index.html')
    expect(absoluteTrackUrl('http://www.1001tracklists.com/track/abc/')).toBe('https://www.1001tracklists.com/track/abc/')
    expect(absoluteTrackUrl('https://evil.example/track')).toBeNull()
    expect(absoluteTrackUrl('javascript:alert(1)')).toBeNull()
    expect(absoluteTrackUrl(null)).toBeNull()
  })
  it('a track upload names the 1001tracklists page and the source, and says mkvid uploaded it', () => {
    const job = { url: 'https://api.soundcloud.com/tracks/123', meta: trackMetaFrom(track) }
    expect(describeJob(job, 'https://soundcloud.com/oddmob/tobehonest')).toBe([
      'https://www.1001tracklists.com/track/1hf79cg5/odd-mob-tobehonest/index.html',
      'https://soundcloud.com/oddmob/tobehonest',
      '',
      'Uploaded by mkvid',
    ].map((l, i) => (i === 0 ? `1001Tracklists: ${l}` : i === 1 ? `Source (soundcloud): ${l}` : l)).join('\n'))
    // No page known: the source URL, no 1001tracklists line.
    expect(describeJob({ ...job, meta: { ...job.meta, trackUrl: null } })).toBe('Source (soundcloud): https://api.soundcloud.com/tracks/123\n\nUploaded by mkvid')
  })
  it('a set keeps its description', () => {
    expect(describeJob({ url: 'https://x', meta: setMeta }, 'https://soundcloud.com/a/b')).toBe(`Tracklist: ${setMeta.setUrl}\nRecording: https://soundcloud.com/a/b`)
  })
})

describe('reportJobToTracked: the endpoint goes by the job origin', () => {
  const finished = (ctx: ReturnType<typeof buildContext>, meta: any, ok: boolean, id: string) => {
    ctx.jobs.create({ id, url: 'https://x', title: 't', privacy: 'public', style: meta.origin === 'tracked' ? 'static' : 'track', meta })
    if (ok) { ctx.jobs.setResult(id, 'abcdefghijk', 'https://youtu.be/abcdefghijk', 'public'); ctx.jobs.setStatus(id, 'done') } else ctx.jobs.setError(id, 'preview_clip: the rip is 30s')
    return ctx.jobs.get(id)!
  }

  it('a done track job goes to /mkvid/track/complete, a set to /mkvid/complete', async () => {
    const client = fakeClient()
    const ctx = buildContext(cfg, { tracked: client })
    expect(await reportJobToTracked(ctx, finished(ctx, trackMetaFrom(track), true, 'j-track'), client)).toBe(true)
    expect(await reportJobToTracked(ctx, finished(ctx, setMeta, true, 'j-set'), client)).toBe(true)
    expect(client.calls).toEqual([
      ['trackComplete', { id: 7, videoId: 'abcdefghijk', videoUrl: 'https://youtu.be/abcdefghijk', privacy: 'public', jobId: 'j-track', artist: 'Odd Mob', title: 'Tobehonest (Where Ya At)', artworkUrl: 'https://img.example/a.jpg' }],
      ['complete', { id: 'req-1', videoId: 'abcdefghijk', videoUrl: 'https://youtu.be/abcdefghijk', privacy: 'public', jobId: 'j-set', style: 'static' }],
    ])
    expect(ctx.jobs.get('j-track')!.meta!.reported).toBe(true)
  })

  it('a failed track job goes to /mkvid/track/fail, permanent for a preview clip', async () => {
    const client = fakeClient()
    const ctx = buildContext(cfg, { tracked: client })
    await reportJobToTracked(ctx, finished(ctx, trackMetaFrom(track), false, 'j-track'), client)
    expect(client.calls).toEqual([['trackFail', { id: 7, error: 'preview_clip: the rip is 30s', permanent: true, jobId: 'j-track' }]])
  })

  it('a 404 / 409 from tracked drops the report; a network error keeps it for the next tick', async () => {
    for (const status of [404, 409]) {
      const client = fakeClient()
      client.trackComplete = async () => { throw new TrackedHttpError(status, '{"error":"not_found"}') }
      const ctx = buildContext(cfg, { tracked: client })
      expect(await reportJobToTracked(ctx, finished(ctx, trackMetaFrom(track), true, 'j'), client)).toBe(true)
      expect(ctx.jobs.listUnreportedTracked()).toEqual([])
    }
    const client = fakeClient()
    client.trackFail = async () => { throw new Error('fetch failed') }
    const ctx = buildContext(cfg, { tracked: client })
    expect(await reportJobToTracked(ctx, finished(ctx, trackMetaFrom(track), false, 'j'), client)).toBe(false)
    expect(ctx.jobs.listUnreportedTracked().map((j) => j.id)).toEqual(['j'])
  })

  it('an interrupted track job without a video is a retryable failure', async () => {
    const client = fakeClient()
    const ctx = buildContext(cfg, { tracked: client })
    ctx.jobs.create({ id: 'j', url: 'https://x', title: 't', privacy: 'public', style: 'track', meta: trackMetaFrom(track) })
    ctx.jobs.setStatus('j', 'interrupted')
    await reportJobToTracked(ctx, ctx.jobs.get('j')!, client)
    expect(client.calls).toEqual([['trackFail', { id: 7, error: 'mkvid restarted mid-job', permanent: false, jobId: 'j' }]])
  })
})

describe('pollTrackUploads: claim gating', () => {
  it('claims one track and starts a track job with the request\'s privacy, title and meta', async () => {
    const client = fakeClient([track])
    const ctx = buildContext(cfg, { tracked: client })
    connected(ctx)
    const enqueue = vi.spyOn(ctx.queue, 'enqueue').mockImplementation(() => {})
    const r = await pollTrackUploads(ctx, client, { resolve: async (u) => u })
    expect(r).toMatchObject({ action: 'started', requestId: 7 })
    const job = ctx.jobs.get((r as { jobId: string }).jobId)!
    expect(job).toMatchObject({ style: 'track', privacy: 'public', title: 'Odd Mob - Tobehonest (Where Ya At)', url: track.sourceUrl, status: 'queued' })
    expect(job.meta).toMatchObject({ origin: 'tracked-track', trackRequestId: 7 })
    expect(enqueue).toHaveBeenCalledWith(job.id)
    expect(client.calls).toEqual([['health', null], ['trackClaim', ['primary']], ['trackJob', { id: 7, jobId: job.id }]])
  })

  it('claims a track while a scene render holds the render slot (a set claim would not)', async () => {
    const client = fakeClient([track])
    const ctx = buildContext(cfg, { tracked: client })
    connected(ctx)
    vi.spyOn(ctx.queue, 'enqueue').mockImplementation(() => {})
    let release!: () => void
    const held = ctx.gate.run('render', 'scene-job', () => new Promise<void>((r) => { release = r }))
    // A set waiting for render behind it: canClaim says no.
    const waiting = ctx.gate.run('render', 'set-2', async () => {})
    expect(canClaim(ctx)).toBe(false)
    expect(await pollTrackUploads(ctx, client, { resolve: async (u) => u })).toMatchObject({ action: 'started' })
    release(); await held; await waiting
  })

  it('one track at a time: busy while one is queued or running, and its claim is renewed every tick', async () => {
    const client = fakeClient([track, { ...track, id: 8 }])
    const ctx = buildContext(cfg, { tracked: client })
    connected(ctx)
    vi.spyOn(ctx.queue, 'enqueue').mockImplementation(() => {})
    const r = await pollTrackUploads(ctx, client, { resolve: async (u) => u })
    const jobId = (r as { jobId: string }).jobId
    client.calls.length = 0
    expect(await pollTrackUploads(ctx, client)).toEqual({ action: 'busy', jobId })
    ctx.jobs.setStatus(jobId, 'transcoding')
    expect(await pollTrackUploads(ctx, client)).toEqual({ action: 'busy', jobId })
    expect(client.calls).toEqual([['trackJob', { id: 7, jobId }], ['trackJob', { id: 7, jobId }]])
    // Done and delivered: the next tick claims again.
    ctx.jobs.setStatus(jobId, 'done')
    ctx.jobs.setMeta(jobId, { ...ctx.jobs.get(jobId)!.meta!, reported: true })
    expect(await pollTrackUploads(ctx, client, { resolve: async (u) => u })).toMatchObject({ action: 'started', requestId: 8 })
  })

  it('does not claim while a finished track is not delivered yet', async () => {
    const client = fakeClient([track])
    const ctx = buildContext(cfg, { tracked: client })
    connected(ctx)
    ctx.jobs.create({ id: 'old', url: 'https://x', title: 't', privacy: 'public', style: 'track', meta: trackMetaFrom(track) })
    ctx.jobs.setError('old', 'boom')
    expect(await pollTrackUploads(ctx, client)).toEqual({ action: 'reporting' })
    expect(client.calls).toEqual([])
  })

  it('claims nothing with TRACKED_TRACKS off, without a connected account, or from a tracked without trackUploads', async () => {
    const off = fakeClient([track])
    const offCtx = buildContext({ ...cfg, tracked: { ...cfg.tracked!, tracks: false } }, { tracked: off })
    connected(offCtx)
    expect(await pollTrackUploads(offCtx, off)).toEqual({ action: 'disabled' })

    const none = fakeClient([track])
    expect(await pollTrackUploads(buildContext(cfg, { tracked: none }), none)).toEqual({ action: 'not_connected' })

    for (const health of [{ ok: true }, { ok: true, trackUploads: false }]) {
      const old = fakeClient([track], health)
      const ctx = buildContext(cfg, { tracked: old })
      connected(ctx)
      expect(await pollTrackUploads(ctx, old)).toEqual({ action: 'waiting_for_tracked' })
      expect(old.calls).toEqual([['health', null]])
    }
    for (const c of [off, none]) expect(c.calls.filter(([k]) => k === 'trackClaim')).toEqual([])
  })

  it('trusts trackUploads: true for a while instead of asking /mkvid/health every tick', async () => {
    const client = fakeClient([])
    const ctx = buildContext(cfg, { tracked: client })
    connected(ctx)
    let now = 1_000_000
    await pollTrackUploads(ctx, client, { now: () => now })
    now += 60_000
    await pollTrackUploads(ctx, client, { now: () => now })
    expect(client.calls.filter(([k]) => k === 'health').length).toBe(1)
    now += 11 * 60_000
    await pollTrackUploads(ctx, client, { now: () => now })
    expect(client.calls.filter(([k]) => k === 'health').length).toBe(2)
  })

  it('a source that cannot be resolved becomes a failed job, reported to /mkvid/track/fail right away', async () => {
    const client = fakeClient([{ ...track, sourceUrl: 'https://hearthis.at/embed/1/' }])
    const ctx = buildContext(cfg, { tracked: client })
    connected(ctx)
    const r = await pollTrackUploads(ctx, client, { resolve: async () => { throw new Error('hearthis embed 1: HTTP 404') } })
    expect(r).toMatchObject({ action: 'refused', requestId: 7 })
    expect(client.calls.at(-1)).toEqual(['trackFail', { id: 7, error: 'source: hearthis embed 1: HTTP 404', permanent: true, jobId: expect.any(String) }])
    expect(ctx.jobs.listUnreportedTracked()).toEqual([])
  })

  it('end to end: the job runs the real pipeline, fails at yt-dlp and reports a retryable failure on the track endpoint', async () => {
    const client = fakeClient([track])
    const ctx = buildContext(diskCfg, { tracked: client })
    openContexts.push(ctx)
    connected(ctx)
    const r = await pollTrackUploads(ctx, client, { resolve: async (u) => u })
    await vi.waitFor(() => expect(client.calls.some(([k]) => k === 'trackFail')).toBe(true), { timeout: 5000 })
    const fail = client.calls.find(([k]) => k === 'trackFail')![1] as { id: number; permanent: boolean; jobId: string }
    expect(fail).toMatchObject({ id: 7, permanent: false, jobId: (r as { jobId: string }).jobId })
    expect(client.calls.some(([k]) => k === 'fail' || k === 'complete')).toBe(false)
  })
})

describe('render progress of a track job', () => {
  it('is a plain (one-pass) job, tagged as a track with its request id; waiting for its own render slot shows as render', () => {
    const job: Job = {
      id: 'j', url: 'https://x', title: 'A - B', status: 'transcoding', privacy: 'public', privacyApplied: null, style: 'track',
      videoId: null, videoUrl: null, uploadStyle: null, videoDeletedAt: null, error: null, meta: trackMetaFrom(track), createdAt: 1, updatedAt: 1,
    }
    const p = describeProgress(job, { viz: [], download: null }, { phase: 'transcode', percent: 50 } as any)
    expect(p).toMatchObject({ kind: 'track', trackRequestId: 7, requestId: null, stage: 'render' })
    expect(p.stages.map((s) => s.key)).toEqual(STAGES_PLAIN.map((s) => s.key))
    expect(p.stages[1]!.progress).toBeCloseTo(0.5)
    const w = describeProgress({ ...job, status: 'transcoding' }, { viz: [], download: null }, null, 'track-render')
    expect(w).toMatchObject({ waiting: 'render', stage: 'render' })
    const set = describeProgress({ ...job, style: 'static', meta: setMeta }, { viz: [], download: null }, null)
    expect(set).toMatchObject({ kind: 'set', requestId: 'req-1', trackRequestId: null })
  })
})

describe('long failure reports (tracked capped error at 2000 and answered 400)', () => {
  it('the client cuts a failure report to 1900 characters, keeping its head and the end of stderr', async () => {
    const bodies: Array<{ url: string; body: any }> = []
    const fetcher = (async (url: string, init: RequestInit) => {
      bodies.push({ url, body: JSON.parse(String(init.body)) })
      return new Response('{"status":"pending"}', { status: 200 })
    }) as unknown as typeof fetch
    const client = makeTrackedClient(cfg.tracked!, fetcher)
    // What track-render / ytdlp used to build: `exit N: ` + the last 2000 characters of stderr.
    const error = `ffmpeg exit 1: ${'x'.repeat(1990)}THE-CAUSE`
    expect(error.length).toBeGreaterThan(2000)
    await client.trackFail({ id: 7, error, permanent: false, jobId: 'j' })
    await client.fail({ id: 'req-1', error, permanent: false, jobId: 'j' })
    for (const b of bodies) {
      expect(b.body.error.length).toBeLessThanOrEqual(MAX_REPORTED_ERROR)
      expect(b.body.error.startsWith('ffmpeg exit 1: ')).toBe(true)
      expect(b.body.error.endsWith('THE-CAUSE')).toBe(true)
    }
    expect(clipError('short')).toBe('short')
  })

  it('a 400 (or any 4xx but 408/429) drops the report; 408, 429 and 5xx keep it for the next tick', async () => {
    for (const [status, dropped] of [[400, true], [422, true], [408, false], [429, false], [500, false], [503, false]] as const) {
      const client = fakeClient()
      client.trackFail = async () => { throw new TrackedHttpError(status, '{"error":"invalid_request"}') }
      const ctx = buildContext(cfg, { tracked: client })
      openContexts.push(ctx)
      const job = (() => {
        ctx.jobs.create({ id: 'j', url: 'https://x', title: 't', privacy: 'public', style: 'track', meta: trackMetaFrom(track) })
        ctx.jobs.setError('j', 'yt-dlp exit 1: boom')
        return ctx.jobs.get('j')!
      })()
      expect(await reportJobToTracked(ctx, job, client)).toBe(dropped)
      expect(ctx.jobs.listUnreportedTracked().map((j) => j.id)).toEqual(dropped ? [] : ['j'])
    }
    expect(isFinalRejection(new TrackedHttpError(400, ''))).toBe(true)
    expect(isFinalRejection(new Error('fetch failed'))).toBe(false)
    expect(isFinalRejection(new TrackedHttpError(401, ''))).toBe(false)
    expect(isFinalRejection(new TrackedHttpError(403, ''))).toBe(false)
  })

  it('a dropped track report no longer holds up the next track claim', async () => {
    const client = fakeClient([track])
    client.trackFail = async () => { throw new TrackedHttpError(400, '{"error":"invalid_request"}') }
    const ctx = buildContext(cfg, { tracked: client })
    openContexts.push(ctx)
    connected(ctx)
    ctx.jobs.create({ id: 'old', url: 'https://x', title: 't', privacy: 'public', style: 'track', meta: trackMetaFrom(track) })
    ctx.jobs.setError('old', `ffmpeg exit 1: ${'x'.repeat(2000)}`)
    await reportJobToTracked(ctx, ctx.jobs.get('old')!, client)
    const r = await pollTrackUploads(ctx, client, { resolve: async (u) => u })
    expect(r.action).not.toBe('reporting')
  })
})
