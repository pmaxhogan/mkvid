import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.js'
import { buildContext } from '../src/context.js'
import {
  COMPLETENESS_SLACK_SECONDS,
  isIncompleteRecording,
  isPermanentFailure,
  makeTrackedClient,
  pollTracked,
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
    async claim() { calls.push(['claim', null]); return requests.shift() ?? null },
    async job(id, jobId) { calls.push(['job', { id, jobId }]) },
    async complete(input) { calls.push(['complete', input]); return { status: 'done' } },
    async fail(input) { calls.push(['fail', input]) },
    async health() { return { ok: true } },
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
    expect(cfg.tracked).toEqual({ url: 'https://tracked.example', token: 'mk', pollSeconds: 60, privacy: 'unlisted' })
    expect(loadConfig({} as any).tracked).toBeNull()
    expect(loadConfig({ TRACKED_URL: 'x' } as any).tracked).toBeNull()
    expect(loadConfig({ TRACKED_URL: 'x', TRACKED_TOKEN: 't', TRACKED_POLL_SECONDS: '5', TRACKED_PRIVACY: 'private' } as any).tracked).toMatchObject({ pollSeconds: 15, privacy: 'private' })
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
    expect((await client.claim())!.id).toBe(request.id)
    expect(seen[0]).toMatchObject({ url: 'https://tracked.example/mkvid/claim' })
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer mk')
    await expect(client.complete({ id: request.id, videoId: 'v', videoUrl: 'u', privacy: 'unlisted', jobId: 'j' })).rejects.toBeInstanceOf(TrackedHttpError)
  })
})

describe('pollTracked', () => {
  it('reports not_connected without YouTube tokens and never claims', async () => {
    const client = fakeClient([request])
    const ctx = buildContext(cfg, { tracked: client })
    expect(await pollTracked(ctx, client)).toEqual({ action: 'not_connected' })
    expect(client.calls).toEqual([])
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
    expect(job.meta).toEqual({ origin: 'tracked', requestId: request.id, setUrl: request.setUrl, sourceUrl: request.sourceUrl, lastCueSeconds: 3600, artistName: 'DJ' })
    expect(client.calls.find((c) => c[0] === 'job')).toEqual(['job', { id: request.id, jobId }])
    // While the job is running the slot is busy.
    expect(await pollTracked(ctx, client)).toEqual({ action: 'busy' })

    // The pipeline fails fast (yt-dlp binary does not exist) and the queue
    // processor delivers the failure to tracked, marking the job reported.
    await vi.waitFor(() => expect(ctx.jobs.get(jobId)!.status).toBe('failed'), { timeout: 5000 })
    await vi.waitFor(() => expect(client.calls.some((c) => c[0] === 'fail' && (c[1] as { jobId: string }).jobId === jobId)).toBe(true), { timeout: 5000 })
    await vi.waitFor(() => expect(ctx.jobs.get(jobId)!.meta!.reported).toBe(true), { timeout: 5000 })
    expect(ctx.jobs.listUnreportedTracked()).toEqual([])
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
    expect(client.calls).toEqual([['complete', { id: request.id, videoId: 'vid12345678', videoUrl: 'https://youtu.be/vid12345678', privacy: 'private', jobId: 'job-done' }]])
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
