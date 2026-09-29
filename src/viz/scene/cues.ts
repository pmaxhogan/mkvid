import type { VizTrack } from '../types.js'

/** Frame at which a cue starts. Cues are compared in frames, never seconds. */
export function cueFrame(startSeconds: number, fps: number): number {
  return Math.max(0, Math.round(startSeconds * fps))
}

/**
 * Index of the last entry whose start frame is <= frame, or -1 when the frame
 * comes before the first entry. `starts` must be sorted ascending.
 */
export function slotAt(starts: ArrayLike<number>, frame: number): number {
  let lo = 0
  let hi = starts.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (starts[mid]! <= frame) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

/** Index of the track playing at a frame, or -1 before the first cue. */
export function trackIndexAt(tracks: readonly VizTrack[], frame: number, fps: number): number {
  return slotAt(
    tracks.map((t) => cueFrame(t.startSeconds, fps)),
    frame,
  )
}

/** A track that plays on top of its group's base track. */
export interface GroupLayer {
  /** Index into the input track list. */
  index: number
  /** First frame it is on screen: its own cue, never before its base's. */
  joinFrame: number
}

/**
 * One stretch of the set owned by a base track: the base plus every layered
 * ("w/") track that plays on top of it. Everything in a group leaves together
 * when the next group starts.
 */
export interface TrackGroup {
  /** Index into the input track list. */
  base: number
  startFrame: number
  /** Sorted by joinFrame, then input order. */
  layers: GroupLayer[]
}

/**
 * Groups a track list into base tracks and their layered tracks.
 *
 * Input order decides what a layered track is layered on (the nearest
 * preceding base in the list), so a layered cue that is earlier than its
 * base's does not move it into another group; it is clamped to the base's
 * start. A layered first entry has nothing to sit on and becomes a base.
 * Groups are then stably sorted by their base's start (as the old per-track
 * sort did), and a layered track that would join at or after the next
 * group's start is dropped: it could never be on screen.
 */
export function groupTracks(tracks: readonly VizTrack[], fps: number): TrackGroup[] {
  const groups: (TrackGroup & { startSeconds: number })[] = []
  tracks.forEach((t, index) => {
    const last = groups[groups.length - 1]
    if (t.layered === true && last) {
      last.layers.push({ index, joinFrame: Math.max(last.startFrame, cueFrame(t.startSeconds, fps)) })
      return
    }
    groups.push({ base: index, startFrame: cueFrame(t.startSeconds, fps), startSeconds: t.startSeconds, layers: [] })
  })
  groups.sort((a, b) => a.startSeconds - b.startSeconds)
  return groups.map((g, k) => {
    const next = groups[k + 1]
    const end = next ? next.startFrame : Number.POSITIVE_INFINITY
    const layers = g.layers.filter((l) => l.joinFrame < end).sort((a, b) => a.joinFrame - b.joinFrame || a.index - b.index)
    return { base: g.base, startFrame: g.startFrame, layers }
  })
}

/**
 * Input indices of every track on screen at a frame: the base first, then
 * the layered tracks that have joined, in join order. Empty before the first
 * cue. When two groups start on the same frame the later one wins.
 */
export function activeTracksAt(groups: readonly TrackGroup[], frame: number): number[] {
  const g = slotAt(
    groups.map((x) => x.startFrame),
    frame,
  )
  if (g < 0) return []
  const group = groups[g]!
  return [group.base, ...group.layers.filter((l) => l.joinFrame <= frame).map((l) => l.index)]
}

/** h:mm:ss for any duration; m:ss would change width mid-video, so hours are always shown. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

/** True when at least one track carries a name worth showing. */
export function hasTrackNames(tracks: readonly VizTrack[]): boolean {
  return tracks.some((t) => (t.artist && t.artist.trim()) || (t.title && t.title.trim()))
}
