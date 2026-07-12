# Render audio to an mp4 with a waveform visualization. Takes a local file or
# any URL yt-dlp can fetch; a URL is downloaded to a temp dir and the mp4 is
# written to the current directory, named after the track.
#
#   mkvid track.m4a
#   mkvid https://soundcloud.com/gorgon-city/4hr-set-space-miami-27122025
#
# -Style static (default) draws the whole track as one still waveform and
# sweeps a playhead across it: ~300x realtime on a 4h set. -Style waves is the
# showwaves oscilloscope, ~37x, and needs -Mode (line|p2p|cline|point).
#
# Why static wins, all measured on a 4h set rather than guessed:
#   * It renders the waveform in a single pass over the samples (~19s) and then
#     encodes near-identical frames, which cost almost nothing. showwaves
#     redraws every frame, so its output compresses like noise.
#   * Output size collapses to roughly the size of the audio itself: 0.29 GB,
#     of which ~0.27 GB is the copied AAC and only ~20 MB is video.
#   * Playhead travel, not smoothness, sets the useful frame rate. Over 4h the
#     playhead crosses 1280 px, i.e. 0.09 px/s, so -Fps 1 already moves it less
#     than a pixel per frame. Auto-Fps therefore targets ~1 px of travel per
#     frame, clamped to 1..10. Override with -Fps.
#
# Two traps worth remembering:
#   * format=yuv420p is required. Both filters emit RGBA, which makes x264 pick
#     a High 4:4:4 profile that Safari, QuickTime, and most upload pipelines
#     refuse to decode.
#   * NVENC will not open below ~256x256 and is absent on non-NVIDIA machines,
#     so try it first and fall back to libx264 (~7x slower) on a failure to
#     open, remembering that for the rest of the session. -Cpu forces libx264.
function mkvid {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0, ValueFromPipeline)]
        [string] $Path,
        [Parameter(Position = 1)]
        [string] $OutFile,
        [switch] $Force,
        [ValidateSet('static', 'waves')]
        [string] $Style = 'static',
        [ValidateSet('line', 'p2p', 'cline', 'point')]
        [string] $Mode = 'line',
        [int]    $Fps = 0,
        [string] $Size = '1280x720',
        [switch] $Cpu,
        [switch] $KeepAudio
    )
    process {
        $tempDir = $null
        $wavePng = $null
        $invariant = [Globalization.CultureInfo]::InvariantCulture
        try {
            if ($Path -match '^https?://') {
                if (-not (Get-Command yt-dlp -ErrorAction SilentlyContinue)) {
                    Write-Error 'mkvid: yt-dlp is not on PATH. Install it with: choco install yt-dlp'
                    return
                }
                $tempDir = Join-Path ([IO.Path]::GetTempPath()) ('mkvid-' + [guid]::NewGuid().ToString('n'))
                New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

                # bestaudio without -x: skip yt-dlp's transcode pass and let the
                # codec check below decide whether the stream can be remuxed.
                yt-dlp --no-playlist -f 'bestaudio/best' `
                    -o (Join-Path $tempDir '%(title)s.%(ext)s') -- $Path
                if ($LASTEXITCODE -ne 0) {
                    Write-Error "mkvid: yt-dlp exited with code $LASTEXITCODE"
                    return
                }
                $item = Get-ChildItem -LiteralPath $tempDir -File | Select-Object -First 1
                if (-not $item) {
                    Write-Error 'mkvid: yt-dlp produced no audio file.'
                    return
                }
                if (-not $OutFile) {
                    $OutFile = Join-Path (Get-Location).ProviderPath ($item.BaseName + '.mp4')
                }
            } else {
                $item = Get-Item -LiteralPath $Path -ErrorAction Stop
                if ($item.PSIsContainer) {
                    Write-Error "mkvid: '$Path' is a directory, not an audio file."
                    return
                }
                if (-not $OutFile) {
                    $OutFile = Join-Path $item.DirectoryName ($item.BaseName + '.mp4')
                }
            }

            if ((Test-Path -LiteralPath $OutFile) -and -not $Force) {
                Write-Error "mkvid: '$OutFile' already exists. Pass -Force to overwrite."
                return
            }

            $width, $height = $Size -split 'x'
            # Two lines: the audio codec, then the container duration. Keep them
            # as an array - casting to [string] joins them with a space.
            $probe = @(& ffprobe -v error -select_streams a:0 `
                -show_entries stream=codec_name -show_entries format=duration `
                -of csv=p=0 -i $item.FullName) | Where-Object { $_ -and $_.Trim() }
            $srcCodec = [string]($probe | Select-Object -First 1)
            $durText = [string]($probe | Select-Object -Skip 1 -First 1)
            $dur = 0.0
            [void][double]::TryParse($durText, [Globalization.NumberStyles]::Float, $invariant, [ref] $dur)
            if ($dur -le 0) {
                Write-Error "mkvid: could not read a duration from '$($item.Name)'."
                return
            }

            if ($Fps -le 0) {
                if ($Style -eq 'static') {
                    $Fps = [int][Math]::Min(10, [Math]::Max(1, [Math]::Round([double]$width / $dur)))
                } else {
                    $Fps = 5
                }
            }

            # Remux the audio untouched when an mp4 can hold it as-is.
            if ($srcCodec.Trim() -in @('aac', 'mp3', 'alac')) {
                $audioArgs = @('-c:a', 'copy')
            } else {
                $audioArgs = @('-c:a', 'aac', '-b:a', '192k')
            }

            if ($Style -eq 'static') {
                $wavePng = Join-Path ([IO.Path]::GetTempPath()) ('mkvid-wave-' + [guid]::NewGuid().ToString('n') + '.png')
                ffmpeg -nostdin -hide_banner -loglevel warning -stats -y -i $item.FullName `
                    -filter_complex "showwavespic=s=${Size}:colors=cyan" -frames:v 1 $wavePng
                if ($LASTEXITCODE -ne 0) {
                    Write-Error "mkvid: showwavespic failed with exit code $LASTEXITCODE"
                    return
                }
                # overlay's x expression has a real timestamp variable; drawbox's
                # `t` is thickness, so a drawbox playhead silently never moves.
                $durText = $dur.ToString('0.000', $invariant)
                $inputArgs = @(
                    '-loop', '1', '-framerate', $Fps, '-i', $wavePng,
                    '-f', 'lavfi', '-i', "color=red:s=4x${height}:r=$Fps",
                    '-i', $item.FullName
                )
                $filter = "[0:v][1:v]overlay=x='(main_w-overlay_w)*t/$durText':y=0,format=yuv420p[v]"
                $mapArgs = @('-map', '[v]', '-map', '2:a', '-shortest')
                # Frames are near-identical, so extra keyframes cost ~nothing and
                # keep scrubbing usable at 1 fps.
                $gop = @('-g', [Math]::Max(1, $Fps * 5))
            } else {
                $inputArgs = @('-i', $item.FullName)
                $filter = "[0:a]showwaves=s=${Size}:mode=${Mode}:rate=$Fps,format=yuv420p[v]"
                $mapArgs = @('-map', '[v]', '-map', '0:a')
                $gop = @()
            }

            $x264 = @('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23')
            $nvenc = @('-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '28')
            if ($Cpu -or $script:MkvidNoNvenc) {
                $encoders = @(, $x264)
            } else {
                $encoders = @(, $nvenc) + @(, $x264)
            }

            for ($i = 0; $i -lt $encoders.Count; $i++) {
                $ffArgs = @('-nostdin', '-hide_banner', '-loglevel', 'warning', '-stats', '-y') +
                    $inputArgs + @('-filter_complex', $filter) + $mapArgs +
                    $encoders[$i] + $gop + $audioArgs + @($OutFile)

                ffmpeg @ffArgs
                if ($LASTEXITCODE -eq 0) {
                    if ($KeepAudio -and $tempDir) {
                        Move-Item -LiteralPath $item.FullName `
                            -Destination (Split-Path $OutFile -Parent) -Force
                    }
                    return Get-Item -LiteralPath $OutFile
                }
                if ($i -lt $encoders.Count - 1) {
                    Write-Warning "mkvid: h264_nvenc did not open (exit $LASTEXITCODE). Falling back to libx264."
                    $script:MkvidNoNvenc = $true
                }
            }
            Write-Error "mkvid: ffmpeg failed with exit code $LASTEXITCODE"
        } finally {
            if ($wavePng -and (Test-Path -LiteralPath $wavePng)) {
                Remove-Item -LiteralPath $wavePng -Force -ErrorAction SilentlyContinue
            }
            if ($tempDir -and (Test-Path -LiteralPath $tempDir)) {
                Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
