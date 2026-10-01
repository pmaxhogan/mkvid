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
export const STAGES: ReadonlyArray<{ key: StageKey; label: string; weight: number }> = [
  { key: 'download', label: 'Download', weight: 2 },
  { key: 'analyse', label: 'Analyse', weight: 2 },
  { key: 'render', label: 'Render', weight: 64 },
  { key: 'assemble', label: 'Assemble', weight: 3 },
  { key: 'upload', label: 'Upload', weight: 29 },
]

export interface StageView { key: StageKey; label: string; weight: number; state: 'done' | 'active' | 'pending'; progress: number | null }
export interface RenderProgress {
  jobId: string
  requestId: string | null
  title: string | null
  style: string
  status: Job['status']
  startedAt: number
  stage: StageKey
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

export function describeProgress(job: Job, logs: { viz: string[]; download: string | null }, live: LiveProgress | null): RenderProgress {
  const viz = logs.viz
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
  } else if (viz.some((l) => l === 'viz: assembling' || l.startsWith('viz: out.mp4 from an earlier attempt'))) {
    stage = 'assemble'
  } else if (segStart) {
    stage = 'render'
    if (live?.phase === 'transcode') progress = clamp(live.percent / 100 / RENDER_SHARE)
    else if (segments) progress = clamp(segments.done / Math.max(1, segments.total))
  } else {
    stage = 'analyse'
  }

  const idx = STAGES.findIndex((s) => s.key === stage)
  const stages: StageView[] = STAGES.map((s, i) => ({
    ...s,
    state: i < idx ? 'done' : i === idx ? 'active' : 'pending',
    progress: i < idx ? 1 : i === idx ? progress : 0,
  }))
  const total = STAGES.reduce((n, s) => n + s.weight, 0)
  const fraction = stages.reduce((n, s) => n + s.weight * (s.progress ?? 0), 0) / total
  return {
    jobId: job.id,
    requestId: job.meta?.requestId ?? null,
    title: job.title,
    style: job.style,
    status: job.status,
    startedAt: job.createdAt,
    stage,
    fraction,
    renderMinutesLeft: stage === 'render' ? minutesLeft : null,
    segments: stage === 'render' || stage === 'assemble' ? segments : null,
    stages,
  }
}
