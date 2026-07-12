import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AppContext } from '../context.js'
import type { SseMessage } from '../types.js'
import { downloadAudio } from './ytdlp.js'
import { probeAudio } from './probe.js'
import { chooseFps, chooseAudioArgs, renderVideo } from './ffmpeg.js'
import { getValidAccessToken } from './google-oauth.js'
import { uploadVideo, addToPlaylist } from './youtube.js'
import { sendPush } from './push.js'
import { log } from './log.js'

export async function runJob(ctx: AppContext, jobId: string): Promise<void> {
  const { jobs, config, hub } = ctx
  const job = jobs.get(jobId)
  if (!job) return
  const workDir = join(config.dataDir, 'work', jobId)
  mkdirSync(workDir, { recursive: true })

  const emit = (m: SseMessage) => hub.publish(jobId, m)
  const logLine = (line: string) => { jobs.appendLog(jobId, line); emit({ type: 'log', line }) }
  const setStatus = (status: SseMessage['status']) => { jobs.setStatus(jobId, status!); emit({ type: 'status', status }) }

  try {
    // 1. download
    setStatus('downloading')
    const { file, title } = await downloadAudio(
      { ytdlpPath: config.ytdlpPath, url: job.url, workDir },
      (p) => emit({ type: 'progress', phase: 'download', percent: p }), logLine,
    )
    const finalTitle = job.title || title
    jobs.setTitle(jobId, finalTitle)

    // 2. probe
    const { codec, duration } = await probeAudio(config.ffprobePath, file)
    const width = Number(config.size.split('x')[0])
    const fps = chooseFps(job.style, width, duration)

    // 3. render
    setStatus('transcoding')
    const outFile = join(workDir, 'out.mp4')
    await renderVideo(
      {
        ffmpegPath: config.ffmpegPath, style: job.style, mode: 'line', size: config.size,
        fps, durSec: duration, audioInput: file, audioArgs: chooseAudioArgs(codec),
        outFile, workDir, cpu: false,
      },
      (p) => emit({ type: 'progress', phase: 'transcode', percent: p }), logLine,
    )

    // 4. upload
    setStatus('uploading')
    const accessToken = await getValidAccessToken(ctx.tokens, config.google)
    const { videoId, videoUrl } = await uploadVideo(
      {
        accessToken, filePath: outFile, title: finalTitle,
        description: `Uploaded by mkvid from ${job.url}`, privacy: job.privacy, categoryId: config.youtubeCategoryId,
      },
      (p) => emit({ type: 'progress', phase: 'upload', percent: p }),
    )
    jobs.setResult(jobId, videoId, videoUrl)
    // Best-effort: add the upload to the configured playlist. A failure here (e.g.
    // token lacks the playlist scope) must not fail an already-successful upload.
    if (config.youtubePlaylistId) {
      try {
        await addToPlaylist(accessToken, videoId, config.youtubePlaylistId)
        logLine(`added to playlist ${config.youtubePlaylistId}`)
      } catch (e: any) {
        logLine(`warning: could not add to playlist — ${String(e?.message || e).slice(0, 140)}`)
      }
    }
    setStatus('done')
    emit({ type: 'done', videoUrl })
    void sendPush(config.vapid, ctx.push.list(), { title: 'Upload complete', body: finalTitle, url: videoUrl },
      (endpoint) => ctx.push.removeByEndpoint(endpoint))
  } catch (e: any) {
    const msg = e?.message === 'reconnect_youtube' ? 'YouTube not connected — reconnect and retry.' : String(e?.message || e)
    jobs.setError(jobId, msg)
    emit({ type: 'error', error: msg })
    void sendPush(config.vapid, ctx.push.list(), { title: 'Upload failed', body: msg.slice(0, 120), url: '/' },
      (endpoint) => ctx.push.removeByEndpoint(endpoint))
    log('error', 'pipeline failed', { jobId, err: msg })
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}
