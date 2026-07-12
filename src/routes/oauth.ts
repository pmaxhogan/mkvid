import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { randomUUID } from 'node:crypto'
import type { AppContext } from '../context.js'
import { getAuthUrl, exchangeCode, revokeAndClear } from '../lib/google-oauth.js'

export function oauthRoutes(ctx: AppContext): Hono {
  const app = new Hono()
  const secure = ctx.config.google.redirectBase.startsWith('https')
  app.get('/start', (c) => {
    const state = randomUUID()
    setCookie(c, 'yt_oauth_state', state, { httpOnly: true, secure, sameSite: 'Lax', path: '/oauth', maxAge: 300 })
    return c.redirect(getAuthUrl(ctx.config.google, state))
  })
  app.get('/callback', async (c) => {
    const state = c.req.query('state'); const code = c.req.query('code')
    const cookie = getCookie(c, 'yt_oauth_state')
    deleteCookie(c, 'yt_oauth_state', { path: '/oauth' })
    if (!code || !state || state !== cookie) return c.redirect('/?yt_error=state_mismatch')
    try {
      const tokens = await exchangeCode(ctx.config.google, code)
      ctx.tokens.save(tokens)
      return c.redirect('/?yt=connected')
    } catch { return c.redirect('/?yt_error=exchange_failed') }
  })
  app.post('/disconnect', async (c) => {
    await revokeAndClear(ctx.tokens, ctx.config.google)
    return c.json({ ok: true })
  })
  return app
}
