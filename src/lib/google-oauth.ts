import { OAuth2Client } from 'google-auth-library'
import { google } from 'googleapis'
import type { Config } from '../config.js'
import type { StoredTokens, TokenStore } from '../types.js'

export const SCOPES = [
  // Manage scope: covers video upload, reading the channel, AND playlist writes
  // (adding each upload to the configured playlist). Superset of youtube.upload +
  // youtube.readonly — changing this requires re-consent (reconnect YouTube).
  'https://www.googleapis.com/auth/youtube',
]

export function makeOAuthClient(cfg: Config['google']): OAuth2Client {
  // Cast: `googleapis` builds `google.auth.OAuth2` from its own internal copy of
  // google-auth-library (resolved via googleapis-common's nested node_modules,
  // pinned to an exact version that differs from the hoisted top-level install
  // this file imports `OAuth2Client` from). The two classes are runtime-identical
  // but structurally distinct to TS because of private fields, so a cast is
  // needed to satisfy the declared return type without deep-importing the
  // nested package.
  return new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, `${cfg.redirectBase}/oauth/callback`) as unknown as OAuth2Client
}

export function getAuthUrl(cfg: Config['google'], state: string): string {
  return makeOAuthClient(cfg).generateAuthUrl({
    access_type: 'offline', prompt: 'consent', scope: SCOPES, state,
  })
}

async function fetchChannel(client: OAuth2Client): Promise<{ channelId?: string; channelTitle?: string }> {
  try {
    const yt = google.youtube({ version: 'v3', auth: client as any })
    const res = await yt.channels.list({ part: ['snippet'], mine: true })
    const ch = res.data.items?.[0]
    return { channelId: ch?.id ?? undefined, channelTitle: ch?.snippet?.title ?? undefined }
  } catch { return {} }
}

export async function exchangeCode(cfg: Config['google'], code: string): Promise<StoredTokens> {
  const client = makeOAuthClient(cfg)
  const { tokens } = await client.getToken(code)
  client.setCredentials(tokens)
  const ch = await fetchChannel(client)
  return {
    accessToken: tokens.access_token || '',
    refreshToken: tokens.refresh_token || '',
    expiresAt: tokens.expiry_date || Date.now() + 3500_000,
    scope: tokens.scope || SCOPES.join(' '),
    connectedAt: Date.now(), ...ch,
  }
}

export function needsRefresh(tokens: StoredTokens, now: number): boolean {
  return tokens.expiresAt - now < 60_000
}

export async function getValidAccessToken(store: TokenStore, cfg: Config['google']): Promise<string> {
  const tokens = store.load()
  if (!tokens) throw new Error('reconnect_youtube')
  if (!needsRefresh(tokens, Date.now())) return tokens.accessToken
  const client = makeOAuthClient(cfg)
  client.setCredentials({ refresh_token: tokens.refreshToken })
  try {
    // google-auth-library v10: refreshAccessToken() is gone; getAccessToken()
    // refreshes as needed and updates client.credentials with the new token/expiry.
    const { token } = await client.getAccessToken()
    const updated: StoredTokens = {
      ...tokens,
      accessToken: token || tokens.accessToken,
      expiresAt: client.credentials.expiry_date || Date.now() + 3500_000,
    }
    store.save(updated)
    return updated.accessToken
  } catch (e: any) {
    if (String(e?.response?.data?.error || e?.message).includes('invalid_grant')) {
      store.clear(); throw new Error('reconnect_youtube')
    }
    throw e
  }
}

export async function revokeAndClear(store: TokenStore, cfg: Config['google']): Promise<void> {
  const tokens = store.load()
  if (tokens) {
    const client = makeOAuthClient(cfg)
    try { await client.revokeToken(tokens.refreshToken || tokens.accessToken) } catch { /* ignore */ }
  }
  store.clear()
}
