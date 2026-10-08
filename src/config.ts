import { clampWorkers, defaultWorkerCount } from './lib/cpu.js'
import { join } from 'node:path'
import { WAVE_STYLES, type Privacy, type WaveStyle } from './types.js'

export interface Config {
  port: number
  dataDir: string
  size: string
  defaultPrivacy: Privacy
  youtubeCategoryId: string
  youtubePlaylistId: string
  cfAccess: { teamDomain: string; aud: string; allowedEmails: string[]; devBypass: boolean }
  google: { clientId: string; clientSecret: string; redirectBase: string }
  /**
   * A second OAuth client, in the tracked sync's Google project, for uploads
   * tracked hands out on the `shared` account once mkvid's own project has
   * used its YouTube quota day. Null (SHARED_GOOGLE_OAUTH_CLIENT_* unset) =
   * mkvid only ever offers the primary.
   */
  googleShared: { clientId: string; clientSecret: string; redirectBase: string } | null
  vapid: { publicKey: string; privateKey: string; subject: string } | null
  ffmpegPath: string
  ffprobePath: string
  ytdlpPath: string
  ffmpegAutoUpdate: boolean
  /**
   * The tracked Worker's mkvid queue (null = not configured, nothing is
   * polled). `token` is tracked's MKVID_TOKEN; `privacy` is what queued sets
   * are uploaded as (unlisted by default — tracked adds them to playlists).
   */
  tracked: { url: string; token: string; pollSeconds: number; privacy: Privacy; style: WaveStyle } | null
  /**
   * The `scene` style (src/viz). `workers` drawing threads (default usable cores - 2, never more than
   * the usable cores: src/lib/cpu),
   * `encodeSessions` segment encodes at a time (= concurrent NVENC sessions;
   * consumer cards allow only a few), `segmentSeconds` per resumable segment.
   */
  viz: {
    size: string; fps: number; workers: number; encodeSessions: number; segmentSeconds: number
    /** Downloaded track artwork, shared by all jobs and kept across restarts. */
    artworkCacheDir: string
    /** A job resumed this many times in a row without finishing a new segment is marked interrupted instead (a crash loop guard). */
    maxResumes: number
    /** A failed render is retried this many times (resuming from finished segments) before the job fails. */
    renderRetries: number
    /** Wait between those retries. */
    retryDelaySeconds: number
    /** A scene render refuses to start (retryably) with less free space than this on the data volume. 0 = no check. */
    minFreeGb: number
    /** The work dir of a failed scene job (audio, segments, out.mp4) is kept this long for a retry... */
    keepHours: number
    /** ...and only while all kept work dirs together stay under this size (oldest go first). */
    keepGb: number
  }
}

function positiveInt(v: string | undefined, fallback: number): number {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

function nonNegative(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function truthy(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'yes'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const devBypass = truthy(env.DEV_BYPASS_CF_ACCESS)
  const dataDir = env.DATA_DIR || './data'
  const redirectBase = (env.OAUTH_REDIRECT_BASE || `http://localhost:${env.PORT || 8080}`).replace(/\/$/, '')
  const vapidPub = env.VAPID_PUBLIC_KEY
  const vapidPriv = env.VAPID_PRIVATE_KEY
  return {
    port: Number(env.PORT || 8080),
    dataDir,
    size: env.MKVID_SIZE || '1280x720',
    defaultPrivacy: (env.DEFAULT_PRIVACY as Privacy) || 'private',
    youtubeCategoryId: env.YOUTUBE_CATEGORY_ID || '10',
    youtubePlaylistId: env.YOUTUBE_PLAYLIST_ID || '',
    cfAccess: {
      teamDomain: env.CF_ACCESS_TEAM_DOMAIN || '',
      aud: env.CF_ACCESS_AUD || '',
      allowedEmails: (env.CF_ACCESS_ALLOWED_EMAILS || '')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
      devBypass,
    },
    google: {
      clientId: env.GOOGLE_OAUTH_CLIENT_ID || '',
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET || '',
      redirectBase,
    },
    googleShared: env.SHARED_GOOGLE_OAUTH_CLIENT_ID && env.SHARED_GOOGLE_OAUTH_CLIENT_SECRET
      ? { clientId: env.SHARED_GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.SHARED_GOOGLE_OAUTH_CLIENT_SECRET, redirectBase }
      : null,
    vapid: vapidPub && vapidPriv
      ? { publicKey: vapidPub, privateKey: vapidPriv, subject: env.VAPID_SUBJECT || 'mailto:pmaxhogan@gmail.com' }
      : null,
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH || 'ffprobe',
    ytdlpPath: env.YTDLP_PATH || 'yt-dlp',
    ffmpegAutoUpdate: env.FFMPEG_AUTOUPDATE ? truthy(env.FFMPEG_AUTOUPDATE) : false,
    tracked: env.TRACKED_URL && env.TRACKED_TOKEN
      ? {
          url: env.TRACKED_URL.replace(/\/$/, ''),
          token: env.TRACKED_TOKEN,
          pollSeconds: Math.max(15, Number(env.TRACKED_POLL_SECONDS) || 60),
          privacy: (env.TRACKED_PRIVACY as Privacy) || 'unlisted',
          // static until switched: the scene style changes what tracked's videos look like.
          style: WAVE_STYLES.includes(env.TRACKED_STYLE as WaveStyle) ? env.TRACKED_STYLE as WaveStyle : 'static',
        }
      : null,
    viz: {
      size: /^\d+x\d+$/.test(env.VIZ_SIZE || '') ? env.VIZ_SIZE! : '1920x1080',
      fps: positiveInt(env.VIZ_FPS, 30),
      workers: clampWorkers(positiveInt(env.VIZ_WORKERS, defaultWorkerCount())),
      encodeSessions: positiveInt(env.VIZ_ENCODE_SESSIONS, 2),
      segmentSeconds: positiveInt(env.VIZ_SEGMENT_SECONDS, 60),
      artworkCacheDir: join(dataDir, 'cache', 'artwork'),
      maxResumes: positiveInt(env.VIZ_MAX_RESUMES, 3),
      renderRetries: Math.floor(nonNegative(env.VIZ_RENDER_RETRIES, 2)),
      retryDelaySeconds: nonNegative(env.VIZ_RETRY_DELAY_SECONDS, 60),
      minFreeGb: nonNegative(env.VIZ_MIN_FREE_GB, 80),
      keepHours: nonNegative(env.VIZ_KEEP_HOURS, 72),
      keepGb: nonNegative(env.VIZ_KEEP_GB, 200),
    },
  }
}
