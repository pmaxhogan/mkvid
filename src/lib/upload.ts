import { basename, extname } from 'node:path'

// Job.url marker for direct uploads (vs. a real URL handed to yt-dlp).
export const UPLOAD_PREFIX = 'upload://'

export const MAX_UPLOAD_BYTES = 300 * 1024 * 1024

// Containers ffmpeg decodes that plausibly hold audio. .webm/.mp4/.m4a can be
// audio-only; ffprobe rejects anything that isn't decodable audio downstream.
const AUDIO_EXTS = new Set([
  '.mp3', '.wav', '.flac', '.m4a', '.m4b', '.aac', '.ogg', '.oga', '.opus',
  '.wma', '.aiff', '.aif', '.mka', '.webm', '.mp4', '.ac3', '.amr', '.ape', '.wv',
])

export function isAllowedAudioExt(filename: string): boolean {
  return AUDIO_EXTS.has(extname(filename).toLowerCase())
}

// Reduce a client-supplied filename to a safe basename we can write into the
// work dir and embed in the upload:// marker. Keeps the extension intact.
export function sanitizeUploadName(name: string): string {
  const base = basename(name.replace(/\\/g, '/'))
  const ext = extname(base).toLowerCase()
  let stem = basename(base, extname(base))
    .replace(/[^\w.\- ()\[\]&,']+/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 120)
  if (!stem) stem = 'audio'
  const out = stem + ext
  // Never collide with the pipeline's own render artifacts in the work dir.
  return out === 'out.mp4' || out === 'wave.png' ? 'upload-' + out : out
}
