import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { loadConfig } from '../src/config.js'
import { buildContext } from '../src/context.js'
import { buildApp } from '../src/app.js'
import { migrate } from '../src/db/index.js'
import { makeJobsRepo } from '../src/db/jobs.js'
import { deleteVideo, DeleteRefused } from '../src/lib/youtube.js'
import { videosRoutes } from '../src/routes/videos.js'
import type { JobMeta } from '../src/types.js'

const cfg = loadConfig({
  DATA_DIR: ':memory:', TRACKED_URL: 'https://tracked.example', TRACKED_TOKEN: 'shared-secret',
  SHARED_GOOGLE_OAUTH_CLIENT_ID: 'sid', SHARED_GOOGLE_OAUTH_CLIENT_SECRET: 'ssec',
} as any)

const REQ = '11111111-1111-4111-8111-111111111111'
const meta = (over: Partial<JobMeta> = {}): JobMeta => ({ origin: 'tracked', requestId: REQ, setUrl: 's', sourceUrl: 'u', lastCueSeconds: null, artistName: null, ...over })

function ctxWithUploads() {
  const ctx = buildContext(cfg, { tracked: null })
  ctx.jobs.create({ id: 'j-primary', url: 'u', title: 't', privacy: 'unlisted', style: 'static', meta: meta() })
  ctx.jobs.setResult('j-primary', 'oldVid00001', 'https://youtu.be/oldVid00001', 'unlisted', 'static')
  ctx.jobs.create({ id: 'j-shared', url: 'u', title: 't', privacy: 'unlisted', style: 'scene', meta: meta({ requestId: '22222222-2222-4222-8222-222222222222', account: 'shared' }) })
  ctx.jobs.setResult('j-shared', 'sharedVid01', 'https://youtu.be/sharedVid01', 'unlisted', 'scene')
  ctx.jobs.create({ id: 'j-ui', url: 'u', title: 't', privacy: 'private', style: 'static' })
  ctx.jobs.setResult('j-ui', 'uiVideo0001', 'https://youtu.be/uiVideo0001')
  return ctx
}

describe('deleteVideo (guarded videos.delete)', () => {
  it('deletes a tracked upload through the account that uploaded it, and marks it', async () => {
    const ctx = ctxWithUploads()
    const api = vi.fn(async () => {})
    const getToken = vi.fn(async (_store: unknown, google: { clientId: string }) => `token-for-${google.clientId || 'primary'}`)
    const r = await deleteVideo('sharedVid01', { jobs: ctx.jobs, accountFor: ctx.accountFor, requestId: '22222222-2222-4222-8222-222222222222', api, getToken })
    expect(r).toEqual({ outcome: 'deleted', jobId: 'j-shared', account: 'shared' })
    // The shared project's client, not the primary's.
    expect(getToken.mock.calls[0]![1]).toMatchObject({ clientId: 'sid' })
    expect(api).toHaveBeenCalledWith('token-for-sid', 'sharedVid01')
    expect(ctx.jobs.get('j-shared')!.videoDeletedAt).toBeGreaterThan(0)
    // A second call does not touch YouTube again.
    expect(await deleteVideo('sharedVid01', { jobs: ctx.jobs, accountFor: ctx.accountFor, api, getToken })).toMatchObject({ outcome: 'already_gone' })
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('uses the primary account for a job without one, and treats a YouTube 404 as already gone', async () => {
    const ctx = ctxWithUploads()
    const api = vi.fn(async () => { throw Object.assign(new Error('Video not found'), { code: 404 }) })
    const getToken = vi.fn(async () => 'tok')
    const r = await deleteVideo('oldVid00001', { jobs: ctx.jobs, accountFor: ctx.accountFor, requestId: REQ, api, getToken })
    expect(r).toEqual({ outcome: 'already_gone', jobId: 'j-primary', account: 'primary' })
    expect(getToken.mock.calls[0]![1]).toMatchObject({ clientId: '' })
    expect(ctx.jobs.get('j-primary')!.videoDeletedAt).not.toBeNull()
  })

  it('refuses a video mkvid did not record, one not uploaded for tracked, and one from another request', async () => {
    const ctx = ctxWithUploads()
    const api = vi.fn(async () => {})
    const deps = { jobs: ctx.jobs, accountFor: ctx.accountFor, api, getToken: async () => 'tok' }
    await expect(deleteVideo('someoneElse', deps)).rejects.toMatchObject({ code: 'unknown_video' })
    await expect(deleteVideo('uiVideo0001', deps)).rejects.toMatchObject({ code: 'not_tracked' })
    await expect(deleteVideo('oldVid00001', { ...deps, requestId: 'other' })).rejects.toBeInstanceOf(DeleteRefused)
    expect(api).not.toHaveBeenCalled()
  })

  it('other YouTube errors propagate (tracked retries them), and nothing is marked', async () => {
    const ctx = ctxWithUploads()
    const api = vi.fn(async () => { throw Object.assign(new Error('quotaExceeded'), { code: 403 }) })
    await expect(deleteVideo('oldVid00001', { jobs: ctx.jobs, accountFor: ctx.accountFor, api, getToken: async () => 'tok' })).rejects.toThrow('quotaExceeded')
    expect(ctx.jobs.get('j-primary')!.videoDeletedAt).toBeNull()
  })
})

describe('POST /api/videos/:id/delete', () => {
  function app(api = vi.fn(async () => {})) {
    const ctx = ctxWithUploads()
    const a = new Hono()
    a.route('/api/videos', videosRoutes(ctx, { api, getToken: async () => 'tok' }))
    const call = (id: string, body: unknown, auth = 'Bearer shared-secret') =>
      a.request(`/api/videos/${id}/delete`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { ctx, api, call }
  }

  it('needs the bearer, a video id and the request id', async () => {
    const { call, api } = app()
    expect((await call('oldVid00001', { requestId: REQ }, 'Bearer wrong')).status).toBe(401)
    expect((await call('oldVid00001', { requestId: REQ }, '')).status).toBe(401)
    expect((await call('not-an-id', { requestId: REQ })).status).toBe(400)
    expect((await call('oldVid00001', {})).status).toBe(400)
    expect(api).not.toHaveBeenCalled()
  })

  it('deletes and answers the outcome; refusals are 404 / 409; YouTube errors 502', async () => {
    const { call } = app()
    const ok = await call('oldVid00001', { requestId: REQ })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, outcome: 'deleted', jobId: 'j-primary', account: 'primary' })
    expect(await (await call('oldVid00001', { requestId: REQ })).json()).toMatchObject({ ok: true, outcome: 'already_gone' })
    const unknown = await call('someoneElse', { requestId: REQ })
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ error: 'unknown_video' })
    expect((await call('uiVideo0001', { requestId: REQ })).status).toBe(409)
    expect(await (await call('sharedVid01', { requestId: REQ })).json()).toMatchObject({ error: 'request_mismatch' })

    const failing = app(vi.fn(async () => { throw new Error('backendError') }))
    const r = await failing.call('oldVid00001', { requestId: REQ })
    expect(r.status).toBe(502)
    expect(await r.json()).toEqual({ error: 'youtube_failed', message: 'backendError' })
  })

  it('is mounted ahead of the Cloudflare Access gate, and 503s when tracked is not configured', async () => {
    const ctx = buildContext(cfg, { tracked: null })
    const full = buildApp(ctx)
    // Access is unconfigured here: every gated route answers cf_access_misconfigured; this one checks its bearer.
    expect((await full.request('/api/jobs')).status).toBe(500)
    const r = await full.request('/api/videos/oldVid00001/delete', { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' })
    expect(r.status).toBe(401)
    const bare = buildApp(buildContext(loadConfig({ DATA_DIR: ':memory:' } as any), { tracked: null }))
    expect((await bare.request('/api/videos/oldVid00001/delete', { method: 'POST', body: '{}' })).status).toBe(503)
  })
})

describe('upload_style column', () => {
  it('backfills existing uploads as static once, and records the style of new uploads', () => {
    const db = new Database(':memory:')
    // A database from before the column existed.
    db.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT, status TEXT NOT NULL, privacy TEXT NOT NULL, style TEXT NOT NULL,
      video_id TEXT, video_url TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
    db.exec(`INSERT INTO jobs VALUES ('up', 'u', 't', 'done', 'unlisted', 'waves', 'vid00000001', 'x', NULL, 1, 1),
                                    ('none', 'u', 't', 'failed', 'unlisted', 'static', NULL, NULL, 'e', 1, 1)`)
    migrate(db)
    const jobs = makeJobsRepo(db)
    expect(jobs.get('up')).toMatchObject({ uploadStyle: 'static', videoDeletedAt: null })
    expect(jobs.get('none')!.uploadStyle).toBeNull()
    // New uploads record their own style; a second migrate does not touch them.
    jobs.create({ id: 'new', url: 'u', title: 't', privacy: 'unlisted', style: 'scene' })
    jobs.setResult('new', 'vid00000002', 'x', null, 'scene')
    migrate(db)
    expect(jobs.get('new')!.uploadStyle).toBe('scene')
    jobs.create({ id: 'defaulted', url: 'u', title: 't', privacy: 'unlisted', style: 'waves' })
    jobs.setResult('defaulted', 'vid00000003', 'x')
    expect(jobs.get('defaulted')!.uploadStyle).toBe('waves')
    expect(jobs.findByVideoId('vid00000002').map((j) => j.id)).toEqual(['new'])
    db.close()
  })
})
