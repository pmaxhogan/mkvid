import { Hono } from 'hono'
import { z } from 'zod'
import type { AppContext } from '../context.js'

const sub = z.object({
  endpoint: z.url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
})

export function pushRoutes(ctx: AppContext): Hono {
  const app = new Hono()
  app.get('/key', (c) => c.json({ key: ctx.config.vapid?.publicKey ?? null }))
  app.post('/subscribe', async (c) => {
    const parsed = sub.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: 'invalid' }, 400)
    ctx.push.add({ endpoint: parsed.data.endpoint, p256dh: parsed.data.keys.p256dh, auth: parsed.data.keys.auth })
    return c.json({ ok: true })
  })
  return app
}
