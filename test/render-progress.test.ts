import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { loadConfig } from '../src/config.js'
import { buildContext } from '../src/context.js'
import { videosRoutes } from '../src/routes/videos.js'
import { describeProgress, STAGES } from '../src/lib/render-progress.js'
import type { Job } from '../src/types.js'

const cfg = loadConfig({ DATA_DIR: ':memory:', TRACKED_URL: 'https://tracked.example', TRACKED_TOKEN: 'shared-secret' } as any)
const REQ = '11111111-1111-4111-8111-111111111111'

const job = (over: Partial<Job> = {}): Job => ({
  id: 'j1', url: 'u', title: 'Odd Mob @ X', status: 'transcoding', privacy: 'unlisted', privacyApplied: null, style: 'scene',
  videoId: null, videoUrl: null, uploadStyle: null, videoDeletedAt: null, error: null,
  meta: { origin: 'tracked', requestId: REQ, setUrl: 's', sourceUrl: 'u', lastCueSeconds: null, artistName: null },
  createdAt: 1000, updatedAt: 2000, ...over,
})
const weight = (k: string) => STAGES.find((s) => s.key === k)!.weight
const TOTAL = STAGES.reduce((n, s) => n + s.weight, 0)

describe('describeProgress', () => {
  it('download: the yt-dlp percent, or the live one', () => {
    const p = describeProgress(job({ status: 'downloading' }), { viz: [], download: '[download]  40.0% of ~ 99.92MiB at 3.60MiB/s' }, null)
    expect(p.stage).toBe('download')
    expect(p.stages[0]).toMatchObject({ state: 'active', progress: 0.4 })
    expect(p.fraction).toBeCloseTo((weight('download') * 0.4) / TOTAL)
    expect(describeProgress(job({ status: 'downloading' }), { viz: [], download: null }, { phase: 'download', percent: 75, at: 1 }).stages[0]!.progress).toBe(0.75)
  })

  it('analyse until the segment line, with no known percent', () => {
    const p = describeProgress(job(), { viz: ['viz: 23 track(s), 22 named, 20 with artwork; set artwork found', 'viz: analysing audio'], download: null }, null)
    expect(p.stage).toBe('analyse')
    expect(p.stages.map((s) => s.state)).toEqual(['done', 'active', 'pending', 'pending', 'pending'])
    expect(p.stages[1]!.progress).toBeNull()
    expect(p.fraction).toBeCloseTo(weight('download') / TOTAL)
  })

  it('render: counts finished segments (also after a resume), minutes left from the newest line; live percent wins', () => {
    const viz = [
      'viz: analysis done in 23.3s (160371 frames)',
      'viz: 90 segment(s), 10 already done; nvenc, 10 drawing worker(s), 2 encode session(s)',
      'viz: segment 12/90 done (84.0 fps, ~31 min left)',
      'viz: segment 11/90 done (80.0 fps, ~30 min left)',
    ]
    const p = describeProgress(job(), { viz, download: null }, null)
    expect(p.stage).toBe('render')
    expect(p.segments).toEqual({ done: 12, total: 90 })
    expect(p.stages[2]!.progress).toBeCloseTo(12 / 90)
    expect(p.renderMinutesLeft).toBe(30)
    const live = describeProgress(job(), { viz, download: null }, { phase: 'transcode', percent: 48.5, at: 1 })
    expect(live.stages[2]!.progress).toBeCloseTo(0.5)
  })

  it('assemble after the last segment, upload from the job status', () => {
    const viz = ['viz: 60 segment(s), 0 already done; nvenc', 'viz: segment 60/60 done (88.6 fps, ~0 min left)', 'viz: assembling']
    const a = describeProgress(job(), { viz, download: null }, null)
    expect(a.stage).toBe('assemble')
    expect(a.stages[2]).toMatchObject({ state: 'done', progress: 1 })
    const u = describeProgress(job({ status: 'uploading' }), { viz, download: null }, { phase: 'upload', percent: 50, at: 1 })
    expect(u.stage).toBe('upload')
    expect(u.fraction).toBeCloseTo((TOTAL - weight('upload') / 2) / TOTAL)
    expect(u.renderMinutesLeft).toBeNull()
  })
})

describe('describeProgress: attempts and old styles', () => {
  it('ignores lines from an earlier attempt (in-process retry, restart resume, UI retry)', () => {
    const failed = ['viz: 90 segment(s), 0 already done; nvenc', 'viz: segment 90/90 done (80.0 fps, ~0 min left)', 'viz: assembling']
    for (const boundary of [
      'render failed: viz: muxed audio is 10.00s, expected 12.00s; retrying in 30s from the finished segments (retry 1/2)',
      'resuming after a restart: audio set.m4a is already here',
      'retry requested',
    ]) {
      const viz = [...failed, boundary, 'viz: analysing audio']
      const p = describeProgress(job(), { viz, download: null }, null)
      expect(p.stage, boundary).toBe('analyse')
      expect(p.segments).toBeNull()
      const again = describeProgress(job(), { viz: [...viz, 'viz: 90 segment(s), 88 already done; nvenc', 'viz: segment 89/90 done (80.0 fps, ~1 min left)'], download: null }, null)
      expect(again.stage).toBe('render')
      expect(again.segments).toEqual({ done: 89, total: 90 })
    }
  })

  it('an old-style job: download, transcode with the live percent, upload', () => {
    const plain = job({ style: 'static' as Job['style'] })
    const p = describeProgress(plain, { viz: [], download: null }, { phase: 'transcode', percent: 40, at: 1 })
    expect(p.stages.map((s) => s.label)).toEqual(['Download', 'Transcode', 'Upload'])
    expect(p.stage).toBe('render')
    expect(p.stages[1]).toMatchObject({ state: 'active', progress: 0.4 })
    expect(p.fraction).toBeCloseTo((5 + 60 * 0.4) / 100)
    expect(describeProgress(plain, { viz: [], download: null }, null).stages[1]!.progress).toBeNull()
    const up = describeProgress(job({ style: 'static' as Job['style'], status: 'uploading' }), { viz: [], download: null }, { phase: 'upload', percent: 50, at: 1 })
    expect(up.stage).toBe('upload')
    expect(up.fraction).toBeCloseTo((5 + 60 + 17.5) / 100)
  })
})

describe('GET /api/videos/render-progress', () => {
  const app = (ctx: ReturnType<typeof buildContext>) => {
    const a = new Hono()
    a.route('/api/videos', videosRoutes(ctx))
    return a
  }
  const get = (a: Hono, token = 'shared-secret') => a.request('/api/videos/render-progress', { headers: { authorization: `Bearer ${token}` } })

  it('is bearer-gated and answers null when nothing runs', async () => {
    const ctx = buildContext(cfg, { tracked: null })
    expect((await get(app(ctx), 'wrong')).status).toBe(401)
    expect(await (await get(app(ctx))).json()).toEqual({ running: null })
  })

  it('describes the running job from its logs and the live progress', async () => {
    const ctx = buildContext(cfg, { tracked: null })
    ctx.jobs.create({ id: 'j1', url: 'u', title: 'Odd Mob @ X', privacy: 'unlisted', style: 'scene', meta: job().meta! })
    ctx.jobs.setStatus('j1', 'transcoding')
    ctx.jobs.appendLog('j1', 'viz: 4 segment(s), 0 already done; nvenc')
    ctx.jobs.appendLog('j1', 'viz: segment 1/4 done (80.0 fps, ~3 min left)')
    ctx.hub.publish('j1', { type: 'progress', phase: 'transcode', percent: 48.5 })
    const body = (await (await get(app(ctx))).json()) as any
    expect(body.running).toMatchObject({ jobId: 'j1', requestId: REQ, stage: 'render', segments: { done: 1, total: 4 }, renderMinutesLeft: 3 })
    expect(body.running.stages[2].progress).toBeCloseTo(0.5)
    // a restart resume after the last segment line: the old lines no longer count
    ctx.jobs.appendLog('j1', 'resuming after a restart: audio a.m4a is already here')
    ctx.jobs.appendLog('j1', 'viz: analysing audio')
    ctx.hub.publish('j1', { type: 'done', videoUrl: 'x' })
    expect(((await (await get(app(ctx))).json()) as any).running).toMatchObject({ stage: 'analyse', segments: null })
    expect(ctx.hub.progress('j1')).toBeNull()
  })
})
