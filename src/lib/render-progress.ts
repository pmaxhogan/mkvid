/**
 * Where the running job is, as stages on one bar, for tracked's mkvid page
 * (GET /api/videos/render-progress). Pure: the job row, its render log lines,
 * the newest yt-dlp line and the in-memory progress event decide it, so it
 * also works right after a restart (logs only, no live percent).
 */

import type { Job } from '../types.js'
import type { LiveProgress } from './sse.js'
import { RENDER_SHARE } from '../viz/render.js'

export type StageKey = 'download' | 'analyse' | 'render' | 'assemble' | 'upload'

/**
 * Relative stage lengths, from six scene renders of 2026-09-30/10-01 (20-64 min
 * of segments each): download ~0.5 min, artwork + audio analysis ~0.5 min,
 * segments ~2/3 of the job, then assembling + the YouTube upload ~0.3-0.5x the
 * segment time. Widths on the bar, not a promise.
 */
export type Stage = { key: StageKey; label: string; weight: number }
export const STAGES: ReadonlyArray<Stage> = [
  { key: 'download', label: 'Download', weight: 2 },
  { key: 'analyse', label: 'Analyse', weight: 2 },
  { key: 'render', label: 'Render', weight: 64 },
  { key: 'assemble', label: 'Assemble', weight: 3 },
  { key: 'upload', label: 'Upload', weight: 29 },
]

/** The old styles (static, waveform): one ffmpeg pass, no analysis or assembly; much shorter than a scene render. */
export const STAGES_PLAIN: ReadonlyArray<Stage> = [
  { key: 'download', label: 'Download', weight: 5 },
  { key: 'render', label: 'Transcode', weight: 60 },
  { key: 'upload', label: 'Upload', weight: 35 },
]

/**
 * Lines that start a new attempt in the same job's log: an in-process render
 * retry, a resume after a restart, a retry from the UI, adopting a failed
 * job's kept work. Everything before the last one belongs to an earlier
 * attempt (its "viz: assembling" or segment lines must not leak in).
 */
// `render failed: ` alone: the message embeds a multi-line ffmpeg stderr tail, so `.*retrying` would miss it.
const ATTEMPT_RE = /^(render failed: |resuming after a restart|retry requested$|reusing the kept work)/

export interface StageView { key: StageKey; label: string; weight: number; state: 'done' | 'active' | 'pending'; progress: number | null }
export interface RenderProgress {
  jobId: string
  requestId: string | null
  title: string | null
  style: string
  status: Job['status']
  startedAt: number
  stage: StageKey
  /**
   * The stage this job is queued for while the other job in flight runs it
   * (stage-gate.ts); `stage` is then that stage, shown as not started.
   */
  waiting: StageKey | null
  /** 0..1 over the whole job, by the stage weights (an active stage without a known percent counts as not started). */
  fraction: number
  /** From the newest segment line ("~N min left"), while rendering. */
  renderMinutesLeft: number | null
  segments: { done: number; total: number } | null
  stages: StageView[]
}

const SEG_RE = /^viz: segment (\d+)\/(\d+) done \([\d.]+ fps, ~(\d+) min left\)/
const SEGS_START_RE = /^viz: (\d+) segment\(s\), (\d+) already done/
const DL_RE = /^\[download\]\s+([\d.]+)%/

const clamp = (n: number) => Math.max(0, Math.min(1, n))
const lastMatch = (lines: string[], re: RegExp): RegExpExecArray | null => {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = re.exec(lines[i]!)
    if (m) return m
  }
  return null
}

export function describeProgress(job: Job, logs: { viz: string[]; download: string | null }, live: LiveProgress | null, waiting: StageKey | null = null): RenderProgress {
  let cut = -1
  logs.viz.forEach((l, i) => { if (ATTEMPT_RE.test(l)) cut = i })
  const viz = logs.viz.slice(cut + 1).filter((l) => l.startsWith('viz:'))
  const plain = job.style !== 'scene'
  const table = plain ? STAGES_PLAIN : STAGES
  const segStart = lastMatch(viz, SEGS_START_RE)
  const lastSeg = lastMatch(viz, SEG_RE)
  let segments: RenderProgress['segments'] = segStart ? { done: Number(segStart[2]), total: Number(segStart[1]) } : null
  // Segments finish out of order (several encoders): the count of "done" lines since the start line is the truth.
  if (segStart && segments) {
    const startIdx = viz.lastIndexOf(segStart.input)
    const doneSince = viz.slice(startIdx + 1).filter((l) => SEG_RE.test(l)).length
    segments = { done: Math.min(segments.total, segments.done + doneSince), total: segments.total }
  }
  const minutesLeft = lastSeg ? Number(lastSeg[3]) : null

  let stage: StageKey
  let progress: number | null = null
  if (job.status === 'uploading') {
    stage = 'upload'
    progress = live?.phase === 'upload' ? clamp(live.percent / 100) : null
  } else if (job.status === 'downloading') {
    stage = 'download'
    if (live?.phase === 'download') progress = clamp(live.percent / 100)
    else if (logs.download) {
      const m = DL_RE.exec(logs.download)
      progress = m ? clamp(Number(m[1]) / 100) : null
    }
  } else if (plain) {
    stage = 'render'
    progress = live?.phase === 'transcode' ? clamp(live.percent / 100) : null
  } else if (viz.some((l) => l === 'viz: assembling' || l.startsWith('viz: out.mp4 from an earlier attempt'))) {
    stage = 'assemble'
  } else if (segStart) {
    stage = 'render'
    if (live?.phase === 'transcode') progress = clamp(live.percent / 100 / RENDER_SHARE)
    else if (segments) progress = clamp(segments.done / Math.max(1, segments.total))
  } else {
    stage = 'analyse'
  }

  // Queued for a stage the other job holds: that stage, not started yet.
  const waitingFor = waiting && table.some((s) => s.key === waiting) ? waiting : null
  if (waitingFor) { stage = waitingFor; progress = 0 }

  const idx = table.findIndex((s) => s.key === stage)
  const stages: StageView[] = table.map((s, i) => ({
    ...s,
    state: i < idx ? 'done' : i === idx ? 'active' : 'pending',
    progress: i < idx ? 1 : i === idx ? progress : 0,
  }))
  const total = table.reduce((n, s) => n + s.weight, 0)
  const fraction = stages.reduce((n, s) => n + s.weight * (s.progress ?? 0), 0) / total
  return {
    jobId: job.id,
    requestId: job.meta?.requestId ?? null,
    title: job.title,
    style: job.style,
    status: job.status,
    startedAt: job.createdAt,
    stage,
    waiting: waitingFor,
    fraction,
    renderMinutesLeft: stage === 'render' ? minutesLeft : null,
    segments: stage === 'render' || stage === 'assemble' ? segments : null,
    stages,
  }
}
