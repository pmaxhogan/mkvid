import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  it('parses allowed emails lowercased and trimmed', () => {
    const c = loadConfig({ CF_ACCESS_ALLOWED_EMAILS: ' A@B.com , c@d.com ' } as any)
    expect(c.cfAccess.allowedEmails).toEqual(['a@b.com', 'c@d.com'])
  })
  it('defaults privacy to private and category to 10', () => {
    const c = loadConfig({} as any)
    expect(c.defaultPrivacy).toBe('private')
    expect(c.youtubeCategoryId).toBe('10')
  })
  it('devBypass true when DEV_BYPASS_CF_ACCESS=1', () => {
    expect(loadConfig({ DEV_BYPASS_CF_ACCESS: '1' } as any).cfAccess.devBypass).toBe(true)
  })
  it('vapid null when keys absent', () => {
    expect(loadConfig({} as any).vapid).toBeNull()
  })
  it('strips trailing slash from redirectBase', () => {
    const c = loadConfig({ OAUTH_REDIRECT_BASE: 'https://mkvid.maxhogan.dev/' } as any)
    expect(c.google.redirectBase).toBe('https://mkvid.maxhogan.dev')
  })
})
