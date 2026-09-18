import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { randomUUID } from 'node:crypto'
import type { AppContext } from '../context.js'
import type { UploadAccount } from '../types.js'
import { getAuthUrl, exchangeCode, revokeAndClear } from '../lib/google-oauth.js'

/**
 * Connect / disconnect YouTube for either upload account. The account rides in
 * the state cookie (`<nonce>:<account>`), never in the redirect URI: Google
 * matches that byte-for-byte against the client's registered URIs.
 */
export function oauthRoutes(ctx: AppContext): Hono {
  const app = new Hono()
  const secure = ctx.config.google.redirectBase.startsWith('https')
  const accountOf = (raw: string | undefined): UploadAccount | null =>
    raw === 'shared' ? (ctx.config.googleShared ? 'shared' : null) : raw === 'primary' || raw === undefined ? 'primary' : null

  app.get('/start', (c) => {
    const account = accountOf(c.req.query('account'))
    if (!account) return c.redirect('/?yt_error=unknown_account')
    const state = `${randomUUID()}:${account}`
    setCookie(c, 'yt_oauth_state', state, { httpOnly: true, secure, sameSite: 'Lax', path: '/oauth', maxAge: 300 })
    return c.redirect(getAuthUrl(ctx.accountFor(account).google, state))
  })
  app.get('/callback', async (c) => {
    const state = c.req.query('state'); const code = c.req.query('code')
    const cookie = getCookie(c, 'yt_oauth_state')
    deleteCookie(c, 'yt_oauth_state', { path: '/oauth' })
    if (!code || !state || state !== cookie) return c.redirect('/?yt_error=state_mismatch')
    const account = accountOf(state.split(':')[1])
    if (!account) return c.redirect('/?yt_error=unknown_account')
    try {
      const acct = ctx.accountFor(account)
      acct.store.save(await exchangeCode(acct.google, code))
      return c.redirect(`/?yt=connected&account=${account}`)
    } catch { return c.redirect('/?yt_error=exchange_failed') }
  })
  app.post('/disconnect', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { account?: string }
    const account = accountOf(body.account ?? c.req.query('account'))
    if (!account) return c.json({ error: 'unknown_account' }, 400)
    const acct = ctx.accountFor(account)
    await revokeAndClear(acct.store, acct.google)
    return c.json({ ok: true, account })
  })
  return app
}
