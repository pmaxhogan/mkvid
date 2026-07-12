import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, basename, extname } from 'node:path'

export function parseDownloadPercent(line: string): number | null {
  const m = line.match(/\[download\]\s+([\d.]+)%/)
  return m ? Number(m[1]) : null
}

export function downloadAudio(
  opts: { ytdlpPath: string; url: string; workDir: string },
  onProgress: (p: number) => void, onLog: (l: string) => void,
): Promise<{ file: string; title: string }> {
  return new Promise((resolve, reject) => {
    const args = ['--no-playlist', '--newline', '-f', 'bestaudio/best',
      '-o', join(opts.workDir, '%(title)s.%(ext)s'), '--', opts.url]
    const p = spawn(opts.ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    const handle = (chunk: Buffer) => {
      chunk.toString().split('\n').forEach((line) => {
        const t = line.trim(); if (!t) return
        onLog(t)
        const pct = parseDownloadPercent(t); if (pct != null) onProgress(pct)
      })
    }
    p.stdout.on('data', handle)
    p.stderr.on('data', (c) => { err += c.toString(); handle(c) })
    p.on('error', reject)
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`yt-dlp exit ${code}: ${err.slice(-2000)}`))
      // Exclude our own render artifacts by exact name (they don't exist yet at
      // download time, but be safe) and yt-dlp partial files — not all .mp4, since
      // a non-SoundCloud `best` fallback can legitimately produce an .mp4 audio file.
      const files = readdirSync(opts.workDir)
        .filter((f) => f !== 'wave.png' && f !== 'out.mp4' && !f.endsWith('.part') && !f.endsWith('.ytdl'))
      if (files.length === 0) return reject(new Error('yt-dlp produced no audio file'))
      const file = join(opts.workDir, files[0])
      resolve({ file, title: basename(files[0], extname(files[0])) })
    })
  })
}
