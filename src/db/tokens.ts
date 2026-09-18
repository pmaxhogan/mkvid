import type Database from 'better-sqlite3'
import type { StoredTokens, TokenStore, UploadAccount } from '../types.js'

/** The stored YouTube tokens for one upload account (see UploadAccount). */
export function makeTokenStore(db: Database.Database, account: UploadAccount = 'primary'): TokenStore {
  return {
    load() {
      const r = db.prepare('SELECT * FROM oauth_accounts WHERE account = ?').get(account) as any
      if (!r) return null
      return {
        accessToken: r.access_token, refreshToken: r.refresh_token,
        expiresAt: r.expires_at, scope: r.scope,
        channelId: r.channel_id ?? undefined, channelTitle: r.channel_title ?? undefined,
        connectedAt: r.connected_at,
      }
    },
    save(t: StoredTokens) {
      db.prepare(`INSERT INTO oauth_accounts
        (account, access_token, refresh_token, expires_at, scope, channel_id, channel_title, connected_at)
        VALUES (@acct, @a, @r, @e, @s, @ci, @ct, @c)
        ON CONFLICT(account) DO UPDATE SET
          access_token=@a, refresh_token=@r, expires_at=@e, scope=@s,
          channel_id=@ci, channel_title=@ct, connected_at=@c`).run({
        acct: account,
        a: t.accessToken, r: t.refreshToken, e: t.expiresAt, s: t.scope,
        ci: t.channelId ?? null, ct: t.channelTitle ?? null, c: t.connectedAt,
      })
    },
    clear() { db.prepare('DELETE FROM oauth_accounts WHERE account = ?').run(account) },
  }
}
