import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function openDb(file: string): Database.Database {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      access_token TEXT, refresh_token TEXT, expires_at INTEGER,
      scope TEXT, channel_id TEXT, channel_title TEXT, connected_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT,
      status TEXT NOT NULL, privacy TEXT NOT NULL, style TEXT NOT NULL,
      video_id TEXT, video_url TEXT, error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS job_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL, ts INTEGER NOT NULL, line TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY, endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER
    );
  `)
  // One token row per upload account. Databases from before accounts existed
  // hold the primary's tokens in oauth_tokens (id = 1): copy them across once
  // (a kv marker, so a later disconnect is not undone by the next boot) and
  // leave the old table alone — harmless, and a rollback still finds it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_accounts (
      account TEXT PRIMARY KEY,
      access_token TEXT, refresh_token TEXT, expires_at INTEGER,
      scope TEXT, channel_id TEXT, channel_title TEXT, connected_at INTEGER
    );
  `)
  const copied = db.prepare("INSERT OR IGNORE INTO kv (key, value, expires_at) VALUES ('migration:oauth_accounts', '1', NULL)").run()
  if (copied.changes > 0) {
    db.exec(`INSERT OR IGNORE INTO oauth_accounts (account, access_token, refresh_token, expires_at, scope, channel_id, channel_title, connected_at)
      SELECT 'primary', access_token, refresh_token, expires_at, scope, channel_id, channel_title, connected_at FROM oauth_tokens WHERE id = 1`)
  }
  // Additive column migrations for databases created before these existed.
  addColumn(db, 'jobs', 'meta', 'TEXT')                // JSON JobMeta (origin: tracked …)
  addColumn(db, 'jobs', 'privacy_applied', 'TEXT')     // privacyStatus YouTube actually set
}

function addColumn(db: Database.Database, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
}
