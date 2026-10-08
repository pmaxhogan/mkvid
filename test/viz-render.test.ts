import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  planSegments, frameCountFor, segmentFileName, buildSegmentArgs, buildAssembleArgs, encodeSignature, VIZ_AUDIO_ARGS,
  openManifest, readManifest, writeManifest, renderScene, renderSegments, colourSelfTest, hashInput, legacyHashInput, rebaseVizInput, type VizFingerprint,
} from '../src/viz/render.js'
import type { VizInput } from '../src/viz/types.js'
import { loadConfig } from '../src/config.js'
import { buildContext } from '../src/context.js'
import { sceneCodeVersion } from '../src/viz/render.js'
import { claimSceneResume, isRenderComplete, readSourceRecord, writeSourceRecord, loadVizInput, rebaseKeptInput, migrateInputStamps } from '../src/lib/pipeline.js'

const tmp = mkdtempSync(join(tmpdir(), 'mkvid-viz-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }))

describe('planSegments', () => {
  it('cuts into fps*seconds frames with a shorter last segment', () => {
    expect(planSegments(4000, 30, 60)).toEqual([
      { index: 0, startFrame: 0, endFrame: 1800 },
      { index: 1, startFrame: 1800, endFrame: 3600 },
      { index: 2, startFrame: 3600, endFrame: 4000 },
    ])
  })
  it('an exact multiple has no empty tail', () => {
    const s = planSegments(3600, 30, 60)
    expect(s).toHaveLength(2)
    expect(s[1]).toEqual({ index: 1, startFrame: 1800, endFrame: 3600 })
  })
  it('handles nothing, one frame, and less than one segment', () => {
    expect(planSegments(0, 30)).toEqual([])
    expect(planSegments(-5, 30)).toEqual([])
    expect(planSegments(1, 30)).toEqual([{ index: 0, startFrame: 0, endFrame: 1 }])
    expect(planSegments(90, 30, 60)).toEqual([{ index: 0, startFrame: 0, endFrame: 90 }])
  })
  it('never plans an empty segment for tiny segment lengths, and covers every frame once', () => {
    const s = planSegments(10, 30, 0.001)
    expect(s).toHaveLength(10)
    const s2 = planSegments(432_001, 30, 60)   // 4 h + 1 frame
    expect(s2).toHaveLength(241)
    expect(s2.at(-1)).toEqual({ index: 240, startFrame: 432_000, endFrame: 432_001 })
    for (let i = 1; i < s2.length; i++) expect(s2[i].startFrame).toBe(s2[i - 1].endFrame)
  })
  it('floors a fractional frame count and rejects nonsense', () => {
    expect(planSegments(2.9, 1, 1)).toHaveLength(2)
    expect(() => planSegments(10, 0)).toThrow()
    expect(() => planSegments(10, 30, 0)).toThrow()
    expect(() => planSegments(10, Number.NaN)).toThrow()
  })
  it('frameCountFor covers the last partial frame', () => {
    expect(frameCountFor(3, 30)).toBe(90)
    expect(frameCountFor(3.01, 30)).toBe(91)
    expect(frameCountFor(0, 30)).toBe(1)
  })
})

describe('ffmpeg arguments', () => {
  it('segment: raw rgba on stdin, video only, closed GOP, temp output', () => {
    const a = buildSegmentArgs({ width: 1920, height: 1080, fps: 30, encoder: 'x264', outFile: '/w/seg-00001.mp4.partial' })
    expect(a.join(' ')).toContain('-f rawvideo -pix_fmt rgba -s 1920x1080 -r 30 -i pipe:0 -an')
    expect(a.join(' ')).toContain('-c:v libx264')
    expect(a.join(' ')).toContain('-b:v 8M -maxrate 12M -bufsize 16M -profile:v high -coder 1 -bf 2')
    expect(a.join(' ')).toContain('-g 15 -flags +cgop')
    expect(a.slice(-3)).toEqual(['-f', 'mp4', '/w/seg-00001.mp4.partial'])
    const n = buildSegmentArgs({ width: 1920, height: 1080, fps: 30, encoder: 'nvenc', outFile: 'x' })
    expect(n.join(' ')).toContain('-c:v h264_nvenc -preset p6 -tune hq -rc vbr -b:v 8M -maxrate 12M -bufsize 16M')
    expect(n.join(' ')).toContain('-profile:v high -coder cabac -bf 2 -g 15 -flags +cgop')
    expect(n).not.toContain('-cq')
  })
  it('YouTube 1080p30 settings: closed GOP of half the frame rate, signature follows it', () => {
    expect(buildSegmentArgs({ width: 64, height: 36, fps: 60, encoder: 'x264', outFile: 'x' }).join(' ')).toContain('-g 30 ')
    expect(encodeSignature('nvenc', 30)).toMatch(/-b:v 8M .* -g 15$/)
    expect(encodeSignature('nvenc', 30)).not.toBe(encodeSignature('nvenc', 60))
    expect(VIZ_AUDIO_ARGS).toEqual(['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'])
  })
  it('assemble: stream-copied video, audio args as given, faststart; a window seeks the audio', () => {
    const a = buildAssembleArgs({ listFile: 'l.txt', audioPath: 'a.m4a', audioArgs: ['-c:a', 'copy'], outFile: 'o.mp4' })
    expect(a.join(' ')).toContain('-f concat -safe 0 -i l.txt -i a.m4a -map 0:v:0 -map 1:a:0 -c:v copy -c:a copy')
    // No edit lists, moov first.
    expect(a.join(' ')).toContain('-use_editlist 0 -movflags +faststart+negative_cts_offsets -f mp4 o.mp4')
    const w = buildAssembleArgs({ listFile: 'l.txt', audioPath: 'a.m4a', audioArgs: ['-c:a', 'aac'], outFile: 'o.mp4', audioStart: 12.5, audioDuration: 20 })
    expect(w.join(' ')).toContain('-ss 12.500 -t 20.000 -i a.m4a')
  })
})

const fp: VizFingerprint = {
  audioSize: 100, audioMtimeMs: 1, fps: 30, width: 64, height: 36, segmentSeconds: 1,
  inputHash: 'h', sceneVersion: 'v1', encoder: 'x264', encodeArgs: 'e', ffmpegVersion: 'ffmpeg version 7',
}

describe('manifest / resume', () => {
  function dirWithTwoSegments(): string {
    const d = mkdtempSync(join(tmp, 'm-'))
    writeFileSync(join(d, segmentFileName(0)), 'aaaa')
    writeFileSync(join(d, segmentFileName(1)), 'bbbbbb')
    writeFileSync(join(d, 'analysis.bin'), 'x')
    writeManifest(d, { version: 1, fingerprint: fp, segments: { 0: { frames: 30, bytes: 4, extradata: 'e' }, 1: { frames: 30, bytes: 6, extradata: 'e' } } })
    return d
  }
  it('keeps finished segments when the fingerprint matches', () => {
    const d = dirWithTwoSegments()
    const m = openManifest(d, { ...fp })
    expect(Object.keys(m.segments).sort()).toEqual(['0', '1'])
    expect(existsSync(join(d, 'analysis.bin'))).toBe(true)
  })
  it('discards segments and the analysis when any part of the fingerprint differs', () => {
    for (const change of [{ audioSize: 101 }, { audioMtimeMs: 2 }, { inputHash: 'other' }, { sceneVersion: 'v2' }, { encoder: 'nvenc' as const }, { fps: 25 }, { ffmpegVersion: 'ffmpeg version 8' }]) {
      const d = dirWithTwoSegments()
      const logs: string[] = []
      const m = openManifest(d, { ...fp, ...change }, (l) => logs.push(l))
      expect(m.segments).toEqual({})
      expect(readdirSync(d).filter((f) => f.startsWith('seg-'))).toEqual([])
      expect(existsSync(join(d, 'analysis.bin'))).toBe(false)
      expect(logs.join('\n')).toMatch(/discarding 2/)
      expect(readManifest(d)!.fingerprint).toMatchObject(change)
    }
  })
  it('ignores and deletes partial files; forgets a segment whose file is missing or the wrong size', () => {
    const d = dirWithTwoSegments()
    writeFileSync(join(d, segmentFileName(2) + '.partial'), 'half')
    writeFileSync(join(d, segmentFileName(1)), 'truncated-or-different')
    const m = openManifest(d, { ...fp })
    expect(Object.keys(m.segments)).toEqual(['0'])
    expect(existsSync(join(d, segmentFileName(2) + '.partial'))).toBe(false)
    const d2 = dirWithTwoSegments()
    rmSync(join(d2, segmentFileName(0)))
    expect(Object.keys(openManifest(d2, { ...fp }).segments)).toEqual(['1'])
  })
  it('the input hash (track list part of the fingerprint) changes with layered, cues and names', () => {
    const base: VizInput = {
      audioPath: '/a.m4a', durationSeconds: 60, setTitle: 'S', setArtist: null, setArtworkPath: null, width: 64, height: 36, fps: 30,
      tracks: [{ startSeconds: 0, artist: 'A', title: 'a', artworkPath: null }, { startSeconds: 0, artist: 'B', title: 'b', artworkPath: null }],
    }
    const h = hashInput(base)
    expect(hashInput({ ...base, tracks: [base.tracks[0], { ...base.tracks[1], layered: true }] })).not.toBe(h)
    expect(hashInput({ ...base, tracks: [base.tracks[0], { ...base.tracks[1], startSeconds: 1 }] })).not.toBe(h)
    expect(hashInput({ ...base, tracks: [base.tracks[0], { ...base.tracks[1], title: null }] })).not.toBe(h)
    expect(hashInput({ ...base, audioPath: '/elsewhere.m4a' })).toBe(h)
  })
  it('the input hash ignores where the artwork lives, but not its bytes', () => {
    const d = mkdtempSync(join(tmp, 'art-'))
    for (const [f, body] of [['a1.jpg', 'pic'], ['a2.jpg', 'pic'], ['b.jpg', 'other pic']]) writeFileSync(join(d, f), body)
    const base: VizInput = {
      audioPath: join(d, 'a.m4a'), durationSeconds: 60, setTitle: 'S', setArtist: null, setArtworkPath: join(d, 'a1.jpg'), width: 64, height: 36, fps: 30,
      tracks: [{ startSeconds: 0, artist: 'A', title: 'a', artworkPath: join(d, 'a1.jpg') }],
    }
    const h = hashInput(base)
    expect(hashInput({ ...base, setArtworkPath: join(d, 'a2.jpg') })).toBe(h)
    expect(hashInput({ ...base, tracks: [{ ...base.tracks[0], artworkPath: join(d, 'a2.jpg') }] })).toBe(h)
    expect(hashInput({ ...base, setArtworkPath: join(d, 'b.jpg') })).not.toBe(h)
    expect(hashInput({ ...base, setArtworkPath: null })).not.toBe(h)
    expect(hashInput(rebaseVizInput(base, d, join(tmp, 'elsewhere')))).not.toBe(h) // the files are not there: missing counts
  })
  it('a kept work dir renamed to the retry\'s id: the saved input follows it, and old stamps move to the new hash', () => {
    const root = mkdtempSync(join(tmp, 'adopt-'))
    const oldDir = join(root, 'old-job'); const newDir = join(root, 'new-job')
    const artCache = mkdtempSync(join(tmp, 'artcache-'))
    mkdirSync(join(oldDir, 'viz'), { recursive: true })
    writeFileSync(join(oldDir, 'set.m4a'), 'audio')
    writeFileSync(join(oldDir, 'viz', 'set-artwork.jpg'), 'set pic')
    writeFileSync(join(artCache, 't1.jpg'), 'track pic')
    const input: VizInput = {
      audioPath: join(oldDir, 'set.m4a'), durationSeconds: 60, setTitle: 'S', setArtist: 'DJ',
      setArtworkPath: join(oldDir, 'viz', 'set-artwork.jpg'), width: 64, height: 36, fps: 30,
      tracks: [{ startSeconds: 0, artist: 'A', title: 'a', artworkPath: join(artCache, 't1.jpg') }],
    }
    writeFileSync(join(oldDir, 'viz', 'input.json'), JSON.stringify(input))
    // Stamps as the previous version wrote them (paths in the hash).
    const legacy = legacyHashInput(input)
    expect(legacy).not.toBe(hashInput(input))
    writeManifest(join(oldDir, 'viz'), { version: 1, fingerprint: { ...fp, inputHash: legacy }, segments: { 0: { frames: 1800, bytes: 5 } as any } })
    writeFileSync(join(oldDir, 'viz', 'rendered.json'), JSON.stringify({ inputHash: legacy, sceneVersion: 'v', bytes: 18 }))

    renameSync(oldDir, newDir)
    expect(loadVizInput(join(newDir, 'viz'), join(newDir, 'set.m4a'))).toBeNull() // the bug: stored paths point at old-job
    rebaseKeptInput(oldDir, newDir)
    const loaded = loadVizInput(join(newDir, 'viz'), join(newDir, 'set.m4a'))
    expect(loaded).not.toBeNull()
    expect(loaded!.setArtworkPath).toBe(join(newDir, 'viz', 'set-artwork.jpg'))
    expect(loaded!.tracks[0].artworkPath).toBe(join(artCache, 't1.jpg')) // the shared cache is not moved
    expect(readManifest(join(newDir, 'viz'))!.fingerprint.inputHash).toBe(hashInput(loaded!))
    expect(Object.keys(readManifest(join(newDir, 'viz'))!.segments)).toEqual(['0'])
    expect(JSON.parse(readFileSync(join(newDir, 'viz', 'rendered.json'), 'utf8')).inputHash).toBe(hashInput(loaded!))
  })
  it('stamps from before the hash change are moved in place on a plain resume; other hashes are left alone', () => {
    const d = mkdtempSync(join(tmp, 'stamps-'))
    writeManifest(d, { version: 1, fingerprint: { ...fp, inputHash: 'old' }, segments: {} })
    writeFileSync(join(d, 'rendered.json'), JSON.stringify({ inputHash: 'old', bytes: 1 }))
    migrateInputStamps(d, 'unrelated', 'new')
    expect(readManifest(d)!.fingerprint.inputHash).toBe('old')
    migrateInputStamps(d, 'old', 'new')
    expect(readManifest(d)!.fingerprint.inputHash).toBe('new')
    expect(JSON.parse(readFileSync(join(d, 'rendered.json'), 'utf8')).inputHash).toBe('new')
  })
  it('an unreadable manifest starts over', () => {
    const d = dirWithTwoSegments()
    writeFileSync(join(d, 'manifest.json'), '{ nope')
    expect(openManifest(d, { ...fp }).segments).toEqual({})
    expect(readdirSync(d).filter((f) => f.startsWith('seg-'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// end to end with a fake scene

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe'
function hasTools(): boolean {
  try {
    const enc = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    execFileSync(ffprobe, ['-version'], { stdio: 'ignore' })
    return /libx264/.test(enc) && /\baac\b/.test(enc)
  } catch {
    return false
  }
}
const tools = hasTools()
if (!tools) console.warn(`viz-render: skipping end-to-end tests (${ffmpeg} missing or without libx264; set FFMPEG_PATH/FFPROBE_PATH)`)

const FAKE_SCENE = `
export async function createScene(input) {
  const buf = new Uint8Array(input.width * input.height * 4)
  const failAt = Number(input.setTitle.match(/fail@(\\d+)/)?.[1] ?? -1)
  const hangAt = Number(input.setTitle.match(/hang@(\\d+)/)?.[1] ?? -1)
  return {
    drawFrame(i) {
      if (i === failAt) throw new Error('boom at ' + i)
      if (i === hangAt) for (;;) { /* a scene stuck forever */ }
      const v = (i * 7) % 256
      for (let p = 0; p < buf.length; p += 4) { buf[p] = v; buf[p + 1] = 255 - v; buf[p + 2] = (i * 3) % 256; buf[p + 3] = 255 }
      return buf
    },
    dispose() {},
  }
}
`

describe.skipIf(!tools)('renderScene end to end (fake scene, libx264)', () => {
  const dir = join(tmp, 'e2e')
  const audio = join(dir, 'set.m4a')
  const sceneModule = pathToFileURL(join(dir, 'fake-scene.mjs')).href
  const input = (title = 'Test set'): VizInput => ({
    audioPath: audio, durationSeconds: 3, setTitle: title, setArtist: null, setArtworkPath: null,
    tracks: [], width: 64, height: 36, fps: 30,
  })
  const base = (vizDir: string, title?: string) => ({
    input: input(title), vizDir, outFile: join(vizDir, '..', `${title ?? 'out'}.mp4`), audioArgs: ['-c:a', 'copy'],
    ffmpegPath: ffmpeg, ffprobePath: ffprobe, workers: 3, encodeSessions: 2, segmentSeconds: 1, encoder: 'x264' as const,
    sceneModule, sceneVersion: 'test-1',
    analyze: async () => ({ path: null, frameCount: 90 }),
  })

  beforeAll(() => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'fake-scene.mjs'), FAKE_SCENE)
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:a', 'aac', '-b:a', '64k', audio])
  })

  const probeFrames = (file: string) => {
    const out = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=nb_read_frames,duration,width,height', '-of', 'json', file], { encoding: 'utf8' })
    return JSON.parse(out).streams[0] as { nb_read_frames: string; duration: string; width: number; height: number }
  }

  it('renders, assembles with audio, and has the right duration and frame count', async () => {
    const vizDir = join(dir, 'viz-a')
    const progress: number[] = []
    const logs: string[] = []
    await renderScene(base(vizDir), (f) => progress.push(f), (l) => logs.push(l))
    const out = join(dir, 'out.mp4')
    const v = probeFrames(out)
    expect(Number(v.nb_read_frames)).toBe(90)
    expect(Math.abs(Number(v.duration) - 3)).toBeLessThan(0.1)
    expect([v.width, v.height]).toEqual([64, 36])
    const audioDur = Number(execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim())
    expect(Math.abs(audioDur - 3)).toBeLessThan(0.1)
    expect(progress[0]).toBe(0)
    expect(progress.at(-1)).toBe(1)
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1])
    expect(readdirSync(vizDir).filter((f) => /^seg-\d{5}\.mp4$/.test(f))).toHaveLength(3)
    expect(readdirSync(vizDir).some((f) => f.endsWith('.partial'))).toBe(false)
    expect(Object.keys(readManifest(vizDir)!.segments)).toHaveLength(3)

    // Resume: same inputs, nothing drawn again (segment files untouched), partial junk ignored.
    const mtimes = [0, 1, 2].map((i) => statSync(join(vizDir, segmentFileName(i))).mtimeMs)
    writeFileSync(join(vizDir, segmentFileName(1) + '.partial'), 'garbage from a killed encode')
    const logs2: string[] = []
    await renderScene(base(vizDir), () => {}, (l) => logs2.push(l))
    expect(logs2.join('\n')).toMatch(/3 segment\(s\), 3 already done/)
    expect([0, 1, 2].map((i) => statSync(join(vizDir, segmentFileName(i))).mtimeMs)).toEqual(mtimes)
    expect(existsSync(join(vizDir, segmentFileName(1) + '.partial'))).toBe(false)
    expect(Number(probeFrames(out).nb_read_frames)).toBe(90)

    // A lost segment is rendered again, alone.
    rmSync(join(vizDir, segmentFileName(2)))
    const logs3: string[] = []
    await renderScene(base(vizDir), () => {}, (l) => logs3.push(l))
    expect(logs3.join('\n')).toMatch(/3 segment\(s\), 2 already done/)

    // New scene code: everything is discarded and rendered again.
    const logs4: string[] = []
    await renderScene({ ...base(vizDir), sceneVersion: 'test-2' }, () => {}, (l) => logs4.push(l))
    expect(logs4.join('\n')).toMatch(/inputs changed \(sceneVersion\), discarding 3/)
    expect(logs4.join('\n')).toMatch(/3 segment\(s\), 0 already done/)
    expect(Number(probeFrames(out).nb_read_frames)).toBe(90)
  }, 60_000)

  it('a scene error fails the render, keeps finished segments and leaves no partial file', async () => {
    const vizDir = join(dir, 'viz-b')
    await expect(renderScene({ ...base(vizDir, 'fail@75'), encodeSessions: 1 }, () => {}, () => {})).rejects.toThrow(/boom at 75/)
    const files = readdirSync(vizDir)
    expect(files.some((f) => f.endsWith('.partial'))).toBe(false)
    expect(files).not.toContain(segmentFileName(2))
    expect(Object.keys(readManifest(vizDir)!.segments).sort()).toEqual(['0', '1'])
  }, 60_000)

  it('colours drawn with the real canvas survive the encode (RGBA order, bt709)', async () => {
    const r = await colourSelfTest({ ffmpegPath: ffmpeg, encoder: 'x264', dir: join(dir, 'colour') })
    expect(r.details.join('\n')).not.toMatch(/WRONG/)
    expect(r.ok).toBe(true)
  }, 30_000)

  it('a stalled render fails instead of hanging the job forever', async () => {
    const d = join(dir, 'viz-c')
    const t0 = Date.now()
    await expect(renderSegments({
      input: input('hang@10'), analysisPath: null, sceneModule, segments: planSegments(30, 30, 1), dir: d,
      ffmpegPath: ffmpeg, ffprobePath: ffprobe, encoder: 'x264', workers: 2, encodeSessions: 1, stallMs: 400,
    })).rejects.toThrow(/stalled/)
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(readdirSync(d)).toEqual([])
  }, 30_000)
})

// ---------------------------------------------------------------------------
// restart recovery (context.ts + db/jobs.ts + pipeline.ts)

describe('restart recovery', () => {
  it('requeues a scene job that has its audio, keeps its work dir; everything else is interrupted and wiped', async () => {
    const dataDir = mkdtempSync(join(tmp, 'data-'))
    const cfg = loadConfig({ DATA_DIR: dataDir, YTDLP_PATH: 'not-a-binary', FFPROBE_PATH: 'not-a-binary', VIZ_MAX_RESUMES: '2' } as any)
    const work = (id: string) => join(dataDir, 'work', id)
    const first = buildContext(cfg)
    const mk = (id: string, style: 'scene' | 'static', status: 'downloading' | 'transcoding' | 'uploading' | 'queued') => {
      first.jobs.create({ id, url: 'https://soundcloud.com/x/y', title: id, privacy: 'private', style })
      first.jobs.setStatus(id, status)
      mkdirSync(join(work(id), 'viz'), { recursive: true })
    }
    const withAudio = (id: string) => {
      writeFileSync(join(work(id), 'My Set.m4a'), 'audio bytes')
      writeSourceRecord(work(id), join(work(id), 'My Set.m4a'), 'My Set')
      writeFileSync(join(work(id), 'viz', segmentFileName(0)), 'segment')
    }
    mk('rendering', 'scene', 'transcoding'); withAudio('rendering')
    mk('uploading', 'scene', 'uploading'); withAudio('uploading')
    mk('uploaded', 'scene', 'uploading'); withAudio('uploaded'); first.jobs.setResult('uploaded', 'vid', 'https://youtu.be/vid')
    mk('no-audio', 'scene', 'downloading')
    mk('changed-audio', 'scene', 'transcoding'); withAudio('changed-audio'); writeFileSync(join(work('changed-audio'), 'My Set.m4a'), 'different length')
    mk('crash-loop', 'scene', 'transcoding'); withAudio('crash-loop'); writeFileSync(join(work('crash-loop'), 'viz', 'resumes.json'), '{"count":2}')
    mk('old-style', 'static', 'transcoding')
    mkdirSync(work('orphan'), { recursive: true })
    first.db.close()

    const second = buildContext(cfg)
    try {
      for (const id of ['uploaded', 'no-audio', 'changed-audio', 'crash-loop', 'old-style']) {
        expect([id, second.jobs.get(id)!.status]).toEqual([id, 'interrupted'])
        expect([id, existsSync(work(id))]).toEqual([id, false])
      }
      expect(existsSync(work('orphan'))).toBe(false)
      for (const id of ['rendering', 'uploading']) {
        // Requeued and already picked up by the queue: the download is skipped, the segment still there.
        expect(second.jobs.get(id)!.status).not.toBe('interrupted')
        expect(existsSync(join(work(id), 'viz', segmentFileName(0)))).toBe(true)
      }
      expect(second.queue.size).toBe(2)
      await vi.waitFor(() => expect(second.queue.size).toBe(0), { timeout: 10_000 })
      // (they then fail here: the fake audio cannot be probed)
      expect(second.jobs.getLogs('rendering', 50).join('\n')).toMatch(/resuming after a restart: audio My Set\.m4a is already here/)
      expect(second.jobs.get('rendering')!.status).toBe('failed')
    } finally {
      second.db.close()
    }
  })

  it('claimSceneResume counts attempts and stops at the limit', () => {
    const wd = mkdtempSync(join(tmp, 'claim-'))
    writeFileSync(join(wd, 'a.opus'), 'x')
    writeSourceRecord(wd, join(wd, 'a.opus'), 'a')
    const job = { style: 'scene', videoId: null } as any
    expect(claimSceneResume(job, wd, 2)).toBe(true)
    expect(claimSceneResume(job, wd, 2)).toBe(true)
    expect(claimSceneResume(job, wd, 2)).toBe(false)
    expect(claimSceneResume({ ...job, style: 'static' }, wd, 9)).toBe(false)
    expect(readSourceRecord(wd)).toEqual({ file: join(wd, 'a.opus'), title: 'a', pageUrl: null })
  })

  it('claimSceneResume never counts a job whose render is complete (waiting for or in upload); a stale stamp still counts', () => {
    const wd = mkdtempSync(join(tmp, 'claim-rendered-'))
    const audio = join(wd, 'a.opus')
    writeFileSync(audio, 'x')
    writeSourceRecord(wd, audio, 'a')
    const input: VizInput = { audioPath: audio, durationSeconds: 60, setTitle: 'a', setArtist: null, setArtworkPath: null, tracks: [], width: 64, height: 36, fps: 30 }
    writeFileSync(join(wd, 'viz', 'input.json'), JSON.stringify(input))
    writeFileSync(join(wd, 'out.mp4'), Buffer.alloc(1234))
    const stamp = (s: object) => writeFileSync(join(wd, 'viz', 'rendered.json'), JSON.stringify({ inputHash: hashInput(input), sceneVersion: sceneCodeVersion(), bytes: 1234, ...s }))
    stamp({})
    expect(isRenderComplete(wd, audio)).toBe(true)
    const job = { style: 'scene', videoId: null } as any
    for (let n = 0; n < 10; n++) expect(claimSceneResume(job, wd, 2)).toBe(true)
    expect(existsSync(join(wd, 'viz', 'resumes.json'))).toBe(false)
    // A truncated video, or a stamp for another input: not complete, the render-loop guard applies.
    stamp({ bytes: 999 })
    expect(isRenderComplete(wd, audio)).toBe(false)
    stamp({ inputHash: 'other' })
    expect(isRenderComplete(wd, audio)).toBe(false)
    expect(claimSceneResume(job, wd, 2)).toBe(true)
    expect(claimSceneResume(job, wd, 2)).toBe(true)
    expect(claimSceneResume(job, wd, 2)).toBe(false)
  })

  it('claimSceneResume only counts restarts without progress: a long render survives many image updates', () => {
    const wd = mkdtempSync(join(tmp, 'claim-progress-'))
    writeFileSync(join(wd, 'a.opus'), 'x')
    writeSourceRecord(wd, join(wd, 'a.opus'), 'a')
    const job = { style: 'scene', videoId: null } as any
    const finished = (n: number) => writeManifest(join(wd, 'viz'), {
      version: 1, fingerprint: fp, segments: Object.fromEntries(Array.from({ length: n }, (_, i) => [i, { frames: 30, bytes: 1, extradata: 'e' }])),
    })
    for (let n = 1; n <= 6; n++) { finished(n); expect(claimSceneResume(job, wd, 2)).toBe(true) }
    // No new segment since: two more restarts are allowed, then it stops.
    expect(claimSceneResume(job, wd, 2)).toBe(true)
    expect(claimSceneResume(job, wd, 2)).toBe(false)
    finished(7)
    expect(claimSceneResume(job, wd, 2)).toBe(true)
  })
})
