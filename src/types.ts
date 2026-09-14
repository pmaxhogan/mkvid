export type WaveStyle = 'static' | 'waves'
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
 * Where a job came from, when not the web UI. `tracked` jobs are sets the
 * tracked Worker queued (no YouTube recording on 1001tracklists, but a
 * SoundCloud / hearthis.at one); their outcome is reported back to it.
 */
export interface JobMeta {
  origin: 'tracked'
  /** tracked's mkvid_requests.id */
  requestId: string
  /** The 1001tracklists set page — goes in the video description. */
  setUrl: string
  /** The recording as tracked found it (the yt-dlp URL may differ after resolution). */
  sourceUrl: string
  /** Last cue on the tracklist; a recording shorter than this is a clip, not the set. */
  lastCueSeconds: number | null
  artistName: string | null
  /** Set once the outcome has been delivered to tracked (survives restarts). */
  reported?: boolean
}

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
