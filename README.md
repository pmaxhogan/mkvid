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
   authorized once via Google OAuth (twice, if a second OAuth client is set —
   see "tracked integration").
4. **Notify** — a Web Push notification fires when the upload finishes, even with
   the site closed (works on Android Chrome via FCM).

## tracked integration

[tracked](https://github.com/pmaxhogan/tracked) keeps YouTube playlists of every
set a followed DJ has on 1001tracklists. Sets with **no YouTube recording but a
SoundCloud / hearthis.at one** are queued there for mkvid; with `TRACKED_URL` +
`TRACKED_TOKEN` set, mkvid polls that queue (`TRACKED_POLL_SECONDS`, default 60)
whenever a new set could start downloading right away (no job limit: one set per stage - download, analyse, render, assemble - and `UPLOAD_CONCURRENCY` (default 2) in upload, so a set is claimed only when download is free, no set here waits for download, analyse or render, and fewer sets wait to upload than there are upload slots: with the default 2, one set waiting to upload does not hold back the next render, two do; `UPLOAD_CONCURRENCY=1` uploads one at a time and stops claiming while one set waits to upload). Each upload logs `upload: progress` every 5 min and `upload: done` / `upload: failed` at the end (bytes, seconds, MB/s, account, uploads at once and on the same account) and:

1. **claims** one request (`POST /mkvid/claim`, bearer `TRACKED_TOKEN` = the
   Worker's `MKVID_TOKEN`) — the set page title, the recording URL and the
   tracklist's last cue. The body lists the **upload accounts** mkvid can use
   right now (`{ "accounts": ["primary", "shared"] }`: the Google Cloud
   projects it has a connected YouTube token for), and the request comes back
   stamped with the one to upload through — tracked fills mkvid's own project
   (`GOOGLE_OAUTH_CLIENT_*`, project mkvid-uploads) first and spills to the
   sync's (`SHARED_GOOGLE_OAUTH_CLIENT_*`, project tracked-youtube) once that
   quota day is spent. Same channel, separate 10 000-unit quotas (an upload
   costs 1 600). With `TRACKED_SPREAD_ACCOUNTS=1` the body also names a
   `preferAccount` (the connected account with the fewest sets in flight
   here), which tracked honours while that account has claims left today, so
   sets uploading at once tend to use different projects. Polling continues with no account connected, so tracked's
   panel can say "reconnect YouTube on mkvid" rather than "mkvid is down";
2. **resolves the source**: SoundCloud API track URLs go to yt-dlp as-is; a
   hearthis.at *embed* is resolved to the track page yt-dlp's extractor accepts
   (one fetch of the embed HTML);
3. **checks the recording is the full set**: `yt-dlp --print duration`, refused
   as `incomplete_recording` (permanent) when it ends more than 90 s before the
   tracklist's last cue — a clip is not the set;
4. runs the normal pipeline (two sets at once, never in the same stage: one
   downloads, analyses, assembles or uploads while the other renders, so two
   renders never share the CPU; the waiting one renews its claim with
   `POST /mkvid/job` on every poll so tracked's claim TTL cannot hand it out
   again) — `static` waveform, uploaded as `TRACKED_PRIVACY`
   (default **unlisted**), the 1001tracklists URL in the description;
5. **reports back**: `POST /mkvid/complete` with the video id, the privacy
   YouTube actually applied (an unverified OAuth app forces `private` — tracked
   shows that) and the `style` the video was made with, or `POST /mkvid/fail` (retryable errors are re-queued by tracked
   with a backoff; permanent ones — unsupported/removed/private source, clip —
   are parked). tracked then adds the video to the DJ's playlist and the
   combined one.

Delivery is durable: the outcome is marked on the job row (`meta.reported`)
only once tracked acknowledged it, and every poll retries undelivered ones —
so a network blip or a restart between upload and report never renders a set
twice. Tracked jobs show `[tracked]` in the job list, linking the set page.

**Verified lists only (scene style).** tracked hands out a set only once its
track list is verified (two fetches by different accounts agreed on every
row), so a claim carries `tracksTrusted: true` and a non-empty list. With
`TRACKED_STYLE=scene`, anything else is refused right after the claim, before
any download: `POST /mkvid/fail { error: "unverified_tracklist: …", permanent:
false }`, which tracked answers by putting the request back to pending without
using an attempt. The pipeline repeats the check at the start of a tracked
scene job (a job queued or resumed from before the rule). A refusal tracked
cannot be told about is kept (`tracked_refusals`) and retried every poll.
Staggered deploys: with `TRACKED_STYLE=scene`, mkvid claims nothing until
tracked's `GET /mkvid/health` answers `verifiedLists: true` — an older tracked
would count every refusal as a used attempt and park the queue as failed.
Every claim also names the style (`{ accounts, style }`). There is no
names-hidden render any more: a video is made with the verified names, or not
at all.

**Deleting a replaced upload.** tracked's "Delete and recreate" renders a set
again; once the new video is in its playlists it calls
`POST /api/videos/<videoId>/delete { requestId }` with `Authorization: Bearer
<TRACKED_TOKEN>` (the same shared secret, the other way). The route sits ahead
of the Cloudflare Access check in the app (a machine caller has no Access
user) and checks the bearer itself; at the edge the path needs a bypass policy
or an Access service token, which tracked sends when configured. It deletes
(`videos.delete`) only a video this database recorded as uploaded by a job for
that tracked request, through the account (Google project) that uploaded it,
and marks the job (`video_deleted_at`). Answers `{ ok, outcome: "deleted" |
"already_gone" }`; `404 unknown_video` / `409 not_tracked | request_mismatch`
when it is not ours to delete (final); `502`/`503` otherwise (tracked retries).
Every upload records its style in `jobs.upload_style` (uploads from before the
column were backfilled from `jobs.style`).

## Scene style

`style: "scene"` (API only for now, or `TRACKED_STYLE=scene` for tracked's
jobs) draws every frame in Node (`src/viz`, `@napi-rs/canvas`) instead of one
ffmpeg filter graph: blurred artwork background, the current track's artwork
inside a circular spectrum, artist and title with a crossfade at each cue,
and a timeline of the set. 1920x1080, 30 fps, H.264.

- **Inputs.** The audio is analysed once (`viz/analysis.ts`, per-frame
  spectrum, energy, bass, onsets). Track list and trust flag come from
  tracked's claim (`meta.tracks`, `meta.tracksTrusted`). A track without a cue
  is dropped, except the first, which starts at 0. A layered ("w/") track
  belongs to the preceding non-layered track: without a cue it starts with it,
  an earlier cue is clamped to it, it is dropped with it, and one cued at or
  after the next track is dropped (never visible). List order is kept; a track
  cued before the previous one is dropped. A tracked job only
  ever gets a verified list (see "Verified lists only"); ID rows show "ID". Track
  artwork is downloaded into `$DATA_DIR/cache/artwork` (keyed by URL hash,
  images only, 15 MB cap). The set artwork is the source's thumbnail via yt-dlp.
- **Segments.** The timeline is cut into `VIZ_SEGMENT_SECONDS` (60 s)
  segments. `VIZ_WORKERS` threads (default usable cores − 2, clamped to the
  usable cores) draw frames and `VIZ_ENCODE_SESSIONS`
  segments encode at once. Every drawing thread feeds every encoder, frame by
  frame. A segment is encoded to `seg-NNNNN.mp4.partial` and renamed once
  ffprobe has counted its frames. All segments of a job use one encoder
  (NVENC when it opens, else libx264): segments from two encoders cannot be
  joined by stream copy.
- **Encoding.** YouTube's recommended 1080p30 upload settings: H.264 High,
  CABAC, 2 B-frames, VBR 8 Mbps (max 12M, buffer 16M), closed GOP of half the
  frame rate (15 at 30 fps), 4:2:0 BT.709. NVENC `-preset p6 -tune hq
  -spatial-aq 1`; libx264 `-preset medium` with the same rate settings.
- **Assemble.** Concat demuxer (stream copy), audio re-encoded to AAC-LC
  192k stereo 48 kHz, `+faststart`, no edit lists (`-use_editlist 0`, B-frame
  delay as negative composition offsets). The duration is checked against the
  audio.
- **Resume.** `work/<job>/viz/manifest.json` records the input fingerprint:
  audio size and mtime, size, fps, segment length, the hash of the scene input
  (titles, tracks, artwork bytes), the hash of the scene/analysis code and
  fonts, and the encoder settings. It also lists finished segments. On start,
  matching finished segments are skipped. Any mismatch discards them all
  (mixing old and new drawing code in one video is never right).
- **Restarts.** At boot, a scene job caught mid-run with its audio downloaded
  and no video yet goes back to `queued` with its work dir kept, instead of
  `interrupted`. The download is skipped (the audio is kept, never
  re-downloaded) and rendering resumes from the finished segments. After
  `VIZ_MAX_RESUMES` (3) restarts in a row without a new finished segment it is marked interrupted (image updates during a long render are harmless), so a job that
  crashes the process cannot loop forever. Jobs of the other styles behave as
  before.
- **Failures.** A failed render is retried `VIZ_RENDER_RETRIES` (2) times after
  `VIZ_RETRY_DELAY_SECONDS` (60), resuming from the finished segments. A render
  refuses to start with less than `VIZ_MIN_FREE_GB` (80) free on the data
  volume (retryable). When a scene job fails while rendering or uploading, its
  work dir (audio, segments, analysis, and a finished `out.mp4`) is kept for
  `VIZ_KEEP_HOURS` (72) within `VIZ_KEEP_GB` (200, oldest dropped first).
  `POST /api/jobs/:id/retry` requeues such a job (UI jobs; a finished
  `out.mp4` is uploaded without rendering again). A tracked job is retried by
  tracked as a new job, which adopts the kept work of the failed job for the
  same request and audio URL. Download failures and the other styles behave as
  before.

Review the look on a local file, rendering a 20 s window with the real scene
and writing four PNG stills:

```bash
FFMPEG_PATH=... FFPROBE_PATH=... npx tsx src/viz/preview.ts --audio set.m4a --from 600 --seconds 20 \
  --out preview.mp4 --tracks tracks.json --artwork cover.jpg --title "Set title" --artist "DJ" --stills stills/
```

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
