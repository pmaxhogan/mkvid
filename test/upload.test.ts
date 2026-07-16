import { describe, it, expect } from 'vitest'
import { isAllowedAudioExt, sanitizeUploadName, UPLOAD_PREFIX } from '../src/lib/upload.js'

describe('isAllowedAudioExt', () => {
  it('accepts common audio formats regardless of case', () => {
    for (const f of ['a.mp3', 'b.WAV', 'c.flac', 'd.m4a', 'e.ogg', 'f.opus', 'g.aiff']) {
      expect(isAllowedAudioExt(f)).toBe(true)
    }
  })
  it('rejects non-audio and extensionless names', () => {
    for (const f of ['a.exe', 'b.txt', 'c.png', 'd.js', 'noext']) {
      expect(isAllowedAudioExt(f)).toBe(false)
    }
  })
})

describe('sanitizeUploadName', () => {
  it('keeps ordinary names intact', () => {
    expect(sanitizeUploadName('My Song (final).mp3')).toBe('My Song (final).mp3')
  })
  it('strips path components from both separators', () => {
    expect(sanitizeUploadName('../../etc/passwd.mp3')).toBe('passwd.mp3')
    expect(sanitizeUploadName('C:\\Users\\x\\track.wav')).toBe('track.wav')
  })
  it('replaces unsafe characters and trims dots/spaces', () => {
    expect(sanitizeUploadName('..we<i>rd??.flac')).toBe('we_i_rd_.flac')
  })
  it('falls back to a stem when nothing survives', () => {
    expect(sanitizeUploadName('....mp3')).toBe('audio.mp3')
  })
  it('never collides with render artifacts', () => {
    expect(sanitizeUploadName('out.mp4')).toBe('upload-out.mp4')
  })
  it('caps very long stems', () => {
    const name = sanitizeUploadName('x'.repeat(500) + '.mp3')
    expect(name.length).toBeLessThanOrEqual(124)
    expect(name.endsWith('.mp3')).toBe(true)
  })
})

describe('UPLOAD_PREFIX', () => {
  it('is not a valid URL scheme yt-dlp would be handed', () => {
    expect(UPLOAD_PREFIX).toBe('upload://')
  })
})
