import { Hono } from 'hono'
import type { AppContext } from '../context.js'
import { PAGE_HTML } from '../ui/page.js'
import { SERVICE_WORKER_JS } from '../ui/sw.js'

export function uiRoutes(ctx: AppContext): Hono {
  const app = new Hono()
  app.get('/', (c) => {
    const t = ctx.tokens.load()
    const status = t ? { connected: true, channelTitle: t.channelTitle ?? null } : { connected: false }
    return c.html(PAGE_HTML(status, ctx.config.vapid?.publicKey ?? null))
  })
  app.get('/api/youtube/status', (c) => {
    const t = ctx.tokens.load()
    return c.json(t ? { connected: true, channelTitle: t.channelTitle ?? null } : { connected: false })
  })
  app.get('/sw.js', (c) => c.body(SERVICE_WORKER_JS, 200, { 'Content-Type': 'application/javascript' }))
  return app
}
