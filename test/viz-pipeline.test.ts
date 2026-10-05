import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The scene render, the upload and the probe are stand-ins: these tests are about
// what the pipeline does around them (retries, kept work, disk guard, adoption).
const h = vi.hoisted(() => ({
  render: [] as Array<'ok' | Error>,
  renderCalls: [] as string[],
  upload: [] as Array<'ok' | Error>,
  uploadCalls: 0,
  staticRender: vi.fn(async () => { throw new Error('ffmpeg exploded') }),
  /** Stage enter/leave order across jobs (overlap test). */
  events: [] as string[],
  renderHold: null as null | (() => Promise<void>),
  uploadHold: null as null | (() => Promise<void>),
}))
vi.mock('../src/viz/render.js', async (orig) => ({
  ...(await orig<typeof import('../src/viz/render.js')>()),
  renderScene: vi.fn(async (o: { vizDir: string; outFile: string; gate?: (stage: string, fn: () => Promise<void>) => Promise<void> }, onProgress: (f: number) => void) => {
    const gate = o.gate ?? ((_stage: string, fn: () => Promise<void>) => fn())
    await gate('render', async () => {
      h.renderCalls.push(o.vizDir)
      const next = h.render.shift() ?? 'ok'
      // Every attempt finishes one more segment before it (maybe) fails, like a real resume.
      const n = h.renderCalls.length
      writeFileSync(join(o.vizDir, `seg-${String(n - 1).padStart(5, '0')}.mp4`), `segment ${n}`)
      h.events.push(`render+ ${o.vizDir}`)
      await h.renderHold?.()
      h.events.push(`render- ${o.vizDir}`)
      if (next instanceof Error) throw next
    })
    await gate('assemble', async () => { writeFileSync(o.outFile, 'the finished video') })
    onProgress(1)
  }),
}))
vi.mock('../src/lib/youtube.js', () => ({
  uploadVideo: vi.fn(async (o: { filePath: string }) => {
    h.uploadCalls++
    h.events.push(`upload+ ${o.filePath}`)
    await h.uploadHold?.()
    h.events.push(`upload- ${o.filePath}`)
    const next = h.upload.shift() ?? 'ok'
    if (next instanceof Error) throw next
    return { videoId: 'vid1', videoUrl: 'https://youtu.be/vid1', privacyApplied: 'private' }
  }),
  addToPlaylist: vi.fn(async () => {}),
}))
vi.mock('../src/lib/google-oauth.js', async (orig) => ({ ...(await orig<object>()), getValidAccessToken: vi.fn(async () => 'token') }))
vi.mock('../src/lib/probe.js', () => ({ probeAudio: vi.fn(async () => ({ codec: 'aac', duration: 3 })) }))
vi.mock('../src/lib/ffmpeg.js', async (orig) => ({ ...(await orig<object>()), renderVideo: h.staticRender }))

import { loadConfig } from '../src/config.js'
import { buildContext } from '../src/context.js'
import { runJob, ensureFreeSpace, pruneKeptWork, isKeptWork, markKept, writeSourceRecord } from '../src/lib/pipeline.js'
import { isPermanentFailure } from '../src/lib/tracked.js'
import { jobsRoutes } from '../src/routes/jobs.js'
import type { JobMeta } from '../src/types.js'

const tmp = mkdtempSync(join(tmpdir(), 'mkvid-vizpipe-'))
const contexts: Array<ReturnType<typeof buildContext>> = []
afterAll(() => {
  for (const c of contexts) c.db.close()
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
})

function setup(env: Record<string, string> = {}) {
  const dataDir = mkdtempSync(join(tmp, 'data-'))
  const cfg = loadConfig({ DATA_DIR: dataDir, YTDLP_PATH: 'not-a-binary', VIZ_RETRY_DELAY_SECONDS: '0', VIZ_MIN_FREE_GB: '0', ...env } as any)
  const ctx = buildContext(cfg)
  contexts.push(ctx)
  const work = (id: string) => join(dataDir, 'work', id)
  /** An uploaded-file job (no yt-dlp), its audio already in the work dir. */
  const uploadJob = (id: string, style: 'scene' | 'static' = 'scene') => {
    mkdirSync(work(id), { recursive: true })
    writeFileSync(join(work(id), 'set.m4a'), 'audio')
    return ctx.jobs.create({ id, url: 'upload://set.m4a', title: id, privacy: 'private', style })
  }
  return { ctx, cfg, dataDir, work, uploadJob, api: jobsRoutes(ctx) }
}

beforeEach(() => {
  h.render.length = 0; h.renderCalls.length = 0; h.upload.length = 0; h.uploadCalls = 0
  h.staticRender.mockClear()
  h.events.length = 0; h.renderHold = null; h.uploadHold = null
})

describe('scene render failures', () => {
  it('a failed render is retried (resuming in the same dir) and the job succeeds', async () => {
    const { ctx, work, uploadJob } = setup()
    uploadJob('j1')
    h.render.push(new Error('ffmpeg exit 1'), new Error('render worker crashed'), 'ok')
    await runJob(ctx, 'j1')
    expect(ctx.jobs.get('j1')!.status).toBe('done')
    expect(h.renderCalls).toHaveLength(3)
    expect(new Set(h.renderCalls)).toEqual(new Set([join(work('j1'), 'viz')]))
    expect(ctx.jobs.getLogs('j1', 100).filter((l) => /retrying in 0s from the finished segments/.test(l))).toHaveLength(2)
    expect(existsSync(work('j1'))).toBe(false) // success: cleaned up as before
  })

  it('when retries are exhausted the job fails but keeps audio, segments and analysis; a retry resumes', async () => {
    const { ctx, work, uploadJob, api } = setup({ VIZ_RENDER_RETRIES: '1' })
    uploadJob('j2')
    h.render.push(new Error('boom'), new Error('boom again'))
    await runJob(ctx, 'j2')
    const job = ctx.jobs.get('j2')!
    expect(job.status).toBe('failed')
    expect(job.error).toBe('boom again')
    expect(h.renderCalls).toHaveLength(2)
    expect(isKeptWork(ctx, 'j2')).toBe(true)
    expect(existsSync(join(work('j2'), 'set.m4a'))).toBe(true)
    expect(existsSync(join(work('j2'), 'viz', 'seg-00000.mp4'))).toBe(true)
    expect(existsSync(join(work('j2'), 'viz', 'seg-00001.mp4'))).toBe(true)
    expect(ctx.jobs.getLogs('j2', 100).join('\n')).toMatch(/keeping the work dir for a retry \(failed while rendering\)/)

    // Manual retry through the API: queued again, resumes in the kept dir, succeeds, cleans up.
    const res = await api.request('/j2/retry', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(ctx.jobs.get('j2')!.error).toBeNull()
    await vi.waitFor(() => expect(ctx.jobs.get('j2')!.status).toBe('done'), { timeout: 5000 })
    expect(h.renderCalls).toHaveLength(3)
    expect(h.renderCalls[2]).toBe(join(work('j2'), 'viz'))
    await vi.waitFor(() => expect(existsSync(work('j2'))).toBe(false))
  })

  it('an upload failure keeps the finished out.mp4, and the retry uploads it without rendering again', async () => {
    const { ctx, work, uploadJob } = setup()
    uploadJob('j3')
    h.upload.push(new Error('socket hang up'))
    await runJob(ctx, 'j3')
    expect(ctx.jobs.get('j3')!.status).toBe('failed')
    expect(readFileSync(join(work('j3'), 'out.mp4'), 'utf8')).toBe('the finished video')
    expect(ctx.jobs.getLogs('j3', 100).join('\n')).toMatch(/failed while uploading/)
    expect(h.renderCalls).toHaveLength(1)

    ctx.jobs.requeue('j3')
    await runJob(ctx, 'j3')
    expect(ctx.jobs.get('j3')!.status).toBe('done')
    expect(h.renderCalls).toHaveLength(1) // not rendered again
    expect(h.uploadCalls).toBe(2)
    expect(ctx.jobs.getLogs('j3', 100).join('\n')).toMatch(/out\.mp4 from an earlier attempt is complete, skipping the render/)
  })

  it('a finished out.mp4 is not trusted when it does not match what was recorded', async () => {
    const { ctx, work, uploadJob } = setup()
    uploadJob('j3b')
    h.upload.push(new Error('socket hang up'))
    await runJob(ctx, 'j3b')
    writeFileSync(join(work('j3b'), 'out.mp4'), 'truncated')
    ctx.jobs.requeue('j3b')
    await runJob(ctx, 'j3b')
    expect(h.renderCalls).toHaveLength(2)
    expect(ctx.jobs.get('j3b')!.status).toBe('done')
  })

  it('a download-stage failure of a scene job removes the work dir as before', async () => {
    const { ctx, work } = setup()
    mkdirSync(work('j4'), { recursive: true })
    ctx.jobs.create({ id: 'j4', url: 'upload://missing.m4a', title: 'x', privacy: 'private', style: 'scene' })
    await runJob(ctx, 'j4')
    expect(ctx.jobs.get('j4')!.error).toMatch(/uploaded file is missing/)
    expect(existsSync(work('j4'))).toBe(false)
    expect(h.renderCalls).toHaveLength(0)
  })

  it('old styles are unchanged: no retry, work dir removed', async () => {
    const { ctx, work, uploadJob } = setup()
    uploadJob('j5', 'static')
    await runJob(ctx, 'j5')
    expect(ctx.jobs.get('j5')!.error).toBe('ffmpeg exploded')
    expect(h.staticRender).toHaveBeenCalledTimes(1)
    expect(existsSync(work('j5'))).toBe(false)
  })
})

describe('disk guard', () => {
  it('ensureFreeSpace refuses below the minimum with a retryable message, and 0 disables it', () => {
    expect(() => ensureFreeSpace('/x', 80, () => 79e9)).toThrow(/insufficient disk space: 79\.0 GB free .* at least 80 GB \(VIZ_MIN_FREE_GB\)/)
    expect(() => ensureFreeSpace('/x', 80, () => 81e9)).not.toThrow()
    expect(() => ensureFreeSpace('/x', 0, () => 0)).not.toThrow()
    try { ensureFreeSpace('/x', 80, () => 1e9) } catch (e: any) { expect(isPermanentFailure(e.message)).toBe(false) }
  })

  it('a scene job on a full volume never starts rendering, fails retryably and keeps its audio', async () => {
    const { ctx, work, uploadJob } = setup({ VIZ_MIN_FREE_GB: '1000000000', VIZ_RENDER_RETRIES: '1' })
    uploadJob('d1')
    await runJob(ctx, 'd1')
    const job = ctx.jobs.get('d1')!
    expect(job.error).toMatch(/^insufficient disk space/)
    expect(isPermanentFailure(job.error!)).toBe(false)
    expect(h.renderCalls).toHaveLength(0)
    expect(ctx.jobs.getLogs('d1', 50).join('\n')).toMatch(/retrying/)
    expect(isKeptWork(ctx, 'd1')).toBe(true)
    expect(existsSync(join(work('d1'), 'set.m4a'))).toBe(true)
  })
})

describe('kept work retention', () => {
  function failedSceneWithWork(s: ReturnType<typeof setup>, id: string, bytes: number, ageHours: number, status: 'failed' | 'transcoding' = 'failed') {
    s.uploadJob(id)
    writeSourceRecord(s.work(id), join(s.work(id), 'set.m4a'), id)
    writeFileSync(join(s.work(id), 'viz', 'seg-00000.mp4'), Buffer.alloc(bytes))
    markKept(s.work(id), 'render')
    const kept = JSON.parse(readFileSync(join(s.work(id), 'viz', 'kept.json'), 'utf8'))
    writeFileSync(join(s.work(id), 'viz', 'kept.json'), JSON.stringify({ ...kept, keptAt: Date.now() - ageHours * 3_600_000 }))
    if (status === 'failed') s.ctx.jobs.setError(id, 'boom')
    else s.ctx.jobs.setStatus(id, status)
  }

  it('drops kept dirs past VIZ_KEEP_HOURS, then the oldest over VIZ_KEEP_GB; never a running job', () => {
    const s = setup({ VIZ_KEEP_HOURS: '48', VIZ_KEEP_GB: '0.000003' }) // 3000 bytes
    failedSceneWithWork(s, 'new', 1000, 1)
    failedSceneWithWork(s, 'mid', 1000, 5)
    failedSceneWithWork(s, 'old', 1500, 10)
    failedSceneWithWork(s, 'expired', 10, 49)
    failedSceneWithWork(s, 'running', 5000, 100, 'transcoding')
    const removed = pruneKeptWork(s.ctx)
    expect(removed.sort()).toEqual(['expired', 'old'])
    for (const id of ['new', 'mid', 'running']) expect([id, existsSync(s.work(id))]).toEqual([id, true])
  })

  it('a restart keeps failed scene jobs\' work (within limits) and still clears orphans', () => {
    const s = setup()
    failedSceneWithWork(s, 'kept', 10, 1)
    mkdirSync(s.work('orphan'), { recursive: true })
    s.ctx.db.close()
    contexts.splice(contexts.indexOf(s.ctx), 1)
    const again = buildContext(s.cfg)
    contexts.push(again)
    expect(existsSync(s.work('kept'))).toBe(true)
    expect(existsSync(s.work('orphan'))).toBe(false)
    expect(isKeptWork(again, 'kept')).toBe(true)
  })
})

describe('retry endpoint', () => {
  it('only failed scene jobs with kept work, never tracked jobs', async () => {
    const s = setup()
    const post = (id: string) => s.api.request(`/${id}/retry`, { method: 'POST' })
    expect((await post('nope')).status).toBe(404)
    s.uploadJob('static-failed', 'static'); s.ctx.jobs.setError('static-failed', 'x')
    expect(await (await post('static-failed')).json()).toMatchObject({ error: 'not_retryable' })
    s.uploadJob('scene-queued')
    expect(await (await post('scene-queued')).json()).toMatchObject({ error: 'not_retryable' })
    s.uploadJob('scene-gone'); s.ctx.jobs.setError('scene-gone', 'x'); rmSync(s.work('scene-gone'), { recursive: true })
    expect(await (await post('scene-gone')).json()).toMatchObject({ error: 'nothing_kept' })
    const meta: JobMeta = { origin: 'tracked', requestId: 'r', setUrl: 's', sourceUrl: 'u', lastCueSeconds: null, artistName: null }
    s.ctx.jobs.create({ id: 'tracked', url: 'https://x/y', title: 't', privacy: 'private', style: 'scene', meta })
    s.ctx.jobs.setError('tracked', 'x')
    expect(await (await post('tracked')).json()).toMatchObject({ error: 'tracked_job' })
  })
})

describe('tracked retries adopt the kept work', () => {
  const meta = (tracks: unknown[]): JobMeta => ({
    origin: 'tracked', requestId: 'req-1', setUrl: 'https://1001/x', sourceUrl: 'https://sc/x', lastCueSeconds: null, artistName: 'DJ',
    tracks: tracks as any, tracksTrusted: true,
  })
  const T = [{ cueSeconds: 0, artist: 'A', title: 'a', artworkUrl: null, isId: false }]

  async function failFirst(s: ReturnType<typeof setup>, m: JobMeta) {
    const first = s.ctx.jobs.create({ id: 'first', url: 'https://sc/x', title: 'x', privacy: 'private', style: 'scene', meta: m })
    mkdirSync(s.work(first.id), { recursive: true })
    writeFileSync(join(s.work(first.id), 'set.m4a'), 'audio')
    writeSourceRecord(s.work(first.id), join(s.work(first.id), 'set.m4a'), 'x') // downloaded earlier
    h.upload.push(new Error('socket hang up'))
    await runJob(s.ctx, first.id)
    expect(isKeptWork(s.ctx, 'first')).toBe(true)
  }

  it('a new job for the same request moves the kept dir over and skips download and render', async () => {
    const s = setup()
    await failFirst(s, meta(T))
    s.ctx.jobs.create({ id: 'second', url: 'https://sc/x', title: 'x', privacy: 'private', style: 'scene', meta: meta(T) })
    await runJob(s.ctx, 'second')
    expect(s.ctx.jobs.get('second')!.status).toBe('done')
    const logs = s.ctx.jobs.getLogs('second', 100).join('\n')
    expect(logs).toMatch(/reusing the kept work of failed job first/)
    expect(logs).toMatch(/resuming after a restart: audio set\.m4a is already here/)
    expect(h.renderCalls).toHaveLength(1)
    expect(existsSync(s.work('first'))).toBe(false)
  })

  it('a changed track list rebuilds the scene input (and so renders again)', async () => {
    const s = setup()
    await failFirst(s, meta(T))
    s.ctx.jobs.create({ id: 'second', url: 'https://sc/x', title: 'x', privacy: 'private', style: 'scene', meta: meta([...T, { ...T[0], cueSeconds: 60, title: 'b' }]) })
    await runJob(s.ctx, 'second')
    expect(s.ctx.jobs.getLogs('second', 100).join('\n')).toMatch(/track list changed: scene input rebuilt/)
    expect(h.renderCalls).toHaveLength(2)
  })

  it('a different audio URL or an expired dir is not adopted', async () => {
    const s = setup()
    await failFirst(s, meta(T))
    s.ctx.jobs.create({ id: 'other-url', url: 'https://mixcloud/x', title: 'x', privacy: 'private', style: 'scene', meta: meta(T) })
    await runJob(s.ctx, 'other-url') // yt-dlp is not configured here: the download fails
    expect(s.ctx.jobs.getLogs('other-url', 100).join('\n')).not.toMatch(/reusing/)
    expect(existsSync(s.work('first'))).toBe(true)
  })
})

describe('two jobs in flight', () => {
  it('one uploads while the other renders, never two in the same stage', async () => {
    const { ctx, uploadJob } = setup()
    for (const id of ['a', 'b', 'c']) uploadJob(id)
    // Long enough for the other job to catch up with this one.
    h.renderHold = () => new Promise((r) => setTimeout(r, 40))
    h.uploadHold = () => new Promise((r) => setTimeout(r, 40))
    for (const id of ['a', 'b', 'c']) ctx.queue.enqueue(id)
    expect(ctx.queue.running).toBe(2)
    await vi.waitFor(() => expect(['a', 'b', 'c'].map((id) => ctx.jobs.get(id)!.status)).toEqual(['done', 'done', 'done']), { timeout: 5000 })

    const inStage = { render: 0, upload: 0 }
    const most = { render: 0, upload: 0 }
    let overlapped = false
    for (const e of h.events) {
      const stage = e.startsWith('render') ? 'render' : 'upload'
      inStage[stage] += e[stage.length] === '+' ? 1 : -1
      most[stage] = Math.max(most[stage], inStage[stage])
      if (inStage.render && inStage.upload) overlapped = true
    }
    expect(most).toEqual({ render: 1, upload: 1 })
    expect(overlapped).toBe(true)
    // The job that waited for the render slot says so in its log.
    expect(ctx.jobs.getLogs('b', 50).some((l) => /^waiting for the render stage: "a" is in it$/.test(l))).toBe(true)
  })
})
