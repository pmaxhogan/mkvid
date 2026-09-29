import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  vizTracksFromTracked, fetchArtwork, resolveVizTracks, sniffImage, artworkCacheKey, buildThumbnailArgs, downloadSetArtwork,
} from '../src/viz/assets.js'
import type { TrackedTrack } from '../src/types.js'

const tmp = mkdtempSync(join(tmpdir(), 'mkvid-assets-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }))

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46])

const t = (cueSeconds: number | null, artist: string | null, title: string | null, extra: Partial<TrackedTrack> = {}): TrackedTrack =>
  ({ cueSeconds, artist, title, artworkUrl: null, isId: false, ...extra })

describe('vizTracksFromTracked', () => {
  it('drops tracks without a cue, except the first, which starts at 0', () => {
    const out = vizTracksFromTracked([t(null, 'A', 'Intro'), t(120, 'B', 'Two'), t(null, 'C', 'Lost'), t(300, 'D', 'Four')])
    expect(out).toEqual([
      { startSeconds: 0, artist: 'A', title: 'Intro', artworkUrl: null },
      { startSeconds: 120, artist: 'B', title: 'Two', artworkUrl: null },
      { startSeconds: 300, artist: 'D', title: 'Four', artworkUrl: null },
    ])
  })
  it('names are always shown (tracked sends verified lists only): there is no names-hidden mode', () => {
    expect(vizTracksFromTracked.length).toBe(1)
    const out = vizTracksFromTracked([
      t(0, 'Real', 'Name', { artworkUrl: 'https://img.example/a.jpg' }),
      t(200, 'Other', 'Track', { artworkUrl: 'https://img.example/b.jpg' }),
    ])
    expect(out).toEqual([
      { startSeconds: 0, artist: 'Real', title: 'Name', artworkUrl: 'https://img.example/a.jpg' },
      { startSeconds: 200, artist: 'Other', title: 'Track', artworkUrl: 'https://img.example/b.jpg' },
    ])
  })
  it('an ID track has no names; artwork survives; blanks become null', () => {
    const out = vizTracksFromTracked([t(0, 'X', 'Y', { isId: true, artworkUrl: 'https://img.example/id.jpg' }), t(60, '  ', ' Title ')])
    expect(out).toEqual([
      { startSeconds: 0, artist: null, title: null, artworkUrl: 'https://img.example/id.jpg' },
      { startSeconds: 60, artist: null, title: 'Title', artworkUrl: null },
    ])
  })
  it('ignores junk entries, bad cues and non-http artwork, and tolerates a missing list', () => {
    const out = vizTracksFromTracked([
      t(100, 'first', 'x'), null as any, t(-3, 'neg', 'x'), t(Number.NaN, 'nan', 'x'),
      t(100, 'a', '1', { artworkUrl: 'javascript:alert(1)' }), t(500, 'b', '2', { artworkUrl: 'file:///etc/passwd' }),
    ])
    expect(out.map((x) => [x.startSeconds, x.artist, x.artworkUrl])).toEqual([[100, 'first', null], [100, 'a', null], [500, 'b', null]])
    expect(vizTracksFromTracked(undefined)).toEqual([])
    expect(vizTracksFromTracked(null)).toEqual([])
    expect(vizTracksFromTracked([])).toEqual([])
  })
  it('keeps list order: a non-layered track cued before the previous kept one is dropped, not reordered', () => {
    const out = vizTracksFromTracked([t(0, 'A', 'a'), t(300, 'B', 'b'), t(200, 'bad', 'data'), t(300, 'C', 'same cue'), t(400, 'D', 'd')])
    expect(out.map((x) => [x.startSeconds, x.artist])).toEqual([[0, 'A'], [300, 'B'], [300, 'C'], [400, 'D']])
  })
})

describe('vizTracksFromTracked: layered tracks', () => {
  const L = (cue: number | null, artist: string, extra: Partial<TrackedTrack> = {}) => t(cue, artist, 'w/', { layered: true, ...extra })
  const brief = (out: ReturnType<typeof vizTracksFromTracked>) => out.map((x) => [x.startSeconds, x.artist, x.layered === true])

  it('a missing layered field means not layered; layered is only set when true', () => {
    const out = vizTracksFromTracked([t(0, 'A', 'a'), t(60, 'B', 'b', { layered: false })])
    expect(out.every((x) => !('layered' in x))).toBe(true)
  })
  it('a layered entry without a cue is kept and starts with its base', () => {
    expect(brief(vizTracksFromTracked([t(0, 'A', 'a'), t(120, 'B', 'b'), L(null, 'B2'), L(null, 'B3'), t(300, 'C', 'c')])))
      .toEqual([[0, 'A', false], [120, 'B', false], [120, 'B2', true], [120, 'B3', true], [300, 'C', false]])
  })
  it('a layered entry with its own cue keeps it', () => {
    expect(brief(vizTracksFromTracked([t(0, 'A', 'a'), L(45, 'A2'), t(300, 'B', 'b')])))
      .toEqual([[0, 'A', false], [45, 'A2', true], [300, 'B', false]])
  })
  it('a layered cue earlier than its base is clamped to the base start', () => {
    expect(brief(vizTracksFromTracked([t(0, 'A', 'a'), t(200, 'B', 'b'), L(150, 'B2')])))
      .toEqual([[0, 'A', false], [200, 'B', false], [200, 'B2', true]])
  })
  it('a layered entry whose base was dropped (no cue, or cued out of order) is dropped', () => {
    expect(brief(vizTracksFromTracked([t(0, 'A', 'a'), t(null, 'gone', 'x'), L(90, 'orphan1'), L(null, 'orphan2'), t(300, 'B', 'b')])))
      .toEqual([[0, 'A', false], [300, 'B', false]])
    expect(brief(vizTracksFromTracked([t(0, 'A', 'a'), t(300, 'B', 'b'), t(100, 'bad', 'x'), L(310, 'orphan'), t(400, 'C', 'c')])))
      .toEqual([[0, 'A', false], [300, 'B', false], [400, 'C', false]])
  })
  it('the first kept track is never layered: a layered first entry becomes an ordinary track (at 0 without a cue)', () => {
    const out = vizTracksFromTracked([L(null, 'first'), L(30, 'on first'), t(100, 'B', 'b')])
    expect(brief(out)).toEqual([[0, 'first', false], [30, 'on first', true], [100, 'B', false]])
    expect('layered' in out[0]).toBe(false)
    expect(brief(vizTracksFromTracked([L(20, 'first')]))).toEqual([[20, 'first', false]])
  })
  it('layered tracks directly follow their base, in list order', () => {
    expect(brief(vizTracksFromTracked([t(0, 'A', 'a'), L(50, 'A3'), L(30, 'A2'), t(100, 'B', 'b'), L(null, 'B2')])))
      .toEqual([[0, 'A', false], [50, 'A3', true], [30, 'A2', true], [100, 'B', false], [100, 'B2', true]])
  })
  it('a layered track cued at or after the next base could never be shown and is dropped', () => {
    expect(brief(vizTracksFromTracked([t(0, 'A', 'a'), L(100, 'late'), L(150, 'later'), L(99, 'ok'), t(100, 'B', 'b')])))
      .toEqual([[0, 'A', false], [99, 'ok', true], [100, 'B', false]])
  })
  it('ID rows keep their cue, artwork and layering but no names', () => {
    const out = vizTracksFromTracked([
      t(0, 'A', 'a'), L(null, 'B', { artworkUrl: 'https://img.example/b.jpg', isId: true }), t(100, null, null, { isId: true }),
    ])
    expect(out).toEqual([
      { startSeconds: 0, artist: 'A', title: 'a', artworkUrl: null },
      { startSeconds: 0, artist: null, title: null, artworkUrl: 'https://img.example/b.jpg', layered: true },
      { startSeconds: 100, artist: null, title: null, artworkUrl: null },
    ])
  })
  it('resolveVizTracks carries layered through to the scene input', async () => {
    const out = await resolveVizTracks(vizTracksFromTracked([t(0, 'A', 'a'), L(null, 'B')]), join(tmp, 'c7'), { fetcher: fakeFetch(() => img(PNG)) })
    expect(out).toEqual([
      { startSeconds: 0, artist: 'A', title: 'a', artworkPath: null },
      { startSeconds: 0, artist: 'B', title: 'w/', artworkPath: null, layered: true },
    ])
  })
})

function fakeFetch(respond: (url: string) => Response): typeof fetch & { calls: string[] } {
  const calls: string[] = []
  const f = (async (input: any) => { const url = String(input); calls.push(url); return respond(url) }) as typeof fetch & { calls: string[] }
  f.calls = calls
  return f
}
const img = (body: Uint8Array, type = 'image/png', headers: Record<string, string> = {}) =>
  new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': type, ...headers } })

describe('fetchArtwork', () => {
  it('downloads an image into the cache under the hash of its URL, then serves it from there', async () => {
    const cache = join(tmp, 'c1')
    const f = fakeFetch(() => img(PNG))
    const url = 'https://img.example/cover.png?size=500'
    const p = await fetchArtwork(url, cache, { fetcher: f })
    expect(p).toBe(join(cache, `${artworkCacheKey(url)}.png`))
    expect(readFileSync(p!)).toEqual(PNG)
    expect(await fetchArtwork(url, cache, { fetcher: f })).toBe(p)
    expect(f.calls).toHaveLength(1)
  })
  it('names the file by what the bytes are, not the content-type', async () => {
    const p = await fetchArtwork('https://img.example/x', join(tmp, 'c2'), { fetcher: fakeFetch(() => img(JPG, 'image/png')) })
    expect(p).toMatch(/\.jpg$/)
  })
  it('rejects non-image content types, and image types whose bytes are not an image', async () => {
    const cache = join(tmp, 'c3')
    expect(await fetchArtwork('https://img.example/a', cache, { fetcher: fakeFetch(() => new Response('<html>', { headers: { 'content-type': 'text/html' } })) })).toBeNull()
    expect(await fetchArtwork('https://img.example/b', cache, { fetcher: fakeFetch(() => img(PNG, 'image/svg+xml')) })).toBeNull()
    expect(await fetchArtwork('https://img.example/c', cache, { fetcher: fakeFetch(() => img(Buffer.from('<html>hi</html>'), 'image/jpeg')) })).toBeNull()
    expect(await fetchArtwork('https://img.example/d', cache, { fetcher: fakeFetch(() => new Response(new Uint8Array(PNG))) })).toBeNull()
    expect(existsSync(cache)).toBe(false)
  })
  it('rejects oversized responses, declared or streamed', async () => {
    const cache = join(tmp, 'c4')
    const big = Buffer.concat([PNG, Buffer.alloc(2000)])
    const declared = fakeFetch(() => img(PNG, 'image/png', { 'content-length': '999999' }))
    expect(await fetchArtwork('https://img.example/big1', cache, { fetcher: declared, maxBytes: 1000 })).toBeNull()
    const streamed = fakeFetch(() => img(big))
    expect(await fetchArtwork('https://img.example/big2', cache, { fetcher: streamed, maxBytes: 1000 })).toBeNull()
    expect(await fetchArtwork('https://img.example/ok', cache, { fetcher: fakeFetch(() => img(big)), maxBytes: 5000 })).not.toBeNull()
  })
  it('never throws: HTTP errors, network errors, timeouts, bad and non-http URLs return null', async () => {
    const cache = join(tmp, 'c5')
    const logs: string[] = []
    expect(await fetchArtwork('https://img.example/404', cache, { fetcher: fakeFetch(() => new Response('no', { status: 404 })), onLog: (l) => logs.push(l) })).toBeNull()
    expect(await fetchArtwork('https://img.example/net', cache, { fetcher: (async () => { throw new TypeError('fetch failed') }) as any })).toBeNull()
    const slow = (async (_u: any, init: any) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))) as any
    expect(await fetchArtwork('https://img.example/slow', cache, { fetcher: slow, timeoutMs: 50 })).toBeNull()
    const never = fakeFetch(() => img(PNG))
    for (const bad of ['not a url', 'file:///etc/passwd', 'ftp://x/y.png', 'data:image/png;base64,AAAA']) {
      expect(await fetchArtwork(bad, cache, { fetcher: never })).toBeNull()
    }
    expect(never.calls).toEqual([])
    expect(logs.join('\n')).toMatch(/HTTP 404/)
  })
  it('sniffs the common formats', () => {
    expect(sniffImage(PNG)).toBe('png')
    expect(sniffImage(JPG)).toBe('jpg')
    expect(sniffImage(Buffer.from('GIF89a'))).toBe('gif')
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp')
    expect(sniffImage(Buffer.from('\0\0\0\x1cftypavif'))).toBe('avif')
    expect(sniffImage(Buffer.from('hello world!'))).toBeNull()
  })
})

describe('resolveVizTracks', () => {
  it('downloads each distinct URL once and falls back to null per track', async () => {
    const f = fakeFetch((url) => (url.endsWith('bad') ? new Response('x', { status: 500 }) : img(PNG)))
    const out = await resolveVizTracks([
      { startSeconds: 0, artist: 'A', title: 'a', artworkUrl: 'https://img.example/same' },
      { startSeconds: 10, artist: 'B', title: 'b', artworkUrl: 'https://img.example/same' },
      { startSeconds: 20, artist: null, title: null, artworkUrl: 'https://img.example/bad' },
      { startSeconds: 30, artist: null, title: null, artworkUrl: null },
    ], join(tmp, 'c6'), { fetcher: f })
    expect(f.calls.sort()).toEqual(['https://img.example/bad', 'https://img.example/same'])
    expect(out[0].artworkPath).toBeTruthy()
    expect(out[1].artworkPath).toBe(out[0].artworkPath)
    expect(out[2].artworkPath).toBeNull()
    expect(out[3]).toEqual({ startSeconds: 30, artist: null, title: null, artworkPath: null })
  })
})

describe('set artwork via yt-dlp', () => {
  it('writes only set-artwork.* into its own directory', () => {
    const a = buildThumbnailArgs({ url: 'https://soundcloud.com/x/y', outDir: '/w/viz', ffmpegPath: '/usr/lib/jellyfin-ffmpeg/ffmpeg' })
    expect(a).toEqual(['--no-playlist', '--skip-download', '--write-thumbnail', '--convert-thumbnails', 'jpg',
      '--ffmpeg-location', '/usr/lib/jellyfin-ffmpeg/ffmpeg', '-o', join('/w/viz', 'set-artwork.%(ext)s'), '--', 'https://soundcloud.com/x/y'])
    expect(buildThumbnailArgs({ url: 'https://x', outDir: 'd', ffmpegPath: 'ffmpeg' })).not.toContain('--ffmpeg-location')
  })
  it('a missing yt-dlp gives null, and nothing throws later even if the directory is gone', async () => {
    const outDir = join(tmp, 'thumb')
    const logs: string[] = []
    const p = downloadSetArtwork({ ytdlpPath: join(tmp, 'no-such-yt-dlp'), url: 'https://soundcloud.com/x/y', outDir }, (l) => logs.push(l))
    rmSync(outDir, { recursive: true, force: true })
    expect(await p).toBeNull()
    await new Promise((r) => setTimeout(r, 200)) // a late 'close' must not throw
    expect(logs.join('\n')).toMatch(/set artwork/)
  })
})
