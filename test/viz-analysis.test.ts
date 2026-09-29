import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeAudio, saveAnalysis, loadAnalysis, syntheticAnalysis } from '../src/viz/analysis.js'
import type { AnalysisData } from '../src/viz/types.js'

// FFMPEG_PATH overrides PATH. Some ffmpeg builds (e.g. the minimal Windows
// App Installer shim) lack the pcm_f32le encoder analyzeAudio needs; skip then.
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
const encoders = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8' })
const hasFfmpeg = encoders.status === 0 && /pcm_f32le/.test(encoders.stdout)
const FPS = 30
let dir = ''

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'viz-analysis-')) })
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

/**
 * 16-bit mono WAV at 44.1 kHz (so ffmpeg has to resample, as with real input).
 * Written in-process because not every ffmpeg build has the lavfi device.
 */
function writeWav(name: string, seconds: number, sample: (i: number, sr: number) => number, sr = 44100): string {
  const n = Math.round(seconds * sr)
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample(i, sr))) * 32767), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  const out = join(dir, `${name}.wav`)
  writeFileSync(out, Buffer.concat([h, data]))
  return out
}

/** Sine at amplitude 1/8 (like lavfi's sine source). */
function tone(name: string, hz: number, seconds: number): string {
  return writeWav(name, seconds, (i, sr) => Math.sin((2 * Math.PI * hz * i) / sr) / 8)
}

/** A click (decaying 80 Hz thump + noise burst) every 60/bpm seconds, starting at 0.25 s. */
function clickTrack(name: string, bpm: number, seconds: number): string {
  let seed = 12345
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1 }
  return writeWav(name, seconds, (i, sr) => {
    const period = Math.round((60 / bpm) * sr)
    // First click at 0.25 s so it is not hidden in the zero padding of frame 0.
    const offset = Math.round(0.25 * sr)
    const k = (i - offset) % period
    if (i < offset || k >= 0.08 * sr) return 0
    const t = k / sr
    return 0.8 * Math.sin(2 * Math.PI * 80 * t) * Math.exp(-t / 0.02) + 0.3 * rand() * Math.exp(-t / 0.004)
  })
}

/** Index of the log band (30 Hz..10 kHz) containing hz, matching analysis.ts. */
function bandOf(hz: number, bands: number): number {
  return Math.floor(Math.log(hz / 30) / Math.log(10000 / 30) * bands)
}

function mean(a: Float32Array, from: number, to: number): number {
  let s = 0
  for (let i = from; i < to; i++) s += a[i]
  return s / (to - from)
}

function allFinite(d: AnalysisData): boolean {
  for (const a of [d.spectrum, d.energy, d.bass, d.onset]) for (const v of a) if (!Number.isFinite(v) || v < 0 || v > 1) return false
  return true
}

describe.skipIf(!hasFfmpeg)('analyzeAudio (ffmpeg)', () => {
  it('puts a 1 kHz tone in the band containing 1 kHz', async () => {
    const d = await analyzeAudio(tone('sine1k', 1000, 3), { ffmpegPath: FFMPEG, fps: FPS })
    expect(allFinite(d)).toBe(true)
    const mid = Math.floor(d.frameCount / 2)
    const row = d.spectrum.subarray(mid * d.bands, (mid + 1) * d.bands)
    let best = 0
    for (let b = 1; b < d.bands; b++) if (row[b] > row[best]) best = b
    expect(best).toBe(bandOf(1000, d.bands))
    expect(row[best]).toBeGreaterThan(0.9)
    // Far-away bands stay dark despite per-band normalization.
    expect(row[bandOf(60, d.bands)]).toBeLessThan(0.05)
    expect(row[bandOf(8000, d.bands)]).toBeLessThan(0.05)
  })

  it('drives bass with a 60 Hz tone but not a 5 kHz tone', async () => {
    const lo = await analyzeAudio(tone('sine60', 60, 3), { ffmpegPath: FFMPEG, fps: FPS })
    const hi = await analyzeAudio(tone('sine5k', 5000, 3), { ffmpegPath: FFMPEG, fps: FPS })
    const n = lo.frameCount
    expect(mean(lo.bass, 10, n - 10)).toBeGreaterThan(0.8)
    expect(mean(hi.bass, 10, hi.frameCount - 10)).toBeLessThan(0.05)
    // Both are steady and loud, so overall energy is high for both.
    expect(mean(lo.energy, 10, n - 10)).toBeGreaterThan(0.8)
    expect(mean(hi.energy, 10, hi.frameCount - 10)).toBeGreaterThan(0.8)
  })

  it('finds 2 onsets per second in a 120 bpm click track, decaying between them', async () => {
    const seconds = 8
    const d = await analyzeAudio(clickTrack('click120', 120, seconds), { ffmpegPath: FFMPEG, fps: FPS })
    expect(allFinite(d)).toBe(true)
    const onsets: number[] = []
    for (let i = 0; i < d.frameCount; i++) if (d.onset[i] === 1) onsets.push(i)
    // Clicks at 0.25, 0.75, ... 7.75 s: 16 of them.
    expect(onsets.length).toBeGreaterThanOrEqual(15)
    expect(onsets.length).toBeLessThanOrEqual(17)
    for (let k = 1; k < onsets.length; k++) {
      const gap = (onsets[k] - onsets[k - 1]) / FPS
      expect(gap).toBeGreaterThan(0.4)
      expect(gap).toBeLessThan(0.6)
      const midpoint = Math.floor((onsets[k] + onsets[k - 1]) / 2)
      expect(d.onset[midpoint]).toBeLessThan(0.5)
      expect(d.onset[midpoint]).toBeGreaterThan(0)
      // Monotonic decay between onsets.
      for (let i = onsets[k - 1] + 1; i < onsets[k]; i++) expect(d.onset[i]).toBeLessThan(d.onset[i - 1])
    }
    // Onsets land near the clicks (window centre may lead the click slightly).
    for (const i of onsets) {
      const t = (i + 0.5) / FPS
      const phase = ((t - 0.25) % 0.5 + 0.5) % 0.5
      expect(Math.min(phase, 0.5 - phase)).toBeLessThan(0.08)
    }
  })

  it('yields zeros for silence without NaN', async () => {
    const d = await analyzeAudio(writeWav('silence', 3, () => 0), { ffmpegPath: FFMPEG, fps: FPS })
    expect(d.frameCount).toBeGreaterThan(0)
    for (const a of [d.spectrum, d.energy, d.bass, d.onset]) for (const v of a) expect(v).toBe(0)
  })

  it('derives frameCount from decoded duration (within one frame)', async () => {
    const d = await analyzeAudio(tone('sine440', 440, 2.5), { ffmpegPath: FFMPEG, fps: 24, bands: 32 })
    expect(Math.abs(d.frameCount - 2.5 * 24)).toBeLessThanOrEqual(1)
    expect(d.bands).toBe(32)
    expect(d.spectrum.length).toBe(d.frameCount * 32)
    expect(d.energy.length).toBe(d.frameCount)
    const d2 = await analyzeAudio(tone('sine440b', 440, 3.37), { ffmpegPath: FFMPEG, fps: 29.97 })
    expect(Math.abs(d2.frameCount - 3.37 * 29.97)).toBeLessThanOrEqual(1)
  })

  it('reports progress ending at 1', async () => {
    const seen: number[] = []
    await analyzeAudio(tone('sine-prog', 300, 4), { ffmpegPath: FFMPEG, fps: FPS, onProgress: (f) => seen.push(f) })
    expect(seen.length).toBeGreaterThan(1)
    expect(seen[seen.length - 1]).toBe(1)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
  })

  it('rejects when ffmpeg fails', async () => {
    await expect(analyzeAudio(join(dir, 'missing.wav'), { ffmpegPath: FFMPEG, fps: FPS })).rejects.toThrow(/ffmpeg exit/)
  })
})

describe('save/load', () => {
  it('round-trips exactly', async () => {
    const d = syntheticAnalysis({ ffmpegPath: FFMPEG, fps: 29.97, durationSeconds: 5, bands: 48, bpm: 128 })
    const f = join(dir, 'a.mkva')
    await saveAnalysis(d, f)
    const back = await loadAnalysis(f)
    expect(back.fps).toBe(29.97)
    expect(back.frameCount).toBe(d.frameCount)
    expect(back.bands).toBe(48)
    expect(Array.from(back.spectrum)).toEqual(Array.from(d.spectrum))
    expect(Array.from(back.energy)).toEqual(Array.from(d.energy))
    expect(Array.from(back.bass)).toEqual(Array.from(d.bass))
    expect(Array.from(back.onset)).toEqual(Array.from(d.onset))
  })

  it('rejects bad magic, wrong version and truncation', async () => {
    const d = syntheticAnalysis({ fps: 30, durationSeconds: 1 })
    const f = join(dir, 'b.mkva')
    await saveAnalysis(d, f)
    const { readFileSync } = await import('node:fs')
    const good = readFileSync(f)

    const badMagic = Buffer.from(good); badMagic.write('NOPE', 0, 'ascii')
    writeFileSync(join(dir, 'm.mkva'), badMagic)
    await expect(loadAnalysis(join(dir, 'm.mkva'))).rejects.toThrow(/magic/)

    const badVer = Buffer.from(good); badVer.writeUInt32LE(99, 4)
    writeFileSync(join(dir, 'v.mkva'), badVer)
    await expect(loadAnalysis(join(dir, 'v.mkva'))).rejects.toThrow(/version/)

    writeFileSync(join(dir, 't.mkva'), good.subarray(0, good.length - 4))
    await expect(loadAnalysis(join(dir, 't.mkva'))).rejects.toThrow(/size/)
  })
})

describe('syntheticAnalysis', () => {
  it('is deterministic, in range and beats at the given bpm', () => {
    const a = syntheticAnalysis({ fps: 30, durationSeconds: 10, bpm: 120 })
    const b = syntheticAnalysis({ fps: 30, durationSeconds: 10, bpm: 120 })
    expect(a.frameCount).toBe(300)
    expect(a.bands).toBe(64)
    expect(Array.from(a.spectrum)).toEqual(Array.from(b.spectrum))
    expect(allFinite(a)).toBe(true)
    let beats = 0
    for (let i = 0; i < a.frameCount; i++) if (a.onset[i] === 1) beats++
    expect(beats).toBe(20)
  })
})
