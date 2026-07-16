import { Hono } from 'hono'
import type { AppContext } from './context.js'
import { cfAccess } from './middleware/cf-access.js'
import { uiRoutes } from './routes/ui.js'
import { jobsRoutes } from './routes/jobs.js'
import { uploadsRoutes } from './routes/uploads.js'
import { oauthRoutes } from './routes/oauth.js'
import { pushRoutes } from './routes/push.js'

export function buildApp(ctx: AppContext): Hono {
  const app = new Hono()
  // /healthz is registered before the gate so it stays un-gated in-app (used by local checks).
  app.get('/healthz', (c) => c.text('ok'))
  app.use('*', cfAccess(ctx.config.cfAccess, ctx.kv))
  app.route('/', uiRoutes(ctx))
  app.route('/api/jobs', jobsRoutes(ctx))
  app.route('/api/uploads', uploadsRoutes(ctx))
  app.route('/oauth', oauthRoutes(ctx))
  app.route('/api/push', pushRoutes(ctx))
  return app
}
