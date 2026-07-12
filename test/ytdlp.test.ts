import { describe, it, expect } from 'vitest'
import { parseDownloadPercent } from '../src/lib/ytdlp.js'

describe('parseDownloadPercent', () => {
  it('parses a percent line', () => {
    expect(parseDownloadPercent('[download]  42.7% of 10.00MiB at 1.00MiB/s')).toBeCloseTo(42.7)
  })
  it('parses 100%', () => {
    expect(parseDownloadPercent('[download] 100% of 10.00MiB')).toBe(100)
  })
  it('returns null for non-progress lines', () => {
    expect(parseDownloadPercent('[info] Downloading 1 format(s)')).toBeNull()
  })
})
