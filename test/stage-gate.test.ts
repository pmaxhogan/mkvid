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

  it('frees the stage when the holder throws', async () => {
    const gate = new StageGate()
    await expect(gate.run('render', 'a', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(gate.holder('render')).toBeNull()
    expect(await gate.run('render', 'b', async () => 7)).toBe(7)
  })
})
