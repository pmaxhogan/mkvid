import type { SseMessage } from '../types.js'

export class SseHub {
  private chans = new Map<string, Set<(m: SseMessage) => void>>()
  add(jobId: string, fn: (m: SseMessage) => void): () => void {
    let set = this.chans.get(jobId)
    if (!set) { set = new Set(); this.chans.set(jobId, set) }
    set.add(fn)
    return () => { set!.delete(fn); if (set!.size === 0) this.chans.delete(jobId) }
  }
  publish(jobId: string, m: SseMessage): void {
    this.chans.get(jobId)?.forEach((fn) => fn(m))
  }
}
