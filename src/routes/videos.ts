/**
 * Calls from tracked (the Worker) into mkvid. Mounted in app.ts ahead of the
 * Cloudflare Access gate, because a machine caller has no Access user: the
 * route checks tracked's bearer itself — TRACKED_TOKEN, the same shared
 * secret mkvid presents to tracked (its MKVID_TOKEN). At the edge the path
 * needs either an Access service token (the Worker sends one when configured)
 * or a bypass policy.
 *
 *   POST /api/videos/:id/delete  { requestId }
 *     → 200 { ok: true, outcome: 'deleted' | 'already_gone', jobId, account }
 *     → 404 { error: 'unknown_video' }     mkvid never recorded uploading this id
 *     → 409 { error: 'not_tracked' | 'request_mismatch' }
 *     → 401 unauthorized, 503 not configured / YouTube not connected, 502 YouTube error (tracked retries these)
 *
 *   GET /api/videos/render-progress
 *     → 200 { running: RenderProgress | null }   the job being downloaded / rendered / uploaded now
 */

import { Hono } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { AppContext } from '../context.js'
import { deleteVideo, DeleteRefused, type VideosDeleteApi } from '../lib/youtube.js'
import { log } from '../lib/log.js'
import { describeProgress } from '../lib/render-progress.js'

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const Body = z.object({ requestId: z.string().min(1).max(100) })

function bearerOk(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '')
  if (!m) return false
  const a = Buffer.from(m[1]!.trim())
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function videosRoutes(ctx: AppContext, opts: { api?: VideosDeleteApi; getToken?: Parameters<typeof deleteVideo>[1]['getToken'] } = {}): Hono {
  const app = new Hono()
  app.get('/render-progress', (c) => {
    const token = ctx.config.tracked?.token
    if (!token) return c.json({ error: 'not_configured', message: 'TRACKED_URL / TRACKED_TOKEN are not set' }, 503)
    if (!bearerOk(c.req.header('authorization'), token)) return c.json({ error: 'unauthorized' }, 401)
    const job = ctx.jobs.running()
    if (!job) return c.json({ running: null })
    return c.json({ running: describeProgress(job, ctx.jobs.progressLogs(job.id), ctx.hub.progress(job.id)) })
  })
  app.post('/:id/delete', async (c) => {
    const token = ctx.config.tracked?.token
    if (!token) return c.json({ error: 'not_configured', message: 'TRACKED_URL / TRACKED_TOKEN are not set' }, 503)
    if (!bearerOk(c.req.header('authorization'), token)) return c.json({ error: 'unauthorized' }, 401)
    const videoId = c.req.param('id')
    if (!VIDEO_ID.test(videoId)) return c.json({ error: 'invalid_request', message: 'not a YouTube video id' }, 400)
    const body = Body.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'invalid_request', message: 'requestId is required' }, 400)
    try {
      const r = await deleteVideo(videoId, {
        jobs: ctx.jobs, accountFor: ctx.accountFor, requestId: body.data.requestId, api: opts.api, getToken: opts.getToken,
      })
      log('info', 'tracked: deleted replaced video', { videoId, requestId: body.data.requestId, ...r })
      return c.json({ ok: true, ...r })
    } catch (e: any) {
      if (e instanceof DeleteRefused) {
        log('warn', 'tracked: refused to delete video', { videoId, requestId: body.data.requestId, code: e.code })
        return c.json({ error: e.code, message: e.message }, e.code === 'unknown_video' ? 404 : 409)
      }
      const message = String(e?.message || e).slice(0, 300)
      if (message === 'reconnect_youtube') return c.json({ error: 'youtube_not_connected', message: 'reconnect YouTube for the account that uploaded this video' }, 503)
      log('warn', 'tracked: video delete failed', { videoId, requestId: body.data.requestId, err: message })
      return c.json({ error: 'youtube_failed', message }, 502)
    }
  })
  return app
}
