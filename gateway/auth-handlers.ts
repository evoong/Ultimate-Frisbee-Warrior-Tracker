import {
  clearPkceCookie,
  clearSessionCookies,
  cookieNames,
  parseCookies,
  pkceCookie,
  sessionCookies,
} from './cookies.js'
import { isExpired } from './jwt.js'

// Server-side minimum password length. Mirrors the client's PASSWORD_MIN_LENGTH
// so we enforce the same rule regardless of Supabase's dashboard setting
// (whose default is only 6). Applied on every path that sets a password.
const PASSWORD_MIN_LENGTH = 8

export interface GatewayConfig {
  supabaseUrl: string
  publishableKey: string
  jwksUrl: string
}

interface SupabaseSession {
  access_token: string
  refresh_token: string
  expires_in?: number
  user?: { id: string; email?: string }
}

function json(body: unknown, status = 200, setCookies: string[] = []): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  for (const c of setCookies) headers.append('Set-Cookie', c)
  return new Response(JSON.stringify(body), { status, headers })
}

function redirect(location: string, setCookies: string[] = []): Response {
  const headers = new Headers({ Location: location })
  for (const c of setCookies) headers.append('Set-Cookie', c)
  return new Response(null, { status: 302, headers })
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json()
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function supabaseAuth(
  config: GatewayConfig,
  path: string,
  init: { method?: string; body?: unknown; accessToken?: string }
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    apikey: config.publishableKey,
    'Content-Type': 'application/json',
  }
  if (init.accessToken) headers.Authorization = `Bearer ${init.accessToken}`
  const res = await fetch(`${config.supabaseUrl}/auth/v1${path}`, {
    method: init.method ?? 'POST',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await res.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }
  return { status: res.status, data }
}

function authErrorMessage(data: any): string {
  return data?.error_description || data?.msg || data?.message || data?.error_code || 'authentication failed'
}

// Exchanges a refresh token; returns the new session or null (invalid/reused
// token, revoked user, etc. — callers clear cookies on null).
export async function refreshSession(
  config: GatewayConfig,
  refreshToken: string
): Promise<SupabaseSession | null> {
  const { status, data } = await supabaseAuth(config, '/token?grant_type=refresh_token', {
    body: { refresh_token: refreshToken },
  })
  if (status !== 200 || !data?.access_token || !data?.refresh_token) return null
  return data as SupabaseSession
}

// Returns a valid access token for the request, refreshing if needed.
// setCookies collects rotated cookies the caller must attach to its response.
export async function resolveAccessToken(
  config: GatewayConfig,
  request: Request,
  url: URL
): Promise<{ accessToken: string | null; setCookies: string[] }> {
  const names = cookieNames(url)
  const cookies = parseCookies(request)
  const at = cookies[names.accessToken]
  const rt = cookies[names.refreshToken]

  if (at && !isExpired(at)) return { accessToken: at, setCookies: [] }
  if (!rt) return { accessToken: null, setCookies: [] }

  const session = await refreshSession(config, rt)
  if (!session) return { accessToken: null, setCookies: clearSessionCookies(url) }
  return { accessToken: session.access_token, setCookies: sessionCookies(url, session) }
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const random = crypto.getRandomValues(new Uint8Array(32))
  const verifier = base64url(random)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64url(new Uint8Array(digest)) }
}

async function checkAllowed(config: GatewayConfig, accessToken: string): Promise<boolean> {
  const res = await fetch(`${config.supabaseUrl}/rest/v1/rpc/is_allowed`, {
    method: 'POST',
    headers: {
      apikey: config.publishableKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  })
  if (!res.ok) return false
  return (await res.json()) === true
}

export async function handleAuthRequest(
  config: GatewayConfig,
  request: Request,
  url: URL
): Promise<Response> {
  const route = `${request.method} ${url.pathname}`

  switch (route) {
    case 'POST /auth/login': {
      const { email, password } = await readJsonBody(request)
      if (typeof email !== 'string' || typeof password !== 'string') {
        return json({ error: 'email and password are required' }, 400)
      }
      const { status, data } = await supabaseAuth(config, '/token?grant_type=password', {
        body: { email, password },
      })
      if (status !== 200 || !data?.access_token) {
        return json({ error: authErrorMessage(data) }, status === 400 ? 400 : 401)
      }
      return json(
        { user: { id: data.user?.id, email: data.user?.email } },
        200,
        sessionCookies(url, data)
      )
    }

    case 'POST /auth/signup': {
      const { email, password } = await readJsonBody(request)
      if (typeof email !== 'string' || typeof password !== 'string') {
        return json({ error: 'email and password are required' }, 400)
      }
      if (password.length < PASSWORD_MIN_LENGTH) {
        return json({ error: `password must be at least ${PASSWORD_MIN_LENGTH} characters` }, 400)
      }
      const { status, data } = await supabaseAuth(config, '/signup', {
        body: { email, password },
      })
      if (status !== 200) return json({ error: authErrorMessage(data) }, 400)
      if (data?.access_token) {
        return json(
          { user: { id: data.user?.id, email: data.user?.email } },
          200,
          sessionCookies(url, data)
        )
      }
      return json({ confirmationRequired: true }, 200)
    }

    case 'GET /auth/login/google': {
      const { verifier, challenge } = await pkcePair()
      const authorize = new URL(`${config.supabaseUrl}/auth/v1/authorize`)
      authorize.searchParams.set('provider', 'google')
      authorize.searchParams.set('redirect_to', `${url.origin}/auth/callback`)
      authorize.searchParams.set('code_challenge', challenge)
      authorize.searchParams.set('code_challenge_method', 's256')
      return redirect(authorize.toString(), [pkceCookie(url, verifier)])
    }

    case 'GET /auth/callback': {
      const names = cookieNames(url)
      const cookies = parseCookies(request)

      if (url.searchParams.get('error')) {
        return redirect(
          `/?auth_error=${encodeURIComponent(url.searchParams.get('error_code') || url.searchParams.get('error')!)}`,
          [clearPkceCookie(url)]
        )
      }

      const tokenHash = url.searchParams.get('token_hash')
      const type = url.searchParams.get('type')
      if (tokenHash && type) {
        // Email-link flows (password recovery, signup confirmation).
        const { status, data } = await supabaseAuth(config, '/verify', {
          body: { token_hash: tokenHash, type },
        })
        if (status !== 200 || !data?.access_token) {
          return redirect('/?auth_error=verify_failed')
        }
        const target = type === 'recovery' ? '/reset-password' : '/'
        return redirect(target, sessionCookies(url, data))
      }

      const code = url.searchParams.get('code')
      const verifier = cookies[names.pkce]
      if (!code) return redirect('/?auth_error=missing_code')
      if (!verifier) return redirect('/?auth_error=login_expired')

      // The code exchange requires the verifier held in this browser's
      // httpOnly cookie, which binds the callback to the flow initiator.
      const { status, data } = await supabaseAuth(config, '/token?grant_type=pkce', {
        body: { auth_code: code, code_verifier: verifier },
      })
      if (status !== 200 || !data?.access_token) {
        return redirect('/?auth_error=oauth_exchange_failed', [clearPkceCookie(url)])
      }
      return redirect('/', [...sessionCookies(url, data), clearPkceCookie(url)])
    }

    case 'POST /auth/refresh': {
      const names = cookieNames(url)
      const rt = parseCookies(request)[names.refreshToken]
      if (!rt) return json({ error: 'no session' }, 401)
      const session = await refreshSession(config, rt)
      if (!session) return json({ error: 'session expired' }, 401, clearSessionCookies(url))
      return json(
        { user: { id: session.user?.id, email: session.user?.email } },
        200,
        sessionCookies(url, session)
      )
    }

    case 'POST /auth/logout': {
      const names = cookieNames(url)
      const at = parseCookies(request)[names.accessToken]
      if (at) {
        // Best-effort server-side revocation; cookies are cleared regardless.
        await supabaseAuth(config, '/logout', { accessToken: at }).catch(() => undefined)
      }
      return new Response(null, {
        status: 204,
        headers: clearSessionCookies(url).reduce((h, c) => {
          h.append('Set-Cookie', c)
          return h
        }, new Headers()),
      })
    }

    case 'GET /auth/session': {
      const { accessToken, setCookies } = await resolveAccessToken(config, request, url)
      if (!accessToken) return json({ user: null }, 401, setCookies)
      const { status, data } = await supabaseAuth(config, '/user', {
        method: 'GET',
        accessToken,
      })
      if (status !== 200 || !data?.id) {
        return json({ user: null }, 401, clearSessionCookies(url))
      }
      const allowed = await checkAllowed(config, accessToken)
      return json({ user: { id: data.id, email: data.email }, allowed }, 200, setCookies)
    }

    case 'POST /auth/forgot-password': {
      const { email } = await readJsonBody(request)
      if (typeof email === 'string' && email) {
        await supabaseAuth(config, '/recover', { body: { email } }).catch(() => undefined)
      }
      // Always 200: no account-existence oracle.
      return json({ ok: true })
    }

    case 'POST /auth/reset-password': {
      const { accessToken, setCookies } = await resolveAccessToken(config, request, url)
      if (!accessToken) return json({ error: 'not authenticated' }, 401)
      const { password } = await readJsonBody(request)
      if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
        return json({ error: `password must be at least ${PASSWORD_MIN_LENGTH} characters` }, 400)
      }
      const { status, data } = await supabaseAuth(config, '/user', {
        method: 'PUT',
        body: { password },
        accessToken,
      })
      if (status !== 200) return json({ error: authErrorMessage(data) }, 400, setCookies)
      return json({ ok: true }, 200, setCookies)
    }

    default:
      return json({ error: 'not found' }, 404)
  }
}
