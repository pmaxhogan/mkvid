/**
 * Bring the YouTube descriptions of past tracked uploads up to date (see
 * lib/description-backfill.ts). Runs beside the server, in its container:
 *
 *   docker exec mkvid node dist/cli/backfill-descriptions.js              dry run: plan + 5 samples per account
 *   docker exec mkvid node dist/cli/backfill-descriptions.js --apply      update, within today's limits
 *
 * Options:
 *   --apply                 write to YouTube (default: dry run, no writes)
 *   --account primary|shared|all          (default all)
 *   --limit-primary N       most updates this run (default 150)
 *   --limit-shared N        (default 30)
 *   --budget-primary N      most units this backfill spends per quota day (default 7600)
 *   --budget-shared N       (default 1600: tracked-youtube also carries tracked's sync and playlist inserts)
 *   --sample N              dry run: videos shown old vs new per account (default 5)
 *   --offline               dry run: do not read YouTube at all
 *   --allow-fallback        when yt-dlp cannot name the SoundCloud page, write the api URL anyway
 *   --force                 also rewrite descriptions a person edited
 *
 * It opens the database without starting a server: no queue, no restart
 * recovery. Tokens are shared with the server (WAL); a refresh by either
 * side is fine, and a 401 is answered with a freshly minted token.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../config.js'
import { openDb } from '../db/index.js'
import { makeJobsRepo } from '../db/jobs.js'
import { makeKvCache } from '../db/kv.js'
import { makeTokenStore } from '../db/tokens.js'
import { getValidAccessToken } from '../lib/google-oauth.js'
import { probePageUrl } from '../lib/ytdlp.js'
import { runDescriptionBackfill, youtubeVideosApi } from '../lib/description-backfill.js'
import { UPLOAD_ACCOUNTS, type UploadAccount } from '../types.js'

export const DEFAULTS = {
  limit: { primary: 150, shared: 30 } as Record<UploadAccount, number>,
  budget: { primary: 7600, shared: 1600 } as Record<UploadAccount, number>,
  sample: 5,
}

export function parseArgs(argv: string[]) {
  const opts = {
    apply: false, accounts: [...UPLOAD_ACCOUNTS] as UploadAccount[],
    limit: { ...DEFAULTS.limit }, budget: { ...DEFAULTS.budget }, sample: DEFAULTS.sample,
    readYouTube: true, allowFallback: false, force: false,
  }
  const num = (v: string | undefined, flag: string): number => {
    const n = Number(v)
    if (v === undefined || !Number.isInteger(n) || n < 0) throw new Error(`${flag} needs a whole number`)
    return n
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    switch (a) {
      case '--apply': opts.apply = true; break
      case '--dry-run': opts.apply = false; break
      case '--offline': opts.readYouTube = false; break
      case '--allow-fallback': opts.allowFallback = true; break
      case '--force': opts.force = true; break
      case '--sample': opts.sample = num(argv[++i], a); break
      case '--limit-primary': opts.limit.primary = num(argv[++i], a); break
      case '--limit-shared': opts.limit.shared = num(argv[++i], a); break
      case '--budget-primary': opts.budget.primary = num(argv[++i], a); break
      case '--budget-shared': opts.budget.shared = num(argv[++i], a); break
      case '--account': {
        const v = argv[++i]
        if (v === 'all') opts.accounts = [...UPLOAD_ACCOUNTS]
        else if (v === 'primary' || v === 'shared') opts.accounts = [v]
        else throw new Error('--account takes primary, shared or all')
        break
      }
      default: throw new Error(`unknown option ${a}`)
    }
  }
  if (opts.apply && !opts.readYouTube) throw new Error('--offline is for dry runs')
  return opts
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const config = loadConfig()
  if (config.dataDir === ':memory:') throw new Error('DATA_DIR is not a data directory')
  // `docker exec` does not see the entrypoint's YTDLP_PATH: use the self-updated copy it installs.
  const bundled = join(config.dataDir, 'bin', 'yt-dlp')
  const ytdlpPath = !process.env.YTDLP_PATH && existsSync(bundled) ? bundled : config.ytdlpPath
  const db = openDb(join(config.dataDir, 'db', 'mkvid.sqlite'))
  const accountGoogle = (a: UploadAccount) => (a === 'shared' ? config.googleShared : config.google)
  const accounts = opts.accounts.filter((a) => {
    if (accountGoogle(a)) return true
    console.log(`[${a}] not configured here, skipped`)
    return false
  })
  console.log(`${opts.apply ? 'APPLY' : 'DRY RUN (no YouTube writes, no job changes)'} — accounts: ${accounts.join(', ')}`)
  try {
    await runDescriptionBackfill({
      jobs: makeJobsRepo(db),
      kv: makeKvCache(db),
      tokenFor: (a) => {
        const store = makeTokenStore(db, a)
        return (o) => getValidAccessToken(store, accountGoogle(a)!, o)
      },
      api: youtubeVideosApi(),
      probePage: (url) => probePageUrl({ ytdlpPath, url }),
      log: (l) => console.log(l),
    }, { ...opts, accounts })
  } finally {
    db.close()
  }
}

if (process.argv[1] && /backfill-descriptions\.[jt]s$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(String(e?.message || e) === 'reconnect_youtube' ? 'YouTube is not connected for that account' : e)
    process.exit(1)
  })
}
