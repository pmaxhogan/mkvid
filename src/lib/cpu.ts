import { availableParallelism } from 'node:os'
import { readFileSync } from 'node:fs'

/**
 * CPUs this process may actually run on. `os.cpus()` lists every host core
 * even inside a container; `availableParallelism()` follows the affinity mask
 * (compose `cpuset`), and a CFS quota (compose `cpus:`, cgroup v2 `cpu.max`)
 * caps it further when one is set.
 */
export function availableCores(cpuMax = readCpuMax()): number {
  const affinity = availableParallelism()
  const quota = parseCpuMax(cpuMax)
  return Math.max(1, quota ? Math.min(affinity, Math.ceil(quota)) : affinity)
}

/** Drawing threads by default: every usable core but two (left for node, ffmpeg and the encoders). */
export function defaultWorkerCount(): number {
  return Math.max(1, availableCores() - 2)
}

/** A configured worker count, never more than the usable cores. */
export function clampWorkers(requested: number, cores = availableCores()): number {
  return Math.max(1, Math.min(requested, cores))
}

/** cgroup v2 `cpu.max` ("<quota> <period>" or "max <period>") → CPUs, or null for no quota. */
export function parseCpuMax(s: string | null): number | null {
  if (!s) return null
  const [quota, period] = s.trim().split(/\s+/)
  const q = Number(quota)
  const p = Number(period)
  return Number.isFinite(q) && q > 0 && p > 0 ? q / p : null
}

function readCpuMax(): string | null {
  try {
    return readFileSync('/sys/fs/cgroup/cpu.max', 'utf8')
  } catch {
    return null
  }
}
