import { describe, it, expect, vi, beforeEach } from 'vitest'

// The OAuth client googleapis builds: a refresh mints `fresh-N`, valid for an hour.
const g = vi.hoisted(() => ({ refreshes: 0 }))
vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        credentials: { expiry_date?: number } = {}
        setCredentials() {}
        async getAccessToken() {
          g.refreshes++
          this.credentials.expiry_date = Date.now() + 3600_000
          return { token: `fresh-${g.refreshes}` }
        }
      },
    },
  },
}))

import { needsRefresh, getValidAccessToken, UPLOAD_MIN_VALID_MS } from '../src/lib/google-oauth.js'
import type { StoredTokens, TokenStore } from '../src/types.js'

const base = { accessToken: 'a', refreshToken: 'r', scope: 's', connectedAt: 0 }
const cfg = { clientId: 'id', clientSecret: 'secret', redirectBase: 'http://x' } as any

function store(t: StoredTokens | null): TokenStore & { saved: StoredTokens | null } {
  const s = {
    saved: t,
    load: () => s.saved,
    save: (n: StoredTokens) => { s.saved = n },
    clear: () => { s.saved = null },
  }
  return s
}

beforeEach(() => { g.refreshes = 0 })

describe('needsRefresh', () => {
  it('true when within 60s of expiry', () => {
    expect(needsRefresh({ ...base, expiresAt: 1000_000 + 30_000 }, 1000_000)).toBe(true)
  })
  it('false when comfortably valid', () => {
    expect(needsRefresh({ ...base, expiresAt: 1000_000 + 600_000 }, 1000_000)).toBe(false)
  })
  it('true when already expired', () => {
    expect(needsRefresh({ ...base, expiresAt: 999_000 }, 1000_000)).toBe(true)
  })
  it('a larger margin: 10 minutes left is not enough for an upload', () => {
    expect(needsRefresh({ ...base, expiresAt: 1000_000 + 600_000 }, 1000_000, UPLOAD_MIN_VALID_MS)).toBe(true)
  })
})

describe('getValidAccessToken', () => {
  it('keeps a token with time left, refreshes one that has less than asked for', async () => {
    const s = store({ ...base, expiresAt: Date.now() + 10 * 60_000 })
    expect(await getValidAccessToken(s, cfg)).toBe('a')
    expect(g.refreshes).toBe(0)
    expect(await getValidAccessToken(s, cfg, { minValidMs: UPLOAD_MIN_VALID_MS })).toBe('fresh-1')
    expect(s.saved!.accessToken).toBe('fresh-1')
    expect(s.saved!.expiresAt).toBeGreaterThan(Date.now() + UPLOAD_MIN_VALID_MS)
    // Now good for an hour: no second refresh.
    expect(await getValidAccessToken(s, cfg, { minValidMs: UPLOAD_MIN_VALID_MS })).toBe('fresh-1')
  })
  it('force mints a new token even when the stored one looks valid (YouTube said 401)', async () => {
    const s = store({ ...base, expiresAt: Date.now() + 3000_000 })
    expect(await getValidAccessToken(s, cfg, { force: true })).toBe('fresh-1')
    expect(s.saved!.refreshToken).toBe('r')
  })
  it('no stored tokens: reconnect', async () => {
    await expect(getValidAccessToken(store(null), cfg)).rejects.toThrow('reconnect_youtube')
  })
})
