import { Hono } from 'hono'
import type { AppContext } from '../context.js'
import { PAGE_HTML } from '../ui/page.js'
import { SERVICE_WORKER_JS } from '../ui/sw.js'

/**
 * Connection status per upload account. `connected`/`channelTitle` at the top
 * level describe the primary (what the page always shows); `shared` is only
 * present when a second client is configured.
 */
export function youtubeStatus(ctx: AppContext): YouTubeStatus {
  const t = ctx.tokens.load()
  const s = ctx.tokensShared?.load()
  return {
    connected: !!t,
    channelTitle: t?.channelTitle ?? null,
    shared: ctx.config.googleShared ? { connected: !!s, channelTitle: s?.channelTitle ?? null } : null,
  }
}
export type YouTubeStatus = { connected: boolean; channelTitle: string | null; shared: { connected: boolean; channelTitle: string | null } | null }

export function uiRoutes(ctx: AppContext): Hono {
  const app = new Hono()
  app.get('/', (c) => {
    const status = youtubeStatus(ctx)
    // Never cache the authenticated, state-dependent shell — otherwise a browser
    // (esp. Android Chrome's back-forward cache) or edge cache can serve a stale
    // connected/not-connected page. no-store also disables bfcache.
    c.header('Cache-Control', 'no-store')
    return c.html(PAGE_HTML(status, ctx.config.vapid?.publicKey ?? null))
  })
  app.get('/api/youtube/status', (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(youtubeStatus(ctx))
  })
  app.get('/sw.js', (c) => c.body(SERVICE_WORKER_JS, 200, { 'Content-Type': 'application/javascript' }))
  return app
}
