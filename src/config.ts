import type { Privacy } from './types.js'

export interface Config {
  port: number
  dataDir: string
  size: string
  defaultPrivacy: Privacy
  youtubeCategoryId: string
  youtubePlaylistId: string
  cfAccess: { teamDomain: string; aud: string; allowedEmails: string[]; devBypass: boolean }
  google: { clientId: string; clientSecret: string; redirectBase: string }
  vapid: { publicKey: string; privateKey: string; subject: string } | null
  ffmpegPath: string
  ffprobePath: string
  ytdlpPath: string
  ffmpegAutoUpdate: boolean
}

function truthy(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'yes'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const devBypass = truthy(env.DEV_BYPASS_CF_ACCESS)
  const dataDir = env.DATA_DIR || './data'
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
      redirectBase: (env.OAUTH_REDIRECT_BASE || `http://localhost:${env.PORT || 8080}`).replace(/\/$/, ''),
    },
    vapid: vapidPub && vapidPriv
      ? { publicKey: vapidPub, privateKey: vapidPriv, subject: env.VAPID_SUBJECT || 'mailto:pmaxhogan@gmail.com' }
      : null,
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH || 'ffprobe',
    ytdlpPath: env.YTDLP_PATH || 'yt-dlp',
    ffmpegAutoUpdate: env.FFMPEG_AUTOUPDATE ? truthy(env.FFMPEG_AUTOUPDATE) : false,
  }
}
