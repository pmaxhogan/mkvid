# mkvid — design spec

**Date:** 2026-07-12
**Status:** approved-pending-review

Convert `mkvid.ps1` (download a track → render an mp4 with a waveform → land it
somewhere) into a self-hosted web app that downloads, transcodes, and uploads the
result to YouTube so it can be listened to there. Runs on the TrueNAS Scale box
`mnmserver` behind the existing Cloudflare tunnel, secured by Cloudflare Access.

## Goals

- Web UI: paste a track URL (usually SoundCloud) → it downloads, renders the mp4
  with the same waveform visualization the ps1 script produces, and uploads it to
  the user's YouTube channel.
- Reuse the transcode logic from `mkvid.ps1` verbatim in behavior (static-waveform
  default, NVENC→libx264 fallback, `yuv420p`, audio remux-or-transcode).
- YouTube upload via OAuth the user connects once in the browser.
- Secured by Cloudflare Access (email allowlist), reachable at
  `mkvid.maxhogan.dev` through the **existing** shared cloudflared tunnel (no new
  port opened).
- Runs the download+transcode on the NAS GPU (NVIDIA → NVENC) so no cloud compute
  is paid for. The dev box also has an NVIDIA card (a different model), so the
  NVENC path is verifiable locally too — `h264_nvenc` is available across the
  NVIDIA lineup, so the card model does not matter.
- yt-dlp and ffmpeg both kept auto-updating.
- Browser push notification when an upload finishes, delivered even if the mkvid
  site/tab is closed (Web Push).
- Everything verifiable locally in Docker Desktop before touching the NAS.

## Non-goals

- Multi-user / multi-tenant. Single user (`pmaxhogan@gmail.com`).
- Public video publishing. Uploads default to **Private** (also required by
  YouTube for un-audited API apps — see Constraints).
- Replacing the ps1 for local ad-hoc use; it stays as-is.

## Decisions (locked)

1. **Topology: all-on-NAS.** One Node/TypeScript container does UI + API + OAuth +
   download + transcode + upload. Rationale: the job is long-running and ends by
   pushing a ~0.3 GB mp4 to YouTube *from the NAS*; a Cloudflare Worker could only
   kick it off and poll, adding a distributed job-state problem for no benefit.
   `tracked` split Worker/NAS only because its Worker needed the NAS's residential
   IP; here the NAS is needed for compute+GPU, so there is nothing to split.
2. **Upload privacy default: Private.** Selectable per-job in the UI, but defaults
   to Private and is effectively forced Private until the OAuth app passes
   YouTube's API audit.

## Architecture

A single container running a Node 22 / TypeScript service:

```
Browser ──HTTPS──> Cloudflare Access ──> existing cloudflared tunnel
   (mkvid.maxhogan.dev)                        │
                                               ▼
                                   ┌────────────────────────────┐
                                   │  mkvid container (NAS)      │
                                   │  Hono (@hono/node-server)   │
                                   │   ├─ CF Access JWT verify   │
                                   │   ├─ Web UI (inline HTML)   │
                                   │   ├─ Google OAuth           │
                                   │   ├─ Job queue (1 at a time)│
                                   │   └─ Pipeline:              │
                                   │       yt-dlp → ffmpeg(NVENC │
                                   │       →libx264) → YouTube   │
                                   │  SQLite (tokens + jobs)     │
                                   │  NVIDIA GPU passthrough     │
                                   └────────────────────────────┘
```

**Reused from `tracked`** (ported to Node, not copied wholesale):
- `src/middleware/cf-access.ts` → Node CF Access JWT verification (RS256 + JWKS,
  fail-closed, email allowlist). Node 20+ exposes global `crypto.subtle`, so the
  WebCrypto logic ports directly; JWKS caches in SQLite instead of KV.
- `src/lib/google-oauth.ts` → the OAuth authorization-code (offline) flow and
  CSRF state-cookie pattern.

**Reused from `doublepost`** (deployment pattern): GHCR image built by GitHub
Actions, pulled by a TrueNAS Custom App compose, exposed via a Public Hostname on
the shared host cloudflared tunnel, secrets via `env_file` + bind mounts on a ZFS
dataset, deploy via `docker compose pull` + `midclt call app.redeploy`.

## Components

### 1. HTTP service (Hono + @hono/node-server)

Routes (all gated by CF Access except `/healthz`):

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Web UI (single inline HTML page) |
| GET | `/healthz` | `200 ok` — un-gated in-app for local checks |
| POST | `/api/jobs` | `{ url, title?, privacy?, style?, mode?, fps?, cpu? }` → `{ id }` |
| GET | `/api/jobs` | Recent jobs |
| GET | `/api/jobs/:id` | Job detail + status |
| GET | `/api/jobs/:id/events` | SSE: progress + log lines |
| GET | `/oauth/start` | Begin Google OAuth (sets state cookie) |
| GET | `/oauth/callback` | Complete OAuth, store tokens |
| POST | `/oauth/disconnect` | Revoke + clear tokens |
| GET | `/api/youtube/status` | `{ connected, channelTitle? }` |
| GET | `/api/push/key` | VAPID public key for subscription |
| POST | `/api/push/subscribe` | Store a `PushSubscription` |
| GET | `/sw.js` | Service worker (served at origin root scope) |

### 2. CF Access middleware

Port of `tracked/src/middleware/cf-access.ts`. Reads `Cf-Access-Jwt-Assertion`
(falls back to `CF_Authorization` cookie), verifies RS256 against JWKS from
`https://<team>/cdn-cgi/access/certs` (cached in SQLite, 1h TTL, refresh once on
`kid` miss), checks `iss`/`aud`/`exp`/`nbf`/`iat`, then enforces the email
allowlist. Fails closed if any of team-domain / AUD / allowlist env is missing.
`DEV_BYPASS_CF_ACCESS=1` skips it for local Docker.

### 3. Google OAuth + YouTube upload

- OAuth via `google-auth-library` `OAuth2Client`. Scopes:
  `https://www.googleapis.com/auth/youtube.upload` +
  `https://www.googleapis.com/auth/youtube.readonly` (channel title for the UI).
  `access_type=offline`, `prompt=consent`. CSRF state cookie like `tracked`.
- Tokens in SQLite (`oauth_tokens`, single row); auto-refresh within 60s of expiry;
  clear on `invalid_grant` so the UI prompts reconnect.
- Upload via `googleapis` `youtube.videos.insert` with a **resumable** media
  stream (`part: ['snippet','status']`, `snippet.title/description`,
  `status.privacyStatus`, `snippet.categoryId=10` Music). Progress from the
  request stream's byte count → SSE.

### 4. Job pipeline (behavioral port of `mkvid.ps1`)

Per job, in a workspace dir under the data volume (`$DATA_DIR/work/<jobId>`):

1. **Download** (URL only): `yt-dlp --no-playlist -f 'bestaudio/best' -o
   '<work>/%(title)s.%(ext)s' -- <url>`. Track title from `--print title` or the
   produced filename's basename.
2. **Probe**: `ffprobe` → `codec_name` + `format=duration`. Fail if duration ≤ 0.
3. **Fps**: static → `min(10, max(1, round(width/dur)))`; waves → 5. Override via
   request.
4. **Audio args**: codec ∈ {aac,mp3,alac} → `-c:a copy`; else `-c:a aac -b:a 192k`.
5. **Filtergraph**:
   - static (default): `showwavespic=s=<size>:colors=cyan` → png; then inputs
     `-loop 1 -framerate <fps> -i wave.png`, `-f lavfi -i color=red:s=4x<h>:r=<fps>`,
     `-i audio`; filter
     `[0:v][1:v]overlay=x='(main_w-overlay_w)*t/<dur>':y=0,format=yuv420p[v]`;
     map `[v]` + `2:a`; `-shortest`; `-g max(1, fps*5)`.
   - waves: `[0:a]showwaves=s=<size>:mode=<mode>:rate=<fps>,format=yuv420p[v]`.
6. **Encoder**: try `h264_nvenc -preset p4 -cq 28` first (unless `cpu` requested or
   NVENC known-bad this run); on open-failure fall back to
   `libx264 -preset veryfast -crf 23` and remember NVENC is unavailable for the
   process lifetime — same logic as the ps1's `$script:MkvidNoNvenc`.
7. **Upload** the mp4 to YouTube (Private default). Title = user override or track
   basename; description includes the source URL.
8. **Cleanup**: delete the workspace on success; keep logs. On failure, keep the
   error output, mark the job failed, still clean the workspace.

**Progress**: yt-dlp `[download] N%` parsed from stderr; ffmpeg run with
`-progress pipe:1 -nostats` for reliable `out_time_us`/`frame` parsing → percent
of duration; upload byte progress. All streamed to the job's SSE channel.

**Concurrency**: a single in-memory FIFO queue, **one job at a time** (one GPU).
On startup any job left mid-flight is marked `interrupted`.

### 5. Web Push notifications

Fires a browser notification when a job finishes (done or failed), even with the
mkvid tab/site closed.

- Client: the UI registers `/sw.js`, requests Notification permission on a user
  gesture ("Enable notifications"), fetches the VAPID public key from
  `/api/push/key`, creates a `PushSubscription`, and POSTs it to
  `/api/push/subscribe`.
- Server: `web-push` (VAPID). On job completion, send a push to every stored
  subscription with `{ title, body, url }`; prune subscriptions that return 404/410.
- Service worker: on `push` → `showNotification(title, { body, data.url })`; on
  `notificationclick` → open the video URL directly (the finished YouTube link, so
  no CF Access round-trip is needed just to watch). For failures, link back to the
  job in the app.
- Delivery is browser-push-service → service worker, so it works with the site
  closed. Requires HTTPS (works on `localhost` for dev).

### 6. Persistence (SQLite, `better-sqlite3`)

- `oauth_tokens(access_token, refresh_token, expires_at, scope, channel_id,
  channel_title, connected_at)` — single row.
- `jobs(id, url, title, status, privacy, video_id, video_url, error, created_at,
  updated_at)` where `status ∈ {queued, downloading, transcoding, uploading, done,
  failed, interrupted}`.
- `job_logs(job_id, ts, line)` — appended log/progress lines (bounded).
- `push_subscriptions(id, endpoint, p256dh, auth, created_at)` — Web Push targets.
- `kv(key, value, expires_at)` — JWKS cache.

DB file lives on the mounted data volume so it survives container recreates.

### 7. Container image

- Base with a working NVENC ffmpeg. Plan: `jellyfin-ffmpeg` (NVENC-capable,
  actively maintained) as the bundled reliable baseline, plus Node 22.
- **Auto-update, without image rebuilds:**
  - yt-dlp: installed into a writable volume dir (`$DATA_DIR/bin`, on PATH),
    self-updated on container start and nightly (node-cron). yt-dlp changes weekly
    and is the thing most likely to break, so this is the important one.
  - ffmpeg: bundled jellyfin-ffmpeg is the guaranteed-good baseline; an optional
    updater fetches the latest static NVENC build into `$DATA_DIR/bin` on start and
    nightly, **with a version/health check and fallback** to the bundled binary if
    the fetched one fails to run. Never leaves the container without a working
    ffmpeg.
- Entrypoint: ensure `$DATA_DIR/bin` binaries, run migrations, start the server.

### 8. GPU passthrough

- Compose `deploy.resources.reservations.devices: [{ driver: nvidia, count: all,
  capabilities: [gpu, video] }]`. `video` is required for NVENC (not just `gpu`).
- TrueNAS Scale: NVIDIA drivers enabled in Apps settings.
- Local Docker Desktop (WSL2 + NVIDIA Container Toolkit): the dev box's NVIDIA card
  (different model from the NAS, which is fine for `h264_nvenc`) means the same
  reservation gives real NVENC locally. If the toolkit is absent, the pipeline's
  libx264 fallback still produces the mp4, so local verification never *depends* on
  the GPU — but the NVENC path can and will be exercised locally.

## Data flow (happy path)

1. User opens `mkvid.maxhogan.dev` → CF Access login → UI loads; shows YouTube
   connection status.
2. First time: "Connect YouTube" → `/oauth/start` → Google consent → `/oauth/callback`
   stores tokens.
3. User pastes URL → `POST /api/jobs` → job queued, UI subscribes to SSE.
4. Pipeline: download → probe → render → upload; progress streams live.
5. Done → UI shows the YouTube link; workspace cleaned.

## Error handling

- Missing/invalid CF Access → 401/403 (fail closed); misconfig → 500.
- yt-dlp / ffmpeg / ffprobe non-zero exit → job `failed` with captured stderr;
  workspace cleaned; UI shows the error.
- NVENC open failure → automatic libx264 fallback (not a job failure).
- OAuth `invalid_grant` → tokens cleared, UI prompts reconnect; a job needing
  upload fails with a clear "reconnect YouTube" message.
- Upload interrupted → resumable retry a bounded number of times, then `failed`.
- Duplicate/oversized: honor YouTube quota errors with a clear message (uploads
  cost 1600 units; ~6/day on default quota).

## Testing strategy

- **Unit (Vitest):** ffmpeg/yt-dlp argument builder (fps calc, audio copy-vs-transcode,
  filtergraph strings, encoder ordering — the ported ps1 logic); CF Access verify
  (adapt `tracked/test/cf-access.test.ts`); OAuth token-refresh logic.
- **Integration (local Docker Desktop, real tools):** submit a short real track URL
  → assert an mp4 is produced and `ffprobe` reports `yuv420p`, one video + one
  audio stream, duration ≈ source. Runs libx264 locally if no GPU.
- **End-to-end upload:** one real Private upload of a short clip via the connected
  account — this is the single step that needs the user (Google consent in the
  browser is sensitive; won't be automated). Everything up to it is verified
  autonomously.

## Deployment

Mirrors `doublepost`:

1. Repo `pmaxhogan/mkvid` on GitHub; GitHub Actions builds `ghcr.io/pmaxhogan/mkvid`
   (`latest` + `sha-<short>`) on push to `main` (copy `build-image.yml`, incl. a
   smoke test that the image's Node entry imports + ffmpeg/yt-dlp run).
2. NAS dataset `alpha/apps/mkvid` (pool name to confirm) holding `.env` (mode 644,
   `apps:apps`), the SQLite DB dir, and the work dir.
3. TrueNAS Custom App: paste the compose YAML (Apps → Discover → Custom App).
   Service pulls `ghcr.io/pmaxhogan/mkvid:latest`, `restart: unless-stopped`,
   `pull_policy: always`, GPU reservation, `env_file`, data volume, internal port.
4. Cloudflare Zero Trust: add Public Hostname `mkvid.maxhogan.dev` →
   `http://<container>:<port>` on the existing tunnel; create a self-hosted Access
   application over that hostname with an allow policy for `pmaxhogan@gmail.com`
   (yields the AUD → `CF_ACCESS_AUD`).
5. Deploy updates: `ssh mnmserver "cd /mnt/alpha/apps/mkvid && sudo docker compose
   pull && sudo midclt call app.redeploy mkvid"`. Never `docker compose up -d`.

## Configuration (env)

`PORT` (8080), `DATA_DIR` (/data), `CF_ACCESS_TEAM_DOMAIN`
(`pmaxhogan.cloudflareaccess.com`), `CF_ACCESS_AUD` (new app's AUD),
`CF_ACCESS_ALLOWED_EMAILS` (`pmaxhogan@gmail.com`), `DEV_BYPASS_CF_ACCESS` (local),
`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `OAUTH_REDIRECT_BASE`
(`https://mkvid.maxhogan.dev`; `http://localhost:8080` for dev), `DEFAULT_PRIVACY`
(private), `YOUTUBE_CATEGORY_ID` (10), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
`VAPID_SUBJECT` (`mailto:pmaxhogan@gmail.com`; generated once via `web-push
generate-vapid-keys`).

## Manual setup (documented in README, one-time)

- **Google Cloud:** reuse `tracked`'s OAuth client (add redirect URIs
  `https://mkvid.maxhogan.dev/oauth/callback` and `http://localhost:8080/oauth/callback`)
  or create a new one; enable YouTube Data API v3; add self as test user.
- **Cloudflare:** the Access application + tunnel Public Hostname above.
- **GHCR:** NAS already authenticates to ghcr.io (from `doublepost`); mkvid image
  will be under the same owner.

## Constraints & risks

- **YouTube API audit:** un-audited API clients have uploads locked to Private and
  cannot be made public until audited. Acceptable — the goal is private listening.
- **Quota:** upload = 1600 units; default 10k/day ≈ 6 uploads/day.
- **NVENC on TrueNAS:** requires the NVIDIA driver enabled and the `video`
  capability; libx264 fallback guarantees function if passthrough misbehaves.
- **TrueNAS footgun:** structural compose edits (new services, volumes, env) are
  not picked up by `app.redeploy` from the on-disk file — they must be applied in
  the UI's Custom Config YAML. The on-disk compose is a reference copy.
- **Auto-updated ffmpeg** could ship a broken build; mitigated by the bundled
  baseline + health-check fallback.
- **Web Push reach:** the primary client is Android Chrome, which supports Web Push
  natively with the site closed (via FCM) — no PWA install needed. Desktop
  Chrome/Edge/Firefox also work. iOS Safari would require adding the site to the
  home screen as a PWA (out of scope for now).

## Parallel workstreams (for the implementation plan)

WS1 defines shared interfaces first; WS2–WS6 then run concurrently; WS7 + integration last.

- **WS1 — Core skeleton:** Hono server, config/env loader, SQLite layer +
  migrations, job model + queue/state machine, SSE hub.
- **WS2 — Pipeline:** yt-dlp + ffmpeg argument builder (ps1 port) + progress
  parsing + encoder fallback. (Depends on WS1's job model.)
- **WS3 — CF Access:** Node port + tests.
- **WS4 — OAuth + YouTube upload:** google-auth-library + googleapis.
- **WS5 — Web UI:** inline HTML page + SSE client + OAuth/status wiring + Web Push
  (service worker, subscribe flow) with the server-side `web-push` send on job
  completion.
- **WS6 — Image:** Dockerfile (Node + jellyfin-ffmpeg + yt-dlp), auto-update
  entrypoint, GPU wiring, local compose.
- **WS7 — Deploy:** GitHub Actions GHCR workflow, TrueNAS compose, README with the
  CF Access / tunnel / Google Cloud / NAS steps.
