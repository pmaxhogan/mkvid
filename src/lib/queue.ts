import { log } from './log.js'

export class JobQueue {
  private q: string[] = []
  private running = false
  constructor(private processor: (jobId: string) => Promise<void>) {}
  get size(): number { return this.q.length + (this.running ? 1 : 0) }
  enqueue(jobId: string): void { this.q.push(jobId); void this.drain() }
  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.q.length) {
        const id = this.q.shift()!
        try { await this.processor(id) }
        catch (e) { log('error', 'job processor failed', { jobId: id, err: String(e) }) }
      }
    } finally { this.running = false }
  }
}
