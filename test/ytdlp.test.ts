import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDownloadPercent, parseDurationOutput, pickDownloadedFile } from '../src/lib/ytdlp.js'

describe('pickDownloadedFile', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mkvid-pick-'))
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  it('ignores directories (the scene style keeps viz/ in the work dir), render artifacts and partials', () => {
    const d = join(tmp, 'w1')
    // Names that sort before the audio, so a picker that took the first entry would get them.
    mkdirSync(join(d, 'viz'), { recursive: true })
    mkdirSync(join(d, 'Aaa dir'), { recursive: true })
    writeFileSync(join(d, 'viz', 'seg-00000.mp4'), 'x')
    writeFileSync(join(d, 'out.mp4'), 'x')
    writeFileSync(join(d, 'wave.png'), 'x')
    writeFileSync(join(d, 'B set.m4a.part'), 'x')
    writeFileSync(join(d, 'B set.m4a.ytdl'), 'x')
    writeFileSync(join(d, 'Z My Set.opus'), 'audio')
    expect(pickDownloadedFile(d)).toEqual({ file: join(d, 'Z My Set.opus'), title: 'Z My Set' })
  })
  it('an .mp4 audio download is still picked; nothing but directories = null', () => {
    const d = join(tmp, 'w2')
    mkdirSync(join(d, 'viz'), { recursive: true })
    expect(pickDownloadedFile(d)).toBeNull()
    writeFileSync(join(d, 'Set.mp4'), 'audio')
    expect(pickDownloadedFile(d)?.title).toBe('Set')
  })
})

describe('parseDurationOutput', () => {
  it('takes the last numeric line', () => {
    expect(parseDurationOutput('WARNING: something\n4569.421\n')).toBeCloseTo(4569.421)
    expect(parseDurationOutput('NA\n')).toBeNull()
    expect(parseDurationOutput('')).toBeNull()
  })
})

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
