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
    uploadStyle: (r.upload_style as WaveStyle | null) ?? null,
    videoDeletedAt: r.video_deleted_at ?? null,
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
    /** Every job the queue is working on (downloading, rendering or uploading), oldest first. */
    runningAll(): Job[] {
      return (db.prepare("SELECT * FROM jobs WHERE status IN ('downloading','transcoding','uploading') ORDER BY created_at ASC").all() as any[]).map(row)
    },
    /**
     * For the progress view: the render's own log lines plus the lines that
     * start a new attempt (newest 400, oldest first; describeProgress cuts at
     * the last attempt boundary), and the newest yt-dlp download line.
     */
    progressLogs(id: string): { viz: string[]; download: string | null } {
      const viz = (db.prepare(`SELECT line FROM job_logs WHERE job_id=? AND (line LIKE 'viz:%' OR line LIKE 'render failed:%'
        OR line LIKE 'resuming after a restart%' OR line = 'retry requested' OR line LIKE 'reusing the kept work%') ORDER BY id DESC LIMIT 400`)
        .all(id) as any[]).map((r) => r.line).reverse()
      const d = db.prepare("SELECT line FROM job_logs WHERE job_id=? AND line LIKE '[download]%' ORDER BY id DESC LIMIT 1").get(id) as any
      return { viz, download: d ? d.line : null }
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
    /** Records the upload; `style` = the visual style the uploaded video was made with. */
    setResult(id: string, videoId: string, videoUrl: string, privacyApplied: Privacy | null = null, style: WaveStyle | null = null) {
      db.prepare('UPDATE jobs SET video_id=@v, video_url=@u, privacy_applied=@p, upload_style=COALESCE(@s, style), updated_at=@t WHERE id=@id')
        .run({ id, v: videoId, u: videoUrl, p: privacyApplied, s: style, t: now() })
    },
    /** Every job that recorded this YouTube video as its upload (normally one), newest first. */
    findByVideoId(videoId: string): Job[] {
      return (db.prepare('SELECT * FROM jobs WHERE video_id=? ORDER BY created_at DESC').all(videoId) as any[]).map(row)
    },
    markVideoDeleted(id: string) {
      db.prepare('UPDATE jobs SET video_deleted_at=@d, updated_at=@t WHERE id=@id').run({ id, d: now(), t: now() })
    },
    /**
     * tracked uploads still on YouTube whose description the backfill has not
     * brought up to date yet, oldest first. `shared` = uploaded through the
     * shared account; everything else went through the primary.
     */
    descriptionBackfillPending(account: 'primary' | 'shared'): Job[] {
      return (db.prepare(`SELECT * FROM jobs WHERE status='done' AND video_id IS NOT NULL AND video_deleted_at IS NULL
        AND description_synced_at IS NULL AND meta IS NOT NULL AND json_extract(meta, '$.origin')='tracked'
        AND (CASE WHEN json_extract(meta, '$.account')='shared' THEN 'shared' ELSE 'primary' END)=?
        ORDER BY created_at ASC`).all(account) as any[]).map(row)
    },
    markDescriptionSynced(id: string) {
      db.prepare('UPDATE jobs SET description_synced_at=@d WHERE id=@id').run({ id, d: now() })
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
    /** tracked jobs queued or running here, oldest first. */
    inFlightTracked(): Job[] {
      const ph = RUNNING.map(() => '?').join(',')
      return (db.prepare(`SELECT * FROM jobs WHERE meta IS NOT NULL AND status IN (${ph}) ORDER BY created_at ASC`).all(...RUNNING) as any[])
        .map(row)
        .filter((j) => j.meta?.origin === 'tracked')
    },
    listUnreportedTracked(): Job[] {
      const finals: JobStatus[] = ['done', 'failed', 'interrupted']
      const ph = finals.map(() => '?').join(',')
      return (db.prepare(`SELECT * FROM jobs WHERE meta IS NOT NULL AND status IN (${ph}) ORDER BY created_at ASC`).all(...finals) as any[])
        .map(row)
        .filter((j) => j.meta?.origin === 'tracked' && !j.meta.reported)
    },
    /** Back to `queued` for a retry: the error is cleared, the video (none, for a failed job) kept. */
    requeue(id: string) {
      db.prepare("UPDATE jobs SET status='queued', error=NULL, updated_at=@t WHERE id=@id").run({ id, t: now() })
    },
    /** Failed scene jobs for one tracked request, newest first (their kept work can be adopted by a new claim). */
    failedSceneJobsForRequest(requestId: string, excludeId: string): Job[] {
      return (db.prepare(`SELECT * FROM jobs WHERE status='failed' AND style='scene' AND id<>? AND meta IS NOT NULL
        AND json_extract(meta, '$.requestId')=? ORDER BY created_at DESC`).all(excludeId, requestId) as any[]).map(row)
    },
    appendLog(id: string, line: string) {
      db.prepare('INSERT INTO job_logs (job_id, ts, line) VALUES (?,?,?)').run(id, now(), line)
    },
    getLogs(id: string, limit: number): string[] {
      return (db.prepare('SELECT line FROM job_logs WHERE job_id=? ORDER BY id ASC LIMIT ?')
        .all(id, limit) as any[]).map((r) => r.line)
    },
    markRunningInterrupted() {
      this.recoverAfterRestart()
    },
    /**
     * Boot-time recovery: every job caught mid-run becomes `interrupted`,
     * except those `resume` accepts (scene jobs mid-render whose work dir is
     * kept), which go back to `queued`. Returns the resumed ids, oldest
     * first, for the caller to enqueue.
     */
    recoverAfterRestart(resume: (job: Job) => boolean = () => false): string[] {
      const ph = RUNNING.map(() => '?').join(',')
      const found = (db.prepare(`SELECT * FROM jobs WHERE status IN (${ph}) ORDER BY created_at ASC`).all(...RUNNING) as any[]).map(row)
      const resumed: string[] = []
      const t = now()
      const set = db.prepare('UPDATE jobs SET status=@s, updated_at=@t WHERE id=@id')
      for (const job of found) {
        let again = false
        try { again = resume(job) } catch { again = false }
        set.run({ id: job.id, s: again ? 'queued' : 'interrupted', t })
        if (again) resumed.push(job.id)
      }
      return resumed
    },
  }
}
