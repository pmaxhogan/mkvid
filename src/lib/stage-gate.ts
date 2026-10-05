/**
 * One job per stage at a time. The queue runs two jobs (queue.ts); this keeps
 * them in different stages, so one set downloads, analyses, assembles or
 * uploads while the other renders, and two renders never fight over the CPU.
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
