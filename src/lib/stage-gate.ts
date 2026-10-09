/**
 * A few jobs per stage at a time: one per stage unless a stage is given more
 * slots (upload has UPLOAD_CONCURRENCY, default 2: a single YouTube upload
 * connection is throttled well below the uplink). The queue has no job limit
 * (queue.ts): this is the limit, so sets move through the stages like a
 * pipeline (one downloads while another analyses, a third renders, ...) and
 * two renders never fight over the CPU. The tracked poller claims a new set
 * only when every job in flight holds a stage and download is free
 * (tracked.ts), so about one set per stage slot is here and none piles up.
 *
 * A job holds a stage only while it runs that stage and never holds one while
 * waiting for the next, so two jobs cannot deadlock. Waiters are served in
 * arrival order.
 */

import type { StageKey } from './render-progress.js'

/**
 * `track-render`: the render of a track upload (the `track` style) has a slot
 * of its own, so a 5-minute track never waits behind an hours-long scene
 * render. It shares download and upload with every other job (tracked.ts
 * pollTrackUploads explains why).
 */
export type GateStage = StageKey | 'track-render'

interface Slot { capacity: number; holders: string[]; waiters: Array<{ jobId: string; wake: () => void }> }

export class StageGate {
  private slots = new Map<GateStage, Slot>()

  /** `capacity`: how many jobs may run a stage at once (1 for any stage not named). */
  constructor(private readonly capacity: Partial<Record<GateStage, number>> = {}) {}

  private slot(stage: GateStage): Slot {
    let s = this.slots.get(stage)
    if (!s) {
      s = { capacity: Math.max(1, Math.floor(this.capacity[stage] ?? 1)), holders: [], waiters: [] }
      this.slots.set(stage, s)
    }
    return s
  }

  /** How many jobs may run `stage` at once. */
  slotsOf(stage: GateStage): number {
    return this.slot(stage).capacity
  }

  /** The job that took `stage` first of those running it now, if any. */
  holder(stage: GateStage): string | null {
    return this.slots.get(stage)?.holders[0] ?? null
  }

  /** Every job running `stage` now, in the order they took it. */
  holders(stage: GateStage): string[] {
    return [...(this.slots.get(stage)?.holders ?? [])]
  }

  /** Does `stage` have a free slot (a job asking now would not wait)? */
  hasRoom(stage: GateStage): boolean {
    const s = this.slot(stage)
    return s.holders.length < s.capacity && s.waiters.length === 0
  }

  /** Jobs running some stage now. A job holds at most one stage at a time. */
  held(): number {
    let n = 0
    for (const s of this.slots.values()) n += s.holders.length
    return n
  }

  /** Jobs waiting for a stage whose slots are all taken (only `stages`, when given). */
  waiting(stages?: readonly GateStage[]): number {
    let n = 0
    for (const [stage, s] of this.slots) if (!stages || stages.includes(stage)) n += s.waiters.length
    return n
  }

  /** The stage `jobId` is queued for, if it is waiting for one. */
  waitingFor(jobId: string): GateStage | null {
    for (const [stage, s] of this.slots) if (s.waiters.some((w) => w.jobId === jobId)) return stage
    return null
  }

  /**
   * Run `fn` holding `stage`. `onWait` is called once, before waiting, when
   * every slot of it is taken (with the ids of the jobs holding them).
   */
  async run<T>(stage: GateStage, jobId: string, fn: () => Promise<T>, onWait?: (holders: string[]) => void): Promise<T> {
    const s = this.slot(stage)
    if (s.holders.length >= s.capacity || s.waiters.length > 0) {
      onWait?.([...s.holders])
      // The slot is handed over in the finally below: holders already lists this job when it wakes.
      await new Promise<void>((wake) => s.waiters.push({ jobId, wake }))
    } else {
      s.holders.push(jobId)
    }
    try {
      return await fn()
    } finally {
      const i = s.holders.indexOf(jobId)
      if (i >= 0) s.holders.splice(i, 1)
      // Hand over synchronously: the next waiter takes the slot before anyone new can.
      const next = s.waiters.shift()
      if (next) { s.holders.push(next.jobId); next.wake() }
    }
  }
}
