import { spawn } from 'node:child_process'
import type { Config } from '../config.js'
import { log } from './log.js'

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'ignore' })
    p.on('error', () => resolve(-1)); p.on('close', (code) => resolve(code ?? -1))
  })
}

async function updateOnce(config: Config): Promise<void> {
  // yt-dlp self-update (binary installed in $DATA_DIR/bin by entrypoint)
  const code = await run(config.ytdlpPath, ['-U'])
  log(code === 0 ? 'info' : 'warn', 'yt-dlp self-update', { code })
  // ffmpeg refresh is handled by the entrypoint on boot (static build fetch); nothing to do here at runtime.
}

export function startUpdater(config: Config): void {
  void updateOnce(config).catch((e) => log('warn', 'updater failed', { err: String(e) }))
  setInterval(() => { void updateOnce(config).catch(() => {}) }, 24 * 60 * 60 * 1000)
}
