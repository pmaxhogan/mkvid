import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import {
  mkdirSync, writeFileSync, appendFileSync, statSync, existsSync, rmSync, readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { AppContext } from '../context.js'
import { MAX_UPLOAD_BYTES, isAllowedAudioExt, sanitizeUploadName } from '../lib/upload.js'

// Chunked upload sessions. Cloudflare caps a single request body at ~100MB, so
// the client slices big files and PUTs them in order; each chunk stays well
// under the edge limit. The filesystem is the source of truth (survives a
// server restart mid-upload): a session is a dir holding exactly one file.
const init = z.object({
  name: z.string().min(1).max(300),
  size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
})
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SESSION_TTL_MS = 24 * 60 * 60 * 1000

export function uploadSessionDir(dataDir: string, id: string): string {
  return join(dataDir, 'uploads', id)
}

// Returns the single audio file in a session dir, or null if the session is invalid.
export function uploadSessionFile(dataDir: string, id: string): string | null {
  if (!ID_RE.test(id)) return null
  const dir = uploadSessionDir(dataDir, id)
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
  return files.length === 1 ? join(dir, files[0]) : null
}

function gcStaleSessions(dataDir: string): void {
  const root = join(dataDir, 'uploads')
  if (!existsSync(root)) return
  for (const d of readdirSync(root)) {
    try {
      if (Date.now() - statSync(join(root, d)).mtimeMs > SESSION_TTL_MS) {
        rmSync(join(root, d), { recursive: true, force: true })
      }
    } catch { /* ignore */ }
  }
}

export function uploadsRoutes(ctx: AppContext): Hono {
  const app = new Hono()

  app.post('/', async (c) => {
    const parsed = init.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: 'invalid_input', detail: parsed.error.issues }, 400)
    if (!isAllowedAudioExt(parsed.data.name)) return c.json({ error: 'unsupported_type' }, 400)
    gcStaleSessions(ctx.config.dataDir)
    const id = randomUUID()
    const name = sanitizeUploadName(parsed.data.name)
    const dir = uploadSessionDir(ctx.config.dataDir, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), Buffer.alloc(0))
    return c.json({ id, name })
  })

  app.put('/:id/chunk', async (c) => {
    const file = uploadSessionFile(ctx.config.dataDir, c.req.param('id'))
    if (!file) return c.json({ error: 'not_found' }, 404)
    const cur = statSync(file).size
    // Client declares where this chunk starts; a mismatch (retry, reorder,
    // duplicate) is rejected with the real offset so it can resume correctly.
    const offset = Number(c.req.header('x-upload-offset'))
    if (!Number.isInteger(offset) || offset !== cur) {
      return c.json({ error: 'offset_mismatch', expected: cur }, 409)
    }
    const buf = Buffer.from(await c.req.arrayBuffer())
    if (buf.length === 0) return c.json({ error: 'empty_chunk' }, 400)
    if (cur + buf.length > MAX_UPLOAD_BYTES) {
      rmSync(uploadSessionDir(ctx.config.dataDir, c.req.param('id')), { recursive: true, force: true })
      return c.json({ error: 'file_too_large', detail: `max ${MAX_UPLOAD_BYTES} bytes` }, 400)
    }
    appendFileSync(file, buf)
    return c.json({ received: cur + buf.length })
  })

  return app
}
