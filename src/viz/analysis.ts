import { spawn } from 'node:child_process'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { endianness } from 'node:os'
import type { AnalysisData } from './types.js'

/**
 * Audio -> per-frame features for the visualizer.
 *
 * ffmpeg decodes to mono f32le at 22050 Hz on stdout and we consume it as a
 * stream: only a sliding window of PCM (a few chunks) is ever held, so a 4 h
 * DJ set costs memory only for the per-frame output arrays.
 */

const SAMPLE_RATE = 22050
const FFT_SIZE = 2048
const HALF = FFT_SIZE / 2
const BIN_HZ = SAMPLE_RATE / FFT_SIZE
const MIN_HZ = 30
const MAX_HZ = 10000
const BASS_HZ = 150

/** Power below this (dBFS, full-scale sine = 0 dB) counts as silence and maps to 0. */
const FLOOR_DB = -85
/**
 * A band's 0..1 range always spans at least this many dB. Without it a steady
 * signal (p5 == p99.5) divides by zero; with it a steady loud band reads ~1.
 */
const MIN_RANGE_DB = 24
/**
 * A band's ceiling is never more than this far below the loudest band's
 * ceiling, so FFT leakage and empty bands are not blown up to full scale.
 */
const BAND_HEADROOM_DB = 30
const LO_PCT = 0.05
const HI_PCT = 0.995
/** Smoothing: near-instant attack so hits land on the beat, slower release so bars do not flicker. */
const ATTACK_TAU = 0.015
const RELEASE_TAU = 0.12
/** Onset envelope decay time constant. */
const ONSET_TAU = 0.2

export interface AnalyzeOptions {
  fps: number
  bands?: number
  ffmpegPath?: string
  onProgress?: (fraction: number) => void
}

// ---------------------------------------------------------------- FFT

/** In-place iterative radix-2 complex FFT with precomputed tables. */
class Fft {
  private readonly rev: Uint32Array
  private readonly cos: Float64Array
  private readonly sin: Float64Array
  constructor(private readonly n: number) {
    const bits = Math.log2(n)
    this.rev = new Uint32Array(n)
    for (let i = 0; i < n; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.rev[i] = r
    }
    this.cos = new Float64Array(n / 2)
    this.sin = new Float64Array(n / 2)
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n)
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n)
    }
  }
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.n
    for (let i = 0; i < n; i++) {
      const j = this.rev[i]
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t
        t = im[i]; im[i] = im[j]; im[j] = t
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1
      const step = n / size
      for (let start = 0; start < n; start += size) {
        for (let k = 0, tw = 0; k < half; k++, tw += step) {
          const a = start + k
          const b = a + half
          const wr = this.cos[tw], wi = this.sin[tw]
          const xr = re[b] * wr - im[b] * wi
          const xi = re[b] * wi + im[b] * wr
          re[b] = re[a] - xr; im[b] = im[a] - xi
          re[a] += xr; im[a] += xi
        }
      }
    }
  }
}

// ---------------------------------------------------------------- band layout

interface BandMap {
  /** Per band: bin indices and weights into the power spectrum. */
  bins: Uint16Array[]
  weights: Float32Array[]
  centres: Float64Array
}

/**
 * Log-spaced bands from MIN_HZ to MAX_HZ. Each band integrates a linearly
 * interpolated power density over its frequency range, precomputed as
 * (bin, weight) pairs. The lowest bands are narrower than one FFT bin
 * (10.8 Hz), so plain "bins inside the band" would leave them empty.
 */
function buildBands(count: number): BandMap {
  const ratio = Math.pow(MAX_HZ / MIN_HZ, 1 / count)
  const bins: Uint16Array[] = []
  const weights: Float32Array[] = []
  const centres = new Float64Array(count)
  for (let b = 0; b < count; b++) {
    const lo = MIN_HZ * Math.pow(ratio, b)
    const hi = lo * ratio
    centres[b] = Math.sqrt(lo * hi)
    const widthBins = (hi - lo) / BIN_HZ
    const steps = Math.max(4, Math.ceil(widthBins * 2))
    const acc = new Map<number, number>()
    for (let s = 0; s < steps; s++) {
      const f = lo + ((s + 0.5) / steps) * (hi - lo)
      const x = f / BIN_HZ
      const k0 = Math.floor(x)
      const frac = x - k0
      // Each sample stands for widthBins/steps bins of spectrum, so wide bands
      // sum their bins and a sub-bin band gets its proportional share.
      const w = widthBins / steps
      acc.set(k0, (acc.get(k0) ?? 0) + w * (1 - frac))
      if (k0 + 1 <= HALF) acc.set(k0 + 1, (acc.get(k0 + 1) ?? 0) + w * frac)
    }
    const keys = [...acc.keys()].sort((a, c) => a - c)
    bins.push(Uint16Array.from(keys))
    weights.push(Float32Array.from(keys.map((k) => acc.get(k)!)))
  }
  return { bins, weights, centres }
}

/** Spectral-flux weight per band: lows count most, so kicks dominate onsets. */
function fluxWeight(hz: number): number {
  if (hz < 200) return 1
  if (hz < 2000) return 0.5
  return 0.15
}

// ---------------------------------------------------------------- growable storage

/** Row-oriented Float32 storage in fixed blocks, so growth never copies the whole thing. */
class Rows {
  private readonly blocks: Float32Array[] = []
  private readonly blockRows = 8192
  count = 0
  constructor(private readonly width: number) {}
  push(row: ArrayLike<number>): void {
    const bi = Math.floor(this.count / this.blockRows)
    if (bi === this.blocks.length) this.blocks.push(new Float32Array(this.blockRows * this.width))
    const off = (this.count % this.blockRows) * this.width
    const blk = this.blocks[bi]
    for (let i = 0; i < this.width; i++) blk[off + i] = row[i]
    this.count++
  }
  /** Exactly n rows; missing rows (should not happen) are filled with fill. Frees blocks as it goes. */
  take(n: number, fill: number): Float32Array {
    const out = new Float32Array(n * this.width).fill(fill)
    const per = this.blockRows * this.width
    const have = Math.min(n, this.count) * this.width
    for (let bi = 0; bi * per < have; bi++) {
      const len = Math.min(per, have - bi * per)
      out.set(this.blocks[bi].subarray(0, len), bi * per)
      ;(this.blocks as (Float32Array | null)[])[bi] = null
    }
    return out
  }
}

// ---------------------------------------------------------------- analysis

export async function analyzeAudio(audioPath: string, opts: AnalyzeOptions): Promise<AnalysisData> {
  const fps = opts.fps
  const bands = opts.bands ?? 64
  if (!(fps > 0)) throw new Error(`invalid fps ${fps}`)
  if (!(bands >= 1 && Number.isInteger(bands))) throw new Error(`invalid bands ${bands}`)
  if (endianness() !== 'LE') throw new Error('analyzeAudio requires a little-endian host')

  const fft = new Fft(FFT_SIZE)
  const map = buildBands(bands)
  const fw = new Float64Array(bands)
  let fwSum = 0
  for (let b = 0; b < bands; b++) { fw[b] = fluxWeight(map.centres[b]); fwSum += fw[b] }
  const window = new Float64Array(FFT_SIZE)
  let winSum = 0
  for (let i = 0; i < FFT_SIZE; i++) { window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE); winSum += window[i] }
  // |X|^2 * powScale is the power of a sinusoid in that bin relative to a full-scale sine (0 dB).
  const powScale = 4 / (winSum * winSum)
  const bassTop = Math.floor(BASS_HZ / BIN_HZ)

  const re = new Float64Array(FFT_SIZE)
  const im = new Float64Array(FFT_SIZE)
  const bandRow = new Float64Array(bands)
  const prevRow = new Float64Array(bands).fill(FLOOR_DB)
  const specRows = new Rows(bands)
  const scalarRows = new Rows(3) // energyDb, bassDb, flux

  // Sliding PCM window: byte storage so unaligned stdout chunks copy straight in.
  let cap = 1 << 18 // samples
  let pcm = new Float32Array(cap)
  let pcmBytes = new Uint8Array(pcm.buffer)
  let bufStart = 0 // absolute sample index of pcm[0]
  let byteLen = 0
  let nextFrame = 0

  const centreOf = (i: number) => Math.floor(((i + 0.5) * SAMPLE_RATE) / fps)

  const processFrame = (i: number, availableEnd: number) => {
    const start = centreOf(i) - HALF
    let sq = 0
    for (let j = 0; j < FFT_SIZE; j++) {
      const abs = start + j
      const x = abs < 0 || abs >= availableEnd ? 0 : pcm[abs - bufStart]
      sq += window[j] * x * x
      re[j] = x * window[j]
      im[j] = 0
    }
    fft.transform(re, im)
    // Power spectrum is written into re[0..HALF].
    for (let k = 0; k <= HALF; k++) re[k] = (re[k] * re[k] + im[k] * im[k]) * powScale
    let bassPow = 0
    for (let k = 1; k <= bassTop; k++) bassPow += re[k]
    let flux = 0
    for (let b = 0; b < bands; b++) {
      const bi = map.bins[b], wt = map.weights[b]
      let p = 0
      for (let m = 0; m < bi.length; m++) p += re[bi[m]] * wt[m]
      const db = 10 * Math.log10(p + 1e-20)
      bandRow[b] = db
      // Flux on floor-clamped dB so noise under the floor never registers as onsets.
      const c = db < FLOOR_DB ? FLOOR_DB : db
      const d = c - prevRow[b]
      if (d > 0) flux += fw[b] * d
      prevRow[b] = c
    }
    specRows.push(bandRow)
    // RMS is taken with the same Hann weighting; a full-scale sine reads -3 dB.
    const rmsDb = 10 * Math.log10(sq / winSum + 1e-20)
    scalarRows.push([rmsDb, 10 * Math.log10(bassPow + 1e-20), flux / fwSum])
  }

  const append = (chunk: Buffer) => {
    const keepFrom = Math.max(0, centreOf(nextFrame) - HALF)
    if (byteLen + chunk.length > cap * 4) {
      // Drop samples no future frame needs, then grow if still short.
      const drop = Math.max(0, Math.min(keepFrom - bufStart, byteLen >> 2))
      if (drop > 0) {
        pcmBytes.copyWithin(0, drop * 4, byteLen)
        byteLen -= drop * 4
        bufStart += drop
      }
      if (byteLen + chunk.length > cap * 4) {
        while (byteLen + chunk.length > cap * 4) cap *= 2
        const next = new Float32Array(cap)
        const nextBytes = new Uint8Array(next.buffer)
        nextBytes.set(pcmBytes.subarray(0, byteLen))
        pcm = next
        pcmBytes = nextBytes
      }
    }
    chunk.copy(pcmBytes, byteLen)
    byteLen += chunk.length
    const availableEnd = bufStart + (byteLen >> 2)
    while (centreOf(nextFrame) + HALF <= availableEnd) processFrame(nextFrame++, availableEnd)
  }

  let durationSec = 0
  let lastReported = -1
  const report = () => {
    if (!opts.onProgress || !(durationSec > 0)) return
    const f = Math.min(1, (bufStart + (byteLen >> 2)) / SAMPLE_RATE / durationSec)
    if (f - lastReported >= 0.01) { lastReported = f; opts.onProgress(f) }
  }

  await new Promise<void>((resolve, reject) => {
    const p = spawn(opts.ffmpegPath ?? 'ffmpeg', [
      // Default loglevel on purpose: the input's "Duration:" line drives onProgress.
      '-nostdin', '-hide_banner', '-nostats', '-i', audioPath,
      '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    let failed = false
    p.stdout.on('data', (d: Buffer) => {
      if (failed) return
      try { append(d); report() } catch (e) { failed = true; p.kill(); reject(e) }
    })
    p.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-8000)
      if (!durationSec) {
        const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
        if (m) durationSec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
      }
    })
    p.on('error', reject)
    p.on('close', (code) => {
      if (failed) return
      code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-2000)}`))
    })
  })

  // Trailing frames (including the last partial one) see zero padding past the end.
  const totalSamples = bufStart + (byteLen >> 2)
  const frameCount = Math.ceil((totalSamples * fps) / SAMPLE_RATE)
  while (nextFrame < frameCount) processFrame(nextFrame++, totalSamples)

  const spectrum = specRows.take(frameCount, -200)
  const scalars = scalarRows.take(frameCount, -200)
  const energy = new Float32Array(frameCount)
  const bass = new Float32Array(frameCount)
  const flux = new Float32Array(frameCount)
  for (let i = 0; i < frameCount; i++) {
    energy[i] = scalars[i * 3]
    bass[i] = scalars[i * 3 + 1]
    flux[i] = scalars[i * 3 + 2]
  }

  normalizeSpectrum(spectrum, frameCount, bands)
  normalizeSeries(energy)
  normalizeSeries(bass)
  const attack = 1 - Math.exp(-1 / (ATTACK_TAU * fps))
  const release = 1 - Math.exp(-1 / (RELEASE_TAU * fps))
  for (let b = 0; b < bands; b++) smooth(spectrum, b, bands, frameCount, attack, release)
  smooth(energy, 0, 1, frameCount, attack, release)
  smooth(bass, 0, 1, frameCount, attack, release)
  const onset = onsetEnvelope(pickOnsets(flux, fps), fps)

  opts.onProgress?.(1)
  return { fps, frameCount, bands, spectrum, energy, bass, onset }
}

// ---------------------------------------------------------------- normalization

function percentileSorted(sorted: Float32Array, p: number): number {
  if (sorted.length === 0) return -200
  return sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))]
}

/** dB -> 0..1 range, anchored as described on the constants above. */
function dbRange(p5: number, p995: number, ceilingFloor: number): [number, number] {
  let hi = Math.max(p995, ceilingFloor)
  let lo = Math.min(p5, hi - MIN_RANGE_DB)
  lo = Math.max(lo, FLOOR_DB)
  hi = Math.max(hi, lo + MIN_RANGE_DB)
  return [lo, hi]
}

function mapDb(v: number, lo: number, hi: number): number {
  const x = (v - lo) / (hi - lo)
  return x <= 0 ? 0 : x >= 1 ? 1 : x
}

/**
 * Per-band percentile scaling in dB: the 5th percentile maps to 0 and the
 * 99.5th to 1 over the whole recording, so one loud drop cannot flatten a 4 h
 * set, and quiet high bands still move. See FLOOR_DB, MIN_RANGE_DB and
 * BAND_HEADROOM_DB for how degenerate (steady, silent, empty) bands are handled.
 */
function normalizeSpectrum(spec: Float32Array, n: number, bands: number): void {
  const col = new Float32Array(n)
  const p5 = new Float64Array(bands)
  const p995 = new Float64Array(bands)
  for (let b = 0; b < bands; b++) {
    for (let i = 0; i < n; i++) col[i] = spec[i * bands + b]
    col.sort()
    p5[b] = percentileSorted(col, LO_PCT)
    p995[b] = percentileSorted(col, HI_PCT)
  }
  let globalHi = -Infinity
  for (let b = 0; b < bands; b++) globalHi = Math.max(globalHi, p995[b])
  for (let b = 0; b < bands; b++) {
    const [lo, hi] = dbRange(p5[b], p995[b], globalHi - BAND_HEADROOM_DB)
    for (let i = 0; i < n; i++) spec[i * bands + b] = mapDb(spec[i * bands + b], lo, hi)
  }
}

function normalizeSeries(a: Float32Array): void {
  const sorted = Float32Array.from(a).sort()
  const [lo, hi] = dbRange(percentileSorted(sorted, LO_PCT), percentileSorted(sorted, HI_PCT), -Infinity)
  for (let i = 0; i < a.length; i++) a[i] = mapDb(a[i], lo, hi)
}

/** One-pole attack/release follower over a strided series, in place. */
function smooth(a: Float32Array, offset: number, stride: number, n: number, attack: number, release: number): void {
  let y = 0
  for (let i = 0; i < n; i++) {
    const idx = i * stride + offset
    const x = a[idx]
    y += (x > y ? attack : release) * (x - y)
    a[idx] = y
  }
}

// ---------------------------------------------------------------- onsets

/**
 * Adaptive-threshold peak picking: a frame is an onset when its flux is the
 * maximum within +-~100 ms, exceeds 1.5x the mean flux over +-~0.5 s plus a
 * small delta (5% of the recording's 99th-percentile flux), and is at least
 * ~100 ms after the previous onset.
 */
export function pickOnsets(flux: Float32Array, fps: number): Uint8Array {
  const n = flux.length
  const out = new Uint8Array(n)
  if (n === 0) return out
  const p99 = percentileSorted(Float32Array.from(flux).sort(), 0.99)
  if (!(p99 > 0)) return out
  const delta = 0.05 * p99
  const peakW = Math.max(1, Math.round(0.1 * fps))
  const meanW = Math.max(2, Math.round(0.5 * fps))
  const minGap = Math.max(1, Math.round(0.1 * fps))
  const prefix = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + flux[i]
  let last = -Infinity
  for (let i = 0; i < n; i++) {
    const v = flux[i]
    if (v <= delta) continue
    const a = Math.max(0, i - meanW), b = Math.min(n, i + meanW + 1)
    const mean = (prefix[b] - prefix[a]) / (b - a)
    if (v < 1.5 * mean + delta) continue
    let isPeak = true
    for (let j = Math.max(0, i - peakW); j <= Math.min(n - 1, i + peakW); j++) {
      // Ties resolve to the earliest frame.
      if (flux[j] > v || (flux[j] === v && j < i)) { isPeak = false; break }
    }
    if (!isPeak || i - last < minGap) continue
    out[i] = 1
    last = i
  }
  return out
}

/** 1 at an onset frame, exponential decay (ONSET_TAU) afterwards. */
function onsetEnvelope(onsets: Uint8Array, fps: number): Float32Array {
  const decay = Math.exp(-1 / (ONSET_TAU * fps))
  const env = new Float32Array(onsets.length)
  let y = 0
  for (let i = 0; i < onsets.length; i++) {
    y = onsets[i] ? 1 : y * decay
    env[i] = y
  }
  return env
}

// ---------------------------------------------------------------- file format

/**
 * Layout, little-endian:
 *   0  magic 'MKVA'   4  u32 version   8  f64 fps   16 u32 frameCount   20 u32 bands
 *   24..32 reserved (zero)
 *   32 spectrum f32[frameCount*bands], energy f32[frameCount], bass, onset
 */
const MAGIC = 'MKVA'
const VERSION = 1
const HEADER_BYTES = 32

export async function saveAnalysis(data: AnalysisData, filePath: string): Promise<void> {
  if (endianness() !== 'LE') throw new Error('saveAnalysis requires a little-endian host')
  const { frameCount, bands } = data
  if (data.spectrum.length !== frameCount * bands || data.energy.length !== frameCount
    || data.bass.length !== frameCount || data.onset.length !== frameCount) {
    throw new Error('analysis array lengths do not match frameCount/bands')
  }
  const header = Buffer.alloc(HEADER_BYTES)
  header.write(MAGIC, 0, 'ascii')
  header.writeUInt32LE(VERSION, 4)
  header.writeDoubleLE(data.fps, 8)
  header.writeUInt32LE(frameCount, 16)
  header.writeUInt32LE(bands, 20)
  // Write to a temp file and rename, so an interrupted save never leaves a
  // truncated file that a resumed render would trust.
  const tmp = `${filePath}.tmp`
  const fh = await open(tmp, 'w')
  try {
    await fh.write(header)
    for (const arr of [data.spectrum, data.energy, data.bass, data.onset]) {
      await fh.write(Buffer.from(arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength))
    }
  } catch (e) {
    await fh.close().catch(() => {})
    await unlink(tmp).catch(() => {})
    throw e
  }
  await fh.close()
  await rename(tmp, filePath)
}

export async function loadAnalysis(filePath: string): Promise<AnalysisData> {
  if (endianness() !== 'LE') throw new Error('loadAnalysis requires a little-endian host')
  const buf = await readFile(filePath)
  if (buf.length < HEADER_BYTES || buf.toString('ascii', 0, 4) !== MAGIC) {
    throw new Error(`${filePath} is not an analysis file (bad magic)`)
  }
  const version = buf.readUInt32LE(4)
  if (version !== VERSION) throw new Error(`${filePath}: unsupported analysis version ${version}`)
  const fps = buf.readDoubleLE(8)
  const frameCount = buf.readUInt32LE(16)
  const bands = buf.readUInt32LE(20)
  const expected = HEADER_BYTES + 4 * (frameCount * bands + 3 * frameCount)
  if (buf.length !== expected) throw new Error(`${filePath}: size ${buf.length}, expected ${expected}`)
  let off = HEADER_BYTES
  // Copy into fresh arrays: readFile's buffer is not guaranteed 4-byte aligned.
  const next = (n: number) => {
    const a = new Float32Array(n)
    new Uint8Array(a.buffer).set(buf.subarray(off, off + n * 4))
    off += n * 4
    return a
  }
  const spectrum = next(frameCount * bands)
  const energy = next(frameCount)
  const bass = next(frameCount)
  const onset = next(frameCount)
  return { fps, frameCount, bands, spectrum, energy, bass, onset }
}

// ---------------------------------------------------------------- synthetic

/**
 * Deterministic stand-in for real analysis: a beat at `bpm` (default 124)
 * with a kick in the low bands, a spectral bump that sweeps up and down, and
 * an 8-beat breakdown (no kick, lower energy) every 32 beats.
 */
export function syntheticAnalysis(opts: { fps: number; durationSeconds: number; bands?: number; bpm?: number }): AnalysisData {
  const { fps } = opts
  const bands = opts.bands ?? 64
  const bpm = opts.bpm ?? 124
  const frameCount = Math.max(0, Math.ceil(opts.durationSeconds * fps))
  const beat = 60 / bpm
  const spectrum = new Float32Array(frameCount * bands)
  const energy = new Float32Array(frameCount)
  const bass = new Float32Array(frameCount)
  const onset = new Float32Array(frameCount)
  const clamp = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
  for (let i = 0; i < frameCount; i++) {
    const t = i / fps
    const beatIdx = Math.floor(t / beat + 1e-9)
    const breakdown = beatIdx % 32 >= 24
    const sinceBeat = Math.max(0, t - beatIdx * beat)
    const kick = breakdown ? 0 : sinceBeat < 1e-9 ? 1 : Math.exp(-sinceBeat / ONSET_TAU)
    onset[i] = kick
    const slow = 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 23)
    const level = breakdown ? 0.45 : 0.8
    energy[i] = clamp(level * (0.75 + 0.25 * slow) + 0.15 * kick)
    bass[i] = clamp((breakdown ? 0.15 : 0.35) + 0.6 * kick)
    const centre = 0.5 + 0.35 * Math.sin((2 * Math.PI * t) / 17) // 0..1 across bands
    for (let b = 0; b < bands; b++) {
      const x = bands > 1 ? b / (bands - 1) : 0
      const tilt = 0.55 - 0.3 * x
      const bump = 0.45 * Math.exp(-((x - centre) ** 2) / 0.02)
      const kickPart = kick * Math.max(0, 1 - x * 5) * 0.6
      const shimmer = 0.08 * Math.sin(t * 7.3 + b * 0.9) * Math.sin(t * 2.1 + b * 0.37)
      spectrum[i * bands + b] = clamp((tilt + bump + shimmer) * level + kickPart)
    }
  }
  return { fps, frameCount, bands, spectrum, energy, bass, onset }
}
