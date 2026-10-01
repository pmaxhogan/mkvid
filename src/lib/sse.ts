import type { ProgressPhase, SseMessage } from '../types.js'

/** The latest progress a running job published (kept in memory only: gone after a restart). */
export interface LiveProgress { phase: ProgressPhase; percent: number; at: number }

export class SseHub {
  private chans = new Map<string, Set<(m: SseMessage) => void>>()
  private latest = new Map<string, LiveProgress>()
  /** The job's latest progress event, for tracked's render-progress view. */
  progress(jobId: string): LiveProgress | null {
    return this.latest.get(jobId) ?? null
  }
  add(jobId: string, fn: (m: SseMessage) => void): () => void {
    let set = this.chans.get(jobId)
    if (!set) { set = new Set(); this.chans.set(jobId, set) }
    set.add(fn)
    return () => { set!.delete(fn); if (set!.size === 0) this.chans.delete(jobId) }
  }
  publish(jobId: string, m: SseMessage): void {
    if (m.type === 'progress' && m.phase && typeof m.percent === 'number' && m.percent >= 0) this.latest.set(jobId, { phase: m.phase, percent: m.percent, at: Date.now() })
    else if (m.type === 'done' || m.type === 'error') this.latest.delete(jobId)
    this.chans.get(jobId)?.forEach((fn) => fn(m))
  }
}
