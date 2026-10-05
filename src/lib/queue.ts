import { log } from './log.js'

/**
 * FIFO job queue running up to `concurrency` jobs at once. mkvid runs two:
 * the stage gate (stage-gate.ts) keeps them from being in the same stage, so
 * one set downloads, analyses or uploads while the other renders.
 */
export class JobQueue {
  private q: string[] = []
  private active = 0
  constructor(private processor: (jobId: string) => Promise<void>, readonly concurrency = 1) {}
  /** Jobs waiting plus jobs running. */
  get size(): number { return this.q.length + this.active }
  get running(): number { return this.active }
  get waiting(): number { return this.q.length }
  /** A job enqueued now would start right away. */
  get hasFreeSlot(): boolean { return this.q.length === 0 && this.active < this.concurrency }
  /** Queued, not yet started. */
  has(jobId: string): boolean { return this.q.includes(jobId) }
  enqueue(jobId: string): void { this.q.push(jobId); this.pump() }
  private pump(): void {
    while (this.active < this.concurrency && this.q.length) {
      const id = this.q.shift()!
      this.active++
      void (async () => {
        try { await this.processor(id) }
        catch (e) { log('error', 'job processor failed', { jobId: id, err: String(e) }) }
        finally { this.active--; this.pump() }
      })()
    }
  }
}
