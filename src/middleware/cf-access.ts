import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import type { KVCache } from '../types.js'

const JWKS_KEY = 'cfaccess:jwks'
const JWKS_TTL = 3600
const SKEW = 60

interface Jwk { kty: string; n: string; e: string; kid: string; alg?: string }
interface Jwks { keys: Jwk[] }
interface Claims { iss?: string; aud?: string | string[]; email?: string; exp?: number; nbf?: number; iat?: number }

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  const buf = Buffer.from(b64, 'base64')
  const out = new Uint8Array(buf.byteLength)
  out.set(buf)
  return out
}
function b64urlToText(s: string): string { return Buffer.from(b64urlToBytes(s)).toString('utf8') }

async function fetchJwks(iss: string): Promise<Jwks> {
  const res = await fetch(`${iss}/cdn-cgi/access/certs`)
  if (!res.ok) throw new Error(`jwks: fetch ${res.status}`)
  return (await res.json()) as Jwks
}

async function getJwks(iss: string, kv: KVCache, force = false): Promise<Jwks> {
  if (!force) {
    const cached = kv.get(JWKS_KEY)
    if (cached) return JSON.parse(cached) as Jwks
  }
  const jwks = await fetchJwks(iss)
  kv.set(JWKS_KEY, JSON.stringify(jwks), JWKS_TTL)
  return jwks
}

async function importKey(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
  )
}

export async function verifyAccessJwt(
  token: string, opts: { teamDomain: string; aud: string }, kv: KVCache,
): Promise<{ email: string }> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('jwt: malformed')
  const [headerB64, payloadB64, sigB64] = parts
  const header = JSON.parse(b64urlToText(headerB64)) as { alg?: string; kid?: string }
  if (header.alg !== 'RS256') throw new Error(`jwt: unsupported alg ${header.alg}`)
  if (!header.kid) throw new Error('jwt: missing kid')

  const expectedIss = `https://${opts.teamDomain.replace(/^https?:\/\//, '').replace(/\/$/, '')}`
  let jwks = await getJwks(expectedIss, kv)
  let jwk = jwks.keys.find((k) => k.kid === header.kid)
  if (!jwk) { jwks = await getJwks(expectedIss, kv, true); jwk = jwks.keys.find((k) => k.kid === header.kid) }
  if (!jwk) throw new Error('jwt: unknown kid')

  const key = await importKey(jwk)
  const signed = new Uint8Array(new TextEncoder().encode(`${headerB64}.${payloadB64}`))
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(sigB64), signed)
  if (!ok) throw new Error('jwt: bad signature')

  const claims = JSON.parse(b64urlToText(payloadB64)) as Claims
  const now = Math.floor(Date.now() / 1000)
  if (claims.iss !== expectedIss) throw new Error(`jwt: bad iss ${claims.iss}`)
  const audMatches = Array.isArray(claims.aud) ? claims.aud.includes(opts.aud) : claims.aud === opts.aud
  if (!audMatches) throw new Error('jwt: bad aud')
  if (typeof claims.exp !== 'number' || claims.exp + SKEW < now) throw new Error('jwt: expired')
  if (typeof claims.nbf === 'number' && claims.nbf - SKEW > now) throw new Error('jwt: not yet valid')
  if (!claims.email) throw new Error('jwt: missing email')
  return { email: claims.email.toLowerCase() }
}

export function cfAccess(
  opts: { teamDomain: string; aud: string; allowedEmails: string[]; devBypass: boolean }, kv: KVCache,
): MiddlewareHandler {
  return async (c, next) => {
    if (opts.devBypass) { c.set('cfAccessEmail', 'dev@local'); return next() }
    if (!opts.teamDomain || !opts.aud || opts.allowedEmails.length === 0) {
      return c.json({ error: 'cf_access_misconfigured' }, 500)
    }
    const token = c.req.header('Cf-Access-Jwt-Assertion') || getCookie(c, 'CF_Authorization')
    if (!token) return c.json({ error: 'unauthorized' }, 401)
    let email: string
    try { ({ email } = await verifyAccessJwt(token, opts, kv)) }
    catch { return c.json({ error: 'unauthorized' }, 401) }
    if (!opts.allowedEmails.includes(email)) return c.json({ error: 'forbidden' }, 403)
    c.set('cfAccessEmail', email)
    return next()
  }
}
