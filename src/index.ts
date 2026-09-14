import { serve } from '@hono/node-server'
import { loadConfig } from './config.js'
import { buildContext } from './context.js'
import { buildApp } from './app.js'
import { initWebPush } from './lib/push.js'
import { startUpdater } from './lib/updater.js'
import { startTrackedPoller } from './lib/tracked.js'
import { log } from './lib/log.js'

const config = loadConfig()
const ctx = buildContext(config)
if (config.vapid) initWebPush(config.vapid)
startUpdater(config)
if (ctx.tracked) startTrackedPoller(ctx, ctx.tracked)
else log('info', 'tracked: not configured (set TRACKED_URL + TRACKED_TOKEN to poll its mkvid queue)')
const app = buildApp(ctx)
serve({ fetch: app.fetch, port: config.port }, (info) => log('info', `mkvid listening on :${info.port}`))
