import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildTrackBackgroundArgs,
  buildTrackVideoArgs,
  cleanText,
  ffEscape,
  fitText,
  layoutTrackText,
  pickTrackFont,
  textPositions,
  trackFontsDir,
  TRACK_LAYOUT,
  resolveTrackNames,
} from '../src/lib/track-render.js'

const graphOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1]!

describe('ffEscape', () => {
  it('escapes a path for an option value inside -filter_complex (two levels)', () => {
    expect(ffEscape('/data/work/abc/track/title.txt')).toBe('/data/work/abc/track/title.txt')
    // `:` -> `\:` for the option parser, then the backslash again for the graph parser.
    expect(ffEscape('C:\\Users\\x\\a.ttf')).toBe(String.raw`C\\:/Users/x/a.ttf`)
    expect(ffEscape("/tmp/it's [1],2;3")).toBe("/tmp/it\\\\\\'s \\[1\\]\\,2\\;3")
  })
})

describe('text fitting', () => {
  it('cleanText drops control characters and collapses whitespace', () => {
    expect(cleanText(' A\n\tB\u0000C  ')).toBe('A B C')
    expect(cleanText(null)).toBe('')
  })

  it('keeps a short title on one line at the largest size', () => {
    expect(fitText('Demo Track 1', { widthPx: 960, maxPx: 84, minPx: 48, maxLines: 2 })).toEqual({ lines: ['Demo Track 1'], px: 84 })
  })

  it('wraps a long title into at most two lines, shrinking first', () => {
    const r = fitText('Tobehonest (Where Ya At) [Extended Mix]', { widthPx: 960, maxPx: 84, minPx: 48, maxLines: 2 })
    expect(r.lines.length).toBe(2)
    expect(r.lines.join(' ')).toBe('Tobehonest (Where Ya At) [Extended Mix]')
    expect(r.px).toBeLessThanOrEqual(84)
  })

  it('cuts a title that does not fit at the smallest size with an ellipsis', () => {
    const long = 'Word '.repeat(80).trim()
    const r = fitText(long, { widthPx: 960, maxPx: 84, minPx: 48, maxLines: 2 })
    expect(r.px).toBe(48)
    expect(r.lines.length).toBe(2)
    expect(r.lines[1]!.endsWith('…')).toBe(true)
  })

  it('breaks a single word wider than a line', () => {
    const r = fitText('A'.repeat(200), { widthPx: 400, maxPx: 40, minPx: 40, maxLines: 2 })
    expect(r.lines.length).toBe(2)
    expect(r.lines[1]!.endsWith('…')).toBe(true)
  })

  it('layoutTrackText: artist one line, title up to two; no artist line when it is empty', () => {
    const t = layoutTrackText('Odd Mob', 'Tobehonest', true)
    expect(t.artist.lines).toEqual(['Odd Mob'])
    expect(t.title.lines).toEqual(['Tobehonest'])
    expect(layoutTrackText(null, 'Only Title', true).artist.lines).toEqual([])
    // No title at all: the artist becomes the title, once.
    const a = layoutTrackText('Just Artist', null, true)
    expect(a.title.lines).toEqual(['Just Artist'])
    expect(a.artist.lines).toEqual([])
  })

  it('centres the text block between the artwork top and the visualizer', () => {
    const one = textPositions(layoutTrackText('A', 'B', true))
    const two = textPositions(layoutTrackText('A', 'A rather long title that will need two lines here', true))
    expect(one.titleY).toBeGreaterThan(one.artistY)
    expect(two.artistY).toBeLessThan(one.artistY)
    expect(two.artistY).toBeGreaterThanOrEqual(TRACK_LAYOUT.block.top)
  })

  it('picks a font that has the script: Noto for CJK / Arabic / Hebrew / Thai / Devanagari, else Inter', () => {
    expect(pickTrackFont('Hello', 'bold')).toBe('inter/InterDisplay-Bold.ttf')
    expect(pickTrackFont('Привет', 'medium')).toBe('inter/Inter-Medium.ttf')
    expect(pickTrackFont('東京 Remix', 'bold')).toBe('noto/NotoSansJP-Bold.otf')
    expect(pickTrackFont('서울', 'bold')).toBe('noto/NotoSansKR-Bold.otf')
    expect(pickTrackFont('حبيبي', 'medium')).toBe('noto/NotoSansArabic-Regular.ttf')
    expect(pickTrackFont('שלום', 'bold')).toBe('noto/NotoSansHebrew-Bold.ttf')
    expect(pickTrackFont('สวัสดี', 'bold')).toBe('noto/NotoSansThai-Bold.ttf')
    expect(pickTrackFont('नमस्ते', 'bold')).toBe('noto/NotoSansDevanagari-Bold.ttf')
  })

  it('every font it can pick is bundled', () => {
    const dir = trackFontsDir()
    for (const s of ['Hello', '東京', '서울', 'حبيبي', 'שלום', 'สวัสดี', 'नमस्ते']) {
      for (const w of ['bold', 'medium'] as const) expect(existsSync(join(dir, pickTrackFont(s, w)))).toBe(true)
    }
  })
})

describe('buildTrackBackgroundArgs', () => {
  const text = layoutTrackText('Artist: "Name"', "Title's [Remix], 100%", true)
  const base = { artistFile: '/w/track/artist.txt', titleFile: '/w/track/title.txt', text, fontsDir: '/app/assets/fonts', outPng: '/w/track/bg.png' }

  it('with artwork: cover background blurred and darkened, a 560 px sharp square, text from files', () => {
    const args = buildTrackBackgroundArgs({ ...base, artworkPath: '/w/track/set-artwork.jpg' })
    expect(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2)).toEqual(['-i', '/w/track/set-artwork.jpg'])
    const g = graphOf(args)
    expect(g).toContain('scale=1920:1080:force_original_aspect_ratio=increase')
    expect(g).toContain('crop=1920:1080')
    expect(g).toMatch(/gblur=sigma=\d+/)
    expect(g).toContain('scale=560:560:force_original_aspect_ratio=increase')
    expect(g).toContain('crop=560:560')
    expect(g).toContain(`overlay=x=${TRACK_LAYOUT.art.x}:y=${TRACK_LAYOUT.art.y}`)
    // Text never enters the graph: textfile + expansion=none, so quotes, colons, brackets and % need no escaping.
    expect(g).toContain('textfile=/w/track/artist.txt:expansion=none')
    expect(g).toContain('textfile=/w/track/title.txt:expansion=none')
    expect(g).not.toContain('Remix')
    expect(g).toContain('fontfile=/app/assets/fonts/inter/InterDisplay-Bold.ttf')
    expect(g).toContain('fontfile=/app/assets/fonts/inter/Inter-Medium.ttf')
    expect(g).toContain(`x=${TRACK_LAYOUT.text.x}`)
    expect(args.slice(-5)).toEqual(['-map', '[out]', '-frames:v', '1', '-update', '1', '/w/track/bg.png'].slice(-5))
    expect(args.at(-1)).toBe('/w/track/bg.png')
  })

  it('without artwork: a solid lavfi background, the text takes the whole width', () => {
    const args = buildTrackBackgroundArgs({ ...base, text: layoutTrackText('A', 'B', false), artworkPath: null })
    expect(args).toContain('lavfi')
    expect(args.find((a) => a.startsWith('color='))).toMatch(/^color=c=0x[0-9a-f]{6}:s=1920x1080/)
    const g = graphOf(args)
    expect(g).not.toContain('gblur')
    expect(g).toContain(`x=${TRACK_LAYOUT.text.noArtX}`)
  })

  it('escapes Windows-style paths in fontfile / textfile', () => {
    const g = graphOf(buildTrackBackgroundArgs({ ...base, artworkPath: null, fontsDir: 'C:\\fonts', titleFile: 'C:\\w\\title.txt' }))
    expect(g).toContain(String.raw`fontfile=C\\:/fonts/inter/InterDisplay-Bold.ttf`)
    expect(g).toContain(String.raw`textfile=C\\:/w/title.txt`)
  })

  it('leaves the artist line out when there is none', () => {
    const g = graphOf(buildTrackBackgroundArgs({ ...base, artistFile: null, text: layoutTrackText(null, 'T', true), artworkPath: null }))
    expect(g.match(/drawtext=/g)!.length).toBe(1)
  })
})

describe('buildTrackVideoArgs', () => {
  const o = { backgroundPng: '/w/track/bg.png', audioPath: '/w/a.opus', durationSeconds: 245.5, outFile: '/w/out.mp4', hasArt: true }

  it('inputs: the background then the audio; the audio is mapped as is and the output cut to the duration', () => {
    const args = buildTrackVideoArgs({ ...o, encoder: 'nvenc' })
    const inputs = args.flatMap((a, i) => (a === '-i' ? [args[i + 1]] : []))
    expect(inputs).toEqual(['/w/track/bg.png', '/w/a.opus'])
    expect(args.join(' ')).toContain('-map [v] -map 1:a:0 -t 245.500')
  })

  it('draws a 960x240 showfreqs visualizer under the text column, 30 fps, and a progress bar driven by t/duration', () => {
    const g = graphOf(buildTrackVideoArgs({ ...o, encoder: 'nvenc' }))
    expect(g).toContain('loop=loop=-1:size=1:start=0,setpts=N/30/TB')
    expect(g).toContain('showfreqs=s=960x240:rate=30')
    expect(g).toContain('alphamerge')
    expect(g).toContain(`overlay=x=${TRACK_LAYOUT.text.x}:y=${TRACK_LAYOUT.viz.y}:shortest=1`)
    expect(g).toContain("overlay=x='-w+w*t/245.500':y=1074")
    expect(g).toContain('color=c=white:s=1920x6:r=30')
    expect(g).toMatch(/format=yuv420p\[v\]$/)
  })

  it('without artwork the visualizer spans the wide column', () => {
    const g = graphOf(buildTrackVideoArgs({ ...o, hasArt: false, encoder: 'x264' }))
    expect(g).toContain(`showfreqs=s=${TRACK_LAYOUT.text.noArtWidth}x240`)
    expect(g).toContain(`overlay=x=${TRACK_LAYOUT.text.noArtX}:y=`)
  })

  it('encodes to YouTube spec: H.264 High, closed GOP of fps/2, bt709 yuv420p, AAC-LC 192k 48 kHz stereo, faststart', () => {
    for (const encoder of ['nvenc', 'x264'] as const) {
      const a = buildTrackVideoArgs({ ...o, encoder }).join(' ')
      expect(a).toContain(encoder === 'nvenc' ? '-c:v h264_nvenc' : '-c:v libx264')
      expect(a).toContain('-profile:v high')
      expect(a).toContain('-g 15 -flags +cgop')
      expect(a).toContain('-pix_fmt yuv420p')
      expect(a).toContain('-colorspace bt709')
      expect(a).toContain('-c:a aac -b:a 192k -ar 48000 -ac 2')
      expect(a).toContain('-movflags +faststart')
      expect(a).toContain('-r 30')
      expect(a.endsWith('-f mp4 /w/out.mp4')).toBe(true)
    }
  })
})

describe('resolveTrackNames: a track video is never "Unknown track"', () => {
  const src = (o: Partial<{ title: string; track: string; artist: string; creator: string; uploader: string }>) => ({ title: null, track: null, artist: null, creator: null, uploader: null, ...o })
  it("tracked's names win", () => {
    expect(resolveTrackNames({ artist: 'A', title: 'T' }, src({ title: 'X - Y' }), 'f')).toEqual({ artist: 'A', title: 'T', from: 'tracked' })
  })
  it('a pre-save saved by id alone: an "Artist - Title" source title is split (the SoundCloud case)', () => {
    expect(resolveTrackNames({ artist: null, title: null }, src({ title: "Beltran - Smack Yo' (Danny Avila Remix)", track: "Beltran - Smack Yo' (Danny Avila Remix)", artist: 'DANNY AVILA REMIXES', uploader: 'DANNY AVILA REMIXES' }), 'f')).toEqual({
      artist: 'Beltran',
      title: "Smack Yo' (Danny Avila Remix)",
      from: 'source',
    })
  })
  it('no dash: the track field and the artist field, then the title and the uploader', () => {
    expect(resolveTrackNames({ artist: null, title: null }, src({ title: 'whatever', track: 'Song', artist: 'Band' }), 'f')).toEqual({ artist: 'Band', title: 'Song', from: 'source' })
    expect(resolveTrackNames({ artist: null, title: null }, src({ title: 'Song', uploader: 'someone' }), 'f')).toEqual({ artist: 'someone', title: 'Song', from: 'source' })
  })
  it('no metadata: the download title, split when it can be', () => {
    expect(resolveTrackNames({ artist: null, title: null }, null, 'Foo – Bar')).toEqual({ artist: 'Foo', title: 'Bar', from: 'fallback' })
    expect(resolveTrackNames({ artist: null, title: null }, src({}), 'just a name')).toEqual({ artist: null, title: 'just a name', from: 'fallback' })
  })
})
