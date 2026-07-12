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

## Architecture

A single Node/TypeScript service (Hono + `@hono/node-server`):

- **CF Access gate** — verifies the `Cf-Access-Jwt-Assertion` JWT (RS256 + JWKS,
  fail-closed, email allowlist). `DEV_BYPASS_CF_ACCESS=1` for local dev.
- **Web UI** — one inline HTML page: URL box, live SSE progress, job history,
  YouTube connect status, notification opt-in.
- **Job pipeline** — single-slot queue (one GPU job at a time): download → ffprobe
  → ffmpeg → YouTube upload → cleanup, streaming progress over SSE.
- **State** — SQLite (`better-sqlite3`) on a mounted volume: OAuth tokens, jobs +
  logs, push subscriptions, JWKS cache.
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
