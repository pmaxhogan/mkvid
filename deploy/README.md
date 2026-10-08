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

1. **Google Cloud (one-time):** mkvid has its own project, **mkvid-uploads**
   (created 2026-09-14 with `gcloud projects create mkvid-uploads`; YouTube
   Data API v3 enabled), with a "Web application" OAuth client whose
   authorized redirect URIs are `https://mkvid.maxhogan.dev/oauth/callback`
   and `http://localhost:8080/oauth/callback` → `GOOGLE_OAUTH_CLIENT_*`.
   The **tracked** sync's project, **tracked-youtube**, holds a second client
   with the same redirect URIs → `SHARED_GOOGLE_OAUTH_CLIENT_*`: tracked
   hands mkvid up to `MKVID_SHARED_DAILY_CLAIM_CAP` uploads a day on it once
   mkvid-uploads has spent its own quota day (README "tracked integration").
   Both consent screens: `pmaxhogan@gmail.com` as a test user, or publish the
   app ("In production", unverified is fine) so refresh tokens stop expiring
   after 7 days. OAuth clients cannot be created with gcloud — console only.

2. **Cloudflare Access (one-time):** Zero Trust → Access → Applications → Add
   → Self-hosted; app domain `mkvid.maxhogan.dev`; policy Allow, Emails
   include `pmaxhogan@gmail.com`; save; copy the **Application Audience
   (AUD)** → `CF_ACCESS_AUD`.

3. **Cloudflare Tunnel (one-time):** Zero Trust → Networks → Tunnels →
   existing tunnel → Public Hostnames → Add → `mkvid.maxhogan.dev` → service
   `http://mkvid.ix-mkvid.svc.cluster.local:8080`. TrueNAS Custom Apps auto-join
   the shared `apps-internal` network (via the dragonify sidecar) with the DNS
   alias `<compose-service>.ix-<appname>.svc.cluster.local`, and the cloudflared
   connector is on that network — the bare `http://mkvid:8080` does NOT resolve.

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
   `DEV_BYPASS_CF_ACCESS`. To render tracked's queue (README "tracked
   integration") add `TRACKED_URL=https://tracked.pmaxhogan.workers.dev` and
   `TRACKED_TOKEN=<the Worker's MKVID_TOKEN secret>`; the container logs
   `tracked: connected` on start when both are right, or
   `tracked: health check failed` when they are not. Add
   `SHARED_GOOGLE_OAUTH_CLIENT_ID/SECRET` (the tracked-youtube client) for the
   second upload account, then connect it from the UI's second button.

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

   **`.env` changes do NOT auto-deploy.** Watchtower only updates the *image*; it
   clones the running container's env and does not re-read `env_file`. After
   editing `/mnt/alpha/apps/mkvid/.env`, load it with a redeploy:
   `ssh mnmserver "sudo midclt call app.redeploy mkvid"` (re-reads the env_file).

   **CPU priority.** mkvid may use every core but yields them: compose
   `cpu_shares: 2` gives its cgroup `cpu.weight` 1 against 100 for every other
   container, so a Postgres/MongoDB burst takes the CPU back at once, while idle
   cores stay mkvid's. The entrypoint also runs node and all its threads and
   children (drawing workers, ffmpeg, yt-dlp) at `nice 19` (`MKVID_NICE`,
   `0` = off); nice only orders work inside the container, the weight is what
   protects the other apps. No `cpuset`/`cpus` limit (it only caps spare CPU);
   if one is ever set, `VIZ_WORKERS` defaults to the usable cores − 2 and is
   clamped to them (`os.availableParallelism()` and cgroup `cpu.max`, not the
   host count). Watchtower's recreate keeps these settings. Check:
   `ssh mnmserver 'id=$(sudo docker inspect -f {{.Id}} mkvid); cat /sys/fs/cgroup/docker/$id/cpu.weight; sudo docker exec mkvid sh -c "for p in /proc/[0-9]*; do echo \$(cut -d\" \" -f19 \$p/stat) \$(cat \$p/comm); done"'`
   (weight `1`; every process at `19`).

10. **Verify:** open `https://mkvid.maxhogan.dev` → CF Access login → Connect
    YouTube → submit a short track → watch progress → confirm the private
    video + push notification.

## `.env` template

Copy `.env.example` to `deploy/.env` and fill in production values (this file
is gitignored — commit only `.env.example`).
