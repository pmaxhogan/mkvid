import type Database from 'better-sqlite3'
import type { Job, JobMeta, JobStatus, Privacy, WaveStyle } from '../types.js'

const RUNNING: JobStatus[] = ['downloading', 'transcoding', 'uploading', 'queued']

function parseMeta(raw: unknown): JobMeta | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const m = JSON.parse(raw) as JobMeta
    return m && typeof m === 'object' && m.origin ? m : null
  } catch {
    return null
  }
}

function row(r: any): Job {
  return {
    id: r.id, url: r.url, title: r.title, status: r.status, privacy: r.privacy,
    privacyApplied: (r.privacy_applied as Privacy | null) ?? null,
    style: r.style, videoId: r.video_id, videoUrl: r.video_url, error: r.error,
    meta: parseMeta(r.meta),
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

export function makeJobsRepo(db: Database.Database) {
  const now = () => Date.now()
  return {
    create(input: { id: string; url: string; title: string | null; privacy: Privacy; style: WaveStyle; meta?: JobMeta | null }): Job {
      const t = now()
      db.prepare(`INSERT INTO jobs (id,url,title,status,privacy,style,meta,created_at,updated_at)
        VALUES (@id,@url,@title,'queued',@privacy,@style,@meta,@t,@t)`).run({
        id: input.id, url: input.url, title: input.title, privacy: input.privacy, style: input.style,
        meta: input.meta ? JSON.stringify(input.meta) : null, t,
      })
      return this.get(input.id)!
    },
    get(id: string): Job | null {
      const r = db.prepare('SELECT * FROM jobs WHERE id=?').get(id)
      return r ? row(r) : null
    },
    list(limit: number): Job[] {
      return (db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit) as any[]).map(row)
    },
    setStatus(id: string, status: JobStatus) {
      db.prepare('UPDATE jobs SET status=@s, updated_at=@t WHERE id=@id').run({ id, s: status, t: now() })
    },
    setError(id: string, error: string) {
      db.prepare("UPDATE jobs SET status='failed', error=@e, updated_at=@t WHERE id=@id").run({ id, e: error, t: now() })
    },
    setResult(id: string, videoId: string, videoUrl: string, privacyApplied: Privacy | null = null) {
      db.prepare('UPDATE jobs SET video_id=@v, video_url=@u, privacy_applied=@p, updated_at=@t WHERE id=@id')
        .run({ id, v: videoId, u: videoUrl, p: privacyApplied, t: now() })
    },
    setTitle(id: string, title: string) {
      db.prepare('UPDATE jobs SET title=@ti, updated_at=@t WHERE id=@id').run({ id, ti: title, t: now() })
    },
    setMeta(id: string, meta: JobMeta | null) {
      db.prepare('UPDATE jobs SET meta=@m, updated_at=@t WHERE id=@id').run({ id, m: meta ? JSON.stringify(meta) : null, t: now() })
    },
    /**
     * Jobs that came from tracked, have reached a final state, and whose
     * outcome has not been delivered yet — what the poller reports on every
     * tick until the Worker has acknowledged each one.
     */
    listUnreportedTracked(): Job[] {
      const finals: JobStatus[] = ['done', 'failed', 'interrupted']
      const ph = finals.map(() => '?').join(',')
      return (db.prepare(`SELECT * FROM jobs WHERE meta IS NOT NULL AND status IN (${ph}) ORDER BY created_at ASC`).all(...finals) as any[])
        .map(row)
        .filter((j) => j.meta?.origin === 'tracked' && !j.meta.reported)
    },
    appendLog(id: string, line: string) {
      db.prepare('INSERT INTO job_logs (job_id, ts, line) VALUES (?,?,?)').run(id, now(), line)
    },
    getLogs(id: string, limit: number): string[] {
      return (db.prepare('SELECT line FROM job_logs WHERE job_id=? ORDER BY id ASC LIMIT ?')
        .all(id, limit) as any[]).map((r) => r.line)
    },
    markRunningInterrupted() {
      const ph = RUNNING.map(() => '?').join(',')
      db.prepare(`UPDATE jobs SET status='interrupted', updated_at=? WHERE status IN (${ph})`).run(now(), ...RUNNING)
    },
  }
}
