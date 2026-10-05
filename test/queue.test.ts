import { describe, it, expect } from 'vitest'
import { JobQueue } from '../src/lib/queue.js'

describe('JobQueue', () => {
  it('runs jobs serially in FIFO order', async () => {
    const order: string[] = []
    const running: number[] = []
    let active = 0
    const q = new JobQueue(async (id) => {
      active++; running.push(active)
      await new Promise((r) => setTimeout(r, 10))
      order.push(id); active--
    })
    q.enqueue('a'); q.enqueue('b'); q.enqueue('c')
    await new Promise((r) => setTimeout(r, 80))
    expect(order).toEqual(['a', 'b', 'c'])
    expect(Math.max(...running)).toBe(1) // never more than one at a time
  })
  it('runs up to its concurrency at once, the rest in FIFO order', async () => {
    const started: string[] = []
    let active = 0, most = 0
    const q = new JobQueue(async (id) => {
      started.push(id); active++; most = Math.max(most, active)
      await new Promise((r) => setTimeout(r, 10))
      active--
    }, 2)
    q.enqueue('a'); q.enqueue('b'); q.enqueue('c')
    expect(q.running).toBe(2)
    expect(q.hasFreeSlot).toBe(false)
    await new Promise((r) => setTimeout(r, 60))
    expect(started).toEqual(['a', 'b', 'c'])
    expect(most).toBe(2)
    expect(q.size).toBe(0)
    expect(q.hasFreeSlot).toBe(true)
  })
  it('keeps draining after a processor throws', async () => {
    const done: string[] = []
    const q = new JobQueue(async (id) => { if (id === 'x') throw new Error('boom'); done.push(id) })
    q.enqueue('x'); q.enqueue('y')
    await new Promise((r) => setTimeout(r, 40))
    expect(done).toEqual(['y'])
  })
})
