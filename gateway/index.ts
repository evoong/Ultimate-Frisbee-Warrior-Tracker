import { handleAuthRequest, type GatewayConfig } from './auth-handlers'
import { handleDbProxy } from './proxy'
import { csrfViolation } from './csrf'
import { cookieNames, parseCookies } from './cookies'
import { verifyAccessToken } from './jwt'

export type { GatewayConfig }
export type Gateway = (request: Request) => Promise<Response | null>

// Framework-agnostic auth gateway: owns /auth/* (login, OAuth, refresh,
// logout, session, password reset) and /db/* (authenticated proxy to
// Supabase REST + Storage). Returns null for any other path so callers can
// fall through to their own routing (assets on Workers, Express routes).
export function createGateway(config: GatewayConfig): Gateway {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url)
    const path = url.pathname

    const owned = path === '/auth' || path.startsWith('/auth/') || path === '/db' || path.startsWith('/db/')
    if (!owned) return null

    const csrf = csrfViolation(request, url)
    if (csrf) return csrf

    if (path.startsWith('/db')) return handleDbProxy(config, request, url)
    return handleAuthRequest(config, request, url)
  }
}

export interface AllowedUser {
  sub: string
  email: string
}

// For routes OUTSIDE the gateway that hold privileged credentials (the
// Express chat endpoints use the service role, which bypasses RLS). Verifies
// the access-token cookie against the project JWKS and checks the allowlist
// via the caller-provided lookup (service-role query, cached by the caller).
export function createRequireAllowedUser(
  config: GatewayConfig,
  isEmailAllowed: (email: string) => Promise<boolean>
) {
  return async (request: Request): Promise<AllowedUser | null> => {
    const url = new URL(request.url)
    const token = parseCookies(request)[cookieNames(url).accessToken]
    if (!token) return null
    const claims = await verifyAccessToken(token, config.jwksUrl, config.supabaseUrl)
    if (!claims) return null
    if (!(await isEmailAllowed(claims.email.toLowerCase()))) return null
    return claims
  }
}
