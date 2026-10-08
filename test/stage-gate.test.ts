import { describe, it, expect } from 'vitest'
import { StageGate } from '../src/lib/stage-gate.js'

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('StageGate', () => {
  it('runs one job per stage, hands the stage over in arrival order, and lets other stages run alongside', async () => {
    const gate = new StageGate()
    const order: string[] = []
    const waits: string[] = []
    const releases: Record<string, () => void> = {}
    const hold = (stage: 'render' | 'upload', job: string) =>
      gate.run(stage, job, () => new Promise<void>((r) => { order.push(`${job}:${stage}`); releases[job + stage] = r }), (h) => waits.push(`${job} waits on ${h}`))

    const a = hold('render', 'a')
    const b = hold('render', 'b')
    const c = hold('render', 'c')
    const u = hold('upload', 'u')
    await tick()
    expect(order).toEqual(['a:render', 'u:upload'])
    expect(gate.holder('render')).toBe('a')
    expect(gate.waitingFor('b')).toBe('render')
    expect(waits).toEqual(['b waits on a', 'c waits on a'])

    releases.arender!()
    await tick()
    expect(order).toEqual(['a:render', 'u:upload', 'b:render'])
    expect(gate.waitingFor('b')).toBeNull()
    releases.brender!(); await tick()
    releases.crender!(); releases.uupload!()
    await Promise.all([a, b, c, u])
    expect(order).toEqual(['a:render', 'u:upload', 'b:render', 'c:render'])
    expect(gate.holder('render')).toBeNull()
  })

  it('a stage with two slots runs two jobs at once and queues the third', async () => {
    const gate = new StageGate({ upload: 2 })
    expect(gate.slotsOf('upload')).toBe(2)
    expect(gate.slotsOf('render')).toBe(1)
    const releases: Record<string, () => void> = {}
    const waits: string[][] = []
    const up = (job: string) => gate.run('upload', job, () => new Promise<void>((r) => { releases[job] = r }), (h) => waits.push(h))
    const a = up('a'); const b = up('b')
    expect(gate.holders('upload')).toEqual(['a', 'b'])
    expect(gate.hasRoom('upload')).toBe(false)
    expect(gate.held()).toBe(2) // jobs holding a stage, not stages held
    const c = up('c')
    await tick()
    expect(waits).toEqual([['a', 'b']])
    expect(gate.waitingFor('c')).toBe('upload')
    releases.b!(); await b; await tick()
    expect(gate.holders('upload')).toEqual(['a', 'c'])
    expect(gate.waiting()).toBe(0)
    releases.a!(); releases.c!()
    await Promise.all([a, c])
    expect(gate.holders('upload')).toEqual([])
    expect(gate.hasRoom('upload')).toBe(true)
  })

  it('frees the stage when the holder throws', async () => {
    const gate = new StageGate()
    await expect(gate.run('render', 'a', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(gate.holder('render')).toBeNull()
    expect(await gate.run('render', 'b', async () => 7)).toBe(7)
  })
})
