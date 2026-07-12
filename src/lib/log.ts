type Level = 'info' | 'warn' | 'error'
export function log(level: Level, msg: string, extra?: Record<string, unknown>): void {
  const rec = { ts: new Date().toISOString(), level, msg, ...extra }
  const line = JSON.stringify(rec)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}
