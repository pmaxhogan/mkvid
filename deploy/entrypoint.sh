#!/usr/bin/env bash
set -euo pipefail
DATA_DIR="${DATA_DIR:-/data}"
BIN="$DATA_DIR/bin"
mkdir -p "$BIN" "$DATA_DIR/db" "$DATA_DIR/work"

# yt-dlp: install latest into $BIN if missing, else it self-updates at runtime.
if [ ! -x "$BIN/yt-dlp" ]; then
  echo "entrypoint: fetching yt-dlp"
  curl -fsSL -o "$BIN/yt-dlp" https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux || cp "$(command -v yt-dlp || true)" "$BIN/yt-dlp" || true
  chmod +x "$BIN/yt-dlp" || true
fi
if "$BIN/yt-dlp" --version >/dev/null 2>&1; then export YTDLP_PATH="$BIN/yt-dlp"; else export YTDLP_PATH="yt-dlp"; fi

# ffmpeg: default to the bundled jellyfin-ffmpeg, which has WORKING NVENC and is
# refreshed by the weekly image rebuild. The John Van Sickle static build is
# opt-in only (FFMPEG_AUTOUPDATE=1) because its h264_nvenc rejects `-cq` and
# silently forces the CPU (libx264) path — so it is OFF by default.
export FFMPEG_PATH="${FFMPEG_PATH:-/usr/lib/jellyfin-ffmpeg/ffmpeg}"
export FFPROBE_PATH="${FFPROBE_PATH:-/usr/lib/jellyfin-ffmpeg/ffprobe}"
if [ "${FFMPEG_AUTOUPDATE:-0}" = "1" ]; then
  if curl -fsSL -o /tmp/ff.tar.xz https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz; then
    mkdir -p /tmp/ffx && tar -xJf /tmp/ff.tar.xz -C /tmp/ffx --strip-components=1 || true
    if /tmp/ffx/ffmpeg -version >/dev/null 2>&1; then
      cp /tmp/ffx/ffmpeg /tmp/ffx/ffprobe "$BIN/" && chmod +x "$BIN/ffmpeg" "$BIN/ffprobe"
      export FFMPEG_PATH="$BIN/ffmpeg"; export FFPROBE_PATH="$BIN/ffprobe"
      echo "entrypoint: using updated static ffmpeg"
    fi
    rm -rf /tmp/ffx /tmp/ff.tar.xz || true
  fi
fi
echo "entrypoint: ffmpeg=$FFMPEG_PATH yt-dlp=$YTDLP_PATH"
exec "$@"
