import { createReadStream, statSync } from 'node:fs'
import { Transform } from 'node:stream'
import { google } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import type { Privacy } from '../types.js'

export async function uploadVideo(
  opts: { accessToken: string; filePath: string; title: string; description: string; privacy: Privacy; categoryId: string },
  onProgress: (percent: number) => void,
): Promise<{ videoId: string; videoUrl: string }> {
  const auth = new OAuth2Client()
  auth.setCredentials({ access_token: opts.accessToken })
  // Cast: see note in google-oauth.ts's makeOAuthClient — googleapis-common
  // pins its own nested google-auth-library version distinct from the
  // top-level install this file imports OAuth2Client from, so the two
  // OAuth2Client classes are structurally (but not runtime-) incompatible.
  const yt = google.youtube({ version: 'v3', auth: auth as any })
  const total = statSync(opts.filePath).size
  // gaxios (googleapis v173's HTTP layer) is fetch-based and its `onUploadProgress`
  // option is deprecated/ignored, so progress is tracked manually by counting bytes
  // as they flow through a pass-through Transform stream piped in front of the upload.
  let bytesRead = 0
  const progressTracker = new Transform({
    transform(chunk, _enc, callback) {
      bytesRead += chunk.length
      onProgress(total > 0 ? Math.min(100, (bytesRead / total) * 100) : -1)
      callback(null, chunk)
    },
  })
  const body = createReadStream(opts.filePath).pipe(progressTracker)
  const res = await yt.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: { title: opts.title.slice(0, 100), description: opts.description, categoryId: opts.categoryId },
      status: { privacyStatus: opts.privacy, selfDeclaredMadeForKids: false },
    },
    media: { body },
  })
  const videoId = res.data.id
  if (!videoId) throw new Error('youtube: no video id returned')
  return { videoId, videoUrl: `https://youtu.be/${videoId}` }
}
