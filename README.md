# mkvid

Paste a track URL (usually SoundCloud) → it downloads the audio, renders an mp4
with a waveform visualization, and uploads it to your YouTube channel so you can
listen there. A web-app port of `mkvid.ps1`, self-hosted on a TrueNAS box behind
Cloudflare Access.

## What it does

1. **Download** — `yt-dlp` fetches `bestaudio/best` from any URL it supports.
2. **Render** — `ffmpeg` draws the waveform and sweeps a playhead across it
   (`static` style, the ps1 default) or an oscilloscope (`waves`), always
   `yuv420p`, encoded with `h264_nvenc` on the GPU (falls back to `libx264`).
3. **Upload** — resumable upload to YouTube via the Data API (Private by default),
   authorized once via Google OAuth.
4. **Notify** — a Web Push notification fires when the upload finishes, even with
   the site closed (works on Android Chrome via FCM).

## tracked integration

[tracked](https://github.com/pmaxhogan/tracked) keeps YouTube playlists of every
set a followed DJ has on 1001tracklists. Sets with **no YouTube recording but a
SoundCloud / hearthis.at one** are queued there for mkvid; with `TRACKED_URL` +
`TRACKED_TOKEN` set, mkvid polls that queue (`TRACKED_POLL_SECONDS`, default 60)
whenever its render slot is free and:

1. **claims** one request (`POST /mkvid/claim`, bearer `TRACKED_TOKEN` = the
   Worker's `MKVID_TOKEN`) — the set page title, the recording URL and the
   tracklist's last cue;
2. **resolves the source**: SoundCloud API track URLs go to yt-dlp as-is; a
   hearthis.at *embed* is resolved to the track page yt-dlp's extractor accepts
   (one fetch of the embed HTML);
3. **checks the recording is the full set**: `yt-dlp --print duration`, refused
   as `incomplete_recording` (permanent) when it ends more than 90 s before the
   tracklist's last cue — a clip is not the set;
4. runs the normal pipeline — `static` waveform, uploaded as `TRACKED_PRIVACY`
   (default **unlisted**), the 1001tracklists URL in the description;
5. **reports back**: `POST /mkvid/complete` with the video id and the privacy
   YouTube actually applied (an unverified OAuth app forces `private` — tracked
   shows that), or `POST /mkvid/fail` (retryable errors are re-queued by tracked
   with a backoff; permanent ones — unsupported/removed/private source, clip —
   are parked). tracked then adds the video to the DJ's playlist and the
   combined one.

Delivery is durable: the outcome is marked on the job row (`meta.reported`)
only once tracked acknowledged it, and every poll retries undelivered ones —
so a network blip or a restart between upload and report never renders a set
twice. Tracked jobs show `[tracked]` in the job list, linking the set page.

## Architecture

A single Node/TypeScript service (Hono + `@hono/node-server`):

- **CF Access gate** — verifies the `Cf-Access-Jwt-Assertion` JWT (RS256 + JWKS,
  fail-closed, email allowlist). `DEV_BYPASS_CF_ACCESS=1` for local dev.
- **Web UI** — one inline HTML page: URL box, live SSE progress, job history,
  YouTube connect status, notification opt-in.
- **Job pipeline** — single-slot queue (one GPU job at a time): download → ffprobe
  → ffmpeg → YouTube upload → cleanup, streaming progress over SSE.
- **State** — SQLite (`better-sqlite3`) on a mounted volume: OAuth tokens, jobs +
  logs (with `meta` for tracked-origin jobs and the privacy YouTube applied),
  push subscriptions, JWKS cache.
- **tracked poller** — `lib/tracked.ts`: claims sets from tracked's queue when
  idle, hands them to the pipeline, reports outcomes (see above).
- **GPU** — NVIDIA passthrough for NVENC.

## Deployment

Runs on TrueNAS Scale (`mnmserver`) as a Custom App, image built by GitHub Actions
and published to GHCR (`ghcr.io/pmaxhogan/mkvid`), exposed at `mkvid.maxhogan.dev`
through the existing cloudflared tunnel. A push to `main` rebuilds the image and a
Watchtower sidecar auto-pulls + restarts within ~2 min. Full runbook:
[`deploy/README.md`](deploy/README.md).

## Local development

```bash
npm install
npm test            # 31 unit tests
npm run typecheck
cp .env.example .env   # keep DEV_BYPASS_CF_ACCESS=1; fill Google OAuth + VAPID
npm run dev            # http://localhost:8080
```

Requires `yt-dlp` and `ffmpeg`/`ffprobe` on `PATH` (or set `YTDLP_PATH` /
`FFMPEG_PATH` / `FFPROBE_PATH`).

## Design & plan

- Spec: [`docs/superpowers/specs/2026-07-12-mkvid-design.md`](docs/superpowers/specs/2026-07-12-mkvid-design.md)
- Implementation plan: [`docs/superpowers/plans/2026-07-12-mkvid.md`](docs/superpowers/plans/2026-07-12-mkvid.md)
