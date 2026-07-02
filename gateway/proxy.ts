import { clearSessionCookies, cookieNames, parseCookies, sessionCookies } from './cookies'
import { refreshSession, resolveAccessToken, type GatewayConfig } from './auth-handlers'

// Headers forwarded from the client to Supabase. Everything else — cookies,
// client-supplied apikey/authorization — is dropped; the gateway injects its
// own credentials.
const FORWARD_REQUEST_HEADERS = [
  'content-type',
  'prefer',
  'range',
  'accept',
  'accept-profile',
  'content-profile',
  'x-upsert',
  'cache-control',
]

// /db/* → {SUPABASE_URL}/* with the user's access token from the httpOnly
// cookie. Handles token expiry transparently: proactive refresh before
// forwarding, plus one retry if Supabase still reports an expired JWT.
export async function handleDbProxy(
  config: GatewayConfig,
  request: Request,
  url: URL
): Promise<Response> {
  const upstreamPath = url.pathname.slice('/db'.length)

  // Auth flows only go through /auth/* — never raw GoTrue.
  if (upstreamPath.startsWith('/auth/')) {
    return jsonError('auth endpoints are not proxied', 403)
  }

  let { accessToken, setCookies } = await resolveAccessToken(config, request, url)
  if (!accessToken) {
    return jsonError('not authenticated', 401, setCookies)
  }

  // Buffer the body so the request can be retried after a refresh.
  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : await request.arrayBuffer()

  let upstream = await forward(config, request, url, upstreamPath, accessToken, body)

  if (upstream.status === 401 && (await isJwtExpiredResponse(upstream.clone()))) {
    const rt = parseCookies(request)[cookieNames(url).refreshToken]
    const session = rt ? await refreshSession(config, rt) : null
    if (!session) {
      return jsonError('session expired', 401, clearSessionCookies(url))
    }
    setCookies = sessionCookies(url, session)
    upstream = await forward(config, request, url, upstreamPath, session.access_token, body)
  }

  const headers = new Headers()
  for (const name of ['content-type', 'content-range', 'content-profile', 'preference-applied']) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  for (const c of setCookies) headers.append('Set-Cookie', c)

  return new Response(upstream.body, { status: upstream.status, headers })
}

async function forward(
  config: GatewayConfig,
  request: Request,
  url: URL,
  upstreamPath: string,
  accessToken: string,
  body: ArrayBuffer | undefined
): Promise<Response> {
  const target = new URL(`${config.supabaseUrl}${upstreamPath}`)
  url.searchParams.forEach((value, key) => target.searchParams.append(key, value))

  const headers = new Headers()
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  headers.set('apikey', config.publishableKey)
  headers.set('Authorization', `Bearer ${accessToken}`)

  return fetch(target.toString(), { method: request.method, headers, body })
}

async function isJwtExpiredResponse(response: Response): Promise<boolean> {
  try {
    const data: any = await response.json()
    const text = `${data?.code ?? ''} ${data?.message ?? ''} ${data?.error ?? ''}`.toLowerCase()
    return text.includes('pgrst301') || text.includes('jwt expired') || text.includes('invalid jwt')
  } catch {
    return false
  }
}

function jsonError(message: string, status: number, setCookies: string[] = []): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  for (const c of setCookies) headers.append('Set-Cookie', c)
  return new Response(JSON.stringify({ error: message }), { status, headers })
}
