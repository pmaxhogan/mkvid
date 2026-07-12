import { describe, it, expect, beforeEach } from 'vitest'
import { generateKeyPairSync, createSign } from 'node:crypto'
import { openDb } from '../src/db/index.js'
import { makeKvCache } from '../src/db/kv.js'
import { verifyAccessJwt } from '../src/middleware/cf-access.js'

const TEAM = 'test.cloudflareaccess.com'
const ISS = `https://${TEAM}`
const AUD = 'test-aud'
const KID = 'kid-1'

function b64url(buf: Buffer | string) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function makeKeyAndJwks() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicKey.export({ format: 'jwk' }) as any
  const jwks = { keys: [{ kty: 'RSA', n: jwk.n, e: jwk.e, kid: KID, alg: 'RS256' }] }
  return { privateKey, jwks }
}

function signJwt(privateKey: any, claims: Record<string, unknown>) {
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }))
  const payload = b64url(JSON.stringify(claims))
  const signer = createSign('RSA-SHA256'); signer.update(`${header}.${payload}`); signer.end()
  const sig = b64url(signer.sign(privateKey))
  return `${header}.${payload}.${sig}`
}

describe('verifyAccessJwt', () => {
  let kv: ReturnType<typeof makeKvCache>
  let privateKey: any
  beforeEach(() => {
    const kp = makeKeyAndJwks()
    privateKey = kp.privateKey
    kv = makeKvCache(openDb(':memory:'))
    kv.set('cfaccess:jwks', JSON.stringify(kp.jwks), 3600)
  })
  const now = () => Math.floor(Date.now() / 1000)
  it('accepts a valid token and returns email', async () => {
    const jwt = signJwt(privateKey, { iss: ISS, aud: AUD, email: 'Me@Example.com', exp: now() + 60, iat: now() })
    const r = await verifyAccessJwt(jwt, { teamDomain: TEAM, aud: AUD }, kv)
    expect(r.email).toBe('me@example.com')
  })
  it('rejects bad aud', async () => {
    const jwt = signJwt(privateKey, { iss: ISS, aud: 'other', email: 'a@b.com', exp: now() + 60 })
    await expect(verifyAccessJwt(jwt, { teamDomain: TEAM, aud: AUD }, kv)).rejects.toThrow(/aud/)
  })
  it('rejects expired', async () => {
    const jwt = signJwt(privateKey, { iss: ISS, aud: AUD, email: 'a@b.com', exp: now() - 120 })
    await expect(verifyAccessJwt(jwt, { teamDomain: TEAM, aud: AUD }, kv)).rejects.toThrow(/expired/)
  })
  it('rejects bad iss', async () => {
    const jwt = signJwt(privateKey, { iss: 'https://evil.com', aud: AUD, email: 'a@b.com', exp: now() + 60 })
    await expect(verifyAccessJwt(jwt, { teamDomain: TEAM, aud: AUD }, kv)).rejects.toThrow(/iss/)
  })
})
