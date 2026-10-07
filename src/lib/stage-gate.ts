/**
 * One job per stage at a time. The queue has no job limit (queue.ts): this is
 * the limit, so sets move through the stages like a pipeline (one downloads
 * while another analyses, a third renders, ...) and two renders never fight
 * over the CPU. The tracked poller claims a new set only when every job in
 * flight holds a stage and download is free (tracked.ts), so at most one set
 * per stage is here and none piles up waiting.
 *
 * A job holds a stage only while it runs that stage and never holds one while
 * waiting for the next, so two jobs cannot deadlock. Waiters are served in
 * arrival order.
 */

import type { StageKey } from './render-progress.js'

export type GateStage = StageKey

interface Slot { holder: string | null; waiters: Array<{ jobId: string; wake: () => void }> }

export class StageGate {
  private slots = new Map<GateStage, Slot>()

  private slot(stage: GateStage): Slot {
    let s = this.slots.get(stage)
    if (!s) { s = { holder: null, waiters: [] }; this.slots.set(stage, s) }
    return s
  }

  /** The job running `stage` now, if any. */
  holder(stage: GateStage): string | null {
    return this.slots.get(stage)?.holder ?? null
  }

  /** Stages some job is running now. A job holds at most one at a time. */
  held(): number {
    let n = 0
    for (const s of this.slots.values()) if (s.holder !== null) n++
    return n
  }

  /** Jobs waiting for a stage another job holds. */
  waiting(): number {
    let n = 0
    for (const s of this.slots.values()) n += s.waiters.length
    return n
  }

  /** The stage `jobId` is queued for, if it is waiting for one. */
  waitingFor(jobId: string): GateStage | null {
    for (const [stage, s] of this.slots) if (s.waiters.some((w) => w.jobId === jobId)) return stage
    return null
  }

  /**
   * Run `fn` holding `stage`. `onWait` is called once, before waiting, when
   * another job holds it (with that job's id).
   */
  async run<T>(stage: GateStage, jobId: string, fn: () => Promise<T>, onWait?: (holder: string) => void): Promise<T> {
    const s = this.slot(stage)
    if (s.holder !== null) {
      onWait?.(s.holder)
      await new Promise<void>((wake) => s.waiters.push({ jobId, wake }))
    }
    s.holder = jobId
    try {
      return await fn()
    } finally {
      const next = s.waiters.shift()
      s.holder = null
      // Hand over synchronously: the next waiter takes the slot before anyone new can.
      if (next) { s.holder = next.jobId; next.wake() }
    }
  }
}
