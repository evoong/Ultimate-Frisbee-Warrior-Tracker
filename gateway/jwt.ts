import { createRemoteJWKSet, jwtVerify } from 'jose'

// Reads exp/email without verifying the signature. Safe ONLY for deciding
// when to refresh proactively — Supabase verifies every forwarded token.
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = typeof atob === 'function'
      ? atob(base64)
      : Buffer.from(base64, 'base64').toString('utf8')
    return JSON.parse(json)
  } catch {
    return null
  }
}

export function isExpired(token: string, skewSeconds = 30): boolean {
  const payload = decodeJwtPayload(token)
  const exp = payload?.exp
  if (typeof exp !== 'number') return true
  return exp * 1000 <= Date.now() + skewSeconds * 1000
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export interface SessionClaims {
  sub: string
  /** Null for anonymous (guest) sessions, which carry no usable email claim. */
  email: string | null
  isAnonymous: boolean
}

// Maps a verified JWT payload to SessionClaims. Pulled out of
// verifyAccessToken so it can be unit tested against realistic payload
// shapes without needing a signed token.
//
// A signed-in session and an anonymous (guest) session both carry
// role: "authenticated" and aud: "authenticated" — is_anonymous is the only
// discriminator between them, so there is no fallback to fall back on.
//
// Supabase anonymous sessions carry email as "" (empty string), not absent,
// so `typeof payload.email === 'string'` alone is not enough to detect a
// guest — it would report email: "" instead of null. Empty and
// whitespace-only strings are normalized to null.
export function mapVerifiedClaims(payload: Record<string, unknown>): SessionClaims | null {
  if (typeof payload.sub !== 'string') return null
  const isAnonymous = payload.is_anonymous === true
  const raw = typeof payload.email === 'string' ? payload.email.trim() : ''
  const email = raw === '' ? null : raw
  // A non-anonymous session without an email is malformed, not a guest.
  if (!isAnonymous && !email) return null
  return { sub: payload.sub, email, isAnonymous }
}

// Cryptographic verification against the project's JWKS. Used where the
// gateway itself is the authorization boundary (e.g. the Express chat routes,
// which query Supabase with the service role and therefore bypass RLS).
export async function verifyAccessToken(
  token: string,
  jwksUrl: string,
  supabaseUrl: string
): Promise<SessionClaims | null> {
  let jwks = jwksCache.get(jwksUrl)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUrl))
    jwksCache.set(jwksUrl, jwks)
  }
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `${supabaseUrl}/auth/v1`,
    })
    return mapVerifiedClaims(payload)
  } catch {
    return null
  }
}
