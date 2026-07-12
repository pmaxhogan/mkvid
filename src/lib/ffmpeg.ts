import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { WaveStyle, WaveMode } from '../types.js'

const ENC = {
  nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '28'],
  x264: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'],
} as const

let nvencDisabled = false
export function isNvencDisabled(): boolean { return nvencDisabled }
export function markNvencDisabled(): void { nvencDisabled = true }

export function chooseFps(style: WaveStyle, width: number, durSec: number, requested?: number): number {
  if (requested && requested > 0) return requested
  if (style === 'static') return Math.min(10, Math.max(1, Math.round(width / durSec)))
  return 5
}

export function chooseAudioArgs(codec: string): string[] {
  return ['aac', 'mp3', 'alac'].includes(codec.trim()) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']
}

export function buildWavePicArgs(input: string, size: string, outPng: string): string[] {
  // `-update 1` is required by ffmpeg 7.x's image2 muxer to write a single PNG to a
  // fixed (non-pattern) filename; without it newer builds warn/refuse.
  return ['-nostdin', '-hide_banner', '-loglevel', 'warning', '-y',
    '-i', input, '-filter_complex', `showwavespic=s=${size}:colors=cyan`, '-frames:v', '1', '-update', '1', outPng]
}

export interface RenderArgs {
  style: WaveStyle; mode: WaveMode; size: string; fps: number; durSec: number
  audioInput: string; wavePng?: string; encoder: 'nvenc' | 'x264'; audioArgs: string[]; outFile: string
}

export function buildRenderArgs(a: RenderArgs): string[] {
  const [, height] = a.size.split('x')
  const base = ['-nostdin', '-hide_banner', '-loglevel', 'warning', '-y', '-progress', 'pipe:1', '-nostats']
  let inputArgs: string[]; let filter: string; let mapArgs: string[]; let gop: string[]
  if (a.style === 'static') {
    if (!a.wavePng) throw new Error('static render requires wavePng')
    const durText = a.durSec.toFixed(3)
    inputArgs = ['-loop', '1', '-framerate', String(a.fps), '-i', a.wavePng,
      '-f', 'lavfi', '-i', `color=red:s=4x${height}:r=${a.fps}`, '-i', a.audioInput]
    filter = `[0:v][1:v]overlay=x='(main_w-overlay_w)*t/${durText}':y=0,format=yuv420p[v]`
    mapArgs = ['-map', '[v]', '-map', '2:a', '-shortest']
    gop = ['-g', String(Math.max(1, a.fps * 5))]
  } else {
    inputArgs = ['-i', a.audioInput]
    filter = `[0:a]showwaves=s=${a.size}:mode=${a.mode}:rate=${a.fps},format=yuv420p[v]`
    mapArgs = ['-map', '[v]', '-map', '0:a']
    gop = []
  }
  return [...base, ...inputArgs, '-filter_complex', filter, ...mapArgs, ...ENC[a.encoder], ...gop, ...a.audioArgs, a.outFile]
}

function runFfmpegProc(
  ffmpegPath: string, args: string[], durSec: number,
  onProgress: (p: number) => void, onLog: (l: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    let buf = ''
    p.stdout.on('data', (d) => {
      buf += d.toString()
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1)
        const m = line.match(/^out_time_us=(\d+)/)
        if (m && durSec > 0) onProgress(Math.min(100, (Number(m[1]) / 1e6 / durSec) * 100))
      }
    })
    p.stderr.on('data', (d) => { const s = d.toString(); stderr += s; s.split('\n').forEach((l: string) => { if (l.trim()) onLog(l.trim()) }) })
    p.on('error', reject)
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-2000)}`)))
  })
}

export async function renderVideo(
  opts: {
    ffmpegPath: string; style: WaveStyle; mode: WaveMode; size: string; fps: number; durSec: number
    audioInput: string; audioArgs: string[]; outFile: string; workDir: string; cpu: boolean
  },
  onProgress: (percent: number) => void, onLog: (line: string) => void,
): Promise<void> {
  let wavePng: string | undefined
  if (opts.style === 'static') {
    wavePng = join(opts.workDir, 'wave.png')
    await runFfmpegProc(opts.ffmpegPath, buildWavePicArgs(opts.audioInput, opts.size, wavePng), 0, () => {}, onLog)
  }
  const encoders: ('nvenc' | 'x264')[] = opts.cpu || isNvencDisabled() ? ['x264'] : ['nvenc', 'x264']
  for (let i = 0; i < encoders.length; i++) {
    const encoder = encoders[i]
    try {
      const args = buildRenderArgs({ ...opts, wavePng, encoder })
      await runFfmpegProc(opts.ffmpegPath, args, opts.durSec, onProgress, onLog)
      return
    } catch (e) {
      if (encoder === 'nvenc' && i < encoders.length - 1) {
        markNvencDisabled(); onLog('mkvid: h264_nvenc did not open, falling back to libx264'); continue
      }
      throw e
    }
  }
}
