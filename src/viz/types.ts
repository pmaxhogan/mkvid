/**
 * Contracts between the three parts of the frame-by-frame visualizer:
 *   analysis.ts  audio -> AnalysisData
 *   scene/       (VizInput, AnalysisData) -> RGBA frames
 *   render.ts    segment planning, worker pool, ffmpeg encode, assemble, resume
 */

/** One entry of the set's track list, already resolved to local files. */
export interface VizTrack {
  /** Where the track starts in the recording. Tracks are sorted by this. */
  startSeconds: number
  /** null for an unidentified track ("ID"), and for every track of an untrusted list. */
  artist: string | null
  title: string | null
  /** Local image file, or null to fall back to the set artwork. */
  artworkPath: string | null
  /**
   * True when this track plays on top of the track before it instead of
   * replacing it (a "w/" row on the tracklist: a mashup, an acapella over an
   * instrumental, two tracks layered). It joins the screen at its own
   * startSeconds, which is never earlier than the start of the track it is
   * layered on, and leaves with that track when the next track that is not
   * layered starts. Several layered tracks may follow one track. Absent
   * means false. The first track of a list is never layered.
   */
  layered?: boolean
}

export interface VizInput {
  audioPath: string
  durationSeconds: number
  setTitle: string
  setArtist: string | null
  /** Local image file; null draws a generated gradient instead. */
  setArtworkPath: string | null
  /** May be empty: the video then shows the set artwork and no track names. */
  tracks: VizTrack[]
  width: number
  height: number
  fps: number
}

/**
 * Per-frame audio features, one entry per video frame. Every value is
 * normalized to 0..1 over the whole recording so a scene needs no gain logic.
 */
export interface AnalysisData {
  fps: number
  frameCount: number
  /** Number of log-spaced frequency bands per frame, low to high. */
  bands: number
  /** frameCount * bands values, row-major (frame, then band). */
  spectrum: Float32Array
  /** Overall loudness. */
  energy: Float32Array
  /** Loudness below about 150 Hz. */
  bass: Float32Array
  /** Beat envelope: jumps to 1 on an onset and decays over a few hundred ms. */
  onset: Float32Array
}

/**
 * A scene draws any frame on its own: drawFrame(i) depends only on i, the
 * input and the analysis, never on which frames were drawn before. Segments
 * are rendered in parallel and out of order, and a resumed render must
 * produce the same pixels, so anything that looks stateful (particles,
 * drifting backgrounds) is computed in closed form from the frame index.
 */
export interface Scene {
  /** width * height * 4 bytes, RGBA. The buffer may be reused by the next call. */
  drawFrame(frameIndex: number): Uint8Array | Buffer
  dispose(): void
}

export interface Segment {
  index: number
  startFrame: number
  /** Exclusive. */
  endFrame: number
}
