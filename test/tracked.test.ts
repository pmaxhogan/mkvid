import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.js'
import { buildContext, JOB_SLOTS } from '../src/context.js'
import { JobQueue } from '../src/lib/queue.js'
import {
  COMPLETENESS_SLACK_SECONDS,
  isIncompleteRecording,
  isPermanentFailure,
  makeTrackedClient,
  pollTracked,
  retryRefusals,
  reportJobToTracked,
  TrackedHttpError,
  type TrackedClient,
  type TrackedRequest,
} from '../src/lib/tracked.js'

const cfg = loadConfig({ DATA_DIR: ':memory:', TRACKED_URL: 'https://tracked.example/', TRACKED_TOKEN: 'mk', YTDLP_PATH: 'definitely-not-a-binary' } as any)
// The end-to-end test lets the real pipeline run (and fail at yt-dlp), which
// needs a work dir on disk; the in-memory database keeps everything else fast.
const tmp = mkdtempSync(join(tmpdir(), 'mkvid-test-'))
const diskCfg = { ...cfg, dataDir: tmp }
const openContexts: Array<ReturnType<typeof buildContext>> = []
afterAll(() => {
  // Windows won't delete a directory while the SQLite file inside is open.
  for (const c of openContexts) c.db.close()
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
})

function fakeClient(requests: TrackedRequest[] = []): TrackedClient & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = []
  return {
    calls,
    async claim(accounts) { calls.push(['claim', [...accounts]]); return requests.shift() ?? null },
    async job(id, jobId) { calls.push(['job', { id, jobId }]) },
    async complete(input) { calls.push(['complete', input]); return { status: 'done' } },
    async fail(input) { calls.push(['fail', input]) },
    async health() { return { ok: true, verifiedLists: true } },
  }
}

const request: TrackedRequest = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'dj',
  setUrl: 'https://www.1001tracklists.com/tracklist/abc/dj-set.html',
  artistName: 'DJ',
  setTitle: 'DJ @ Somewhere 2026-09-01',
  source: 'soundcloud',
  sourceUrl: 'https://api.soundcloud.com/tracks/123',
  lastCueSeconds: 3600,
  trackCount: 20,
  idedCount: 20,
  attempts: 1,
}

const connected = (ctx: ReturnType<typeof buildContext>) =>
  ctx.tokens.save({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, scope: 's', connectedAt: 1 })

describe('config', () => {
  it('parses the tracked settings, trims the URL, defaults poll + privacy', () => {
    expect(cfg.tracked).toEqual({ url: 'https://tracked.example', token: 'mk', pollSeconds: 60, privacy: 'unlisted', style: 'static' })
    expect(loadConfig({} as any).tracked).toBeNull()
    expect(loadConfig({ TRACKED_URL: 'x' } as any).tracked).toBeNull()
    expect(loadConfig({ TRACKED_URL: 'x', TRACKED_TOKEN: 't', TRACKED_POLL_SECONDS: '5', TRACKED_PRIVACY: 'private' } as any).tracked).toMatchObject({ pollSeconds: 15, privacy: 'private' })
  })
  it('TRACKED_STYLE picks the style of tracked jobs, static unless a known style is named', () => {
    const env = { TRACKED_URL: 'x', TRACKED_TOKEN: 't' }
    expect(loadConfig({ ...env, TRACKED_STYLE: 'scene' } as any).tracked!.style).toBe('scene')
    expect(loadConfig({ ...env, TRACKED_STYLE: 'waves' } as any).tracked!.style).toBe('waves')
    expect(loadConfig({ ...env, TRACKED_STYLE: 'fancy' } as any).tracked!.style).toBe('static')
  })
})

describe('helpers', () => {
  it('isIncompleteRecording compares duration with the last cue, with slack', () => {
    expect(isIncompleteRecording(1800, 3600)).toBe(true)
    expect(isIncompleteRecording(3600 - COMPLETENESS_SLACK_SECONDS, 3600)).toBe(false)
    expect(isIncompleteRecording(3600 - COMPLETENESS_SLACK_SECONDS - 1, 3600)).toBe(true)
    expect(isIncompleteRecording(null, 3600)).toBe(false)
    expect(isIncompleteRecording(100, null)).toBe(false)
  })
  it('isPermanentFailure recognises the errors a retry cannot fix', () => {
    expect(isPermanentFailure('yt-dlp exit 1: ERROR: Unsupported URL: https://x')).toBe(true)
    expect(isPermanentFailure('incomplete_recording: source is 1800s')).toBe(true)
    expect(isPermanentFailure('HTTP Error 404: Not Found')).toBe(true)
    expect(isPermanentFailure('yt-dlp exit 1: ERROR: Unable to download webpage: timed out')).toBe(false)
    expect(isPermanentFailure('ffmpeg exit 1')).toBe(false)
    // A 403 for quota is not permanent — tomorrow's quota fixes it.
    expect(isPermanentFailure('403 The request cannot be completed because you have exceeded your quota. (quotaExceeded)')).toBe(false)
  })
})

describe('makeTrackedClient', () => {
  it('sends the bearer token and JSON bodies, throws TrackedHttpError on non-2xx', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      if (url.endsWith('/mkvid/complete')) return new Response('{"error":"not_found"}', { status: 404 })
      return new Response(JSON.stringify({ request: request }), { status: 200 })
    }) as unknown as typeof fetch
    const client = makeTrackedClient(cfg.tracked!, fetcher)
    expect((await client.claim(['primary', 'shared']))!.id).toBe(request.id)
    expect(seen[0]).toMatchObject({ url: 'https://tracked.example/mkvid/claim', init: { body: JSON.stringify({ accounts: ['primary', 'shared'] }) } })
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer mk')
    // The claim also names the style tracked jobs are rendered with (tracked gates recreations on it).
    await client.claim(['primary'], 'scene')
    expect(seen[1]!.init.body).toBe(JSON.stringify({ accounts: ['primary'], style: 'scene' }))
    await expect(client.complete({ id: request.id, videoId: 'v', videoUrl: 'u', privacy: 'unlisted', jobId: 'j', style: 'static' })).rejects.toBeInstanceOf(TrackedHttpError)
  })
})

describe('pollTracked', () => {
  it('reports not_connected without YouTube tokens — still polling, with no accounts, so tracked can show why', async () => {
    const client = fakeClient([request])
    const ctx = buildContext(cfg, { tracked: client })
    expect(ctx.connectedAccounts()).toEqual([])
    expect(await pollTracked(ctx, client)).toEqual({ action: 'not_connected' })
    expect(client.calls).toEqual([['claim', []]])
    expect(ctx.jobs.list(10)).toEqual([])
  })

  it('offers only the accounts that are configured and connected, primary first', async () => {
    const client = fakeClient([])
    const one = buildContext(cfg, { tracked: client })
    expect(one.tokensShared).toBeNull()
    connected(one)
    expect(one.connectedAccounts()).toEqual(['primary'])
    await pollTracked(one, client)
    expect(client.calls.at(-1)).toEqual(['claim', ['primary']])

    const twoCfg = loadConfig({ DATA_DIR: ':memory:', TRACKED_URL: 'https://tracked.example', TRACKED_TOKEN: 'mk', SHARED_GOOGLE_OAUTH_CLIENT_ID: 'shared-id', SHARED_GOOGLE_OAUTH_CLIENT_SECRET: 'shared-secret' } as any)
    const two = buildContext(twoCfg, { tracked: client })
    two.tokensShared!.save({ accessToken: 'a2', refreshToken: 'r2', expiresAt: Date.now() + 3600_000, scope: 's', connectedAt: 1 })
    expect(two.connectedAccounts()).toEqual(['shared'])
    connected(two)
    expect(two.connectedAccounts()).toEqual(['primary', 'shared'])
    expect(two.accountFor('shared').google).toMatchObject({ clientId: 'shared-id', clientSecret: 'shared-secret', redirectBase: 'http://localhost:8080' })
    expect(two.accountFor('primary').store).toBe(two.tokens)
    expect(two.accountFor(undefined).store).toBe(two.tokens)
    // Never configured: a 'shared' request falls back to the primary rather than failing.
    expect(one.accountFor('shared').store).toBe(one.tokens)
  })

  it('stamps the job with the account tracked handed the request out for', async () => {
    const client = fakeClient([{ ...request, account: 'shared' }, { ...request, id: '22222222-2222-4222-8222-222222222222' }])
    const ctx = buildContext(diskCfg, { tracked: client })
    openContexts.push(ctx)
    connected(ctx)
    const r = await pollTracked(ctx, client, { probe: async () => 3700, resolve: async (u) => u })
    expect(r).toMatchObject({ action: 'started' })
    expect(ctx.jobs.get((r as { jobId: string }).jobId)!.meta).toMatchObject({ account: 'shared' })
    await vi.waitFor(() => expect(ctx.queue.size).toBe(0), { timeout: 5000 })
    const r2 = await pollTracked(ctx, client, { probe: async () => 3700, resolve: async (u) => u })
    expect(ctx.jobs.get((r2 as { jobId: string }).jobId)!.meta).toMatchObject({ account: 'primary' })
  })

  it('with TRACKED_STYLE=scene, creates a scene job carrying the track list, its trust flag and the track count', async () => {
    const tracks = [
      { cueSeconds: null, artist: 'A', title: 'One', artworkUrl: 'https://img.example/1.jpg', isId: false },
      { cueSeconds: 300, artist: null, title: null, artworkUrl: null, isId: true },
    ]
    const client = fakeClient([{ ...request, tracks, tracksTrusted: true }])
    const ctx = buildContext({ ...diskCfg, tracked: { ...diskCfg.tracked!, style: 'scene' } }, { tracked: client })
    openContexts.push(ctx)
    connected(ctx)
    const r = await pollTracked(ctx, client, { probe: async () => 3700, resolve: async (u) => u })
    const job = ctx.jobs.get((r as { jobId: string }).jobId)!
    expect(job.style).toBe('scene')
    expect(job.meta).toMatchObject({ tracks, tracksTrusted: true, trackCount: 20 })
    await vi.waitFor(() => expect(ctx.queue.size).toBe(0), { timeout: 5000 })
  })

  it.each([
    ['untrusted', { tracks: [{ cueSeconds: 0, artist: 'A', title: 'B', artworkUrl: null, isId: false }], tracksTrusted: false }],
    ['trust flag missing', { tracks: [{ cueSeconds: 0, artist: 'A', title: 'B', artworkUrl: null, isId: false }] }],
    ['trusted but empty', { tracks: [], tracksTrusted: true }],
    ['no list at all', {}],
  ])('with TRACKED_STYLE=scene, refuses an unverified list (%s) before downloading: not permanent, no job', async (_label, extra) => {
    const client = fakeClient([{ ...request, ...extra } as TrackedRequest])
    const ctx = buildContext({ ...cfg, tracked: { ...cfg.tracked!, style: 'scene' } }, { tracked: client })
    connected(ctx)
    const probe = vi.fn(async () => 3700)
    const resolve = vi.fn(async (u: string) => u)
    const r = await pollTracked(ctx, client, { probe, resolve })
    expect(r).toMatchObject({ action: 'refused', requestId: request.id, reason: expect.stringMatching(/^unverified_tracklist: /) })
    expect(client.calls.at(-1)).toEqual(['fail', { id: request.id, error: expect.stringMatching(/^unverified_tracklist: /), permanent: false, jobId: null }])
    expect(isPermanentFailure((r as { reason: string }).reason)).toBe(false)
    expect(resolve).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
    expect(ctx.jobs.list(10)).toEqual([])
  })

  it('with TRACKED_STYLE=scene, claims nothing from a tracked that does not advertise verified lists (staggered deploy)', async () => {
    for (const health of [{ ok: true }, { ok: true, verifiedLists: false }]) {
      const client = fakeClient([{ ...request, tracksTrusted: false, tracks: [] }])
      client.health = async () => health
      const ctx = buildContext({ ...cfg, tracked: { ...cfg.tracked!, style: 'scene' } }, { tracked: client })
      connected(ctx)
      expect(await pollTracked(ctx, client)).toEqual({ action: 'waiting_for_tracked' })
      // Nothing claimed, so an old tracked never counts an attempt against the request.
      expect(client.calls).toEqual([])
    }
    // The static style keeps working against an old tracked.
    const client = fakeClient([request])
    client.health = async () => ({ ok: true })
    const ctx = buildContext(cfg, { tracked: client })
    connected(ctx)
    const r = await pollTracked(ctx, client, { probe: async () => 3700, resolve: async (u) => u })
    expect(r).toMatchObject({ action: 'started' })
    expect(client.calls[0]).toEqual(['claim', ['primary']])
    await vi.waitFor(() => expect(ctx.queue.size).toBe(0), { timeout: 5000 })
  })

  it('with TRACKED_STYLE=scene, claims nothing when the health check throws (fails closed)', async () => {
    const client = fakeClient([{ ...request, tracksTrusted: false, tracks: [] }])
    client.health = async () => { throw new Error('fetch failed') }
    const ctx = buildContext({ ...cfg, tracked: { ...cfg.tracked!, style: 'scene' } }, { tracked: client })
    connected(ctx)
    await expect(pollTracked(ctx, client)).rejects.toThrow('fetch failed')
    expect(client.calls).toEqual([])
  })

  it('a refusal tracked could not be told about is kept and retried on the next poll', async () => {
    const client = fakeClient([{ ...request, tracksTrusted: false, tracks: [] }])
    let down = true
    const fail = client.fail.bind(client)
    client.fail = async (input) => { if (down) throw new Error('fetch failed'); return fail(input) }
    const ctx = buildContext({ ...cfg, tracked: { ...cfg.tracked!, style: 'scene' } }, { tracked: client })
    connected(ctx)
    expect(await pollTracked(ctx, client)).toMatchObject({ action: 'refused', requestId: request.id })
    expect(ctx.db.prepare('SELECT request_id FROM tracked_refusals').all()).toEqual([{ request_id: request.id }])
    down = false
    expect(await pollTracked(ctx, client)).toEqual({ action: 'idle' })
    expect(client.calls).toContainEqual(['fail', { id: request.id, error: expect.stringMatching(/^unverified_tracklist: /), permanent: false, jobId: null }])
    expect(ctx.db.prepare('SELECT * FROM tracked_refusals').all()).toEqual([])
  })

  it('claiming a request again clears its saved refusal, so the stale one cannot reset it while it renders', async () => {
    const verified = { ...request, tracksTrusted: true, tracks: [{ cueSeconds: 0, artist: 'A', title: 'B', artworkUrl: null, isId: false }] }
    const client = fakeClient([{ ...request, tracksTrusted: false, tracks: [] }, verified])
    let down = true
    const fail = client.fail.bind(client)
    client.fail = async (input) => { if (down) throw new Error('fetch failed'); return fail(input) }
    const ctx = buildContext({ ...diskCfg, tracked: { ...diskCfg.tracked!, style: 'scene' } }, { tracked: client })
    openContexts.push(ctx)
    connected(ctx)
    expect(await pollTracked(ctx, client)).toMatchObject({ action: 'refused', requestId: request.id })
    expect(ctx.db.prepare('SELECT request_id FROM tracked_refusals').all()).toEqual([{ request_id: request.id }])
    // Claimed again (tracked put it back to pending): the saved refusal goes.
    expect(await pollTracked(ctx, client, { probe: async () => 3700, resolve: async (u) => u })).toMatchObject({ action: 'started', requestId: request.id })
    expect(ctx.db.prepare('SELECT * FROM tracked_refusals').all()).toEqual([])
    down = false
    expect(await retryRefusals(ctx, client)).toBe(0)
    expect(client.calls.filter(([name, input]) => name === 'fail' && (input as { jobId: unknown }).jobId === null)).toEqual([])
    await vi.waitFor(() => expect(ctx.queue.size).toBe(0), { timeout: 5000 })
  })

  it('a tracked scene job with an unverified list fails at the start of the pipeline (e.g. queued before the rule), retryably', async () => {
    const client = fakeClient()
    const ctx = buildContext(diskCfg, { tracked: client })
    openContexts.push(ctx)
    connected(ctx)
    ctx.jobs.create({ id: 'old-scene', url: 'https://example.com/a', title: 't', privacy: 'unlisted', style: 'scene',
      meta: { origin: 'tracked', requestId: request.id, setUrl: request.setUrl, sourceUrl: request.sourceUrl, lastCueSeconds: null, artistName: null, tracks: [], tracksTrusted: false } })
    ctx.queue.enqueue('old-scene')
    await vi.waitFor(() => expect(ctx.jobs.get('old-scene')!.meta!.reported).toBe(true), { timeout: 5000 })
    const job = ctx.jobs.get('old-scene')!
    expect(job.status).toBe('failed')
    expect(job.error).toMatch(/^unverified_tracklist: /)
    expect(client.calls).toContainEqual(['fail', { id: request.id, error: job.error, permanent: false, jobId: 'old-scene' }])
  })

  it('idles when tracked has nothing queued', async () => {
    const client = fakeClient([])
    const ctx = buildContext(cfg, { tracked: client })
    connected(ctx)
    expect(await pollTracked(ctx, client)).toEqual({ action: 'idle' })
  })

  it('refuses a recording shorter than the last cue as a permanent failure, without creating a job', async () => {
    const client = fakeClient([request])
    const ctx = buildContext(cfg, { tracked: client })
    connected(ctx)
    const r = await pollTracked(ctx, client, { probe: async () => 1800, resolve: async (u) => u })
    expect(r).toMatchObject({ action: 'refused', requestId: request.id })
    expect(client.calls.at(-1)).toEqual(['fail', { id: request.id, error: expect.stringMatching(/^incomplete_recording/), permanent: true, jobId: null }])
    expect(ctx.jobs.list(10)).toEqual([])
  })

  it('reports a source that cannot be resolved', async () => {
    const client = fakeClient([{ ...request, source: 'hearthis', sourceUrl: 'https://hearthis.at/embed/1/' }])
    const ctx = buildContext(cfg, { tracked: client })
    connected(ctx)
    const r = await pollTracked(ctx, client, { resolve: async () => { throw new Error('hearthis embed 1: HTTP 404') } })
    expect(r).toMatchObject({ action: 'refused' })
    expect(client.calls.at(-1)).toEqual(['fail', { id: request.id, error: 'source: hearthis embed 1: HTTP 404', permanent: true, jobId: null }])
  })

  it('creates an unlisted static-waveform job with tracked meta, attaches the job id, and reports the outcome once it finishes', async () => {
    const client = fakeClient([request])
    const ctx = buildContext(diskCfg, { tracked: client })
    openContexts.push(ctx)
    connected(ctx)
    const r = await pollTracked(ctx, client, { probe: async () => 3700, resolve: async (u) => u })
    expect(r).toMatchObject({ action: 'started', requestId: request.id })
    const jobId = (r as { jobId: string }).jobId
    const job = ctx.jobs.get(jobId)!
    expect(job).toMatchObject({ url: request.sourceUrl, title: request.setTitle, privacy: 'unlisted', style: 'static' })
    expect(job.meta).toEqual({ origin: 'tracked', account: 'primary', requestId: request.id, setUrl: request.setUrl, sourceUrl: request.sourceUrl, lastCueSeconds: 3600, artistName: 'DJ', trackCount: 20 })
    expect(client.calls.find((c) => c[0] === 'job')).toEqual(['job', { id: request.id, jobId }])
    // The new job has not taken a stage yet (it is about to download): no second claim.
    expect(await pollTracked(ctx, client)).toEqual({ action: 'busy' })

    // The pipeline fails fast (yt-dlp binary does not exist) and the queue
    // processor delivers the failure to tracked, marking the job reported.
    await vi.waitFor(() => expect(ctx.jobs.get(jobId)!.status).toBe('failed'), { timeout: 5000 })
    await vi.waitFor(() => expect(client.calls.some((c) => c[0] === 'fail' && (c[1] as { jobId: string }).jobId === jobId)).toBe(true), { timeout: 5000 })
    await vi.waitFor(() => expect(ctx.jobs.get(jobId)!.meta!.reported).toBe(true), { timeout: 5000 })
    expect(ctx.jobs.listUnreportedTracked()).toEqual([])
  })
})

describe('pollTracked with no job limit, one set per stage', () => {
  /** Jobs that never finish and take no stage on their own: the test puts them in one. */
  const holdJobs = (ctx: ReturnType<typeof buildContext>) => { ctx.queue = new JobQueue(() => new Promise<void>(() => {}), JOB_SLOTS) }
  /** Puts the job in `stage` until the returned function is called. */
  const hold = (ctx: ReturnType<typeof buildContext>, stage: 'download' | 'render' | 'upload', r: { jobId?: string }) => {
    let release!: () => void
    const done = ctx.gate.run(stage, r.jobId!, () => new Promise<void>((res) => { release = res }))
    return async () => { release(); await done }
  }
  const second = { ...request, id: '22222222-2222-4222-8222-222222222222' }
  const third = { ...request, id: '33333333-3333-4333-8333-333333333333' }
  const fourth = { ...request, id: '44444444-4444-4444-8444-444444444444' }
  const opts = { probe: async () => 3700, resolve: async (u: string) => u }

  it('claims the next set whenever download is free and every set here runs a stage, and renews every claim on each tick', async () => {
    const client = fakeClient([request, second, third, fourth])
    const ctx = buildContext(cfg, { tracked: client })
    connected(ctx)
    holdJobs(ctx)
    const a = (await pollTracked(ctx, client, opts)) as { action: string; jobId: string }
    expect(a.action).toBe('started')
    const downloaded = hold(ctx, 'download', a)
    expect(await pollTracked(ctx, client, opts)).toEqual({ action: 'busy' }) // a is downloading
    // a moves on to render: download is free, the next set is claimed
    await downloaded()
    hold(ctx, 'render', a)
    const b = (await pollTracked(ctx, client, opts)) as { action: string; jobId: string }
    expect(b.action).toBe('started')
    hold(ctx, 'upload', b)
    const c = (await pollTracked(ctx, client, opts)) as { action: string; jobId: string }
    expect(c.action).toBe('started') // a third set at once: no job limit
    expect(ctx.queue.running).toBe(3)
    // c has not taken a stage yet: nothing more until it does
    const before = client.calls.length
    expect(await pollTracked(ctx, client, opts)).toEqual({ action: 'busy' })
    expect(client.calls.slice(before)).toEqual([
      ['job', { id: request.id, jobId: a.jobId }],
      ['job', { id: second.id, jobId: b.jobId }],
      ['job', { id: third.id, jobId: c.jobId }],
    ])
  })

  it('never claims while a set here waits for a stage another holds', async () => {
    const client = fakeClient([request, second, third])
    const ctx = buildContext(cfg, { tracked: client })
    connected(ctx)
    holdJobs(ctx)
    const a = (await pollTracked(ctx, client, opts)) as { jobId: string }
    hold(ctx, 'render', a)
    const b = (await pollTracked(ctx, client, opts)) as { jobId: string }
    hold(ctx, 'render', b) // b waits for a's render slot
    expect(ctx.gate.waiting()).toBe(1)
    expect(await pollTracked(ctx, client, opts)).toEqual({ action: 'busy' })
  })

  it('a set handed out again while its job is still here keeps that job and starts nothing', async () => {
    const client = fakeClient([request, request])
    const ctx = buildContext(cfg, { tracked: client })
    connected(ctx)
    holdJobs(ctx)
    const a = await pollTracked(ctx, client, opts)
    const jobId = (a as { jobId: string }).jobId
    hold(ctx, 'render', { jobId })
    expect(await pollTracked(ctx, client, opts)).toEqual({ action: 'already_running', jobId, requestId: request.id })
    expect(ctx.jobs.list(10).map((j) => j.id)).toEqual([jobId])
    expect(ctx.queue.running).toBe(1)
    expect(client.calls.at(-1)).toEqual(['job', { id: request.id, jobId }])
  })
})

describe('reportJobToTracked', () => {
  function jobWith(ctx: ReturnType<typeof buildContext>, status: 'done' | 'failed' | 'interrupted') {
    const id = 'job-' + status
    ctx.jobs.create({ id, url: 'u', title: 't', privacy: 'unlisted', style: 'static', meta: { origin: 'tracked', requestId: request.id, setUrl: request.setUrl, sourceUrl: request.sourceUrl, lastCueSeconds: null, artistName: null } })
    if (status === 'done') { ctx.jobs.setResult(id, 'vid12345678', 'https://youtu.be/vid12345678', 'private'); ctx.jobs.setStatus(id, 'done') }
    else if (status === 'failed') ctx.jobs.setError(id, 'ffmpeg exit 1')
    else ctx.jobs.setStatus(id, 'interrupted')
    return ctx.jobs.get(id)!
  }

  it('delivers a done job with the privacy YouTube applied', async () => {
    const client = fakeClient()
    const ctx = buildContext(cfg, { tracked: client })
    expect(await reportJobToTracked(ctx, jobWith(ctx, 'done'), client)).toBe(true)
    expect(client.calls).toEqual([['complete', { id: request.id, videoId: 'vid12345678', videoUrl: 'https://youtu.be/vid12345678', privacy: 'private', jobId: 'job-done', style: 'static' }]])
    expect(ctx.jobs.get('job-done')!.meta!.reported).toBe(true)
  })

  it('an interrupted job that had already uploaded is delivered as a completion, not requeued', async () => {
    const client = fakeClient()
    const ctx = buildContext(cfg, { tracked: client })
    const job = jobWith(ctx, 'done')
    ctx.jobs.setStatus(job.id, 'interrupted')
    expect(await reportJobToTracked(ctx, ctx.jobs.get(job.id)!, client)).toBe(true)
    expect(client.calls[0]![0]).toBe('complete')
  })

  it('reports failures (retryable) and interruptions, and skips UI jobs / already-reported ones', async () => {
    const client = fakeClient()
    const ctx = buildContext(cfg, { tracked: client })
    expect(await reportJobToTracked(ctx, jobWith(ctx, 'failed'), client)).toBe(true)
    expect(client.calls[0]).toEqual(['fail', { id: request.id, error: 'ffmpeg exit 1', permanent: false, jobId: 'job-failed' }])
    expect(await reportJobToTracked(ctx, jobWith(ctx, 'interrupted'), client)).toBe(true)
    expect(client.calls[1]).toEqual(['fail', { id: request.id, error: 'mkvid restarted mid-job', permanent: false, jobId: 'job-interrupted' }])
    ctx.jobs.create({ id: 'ui', url: 'u', title: null, privacy: 'private', style: 'static' })
    expect(await reportJobToTracked(ctx, ctx.jobs.get('ui')!, client)).toBe(false)
    expect(await reportJobToTracked(ctx, ctx.jobs.get('job-failed')!, client)).toBe(false)
    expect(client.calls).toHaveLength(2)
  })

  it('keeps an undelivered outcome for the next tick, but drops one tracked rejected as unknown/finished', async () => {
    const flaky: TrackedClient = { ...fakeClient(), complete: async () => { throw new Error('fetch failed') } }
    const ctx = buildContext(cfg, { tracked: flaky })
    const job = jobWith(ctx, 'done')
    expect(await reportJobToTracked(ctx, job, flaky)).toBe(false)
    expect(ctx.jobs.listUnreportedTracked().map((j) => j.id)).toEqual(['job-done'])
    const rejecting: TrackedClient = { ...fakeClient(), complete: async () => { throw new TrackedHttpError(409, '{"error":"invalid_state"}') } }
    expect(await reportJobToTracked(ctx, job, rejecting)).toBe(true)
    expect(ctx.jobs.listUnreportedTracked()).toEqual([])
  })
})
