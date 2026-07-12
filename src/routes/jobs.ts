import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AppContext } from '../context.js'

const submit = z.object({
  url: z.url(),
  title: z.string().trim().max(100).optional(),
  privacy: z.enum(['private', 'unlisted', 'public']).optional(),
  style: z.enum(['static', 'waves']).optional(),
})

export function jobsRoutes(ctx: AppContext): Hono {
  const app = new Hono()
  app.post('/', async (c) => {
    const parsed = submit.safeParse(await c.req.json().catch(() => ({})))
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
      const off = ctx.hub.add(id, (m) => { void stream.writeSSE({ data: JSON.stringify(m) }) })
      stream.onAbort(off)
      const job = ctx.jobs.get(id)
      if (job) await stream.writeSSE({ data: JSON.stringify({ type: 'status', status: job.status }) })
      // keepalive until the client disconnects (empty log line is ignored client-side)
      while (!stream.aborted) {
        await stream.sleep(15000)
        await stream.writeSSE({ data: JSON.stringify({ type: 'log', line: '' }) })
      }
    })
  })
  return app
}
