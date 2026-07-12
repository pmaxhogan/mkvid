import { describe, it, expect } from 'vitest'
import { needsRefresh } from '../src/lib/google-oauth.js'

const base = { accessToken: 'a', refreshToken: 'r', scope: 's', connectedAt: 0 }

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
})
