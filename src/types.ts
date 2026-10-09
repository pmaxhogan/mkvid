/**
 * `scene`: the frame-by-frame visualizer in src/viz (artwork, track names,
 * spectrum); the others are single ffmpeg graphs. `track` is the single-track
 * visualizer of tracked's track uploads (src/lib/track-render.ts): only those
 * jobs use it, never a set or a job from the web UI.
 */
export type WaveStyle = 'static' | 'waves' | 'scene' | 'track'
/** The styles a set (TRACKED_STYLE) or a web UI job may use. */
export const WAVE_STYLES: readonly WaveStyle[] = ['static', 'waves', 'scene']
export type WaveMode = 'line' | 'p2p' | 'cline' | 'point'
export type Privacy = 'private' | 'unlisted' | 'public'
export type JobStatus =
  | 'queued' | 'downloading' | 'transcoding' | 'uploading'
  | 'done' | 'failed' | 'interrupted'

export interface JobInput {
  url: string
  title?: string
  privacy?: Privacy
  style?: WaveStyle
  mode?: WaveMode
  fps?: number
  size?: string
  cpu?: boolean
}

/**
 * Which Google Cloud project's OAuth client an upload goes through. `primary`
 * is mkvid's own (GOOGLE_OAUTH_CLIENT_*), `shared` the tracked sync's
 * (SHARED_GOOGLE_OAUTH_CLIENT_*) — same YouTube channel, separate API quota.
 */
export type UploadAccount = 'primary' | 'shared'
export const UPLOAD_ACCOUNTS: readonly UploadAccount[] = ['primary', 'shared']

/** One entry of tracked's track list, on the wire. */
export interface TrackedTrack {
  cueSeconds: number | null
  artist: string | null
  title: string | null
  artworkUrl: string | null
  isId: boolean
  /** Plays on top of the preceding non-layered track (a "w/" row); absent = false. */
  layered?: boolean
}

/**
 * Where a job came from, when not the web UI (null meta = the web UI). Both
 * kinds come from the tracked Worker and their outcome is reported back to it,
 * each through its own endpoints:
 * - `tracked`: a set tracked queued (no YouTube recording on 1001tracklists,
 *   but a SoundCloud / hearthis.at one) — `/mkvid/*`;
 * - `tracked-track`: one pre-saved track with no YouTube link but a link
 *   yt-dlp can rip — `/mkvid/track/*` (lib/tracked.ts pollTrackUploads).
 * Narrow on `origin` before touching anything kind-specific.
 */
export type JobMeta = TrackedSetMeta | TrackedTrackMeta

interface TrackedMetaBase {
  /** The account tracked handed this request out for (absent on jobs from before accounts existed = primary). */
  account?: UploadAccount
  /** The recording as tracked found it (the yt-dlp URL may differ after resolution). */
  sourceUrl: string
  /**
   * The recording's page as yt-dlp named it (`webpage_url`): a link a
   * listener can open (`soundcloud.com/<user>/<track>`) where sourceUrl is an
   * API URL. Recorded at download; absent on jobs from before.
   */
  recordingUrl?: string
  /** Set once the outcome has been delivered to tracked (survives restarts). */
  reported?: boolean
}

export interface TrackedSetMeta extends TrackedMetaBase {
  origin: 'tracked'
  /** tracked's mkvid_requests.id */
  requestId: string
  /** The 1001tracklists set page — goes in the video description. */
  setUrl: string
  /** Last cue on the tracklist; a recording shorter than this is a clip, not the set. */
  lastCueSeconds: number | null
  artistName: string | null
  /** The set's track list as tracked's claim delivered it (absent from Workers that do not send it). */
  tracks?: TrackedTrack[]
  /** true = verified (two fetches by different accounts agreed). A scene job renders nothing else. */
  tracksTrusted?: boolean
  /** Number of tracks on the tracklist, as tracked counted them. */
  trackCount?: number | null
}

/** A track upload (tracked's track_uploads row), rendered with the `track` style. */
export interface TrackedTrackMeta extends TrackedMetaBase {
  origin: 'tracked-track'
  /** tracked's track_uploads.id (an integer there), sent back as received. */
  trackRequestId: number
  presaveId: number | null
  /** The site the rip comes from (soundcloud, bandcamp, ...), as tracked named it. */
  sourceName: string | null
  /** The track's length as 1001tracklists' players know it; a much shorter rip is a preview clip. */
  expectedDurationSeconds: number | null
  /** The rip must be at least expected x this long (else `preview_clip`, permanent). */
  minDurationRatio: number
  artist: string | null
  title: string | null
  artworkUrl: string | null
  /** The 1001tracklists track page, absolute (null when tracked has none). */
  trackUrl: string | null
}

/** A job whose meta is a tracked set / a tracked track upload. */
export type SetJob = Job & { meta: TrackedSetMeta }
export type TrackJob = Job & { meta: TrackedTrackMeta }
export function isSetJob(j: Job): j is SetJob { return j.meta?.origin === 'tracked' }
export function isTrackJob(j: Job): j is TrackJob { return j.meta?.origin === 'tracked-track' }

export interface Job {
  id: string
  url: string
  title: string | null
  status: JobStatus
  privacy: Privacy
  /** What YouTube actually applied (an unverified OAuth app can force private). */
  privacyApplied: Privacy | null
  style: WaveStyle
  videoId: string | null
  videoUrl: string | null
  /** The visual style the uploaded video was made with (null = no upload yet; pre-existing uploads were backfilled as static). */
  uploadStyle: WaveStyle | null
  /** When mkvid deleted the uploaded video from YouTube (tracked's "Delete and recreate"); null = still up. */
  videoDeletedAt: number | null
  error: string | null
  meta: JobMeta | null
  createdAt: number
  updatedAt: number
}

export type ProgressPhase = 'download' | 'transcode' | 'upload'
export interface SseMessage {
  type: 'progress' | 'log' | 'status' | 'done' | 'error'
  phase?: ProgressPhase
  percent?: number      // 0..100, or -1 unknown
  status?: JobStatus
  line?: string
  videoUrl?: string
  error?: string
}

export interface StoredTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number     // epoch ms
  scope: string
  channelId?: string
  channelTitle?: string
  connectedAt: number
}

export interface KVCache {
  get(key: string): string | null
  set(key: string, value: string, ttlSeconds: number): void
}

export interface TokenStore {
  load(): StoredTokens | null
  save(t: StoredTokens): void
  clear(): void
}

export interface PushSubscriptionRecord {
  id: string
  endpoint: string
  p256dh: string
  auth: string
  createdAt: number
}
