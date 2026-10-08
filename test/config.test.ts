import { describe, it, expect } from 'vitest'
import { availableParallelism } from 'node:os'
import { loadConfig } from '../src/config.js'
import { availableCores, clampWorkers, parseCpuMax } from '../src/lib/cpu.js'

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
  it('has a shared OAuth client only when both SHARED_GOOGLE_OAUTH_* are set', () => {
    expect(loadConfig({} as any).googleShared).toBeNull()
    expect(loadConfig({ SHARED_GOOGLE_OAUTH_CLIENT_ID: 'x' } as any).googleShared).toBeNull()
    expect(loadConfig({ SHARED_GOOGLE_OAUTH_CLIENT_ID: 'x', SHARED_GOOGLE_OAUTH_CLIENT_SECRET: 'y', OAUTH_REDIRECT_BASE: 'https://mkvid.maxhogan.dev/' } as any).googleShared)
      .toEqual({ clientId: 'x', clientSecret: 'y', redirectBase: 'https://mkvid.maxhogan.dev' })
  })
  it('UPLOAD_CONCURRENCY sets the upload slots, 2 by default', () => {
    expect(loadConfig({} as any).uploadConcurrency).toBe(2)
    expect(loadConfig({ UPLOAD_CONCURRENCY: '1' } as any).uploadConcurrency).toBe(1)
    expect(loadConfig({ UPLOAD_CONCURRENCY: '0' } as any).uploadConcurrency).toBe(2)
    expect(loadConfig({ UPLOAD_CONCURRENCY: 'x' } as any).uploadConcurrency).toBe(2)
  })
  it('strips trailing slash from redirectBase', () => {
    const c = loadConfig({ OAUTH_REDIRECT_BASE: 'https://mkvid.maxhogan.dev/' } as any)
    expect(c.google.redirectBase).toBe('https://mkvid.maxhogan.dev')
  })
})

describe('drawing workers', () => {
  it('parses cgroup cpu.max', () => {
    expect(parseCpuMax('max 100000\n')).toBeNull()
    expect(parseCpuMax('400000 100000')).toBe(4)
    expect(parseCpuMax(null)).toBeNull()
  })
  it('caps cores by a CFS quota and workers by the cores', () => {
    expect(availableCores('max 100000')).toBe(availableParallelism())
    expect(availableCores('150000 100000')).toBe(Math.min(availableParallelism(), 2))
    expect(clampWorkers(16, 10)).toBe(10)
    expect(clampWorkers(6, 10)).toBe(6)
  })
  it('VIZ_WORKERS never exceeds the usable cores', () => {
    expect(loadConfig({ VIZ_WORKERS: '100000' } as any).viz.workers).toBe(availableCores())
    expect(loadConfig({ VIZ_WORKERS: '1' } as any).viz.workers).toBe(1)
  })
})
