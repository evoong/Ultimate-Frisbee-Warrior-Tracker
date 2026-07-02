// Cookie scheme for the auth gateway. All names/attributes live here.
//
// On https origins the __Host- prefix enforces Secure + Path=/ + no Domain.
// Browsers reject __Host-/Secure cookies on plain http, so local dev
// (http://localhost:5000, :8787) falls back to unprefixed names without
// Secure. CSRF protection still holds there via SameSite=Lax + origin checks.

const ACCESS_MAX_AGE_FALLBACK = 3600
const REFRESH_MAX_AGE = 30 * 24 * 3600
const PKCE_MAX_AGE = 600

export interface CookieNames {
  accessToken: string
  refreshToken: string
  pkce: string
}

export function cookieNames(requestUrl: URL): CookieNames {
  const prefix = requestUrl.protocol === 'https:' ? '__Host-' : ''
  return {
    accessToken: `${prefix}ufwt_at`,
    refreshToken: `${prefix}ufwt_rt`,
    pkce: `${prefix}ufwt_pkce`,
  }
}

export function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get('cookie')
  if (!header) return {}
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name) out[name] = decodeURIComponent(value)
  }
  return out
}

function serialize(name: string, value: string, maxAge: number, secure: boolean): string {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ]
  if (secure) attrs.push('Secure')
  return attrs.join('; ')
}

export function sessionCookies(
  requestUrl: URL,
  session: { access_token: string; refresh_token: string; expires_in?: number }
): string[] {
  const names = cookieNames(requestUrl)
  const secure = requestUrl.protocol === 'https:'
  return [
    serialize(names.accessToken, session.access_token, session.expires_in ?? ACCESS_MAX_AGE_FALLBACK, secure),
    serialize(names.refreshToken, session.refresh_token, REFRESH_MAX_AGE, secure),
  ]
}

export function pkceCookie(requestUrl: URL, payload: string): string {
  const names = cookieNames(requestUrl)
  return serialize(names.pkce, payload, PKCE_MAX_AGE, requestUrl.protocol === 'https:')
}

export function clearSessionCookies(requestUrl: URL): string[] {
  const names = cookieNames(requestUrl)
  const secure = requestUrl.protocol === 'https:'
  return [
    serialize(names.accessToken, '', 0, secure),
    serialize(names.refreshToken, '', 0, secure),
  ]
}

export function clearPkceCookie(requestUrl: URL): string {
  return serialize(cookieNames(requestUrl).pkce, '', 0, requestUrl.protocol === 'https:')
}
