import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../src/db/index.js'
import { makeJobsRepo } from '../src/db/jobs.js'
import { makeKvCache } from '../src/db/kv.js'
import { describeJob, recordingLink } from '../src/lib/describe.js'
import { isMkvidDescription, runDescriptionBackfill, quotaDayStart, unitsFor, type VideoSnippet, type VideosApi, type BackfillOptions } from '../src/lib/description-backfill.js'
import { parsePageUrl } from '../src/lib/ytdlp.js'
import { YouTubeHttpError } from '../src/lib/youtube.js'
import { parseArgs } from '../src/cli/backfill-descriptions.js'
import type { JobMeta } from '../src/types.js'

const SET = 'https://www.1001tracklists.com/tracklist/kdmfpct/mau-p-xxx-radio-208-2026-10-02.html'
const API_URL = 'https://api.soundcloud.com/tracks/2411689830'
const PAGE = 'https://soundcloud.com/realmaup/xxx-radio-208'
const LEGACY_PARA = 'Rendered by mkvid for tracked — the set has no YouTube recording on 1001tracklists, so this is its SoundCloud / hearthis.at recording with a waveform.'
const meta = (over: Partial<JobMeta> = {}): JobMeta => ({ origin: 'tracked', requestId: 'r1', setUrl: SET, sourceUrl: API_URL, lastCueSeconds: null, artistName: null, ...over })
const legacy = (setUrl = SET, rec = API_URL) => `Tracklist: ${setUrl}\nRecording: ${rec}\n\n${LEGACY_PARA}`

describe('describeJob', () => {
  it('tracked: tracklist and recording, no closing paragraph', () => {
    expect(describeJob({ url: API_URL, meta: meta() })).toBe(`Tracklist: ${SET}\nRecording: ${API_URL}`)
  })
  it('prefers the page yt-dlp named, passed in or recorded on the job', () => {
    expect(describeJob({ url: API_URL, meta: meta() }, PAGE)).toBe(`Tracklist: ${SET}\nRecording: ${PAGE}`)
    expect(describeJob({ url: API_URL, meta: meta({ recordingUrl: PAGE }) })).toBe(`Tracklist: ${SET}\nRecording: ${PAGE}`)
  })
  it('hearthis: the track page the job downloaded, not the embed player', () => {
    const page = 'https://hearthis.at/razorator/johnsummit-liveatrockinriobrazil13-09-2026-razorator/'
    expect(recordingLink({ url: page, meta: meta({ sourceUrl: 'https://hearthis.at/embed/14675827/' }) })).toBe(page)
  })
  it('UI jobs are unchanged', () => {
    expect(describeJob({ url: 'https://soundcloud.com/a/b', meta: null })).toBe('Uploaded by mkvid from https://soundcloud.com/a/b')
    expect(describeJob({ url: 'upload://x.mp3', meta: null })).toBe('Uploaded by mkvid')
  })
})

describe('parsePageUrl', () => {
  it('takes the last URL line', () => {
    expect(parsePageUrl(`${PAGE}\n`)).toBe(PAGE)
    expect(parsePageUrl('NA\n')).toBeNull()
    expect(parsePageUrl('')).toBeNull()
  })
})

describe('isMkvidDescription', () => {
  const job = { url: API_URL, meta: meta() }
  it('knows the old and new templates', () => {
    expect(isMkvidDescription(legacy(), job)).toBe(true)
    expect(isMkvidDescription(legacy().replace(/\n/g, '\r\n'), job)).toBe(true)
    expect(isMkvidDescription(describeJob(job, PAGE), job)).toBe(true)
    expect(isMkvidDescription(`Uploaded by mkvid from ${API_URL}`, job)).toBe(true)
  })
  it('anything a person wrote is not ours', () => {
    expect(isMkvidDescription(`${legacy()}\n\nThanks to the DJ!`, job)).toBe(false)
    expect(isMkvidDescription(legacy('https://other.example'), job)).toBe(false)
    expect(isMkvidDescription('', job)).toBe(false)
  })
})

describe('quota day', () => {
  it('starts at midnight Pacific', () => {
    // 2026-10-08 20:00 UTC = 13:00 PDT; midnight PDT = 07:00 UTC
    expect(new Date(quotaDayStart(Date.UTC(2026, 9, 8, 20))).toISOString()).toBe('2026-10-08T07:00:00.000Z')
  })
  it('units', () => {
    expect(unitsFor(216)).toBe(216 * 50 + 5)
  })
})

function setup(n: number, over: (i: number) => Partial<JobMeta> = () => ({})) {
  const db = new Database(':memory:')
  migrate(db)
  const jobs = makeJobsRepo(db)
  const kv = makeKvCache(db)
  const live = new Map<string, VideoSnippet>()
  for (let i = 0; i < n; i++) {
    const id = `job${i}`
    const vid = `vid${String(i).padStart(8, '0')}`
    const m = meta({ requestId: `r${i}`, sourceUrl: `https://api.soundcloud.com/tracks/${1000 + i}`, ...over(i) })
    jobs.create({ id, url: m.sourceUrl, title: `Set ${i}`, privacy: 'unlisted', style: 'scene', meta: m })
    jobs.setResult(id, vid, `https://youtu.be/${vid}`)
    jobs.setStatus(id, 'done')
    live.set(vid, { title: `Set ${i} (live)`, description: legacy(SET, m.sourceUrl), categoryId: '10', tags: ['dj'], defaultLanguage: 'en' })
  }
  const updates: Array<{ id: string; snippet: VideoSnippet }> = []
  const api: VideosApi = {
    list: vi.fn(async (_t: string, ids: string[]) => new Map(ids.filter((i) => live.has(i)).map((i) => [i, { ...live.get(i)! }]))),
    update: vi.fn(async (_t: string, id: string, snippet: VideoSnippet) => { updates.push({ id, snippet }); live.set(id, snippet) }),
  }
  const probePage = vi.fn(async (url: string) => `https://soundcloud.com/dj/track-${url.split('/').pop()}`)
  const lines: string[] = []
  const deps = { jobs, kv, api, probePage, tokenFor: () => async () => 'tok', log: (l: string) => lines.push(l), now: () => Date.UTC(2026, 9, 8, 20) }
  return { db, jobs, kv, live, api, updates, probePage, deps, lines }
}

const opts = (over: Partial<BackfillOptions> = {}): BackfillOptions => ({
  apply: true, accounts: ['primary'], limit: { primary: 100, shared: 100 }, budget: { primary: 10_000, shared: 10_000 }, sample: 2, readYouTube: true, ...over,
})

describe('runDescriptionBackfill', () => {
  it('dry run: reads, writes nothing to YouTube or the jobs', async () => {
    const s = setup(3)
    const [r] = await runDescriptionBackfill(s.deps, opts({ apply: false }))
    expect(r).toMatchObject({ pending: 3, unitsNeeded: 151, updated: 0 })
    expect(s.api.update).not.toHaveBeenCalled()
    expect(s.jobs.descriptionBackfillPending('primary')).toHaveLength(3)
    expect(s.jobs.get('job0')!.meta!.recordingUrl).toBeUndefined()
    expect(s.lines.join('\n')).toContain('Recording: https://soundcloud.com/dj/track-1000')
    expect(s.lines.join('\n')).toContain('Rendered by mkvid')
  })

  it('apply: resends the live snippet with the new description, records the page, marks done', async () => {
    const s = setup(2)
    const [r] = await runDescriptionBackfill(s.deps, opts())
    expect(r).toMatchObject({ updated: 2, stoppedBy: null })
    expect(s.updates[0]).toEqual({
      id: 'vid00000000',
      snippet: { title: 'Set 0 (live)', categoryId: '10', tags: ['dj'], defaultLanguage: 'en', description: `Tracklist: ${SET}\nRecording: https://soundcloud.com/dj/track-1000` },
    })
    expect(s.jobs.get('job0')!.meta!.recordingUrl).toBe('https://soundcloud.com/dj/track-1000')
    expect(s.jobs.descriptionBackfillPending('primary')).toHaveLength(0)
    expect(Number(s.kv.get(`descbackfill:units:primary:${quotaDayStart(Date.UTC(2026, 9, 8, 20))}`))).toBe(101)
    // a second run has nothing to do and spends nothing
    const [again] = await runDescriptionBackfill(s.deps, opts())
    expect(again).toMatchObject({ pending: 0, updated: 0 })
    expect(s.api.list).toHaveBeenCalledTimes(1)
  })

  it('stops at the per-run limit and at the daily budget, carried across runs', async () => {
    const s = setup(5)
    const [a] = await runDescriptionBackfill(s.deps, opts({ limit: { primary: 2, shared: 0 } }))
    expect(a).toMatchObject({ updated: 2, stoppedBy: 'limit' })
    // 101 spent; a 160-unit budget leaves room for one more update (list 1 + 50)
    const [b] = await runDescriptionBackfill(s.deps, opts({ budget: { primary: 160, shared: 0 } }))
    expect(b).toMatchObject({ updated: 1, stoppedBy: 'budget' })
    expect(s.jobs.descriptionBackfillPending('primary')).toHaveLength(2)
  })

  it('skips current, gone, hand-edited and unresolved videos correctly', async () => {
    const s = setup(4)
    s.live.set('vid00000000', { ...s.live.get('vid00000000')!, description: `Tracklist: ${SET}\nRecording: https://soundcloud.com/dj/track-1000` })
    s.live.delete('vid00000001')
    s.live.set('vid00000002', { ...s.live.get('vid00000002')!, description: 'my own words' })
    s.probePage.mockImplementation(async (url: string) => (url.endsWith('1003') ? null : `https://soundcloud.com/dj/track-${url.split('/').pop()}`))
    const [r] = await runDescriptionBackfill(s.deps, opts())
    expect(r).toMatchObject({ updated: 0, alreadyCurrent: 1, gone: 1, handEdited: 1, unresolved: 1 })
    expect(s.jobs.descriptionBackfillPending('primary').map((j) => j.id)).toEqual(['job2', 'job3'])
    // --allow-fallback writes the api URL for the unresolved one
    const [f] = await runDescriptionBackfill(s.deps, opts({ allowFallback: true }))
    expect(f.updated).toBe(1)
    expect(s.live.get('vid00000003')!.description).toBe(`Tracklist: ${SET}\nRecording: https://api.soundcloud.com/tracks/1003`)
  })

  it('a recorded page or a hearthis page needs no yt-dlp', async () => {
    const hearthis = 'https://hearthis.at/razorator/set/'
    const s = setup(2, (i) => (i === 0 ? { recordingUrl: PAGE } : { sourceUrl: 'https://hearthis.at/embed/1/' }))
    // job1's url is the hearthis page tracked's embed resolved to
    s.db.prepare("UPDATE jobs SET url=? WHERE id='job1'").run(hearthis)
    await runDescriptionBackfill(s.deps, opts())
    expect(s.probePage).not.toHaveBeenCalled()
    expect(s.updates.map((u) => u.snippet.description.split('\n')[1])).toEqual([`Recording: ${PAGE}`, `Recording: ${hearthis}`])
  })

  it('quota exceeded stops the account without marking anything', async () => {
    const s = setup(2)
    ;(s.api.update as any).mockRejectedValueOnce(new YouTubeHttpError(403, 'videos.update: HTTP 403 quotaExceeded'))
    const [r] = await runDescriptionBackfill(s.deps, opts())
    expect(r).toMatchObject({ updated: 0, stoppedBy: 'quota' })
    expect(s.jobs.descriptionBackfillPending('primary')).toHaveLength(2)
  })

  it('only takes its own account, never UI or deleted uploads', async () => {
    const s = setup(2, (i) => (i === 1 ? { account: 'shared' } : {}))
    s.jobs.create({ id: 'ui', url: 'https://x', title: 't', privacy: 'private', style: 'static' })
    s.jobs.setResult('ui', 'uiVideo0001', 'https://youtu.be/uiVideo0001'); s.jobs.setStatus('ui', 'done')
    expect(s.jobs.descriptionBackfillPending('primary').map((j) => j.id)).toEqual(['job0'])
    expect(s.jobs.descriptionBackfillPending('shared').map((j) => j.id)).toEqual(['job1'])
    s.jobs.markVideoDeleted('job0')
    expect(s.jobs.descriptionBackfillPending('primary')).toHaveLength(0)
    // runJob marks a fresh upload synced: it already has the current description
    s.jobs.markDescriptionSynced('job1')
    expect(s.jobs.descriptionBackfillPending('shared')).toHaveLength(0)
  })

  it('a current description that YouTube returns with CRLF is not updated again', async () => {
    const s = setup(1)
    s.live.set('vid00000000', { ...s.live.get('vid00000000')!, description: `Tracklist: ${SET}\r\nRecording: https://soundcloud.com/dj/track-1000` })
    const [r] = await runDescriptionBackfill(s.deps, opts())
    expect(r).toMatchObject({ updated: 0, alreadyCurrent: 1 })
  })
})

describe('parseArgs', () => {
  it('defaults to a dry run over both accounts', () => {
    expect(parseArgs([])).toMatchObject({ apply: false, accounts: ['primary', 'shared'], limit: { primary: 150, shared: 30 } })
    expect(parseArgs(['--apply', '--account', 'shared', '--limit-shared', '10'])).toMatchObject({ apply: true, accounts: ['shared'], limit: { shared: 10 } })
    expect(() => parseArgs(['--apply', '--offline'])).toThrow()
    expect(() => parseArgs(['--bogus'])).toThrow()
  })
})
