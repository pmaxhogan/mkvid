import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { uploadVideo, withAuthRetry, UPLOAD_URL, type TokenGetter } from '../src/lib/youtube.js'

const tmp = mkdtempSync(join(tmpdir(), 'mkvid-ytup-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }))

const KB256 = 256 * 1024
const SESSION = 'https://upload.example/session-1'

/** A file of `n` bytes. */
function video(n: number): string {
  const p = join(tmp, `v-${n}-${Math.random().toString(36).slice(2)}.mp4`)
  writeFileSync(p, Buffer.alloc(n, 7))
  return p
}

interface Call { method: string; url: string; range?: string; auth?: string; bytes: number }

/**
 * A scripted YouTube: each request is answered by the next step. A step gets
 * the request and returns a Response or throws (a dropped connection).
 */
function fakeYouTube(steps: Array<(c: Call) => Response>) {
  const calls: Call[] = []
  const fetchFn = (async (url: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>
    const c: Call = {
      method: String(init.method), url, range: h['Content-Range'], auth: h.Authorization,
      bytes: init.body ? (init.body as Uint8Array).length ?? String(init.body).length : 0,
    }
    calls.push(c)
    const step = steps.shift()
    if (!step) throw new Error(`unexpected request ${c.method} ${url} ${c.range ?? ''}`)
    return step(c)
  }) as unknown as typeof fetch
  return { fetchFn, calls, left: () => steps.length }
}

const session = () => new Response(null, { status: 200, headers: { location: SESSION } })
const resume = (lastByte: number | null) => new Response(null, { status: 308, headers: lastByte === null ? {} : { range: `bytes=0-${lastByte}` } })
const done = (id = 'vid1', privacy = 'private') => new Response(JSON.stringify({ id, status: { privacyStatus: privacy } }), { status: 200 })
const err = (status: number, message: string) => new Response(JSON.stringify({ error: { code: status, message } }), { status })

function tokens() {
  const asked: Array<string> = []
  let n = 0
  const getToken: TokenGetter = async (o) => {
    if (o?.force) n++
    asked.push(o?.force ? 'force' : 'normal')
    return `tok${n}`
  }
  return { getToken, asked }
}

const base = { title: 't', description: 'd', privacy: 'private' as const, categoryId: '10', chunkBytes: KB256, retryDelayMs: () => 0 }

describe('uploadVideo (resumable)', () => {
  it('opens a session and sends the file in 256 KiB-aligned chunks', async () => {
    const file = video(KB256 * 2 + 100)
    const yt = fakeYouTube([session, () => resume(KB256 - 1), () => resume(2 * KB256 - 1), () => done('abc', 'unlisted')])
    const t = tokens()
    const progress: number[] = []
    const r = await uploadVideo({ ...base, getToken: t.getToken, filePath: file, fetch: yt.fetchFn }, (p) => progress.push(p))
    expect(r).toEqual({ videoId: 'abc', videoUrl: 'https://youtu.be/abc', privacyApplied: 'unlisted' })
    expect(yt.calls.map((c) => [c.method, c.url, c.range, c.bytes])).toEqual([
      ['POST', UPLOAD_URL, undefined, expect.any(Number)],
      ['PUT', SESSION, `bytes 0-${KB256 - 1}/${2 * KB256 + 100}`, KB256],
      ['PUT', SESSION, `bytes ${KB256}-${2 * KB256 - 1}/${2 * KB256 + 100}`, KB256],
      ['PUT', SESSION, `bytes ${2 * KB256}-${2 * KB256 + 99}/${2 * KB256 + 100}`, 100],
    ])
    expect(yt.calls.every((c) => c.auth === 'Bearer tok0')).toBe(true)
    expect(progress.at(-1)).toBe(100)
  })

  it('a 503 or a dropped connection asks the session what it holds and resumes from there', async () => {
    const total = KB256 * 3
    const file = video(total)
    const yt = fakeYouTube([
      session,
      () => resume(KB256 - 1),
      () => err(503, 'Backend Error'),
      () => resume(KB256 + 1000), // status query: part of the failed chunk did arrive
      () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) },
      () => resume(2 * KB256 - 1), // status query after the reset
      () => done(),
    ])
    const logs: string[] = []
    const r = await uploadVideo({ ...base, getToken: tokens().getToken, filePath: file, fetch: yt.fetchFn, onLog: (l) => logs.push(l) }, () => {})
    expect(r.videoId).toBe('vid1')
    expect(yt.calls.map((c) => c.range)).toEqual([
      undefined,
      `bytes 0-${KB256 - 1}/${total}`,
      `bytes ${KB256}-${2 * KB256 - 1}/${total}`,
      `bytes */${total}`,
      `bytes ${KB256 + 1001}-${2 * KB256 + 1000}/${total}`,
      `bytes */${total}`,
      `bytes ${2 * KB256}-${3 * KB256 - 1}/${total}`,
    ])
    expect(logs.join('\n')).toMatch(/HTTP 503/)
    expect(logs.join('\n')).toMatch(/ECONNRESET/)
  })

  it('a 401 mid-upload mints a new token and sends the same chunk again (no restart)', async () => {
    const total = KB256 * 2
    const file = video(total)
    const yt = fakeYouTube([
      session,
      () => resume(KB256 - 1),
      () => err(401, 'Request had invalid authentication credentials.'),
      () => done(),
    ])
    const t = tokens()
    await uploadVideo({ ...base, getToken: t.getToken, filePath: file, fetch: yt.fetchFn }, () => {})
    expect(yt.calls.slice(2).map((c) => [c.range, c.auth])).toEqual([
      [`bytes ${KB256}-${total - 1}/${total}`, 'Bearer tok0'],
      [`bytes ${KB256}-${total - 1}/${total}`, 'Bearer tok1'],
    ])
    expect(t.asked.filter((a) => a === 'force')).toHaveLength(1)
  })

  it('a 401 that persists after a new token fails with YouTube\'s message', async () => {
    const file = video(KB256)
    const yt = fakeYouTube([session, () => err(401, 'Request had invalid authentication credentials.'), () => err(401, 'Request had invalid authentication credentials.')])
    await expect(uploadVideo({ ...base, getToken: tokens().getToken, filePath: file, fetch: yt.fetchFn }, () => {}))
      .rejects.toMatchObject({ status: 401, message: 'Request had invalid authentication credentials.' })
  })

  it('quota and other 4xx answers are not retried and keep the API message', async () => {
    const file = video(KB256)
    const yt = fakeYouTube([() => err(403, 'The request cannot be completed because you have exceeded your quota.')])
    await expect(uploadVideo({ ...base, getToken: tokens().getToken, filePath: file, fetch: yt.fetchFn }, () => {}))
      .rejects.toThrow(/exceeded your quota/)
    expect(yt.left()).toBe(0)
  })

  it('an expired session starts over with a new one', async () => {
    const total = KB256 * 2
    const file = video(total)
    const yt = fakeYouTube([session, () => resume(KB256 - 1), () => err(404, 'gone'), session, () => resume(KB256 - 1), () => done()])
    await uploadVideo({ ...base, getToken: tokens().getToken, filePath: file, fetch: yt.fetchFn }, () => {})
    expect(yt.calls.map((c) => c.method)).toEqual(['POST', 'PUT', 'PUT', 'POST', 'PUT', 'PUT'])
    expect(yt.calls[4].range).toBe(`bytes 0-${KB256 - 1}/${total}`)
  })

  it('a session lost again and again fails retryably (no "404" in the message: tracked would park the set)', async () => {
    const file = video(KB256)
    const gone = () => err(404, 'Not Found')
    const yt = fakeYouTube([session, gone, session, gone, session, gone])
    const e = await uploadVideo({ ...base, getToken: tokens().getToken, filePath: file, fetch: yt.fetchFn }, () => {}).catch((x) => x)
    expect(String(e.message)).toMatch(/dropped the upload session/)
    expect(String(e.message)).not.toMatch(/404/)
  })

  it('gives up after maxRetries failures in a row without progress', async () => {
    const file = video(KB256)
    const fail = () => err(500, 'Internal error')
    const yt = fakeYouTube([session, fail, fail, fail, fail, fail, fail, fail])
    await expect(uploadVideo({ ...base, maxRetries: 2, getToken: tokens().getToken, filePath: file, fetch: yt.fetchFn }, () => {}))
      .rejects.toMatchObject({ status: 500 })
  })
})

describe('withAuthRetry', () => {
  it('retries once with a forced token on a 401', async () => {
    const t = tokens()
    const seen: string[] = []
    const r = await withAuthRetry(t.getToken, async (tok) => {
      seen.push(tok)
      if (seen.length === 1) throw Object.assign(new Error('Request had invalid authentication credentials.'), { status: 401 })
      return 'ok'
    })
    expect(r).toBe('ok')
    expect(seen).toEqual(['tok0', 'tok1'])
  })
  it('a second 401 or any other error is thrown', async () => {
    const t = tokens()
    await expect(withAuthRetry(t.getToken, async () => { throw Object.assign(new Error('nope'), { code: 401 }) })).rejects.toThrow('nope')
    expect(t.asked).toEqual(['normal', 'force'])
    const t2 = tokens()
    await expect(withAuthRetry(t2.getToken, async () => { throw Object.assign(new Error('quota'), { status: 403 }) })).rejects.toThrow('quota')
    expect(t2.asked).toEqual(['normal'])
  })
})
