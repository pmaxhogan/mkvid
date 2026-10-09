/**
 * The `track` style: one track (a tracked track upload) as a 1920x1080 @ 30
 * fps video, drawn by ffmpeg alone in two passes.
 *
 *   1. background (one frame -> bg.png): the artwork scaled to cover the frame,
 *      a soft drop shadow under where the sharp artwork goes, blurred and
 *      darkened; the sharp square artwork on the left with a hairline border;
 *      artist (smaller) and title (large, up to two lines) on the right; the
 *      dim track of the progress bar along the bottom. Everything that never
 *      changes is drawn once, so the blur and the text cost one frame.
 *   2. video: bg.png looped, an audio visualizer (showfreqs bars, white with
 *      the bars' own brightness as alpha) under the text, and a progress bar
 *      sliding in along the bottom by t / duration. YouTube-spec encode like
 *      the scene style (H.264 High, closed GOP of fps/2, AAC-LC 192k 48 kHz
 *      stereo, yuv420p bt709, +faststart).
 *
 * No artwork at all: a dark solid background and the text block takes the
 * whole width instead of the right column.
 *
 * Text never goes through the filter graph: it is written to files that
 * drawtext reads (`textfile=`, `expansion=none`), so a title with `:`, `'`,
 * `%`, `\` or brackets needs no escaping. Only file paths do (ffEscape).
 *
 * The argument builders are pure (tests in test/track-render.test.ts);
 * renderTrackVideo runs them.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VIZ_ENC, VIZ_AUDIO_ARGS, gopFor, type VizEncoder } from '../viz/render.js'
import { isNvencDisabled } from './ffmpeg.js'

export const TRACK_WIDTH = 1920
export const TRACK_HEIGHT = 1080
export const TRACK_FPS = 30
/** Visualizer input shaping (dB): overall gain and tilt per octave around 1 kHz. */
const VIZ_GAIN_DB = 15
const VIZ_TILT_DB = 3

/** Layout of the frame, in pixels. */
export const TRACK_LAYOUT = {
  /** The sharp square artwork. */
  art: { x: 160, y: 260, size: 560 },
  /** The text column right of the artwork (or the whole width without one). */
  text: { x: 820, width: 960, noArtX: 160, noArtWidth: 1600 },
  artist: { maxPx: 46, minPx: 30 },
  title: { maxPx: 84, minPx: 48, maxLines: 2, lineSpacing: 14 },
  /** The visualizer: bottom edge level with the artwork's. */
  viz: { y: 580, width: 960, height: 240, barWidth: 20, barGap: 6 },
  /** The progress bar along the bottom edge. */
  bar: { height: 6 },
  /** Text block: vertically centred between the artwork's top and a little above the visualizer. */
  block: { top: 260, bottom: 550, gap: 22 },
  /** Background when there is no artwork. */
  solid: '0x161a24',
} as const

// ---------------------------------------------------------------------------
// fonts and text fitting

/** The bundled fonts (assets/fonts); MKVID_FONTS_DIR overrides, like the scene style. */
export function trackFontsDir(): string {
  return process.env.MKVID_FONTS_DIR || fileURLToPath(new URL('../../assets/fonts/', import.meta.url))
}

const SCRIPTS: Array<{ re: RegExp; bold: string; medium: string }> = [
  { re: /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/, bold: 'noto/NotoSansKR-Bold.otf', medium: 'noto/NotoSansKR-Medium.otf' },
  { re: /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/, bold: 'noto/NotoSansJP-Bold.otf', medium: 'noto/NotoSansJP-Medium.otf' },
  { re: /[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/, bold: 'noto/NotoSansArabic-Bold.ttf', medium: 'noto/NotoSansArabic-Regular.ttf' },
  { re: /[\u0590-\u05ff]/, bold: 'noto/NotoSansHebrew-Bold.ttf', medium: 'noto/NotoSansHebrew-Regular.ttf' },
  { re: /[\u0e00-\u0e7f]/, bold: 'noto/NotoSansThai-Bold.ttf', medium: 'noto/NotoSansThai-Regular.ttf' },
  { re: /[\u0900-\u097f]/, bold: 'noto/NotoSansDevanagari-Bold.ttf', medium: 'noto/NotoSansDevanagari-Regular.ttf' },
]

/**
 * The font file for a text (drawtext has no fallback chain): the Noto face of
 * the first non-Latin script it contains, else Inter (Latin, Greek, Cyrillic).
 * Returned relative to the fonts dir.
 */
export function pickTrackFont(text: string, weight: 'bold' | 'medium'): string {
  for (const s of SCRIPTS) if (s.re.test(text)) return weight === 'bold' ? s.bold : s.medium
  return weight === 'bold' ? 'inter/InterDisplay-Bold.ttf' : 'inter/Inter-Medium.ttf'
}

const WIDE = /[\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/

/** Rough rendered width of `text` in ems (Inter Display Bold proportions; CJK full width). Errs wide. */
export function estimateEm(text: string): number {
  let em = 0
  for (const ch of text) {
    if (WIDE.test(ch)) em += 1.0
    else if (ch === ' ') em += 0.28
    else if (/[iljI.,:;'!|]/.test(ch)) em += 0.3
    else if (/[mwMW@]/.test(ch)) em += 0.9
    else if (/[A-Z0-9&%#]/.test(ch)) em += 0.68
    else em += 0.58
  }
  return em
}

/** Drop control characters and collapse whitespace (a newline in a title must not become a line). */
export function cleanText(s: string | null | undefined): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()
}

function ellipsize(text: string, maxEm: number): string {
  const chars = Array.from(text)
  if (estimateEm(text) <= maxEm) return text
  while (chars.length > 1 && estimateEm(chars.join('') + '…') > maxEm) chars.pop()
  return chars.join('').trimEnd() + '…'
}

/** Greedy word wrap at `maxEm`; a word wider than a line is broken by characters. */
function wrap(text: string, maxEm: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const tryLine = line ? `${line} ${word}` : word
    if (estimateEm(tryLine) <= maxEm) { line = tryLine; continue }
    if (line) lines.push(line)
    line = ''
    let rest = word
    while (estimateEm(rest) > maxEm) {
      const chars = Array.from(rest)
      let n = chars.length
      while (n > 1 && estimateEm(chars.slice(0, n).join('')) > maxEm) n--
      lines.push(chars.slice(0, n).join(''))
      rest = chars.slice(n).join('')
    }
    line = rest
  }
  if (line) lines.push(line)
  return lines
}

/**
 * Fit a text into `maxLines` lines of `widthPx`: the largest size (from
 * maxPx down to minPx in 2 px steps) at which it wraps into that many lines;
 * at minPx the last line is cut with an ellipsis.
 */
export function fitText(text: string, o: { widthPx: number; maxPx: number; minPx: number; maxLines: number }): { lines: string[]; px: number } {
  const t = cleanText(text)
  if (!t) return { lines: [], px: o.maxPx }
  for (let px = o.maxPx; px >= o.minPx; px -= 2) {
    const lines = wrap(t, o.widthPx / px)
    if (lines.length <= o.maxLines) return { lines, px }
  }
  const px = o.minPx
  const maxEm = o.widthPx / px
  const lines = wrap(t, maxEm)
  const kept = lines.slice(0, o.maxLines)
  kept[kept.length - 1] = ellipsize(`${kept[kept.length - 1]} ${lines.slice(o.maxLines).join(' ')}`, maxEm)
  return { lines: kept, px }
}

/** "Artist - Title" split at the first " - " (also " – " / " — "); null when there is none. */
export function splitArtistTitle(s: string | null | undefined): { artist: string; title: string } | null {
  const t = cleanText(s)
  const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/)
  return m ? { artist: m[1]!.trim(), title: m[2]!.trim() } : null
}

/**
 * The names a track video is drawn and titled with. tracked's names win; a
 * pre-save saved by id alone has none, so they come from the source's
 * metadata (yt-dlp: `track`/`artist`, else an "Artist - Title" title, else
 * the title and the uploader), and last from `fallbackTitle` (the download's
 * title, never empty). A track video is never "Unknown track".
 */
export function resolveTrackNames(
  given: { artist: string | null; title: string | null },
  source: { title: string | null; track: string | null; artist: string | null; creator: string | null; uploader: string | null } | null,
  fallbackTitle: string,
): { artist: string | null; title: string; from: 'tracked' | 'source' | 'fallback' } {
  const ga = cleanText(given.artist) || null
  const gt = cleanText(given.title) || null
  if (gt) return { artist: ga, title: gt, from: 'tracked' }
  if (source) {
    // SoundCloud puts "Artist - Title" in track and title, and the uploader (a label, a remixer) in
    // artist: a dash in the name beats the artist field.
    const name = cleanText(source.track) || cleanText(source.title) || null
    const split = splitArtistTitle(name)
    const title = split?.title || name
    if (title) {
      const artist = ga || split?.artist || cleanText(source.artist) || cleanText(source.creator) || cleanText(source.uploader) || null
      return { artist, title, from: 'source' }
    }
  }
  const split = splitArtistTitle(fallbackTitle)
  return { artist: ga || split?.artist || null, title: split?.title || cleanText(fallbackTitle) || 'Untitled', from: 'fallback' }
}

export interface TrackText {
  artist: { lines: string[]; px: number; font: string }
  title: { lines: string[]; px: number; font: string }
}

/** Fit artist (one line) and title (up to two) into the text column. */
export function layoutTrackText(artist: string | null, title: string | null, hasArt: boolean): TrackText {
  const L = TRACK_LAYOUT
  const widthPx = hasArt ? L.text.width : L.text.noArtWidth
  const a = cleanText(artist)
  const t = cleanText(title) || a || 'Unknown track'
  const artistFit = a && t !== a ? fitText(a, { widthPx, maxPx: L.artist.maxPx, minPx: L.artist.minPx, maxLines: 1 }) : { lines: [], px: L.artist.maxPx }
  const titleFit = fitText(t, { widthPx, maxPx: L.title.maxPx, minPx: L.title.minPx, maxLines: L.title.maxLines })
  return {
    artist: { ...artistFit, font: pickTrackFont(a, 'medium') },
    title: { ...titleFit, font: pickTrackFont(t, 'bold') },
  }
}

// ---------------------------------------------------------------------------
// filter graph

/**
 * A file path as a filter option value inside -filter_complex: escaped for
 * the option parser (`\ ' :`), then again for the graph parser
 * (`\ ' [ ] , ;`). Backslashes become forward slashes first (Windows paths;
 * ffmpeg takes both), so `C:\x` comes out as `C\\\:/x`.
 */
export function ffEscape(value: string): string {
  const level1 = value.replace(/\\/g, '/').replace(/[\\':]/g, (c) => `\\${c}`)
  return level1.replace(/[\\'[\],;]/g, (c) => `\\${c}`)
}

/** Top of the artist line and of the title: the block is centred in TRACK_LAYOUT.block. */
export function textPositions(text: TrackText): { artistY: number; titleY: number } {
  const L = TRACK_LAYOUT
  const n = text.title.lines.length || 1
  const titleH = n * text.title.px + (n - 1) * L.title.lineSpacing
  const artistH = text.artist.lines.length ? text.artist.px + L.block.gap : 0
  const top = Math.round(L.block.top + (L.block.bottom - L.block.top - artistH - titleH) / 2)
  return { artistY: top, titleY: top + artistH }
}

export interface TrackBackgroundInput {
  /** The artwork image, or null for the solid background. */
  artworkPath: string | null
  /** Files holding the artist line and the title lines (newline-separated), UTF-8. Null = no such text. */
  artistFile: string | null
  titleFile: string
  text: TrackText
  fontsDir: string
  outPng: string
}

/** Pass 1: one frame with everything that does not move (see the file comment). */
export function buildTrackBackgroundArgs(o: TrackBackgroundInput): string[] {
  const L = TRACK_LAYOUT
  const W = TRACK_WIDTH
  const H = TRACK_HEIGHT
  const hasArt = !!o.artworkPath
  const tx = hasArt ? L.text.x : L.text.noArtX
  const parts: string[] = []
  const input = hasArt
    ? ['-i', o.artworkPath!]
    : ['-f', 'lavfi', '-i', `color=c=${L.solid}:s=${W}x${H}:r=1`]
  if (hasArt) {
    const { x, y, size } = L.art
    parts.push(
      '[0:v]format=rgb24,split=2[bgsrc][artsrc]',
      // Cover, then a dark box where the artwork goes: blurred along with the rest, it becomes a soft shadow below it.
      `[bgsrc]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bicubic,crop=${W}:${H},setsar=1,` +
        `drawbox=x=${x - 10}:y=${y + 24}:w=${size + 20}:h=${size + 10}:color=black@0.85:t=fill,` +
        'gblur=sigma=36:steps=2,eq=brightness=-0.16:saturation=1.15,' +
        `drawbox=x=0:y=0:w=${W}:h=${H}:color=black@0.35:t=fill,vignette=angle=PI/5[bg]`,
      `[artsrc]scale=${size}:${size}:force_original_aspect_ratio=increase:flags=lanczos,crop=${size}:${size},setsar=1[art]`,
      `[bg][art]overlay=x=${x}:y=${y},drawbox=x=${x}:y=${y}:w=${size}:h=${size}:color=white@0.14:t=2[base]`,
    )
  } else {
    parts.push(`[0:v]format=rgb24,vignette=angle=PI/4[base]`)
  }
  const draw: string[] = []
  const fontfile = (rel: string) => ffEscape(join(o.fontsDir, rel))
  const { artistY, titleY } = textPositions(o.text)
  if (o.artistFile && o.text.artist.lines.length) {
    draw.push(`drawtext=fontfile=${fontfile(o.text.artist.font)}:textfile=${ffEscape(o.artistFile)}:expansion=none:` +
      `fontsize=${o.text.artist.px}:fontcolor=white@0.72:x=${tx}:y=${artistY}`)
  }
  draw.push(`drawtext=fontfile=${fontfile(o.text.title.font)}:textfile=${ffEscape(o.titleFile)}:expansion=none:` +
    `fontsize=${o.text.title.px}:fontcolor=white:line_spacing=${L.title.lineSpacing}:x=${tx}:y=${titleY}:` +
    'shadowcolor=black@0.35:shadowx=0:shadowy=3')
  // The progress bar's dim track.
  draw.push(`drawbox=x=0:y=${H - L.bar.height}:w=${W}:h=${L.bar.height}:color=white@0.16:t=fill`)
  parts.push(`[base]${draw.join(',')}[out]`)
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    ...input,
    '-filter_complex', parts.join(';'),
    '-map', '[out]', '-frames:v', '1', '-update', '1', o.outPng,
  ]
}

export interface TrackVideoInput {
  backgroundPng: string
  audioPath: string
  durationSeconds: number
  encoder: VizEncoder
  outFile: string
  /** Where the text column starts (the visualizer sits under it). */
  hasArt: boolean
}

/** Pass 2: the looped background + visualizer + progress bar, encoded for YouTube. */
export function buildTrackVideoArgs(o: TrackVideoInput): string[] {
  const L = TRACK_LAYOUT
  const W = TRACK_WIDTH
  const H = TRACK_HEIGHT
  const fps = TRACK_FPS
  const dur = Math.max(0.1, o.durationSeconds).toFixed(3)
  const vx = o.hasArt ? L.text.x : L.text.noArtX
  const vw = o.hasArt ? L.viz.width : L.text.noArtWidth
  const vh = L.viz.height
  const barW = L.viz.barWidth
  const barGap = L.viz.barGap
  const bars = Math.floor(vw / barW)
  const graph = [
    // The still, decoded and converted to bt709 yuv420p once, then repeated (a looped image input would
    // decode and convert the PNG for every frame); the overlays below blend in yuv420p.
    `[0:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,loop=loop=-1:size=1:start=0,setpts=N/${fps}/TB[still]`,
    // Bars: showfreqs over the full width (log frequency, cube-root amplitude) of a mono mix tilted +3 dB
    // per octave around 1 kHz with +15 dB of gain, so a mix's natural bass-heavy slope reads as an even
    // row of moving bars; the gray floor (16) cut to 0 and the rest dimmed to 85 %, averaged down to one
    // pixel per bar and scaled up blocky, then multiplied with a still of vertical stripes for the gaps.
    // That is the alpha of a white layer, so the bars blend into the blurred background. All of it at
    // 960x240 in gray / yuva420p, never rgb.
    `[1:a]aformat=channel_layouts=mono,firequalizer=gain='${VIZ_GAIN_DB}+${VIZ_TILT_DB}*log(max(f,20)/1000)/log(2)',` +
      `showfreqs=s=${vw}x${vh}:rate=${fps}:mode=bar:ascale=cbrt:fscale=log:win_size=4096:averaging=2:colors=white,` +
      `format=gray,lut=c0='if(lt(val,24),0,val*0.85)',scale=${bars}:${vh}:flags=area,scale=${bars * barW}:${vh}:flags=neighbor[bars]`,
    `color=c=white:s=${bars * barW}x${vh}:r=${fps}:d=1,format=gray,drawgrid=w=${barW}:h=${vh}:t=${barGap}:color=black,` +
      `trim=end_frame=1,loop=loop=-1:size=1:start=0,setpts=N/${fps}/TB[gaps]`,
    '[bars][gaps]blend=all_mode=multiply:shortest=1[mask]',
    `color=c=white:s=${bars * barW}x${vh}:r=${fps},format=yuva420p[fill]`,
    '[fill][mask]alphamerge[viz]',
    `[still][viz]overlay=x=${vx}:y=${L.viz.y}:shortest=1:format=yuv420[v1]`,
    `color=c=white:s=${W}x${L.bar.height}:r=${fps}[bar]`,
    `[v1][bar]overlay=x='-w+w*t/${dur}':y=${H - L.bar.height}:shortest=1:format=yuv420,format=yuv420p[v]`,
  ].join(';')
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'warning', '-y', '-progress', 'pipe:1', '-nostats',
    '-i', o.backgroundPng, '-i', o.audioPath,
    '-filter_complex', graph,
    '-map', '[v]', '-map', '1:a:0', '-t', dur,
    '-r', String(fps),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    ...VIZ_ENC[o.encoder], '-g', String(gopFor(fps)), '-flags', '+cgop', '-pix_fmt', 'yuv420p',
    ...VIZ_AUDIO_ARGS,
    '-movflags', '+faststart', '-f', 'mp4', o.outFile,
  ]
}

// ---------------------------------------------------------------------------
// running it

function runFfmpeg(ffmpegPath: string, args: string[], durSec: number, onProgress: (p: number) => void, onLog: (l: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stderr = ''
    let buf = ''
    p.stdout.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
        const m = /^out_time_us=(\d+)/.exec(line)
        if (m && durSec > 0) onProgress(Math.min(100, (Number(m[1]) / 1e6 / durSec) * 100))
      }
    })
    p.stderr.on('data', (d) => { const s = d.toString(); stderr = (stderr + s).slice(-4000); s.split('\n').forEach((l: string) => { if (l.trim()) onLog(l.trim()) }) })
    p.on('error', reject)
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-1800)}`)))
  })
}

export interface RenderTrackOptions {
  ffmpegPath: string
  audioPath: string
  durationSeconds: number
  artworkPath: string | null
  artist: string | null
  title: string | null
  /** A directory of its own (never the download dir: its first file is taken as the audio). */
  dir: string
  outFile: string
  /** Tests / the CPU-only box: skip NVENC. */
  cpu?: boolean
  fontsDir?: string
}

/**
 * Render a track video. NVENC first, libx264 when it does not open — for this
 * render only: unlike renderVideo this never disables NVENC process-wide, as
 * a track renders beside a scene render's encode sessions and a session limit
 * hit here says nothing about the scene's encoder.
 */
export async function renderTrackVideo(o: RenderTrackOptions, onProgress: (percent: number) => void, onLog: (line: string) => void): Promise<{ encoder: VizEncoder; backgroundPng: string }> {
  mkdirSync(o.dir, { recursive: true })
  const hasArt = !!o.artworkPath
  const text = layoutTrackText(o.artist, o.title, hasArt)
  const artistFile = text.artist.lines.length ? join(o.dir, 'artist.txt') : null
  const titleFile = join(o.dir, 'title.txt')
  if (artistFile) writeFileSync(artistFile, text.artist.lines.join('\n'), 'utf8')
  writeFileSync(titleFile, text.title.lines.join('\n'), 'utf8')
  const backgroundPng = join(o.dir, 'bg.png')
  onLog(`track: background (${hasArt ? 'artwork' : 'no artwork'}; title ${text.title.lines.length} line(s) at ${text.title.px}px)`)
  await runFfmpeg(o.ffmpegPath, buildTrackBackgroundArgs({
    artworkPath: o.artworkPath, artistFile, titleFile, text, fontsDir: o.fontsDir ?? trackFontsDir(), outPng: backgroundPng,
  }), 0, () => {}, onLog)
  const encoders: VizEncoder[] = o.cpu || isNvencDisabled() ? ['x264'] : ['nvenc', 'x264']
  for (let i = 0; i < encoders.length; i++) {
    const encoder = encoders[i]!
    try {
      await runFfmpeg(o.ffmpegPath, buildTrackVideoArgs({ backgroundPng, audioPath: o.audioPath, durationSeconds: o.durationSeconds, encoder, outFile: o.outFile, hasArt }),
        o.durationSeconds, onProgress, onLog)
      return { encoder, backgroundPng }
    } catch (e: any) {
      if (encoder === 'nvenc' && i < encoders.length - 1) {
        onLog(`track: h264_nvenc failed (${String(e?.message || e).split('\n').pop()?.slice(0, 160)}), rendering this track with libx264`)
        continue
      }
      throw e
    }
  }
  throw new Error('track render: no encoder')
}
