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

// Cryptographic verification against the project's JWKS. Used where the
// gateway itself is the authorization boundary (e.g. the Express chat routes,
// which query Supabase with the service role and therefore bypass RLS).
export async function verifyAccessToken(
  token: string,
  jwksUrl: string,
  supabaseUrl: string
): Promise<{ sub: string; email: string } | null> {
  let jwks = jwksCache.get(jwksUrl)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUrl))
    jwksCache.set(jwksUrl, jwks)
  }
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `${supabaseUrl}/auth/v1`,
    })
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') return null
    return { sub: payload.sub, email: payload.email }
  } catch {
    return null
  }
}
