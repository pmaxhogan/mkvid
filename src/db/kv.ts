import type Database from 'better-sqlite3'
import type { KVCache } from '../types.js'

export function makeKvCache(db: Database.Database): KVCache {
  return {
    get(key: string): string | null {
      const r = db.prepare('SELECT value, expires_at FROM kv WHERE key=?').get(key) as any
      if (!r) return null
      if (r.expires_at != null && r.expires_at < Date.now()) {
        db.prepare('DELETE FROM kv WHERE key=?').run(key)
        return null
      }
      return r.value
    },
    set(key: string, value: string, ttlSeconds: number) {
      const exp = Date.now() + ttlSeconds * 1000
      db.prepare(`INSERT INTO kv (key, value, expires_at) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at`)
        .run(key, value, exp)
    },
  }
}
