# mkvid — TrueNAS deploy runbook

Operator runbook for deploying mkvid to the TrueNAS Scale box (`mnmserver`) as a
Custom App, exposed through the existing cloudflared tunnel at
`mkvid.maxhogan.dev`.

## Auto-deploy chain

Push to `main` → `build-image.yml` builds + pushes
`ghcr.io/pmaxhogan/mkvid:latest` → Watchtower (polling every 120s) sees the new
digest → pulls + recreates the `mkvid` container. No SSH, no manual redeploy.

Caveat to verify on TrueNAS: the app middleware also tracks this container; if
a later `app.redeploy`/UI edit fights Watchtower's recreate, either keep all
changes in the UI Custom Config YAML or fall back to the manual
`docker compose pull` + `midclt call app.redeploy mkvid`. Watchtower reads
GHCR auth from the mounted `/root/.docker/config.json` (from the one-time
`docker login ghcr.io`).

## One-time setup

1. **Google Cloud (one-time):** reuse `tracked`'s OAuth client or create a new
   "Web application" client; add authorized redirect URIs
   `https://mkvid.maxhogan.dev/oauth/callback` and
   `http://localhost:8080/oauth/callback`; enable **YouTube Data API v3**; on
   the OAuth consent screen add `pmaxhogan@gmail.com` as a test user. Note:
   un-audited apps force uploads to Private.

2. **Cloudflare Access (one-time):** Zero Trust → Access → Applications → Add
   → Self-hosted; app domain `mkvid.maxhogan.dev`; policy Allow, Emails
   include `pmaxhogan@gmail.com`; save; copy the **Application Audience
   (AUD)** → `CF_ACCESS_AUD`.

3. **Cloudflare Tunnel (one-time):** Zero Trust → Networks → Tunnels →
   existing tunnel → Public Hostnames → Add → `mkvid.maxhogan.dev` → service
   `http://mkvid:8080` (container hostname on the shared network, matching
   `container_name`).

4. **VAPID keys (one-time):** `npm run vapid` → put the public/private keys
   into `.env`.

5. **NAS dataset + secrets:**
   ```bash
   ssh mnmserver "sudo install -d -o apps -g apps -m 755 /mnt/alpha/apps/mkvid /mnt/alpha/apps/mkvid/data"
   scp deploy/.env mnmserver:/tmp/.env
   ssh mnmserver "sudo install -o apps -g apps -m 644 /tmp/.env /mnt/alpha/apps/mkvid/.env && sudo shred -u /tmp/.env"
   ```
   `.env` must set `OAUTH_REDIRECT_BASE=https://mkvid.maxhogan.dev`, real
   `CF_ACCESS_AUD`, `GOOGLE_OAUTH_*`, `VAPID_*`, and **not** set
   `DEV_BYPASS_CF_ACCESS`.

6. **GHCR auth (if not already):**
   `ssh mnmserver "docker login ghcr.io -u pmaxhogan"` (read:packages PAT).

7. **Install:** Apps → Discover → Custom App → name `mkvid` → paste
   `docker-compose.nas.yml` → Install; wait for Running.

8. **Enable NVIDIA:** TrueNAS Apps settings → install NVIDIA drivers (if not
   already); confirm
   `ssh mnmserver "sudo docker exec mkvid /usr/local/bin/ffmpeg -encoders | grep nvenc"`.

9. **Deploy updates (automatic):** a push to `main` builds+pushes `:latest`
   to GHCR and the bundled **Watchtower** sidecar pulls+recreates `mkvid`
   within ~2 min — no action needed. **Manual override** (immediate, or if
   Watchtower is disabled):
   `ssh mnmserver "cd /mnt/alpha/apps/mkvid && sudo docker compose pull && sudo midclt call app.redeploy mkvid"`.
   Never `docker compose up -d`. Structural compose edits go through
   Apps → mkvid → Edit → Custom Config YAML.

10. **Verify:** open `https://mkvid.maxhogan.dev` → CF Access login → Connect
    YouTube → submit a short track → watch progress → confirm the private
    video + push notification.

## `.env` template

Copy `.env.example` to `deploy/.env` and fill in production values (this file
is gitignored — commit only `.env.example`).
