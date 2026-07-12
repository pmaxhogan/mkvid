import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const pExecFile = promisify(execFile)

export async function probeAudio(ffprobePath: string, file: string): Promise<{ codec: string; duration: number }> {
  const { stdout } = await pExecFile(ffprobePath, [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', '-i', file,
  ])
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  const codec = lines[0] || ''
  const duration = Number(lines[1] || 0)
  if (!(duration > 0)) throw new Error(`could not read duration from ${file}`)
  return { codec, duration }
}
