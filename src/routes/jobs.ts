import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, extname, basename, dirname } from 'node:path'
import { z } from 'zod'
import type { AppContext } from '../context.js'
import { UPLOAD_PREFIX, MAX_UPLOAD_BYTES, isAllowedAudioExt, sanitizeUploadName } from '../lib/upload.js'
import { uploadSessionFile } from './uploads.js'

const options = z.object({
  title: z.string().trim().max(100).optional(),
  privacy: z.enum(['private', 'unlisted', 'public']).optional(),
  style: z.enum(['static', 'waves']).optional(),
})
// http(s) only: the upload:// marker is reserved for the upload paths, and a
// JSON-submitted upload://../../x would traverse out of the work dir in the pipeline.
const submit = options.extend({ url: z.url({ protocol: /^https?$/ }) })
// Chunked-upload finalize: reference a completed /api/uploads session instead of a URL.
const submitUpload = options.extend({ uploadId: z.uuid() })

export function jobsRoutes(ctx: AppContext): Hono {
  const app = new Hono()
  app.post('/', async (c) => {
    if ((c.req.header('content-type') || '').includes('multipart/form-data')) {
      const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
      const file = body.file
      if (!(file instanceof File)) return c.json({ error: 'missing_file' }, 400)
      if (!isAllowedAudioExt(file.name)) {
        return c.json({ error: 'unsupported_type', detail: extname(file.name) || '(no extension)' }, 400)
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        return c.json({ error: 'file_too_large', detail: `max ${MAX_UPLOAD_BYTES} bytes` }, 400)
      }
      const parsed = options.safeParse({
        title: typeof body.title === 'string' && body.title ? body.title : undefined,
        privacy: typeof body.privacy === 'string' && body.privacy ? body.privacy : undefined,
        style: typeof body.style === 'string' && body.style ? body.style : undefined,
      })
      if (!parsed.success) return c.json({ error: 'invalid_input', detail: parsed.error.issues }, 400)
      const b = parsed.data
      const id = randomUUID()
      // Write the audio straight into this job's work dir; the pipeline picks it
      // up from there (and cleans the dir up) instead of running yt-dlp.
      const name = sanitizeUploadName(file.name)
      const workDir = join(ctx.config.dataDir, 'work', id)
      mkdirSync(workDir, { recursive: true })
      writeFileSync(join(workDir, name), Buffer.from(await file.arrayBuffer()))
      ctx.jobs.create({
        id, url: UPLOAD_PREFIX + name, title: b.title ?? basename(name, extname(name)),
        privacy: b.privacy ?? ctx.config.defaultPrivacy, style: b.style ?? 'static',
      })
      ctx.queue.enqueue(id)
      return c.json({ id })
    }
    const body = await c.req.json().catch(() => ({}))
    if (body && typeof body === 'object' && 'uploadId' in body) {
      const parsed = submitUpload.safeParse(body)
      if (!parsed.success) return c.json({ error: 'invalid_input', detail: parsed.error.issues }, 400)
      const b = parsed.data
      const src = uploadSessionFile(ctx.config.dataDir, b.uploadId)
      if (!src) return c.json({ error: 'upload_not_found' }, 404)
      if (statSync(src).size === 0) return c.json({ error: 'empty_upload' }, 400)
      const id = randomUUID()
      const name = basename(src)
      const workDir = join(ctx.config.dataDir, 'work', id)
      mkdirSync(workDir, { recursive: true })
      renameSync(src, join(workDir, name))
      rmSync(dirname(src), { recursive: true, force: true })
      ctx.jobs.create({
        id, url: UPLOAD_PREFIX + name, title: b.title ?? basename(name, extname(name)),
        privacy: b.privacy ?? ctx.config.defaultPrivacy, style: b.style ?? 'static',
      })
      ctx.queue.enqueue(id)
      return c.json({ id })
    }
    const parsed = submit.safeParse(body)
    if (!parsed.success) return c.json({ error: 'invalid_input', detail: parsed.error.issues }, 400)
    const b = parsed.data
    const id = randomUUID()
    ctx.jobs.create({
      id, url: b.url, title: b.title ?? null,
      privacy: b.privacy ?? ctx.config.defaultPrivacy, style: b.style ?? 'static',
    })
    ctx.queue.enqueue(id)
    return c.json({ id })
  })
  app.get('/', (c) => c.json({ jobs: ctx.jobs.list(50) }))
  app.get('/:id', (c) => {
    const job = ctx.jobs.get(c.req.param('id'))
    return job ? c.json({ job, logs: ctx.jobs.getLogs(job.id, 500) }) : c.json({ error: 'not_found' }, 404)
  })
  app.get('/:id/events', (c) => {
    const id = c.req.param('id')
    return streamSSE(c, async (stream) => {
      const off = ctx.hub.add(id, (m) => { stream.writeSSE({ data: JSON.stringify(m) }).catch(() => {}) })
      try {
        const job = ctx.jobs.get(id)
        if (job) await stream.writeSSE({ data: JSON.stringify({ type: 'status', status: job.status }) })
        // keepalive until the client disconnects (empty log line is ignored client-side)
        while (!stream.aborted) {
          await stream.sleep(15000)
          await stream.writeSSE({ data: JSON.stringify({ type: 'log', line: '' }) })
        }
      } finally {
        off()  // always unsubscribe: normal exit, abort, or a write rejection
      }
    })
  })
  return app
}
