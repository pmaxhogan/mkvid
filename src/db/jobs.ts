import type Database from 'better-sqlite3'
import type { Job, JobStatus, Privacy, WaveStyle } from '../types.js'

const RUNNING: JobStatus[] = ['downloading', 'transcoding', 'uploading', 'queued']

function row(r: any): Job {
  return {
    id: r.id, url: r.url, title: r.title, status: r.status, privacy: r.privacy,
    style: r.style, videoId: r.video_id, videoUrl: r.video_url, error: r.error,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

export function makeJobsRepo(db: Database.Database) {
  const now = () => Date.now()
  return {
    create(input: { id: string; url: string; title: string | null; privacy: Privacy; style: WaveStyle }): Job {
      const t = now()
      db.prepare(`INSERT INTO jobs (id,url,title,status,privacy,style,created_at,updated_at)
        VALUES (@id,@url,@title,'queued',@privacy,@style,@t,@t)`).run({ ...input, t })
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
    setResult(id: string, videoId: string, videoUrl: string) {
      db.prepare('UPDATE jobs SET video_id=@v, video_url=@u, updated_at=@t WHERE id=@id')
        .run({ id, v: videoId, u: videoUrl, t: now() })
    },
    setTitle(id: string, title: string) {
      db.prepare('UPDATE jobs SET title=@ti, updated_at=@t WHERE id=@id').run({ id, ti: title, t: now() })
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
