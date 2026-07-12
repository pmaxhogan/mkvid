import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { PushSubscriptionRecord } from '../types.js'

export function makePushRepo(db: Database.Database) {
  return {
    add(sub: { endpoint: string; p256dh: string; auth: string }) {
      db.prepare(`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, created_at)
        VALUES (@id,@e,@p,@a,@t)
        ON CONFLICT(endpoint) DO UPDATE SET p256dh=@p, auth=@a`)
        .run({ id: randomUUID(), e: sub.endpoint, p: sub.p256dh, a: sub.auth, t: Date.now() })
    },
    list(): PushSubscriptionRecord[] {
      return (db.prepare('SELECT * FROM push_subscriptions').all() as any[]).map((r) => ({
        id: r.id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, createdAt: r.created_at,
      }))
    },
    removeByEndpoint(endpoint: string) {
      db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(endpoint)
    },
  }
}
