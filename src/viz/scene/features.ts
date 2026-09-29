import type { AnalysisData } from '../types.js'

/**
 * Read-only views over the analysis, built once per scene. Everything that
 * looks like inertia (averages, peak hold, particles that travel further on
 * loud bass) is a closed-form read of these arrays around frame i.
 */
export class Features {
  readonly frames: number
  readonly bands: number
  private readonly spectrum: Float32Array
  private readonly energy: Float32Array
  private readonly bass: Float32Array
  private readonly onset: Float32Array
  /** prefix[i] = sum of values in frames [0, i). */
  private readonly energySum: Float64Array
  private readonly bassSum: Float64Array
  /** Prefix sum of expanded, squared bass: loud low end pushes particles. */
  private readonly bassPushSum: Float64Array
  /** Analysis frames per video frame, when the two rates differ. */
  private readonly ratio: number
  /**
   * Weight of the onset whose envelope is decaying at each analysis frame:
   * full for an onset with a bass rise around it (a kick), faint for the
   * rest (hats, off-beat stabs). Real music fires about three onsets a
   * second; this leaves about one and a half strong pulses.
   */
  private readonly onsetGain: Float32Array

  constructor(a: AnalysisData, videoFps: number) {
    this.frames = Math.max(0, Math.min(a.frameCount, a.energy.length, a.bass.length, a.onset.length))
    this.bands = Math.max(0, a.bands | 0)
    if (this.bands > 0) this.frames = Math.min(this.frames, Math.floor(a.spectrum.length / this.bands))
    this.spectrum = a.spectrum
    this.energy = a.energy
    this.bass = a.bass
    this.onset = a.onset
    this.ratio = a.fps > 0 && videoFps > 0 ? a.fps / videoFps : 1
    this.energySum = prefix(a.energy, this.frames)
    this.bassSum = prefix(a.bass, this.frames)
    this.bassPushSum = prefix(a.bass, this.frames, (v) => expand(v) ** 2)
    this.onsetGain = onsetGains(a.onset, a.bass, this.frames)
  }

  /** Analysis frame for a video frame, clamped into range. */
  private at(i: number): number {
    const j = Math.floor(i * this.ratio)
    return j < 0 ? 0 : j >= this.frames ? this.frames - 1 : j
  }

  private read(arr: Float32Array, i: number): number {
    if (this.frames === 0) return 0
    const v = arr[this.at(i)]!
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
  }

  energyAt(i: number): number {
    return this.read(this.energy, i)
  }
  bassAt(i: number): number {
    return this.read(this.bass, i)
  }
  onsetAt(i: number): number {
    return this.read(this.onset, i)
  }

  private windowMean(sum: Float64Array, i: number, back: number): number {
    if (this.frames === 0) return 0
    const end = this.at(i) + 1
    const start = Math.max(0, end - Math.max(1, Math.round(back * this.ratio)))
    const v = (sum[end]! - sum[start]!) / (end - start)
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
  }

  /** Mean energy over the `back` video frames ending at i. */
  energyMean(i: number, back: number): number {
    return this.windowMean(this.energySum, i, back)
  }
  bassMean(i: number, back: number): number {
    return this.windowMean(this.bassSum, i, back)
  }

  /** Running sum of bass push up to video frame i (monotonic, for travel distance). */
  bassIntegral(i: number): number {
    if (this.frames === 0) return 0
    if (i < 0) return 0
    return this.bassPushSum[this.at(i) + 1]! / this.ratio
  }

  /**
   * Energy is dB-scaled and sits high most of the time, so it is expanded:
   * about 0 in a breakdown, about 0.7 in a typical loud section.
   */
  level(i: number): number {
    return smoothstep(0.2, 0.95, this.energyMean(i, 18))
  }
  levelSlow(i: number): number {
    return smoothstep(0.2, 0.95, this.energyMean(i, 90))
  }

  /**
   * Bass drive 0..1: part absolute level, part rise over the last two
   * seconds, so a steady loud kick does not pin every effect at maximum.
   */
  bassDrive(i: number): number {
    const now = this.bassMean(i, 3)
    const slow = this.bassMean(i, 60)
    const rise = Math.min(1, Math.max(0, (now - slow) / 0.2 + 0.2))
    return Math.min(1, 0.4 * smoothstep(0.35, 1, now) + 0.6 * rise)
  }

  /**
   * Onset with a short attack-release shape: the max of onset over the last
   * few frames with an exponential decay, so a beat pulse eases out.
   */
  pulse(i: number, back = 6, decay = 0.72): number {
    let best = 0
    let w = 1
    for (let k = 0; k <= back; k++) {
      // Only strong onsets count: real music fires the envelope ~3 times a second.
      const v = Math.max(0, (this.onsetAt(i - k) - 0.45) / 0.55) * this.gainAt(i - k) * w
      if (v > best) best = v
      w *= decay
    }
    return best
  }

  /**
   * Spectrum resampled to `n` points across [lo, hi) of the band range,
   * peak-held over `back` frames with decay, lightly smoothed across bands.
   */
  spectrumAt(i: number, n: number, out: Float32Array, back = 5, decay = 0.8, lo = 0, hi = 1, rise = 1.2, attack = 1): Float32Array {
    out.fill(0, 0, n)
    if (this.frames === 0 || this.bands === 0) return out
    const b = this.bands
    const raw = this.scratchRaw.length === b ? this.scratchRaw : (this.scratchRaw = new Float32Array(b))
    const slow = this.scratchSlow.length === b ? this.scratchSlow : (this.scratchSlow = new Float32Array(b))
    raw.fill(0)
    slow.fill(0)
    let w = 1
    for (let k = 0; k <= back && i - k >= 0; k++) {
      const row = this.at(i - k) * b
      // attack > 1: each held frame is the mean of it and the frames before
      // it, so a single-frame transient rises over a few frames.
      const prevRows: number[] = []
      for (let a = 1; a < attack; a++) prevRows.push(this.at(Math.max(0, i - k - a)) * b)
      for (let j = 0; j < b; j++) {
        let c = this.cell(row + j)
        if (attack > 1) {
          for (const pr of prevRows) c += this.cell(pr + j)
          c /= attack
        }
        const v = c * w
        if (v > raw[j]!) raw[j] = v
      }
      w *= decay
    }
    // Per-band average over the last ~1.2 s, sampled every third frame.
    let samples = 0
    for (let k = 0; k < 36 && i - k >= 0; k += 3) {
      const row = this.at(i - k) * b
      for (let j = 0; j < b; j++) slow[j]! += this.cell(row + j)
      samples++
    }
    // dB-scaled bands idle around 0.6: expand the range, then add the rise over
    // the band's recent average so movement shows even in dense mixes.
    for (let j = 0; j < b; j++) {
      const d = expand(raw[j]!)
      const s = expand(samples ? slow[j]! / samples : 0)
      raw[j] = Math.min(1, Math.max(0, 0.5 * d * d + rise * (d - s)))
    }
    const span = (hi - lo) * (b - 1)
    for (let p = 0; p < n; p++) {
      const x = lo * (b - 1) + (n === 1 ? 0 : (p / (n - 1)) * span)
      const j0 = Math.floor(x)
      const j1 = Math.min(b - 1, j0 + 1)
      const f = x - j0
      out[p] = raw[j0]! * (1 - f) + raw[j1]! * f
    }
    // 3-tap smoothing, three passes.
    for (let pass = 0; pass < 3; pass++) {
      let prev = out[0]!
      for (let p = 0; p < n; p++) {
        const cur = out[p]!
        const next = p + 1 < n ? out[p + 1]! : cur
        out[p] = prev * 0.25 + cur * 0.5 + next * 0.25
        prev = cur
      }
    }
    return out
  }

  private gainAt(i: number): number {
    return this.frames === 0 ? 0 : this.onsetGain[this.at(i)]!
  }

  private scratchRaw = new Float32Array(0)
  private scratchSlow = new Float32Array(0)

  private cell(k: number): number {
    const v = this.spectrum[k]!
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
  }
}

/** dB-normalised features idle high; map the useful part of the range to 0..1. */
export function expand(v: number): number {
  return Math.min(1, Math.max(0, (v - 0.45) / 0.53))
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Per analysis frame: gain of the onset that started the envelope there (see Features.onsetGain). */
function onsetGains(onset: Float32Array, bass: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n)
  const v = (arr: Float32Array, i: number) => {
    const x = arr[Math.min(n - 1, Math.max(0, i))]!
    return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0
  }
  let gain = 1
  for (let i = 0; i < n; i++) {
    if (i === 0 || v(onset, i) - v(onset, i - 1) > 0.3) {
      // Bass rise from just before the onset to just after it.
      const after = Math.max(v(bass, i), v(bass, i + 1), v(bass, i + 2))
      const before = Math.min(v(bass, i - 1), v(bass, i - 2), v(bass, i - 3), v(bass, i - 4))
      gain = 0.3 + 0.7 * smoothstep(0.02, 0.1, after - before)
    }
    out[i] = gain
  }
  return out
}

function prefix(arr: Float32Array, n: number, map: (v: number) => number = (v) => v): Float64Array {
  const out = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) {
    const v = arr[i]!
    out[i + 1] = out[i]! + map(Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)
  }
  return out
}
