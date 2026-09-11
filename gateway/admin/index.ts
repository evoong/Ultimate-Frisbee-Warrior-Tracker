import { cookieNames, parseCookies } from '../cookies.js'
import { csrfViolation } from '../csrf.js'
import { verifyAccessToken } from '../jwt.js'
import type { AdminLookup } from './adminAuth.js'
import { ADMIN_OPERATIONS } from './ops.js'
import { createRegistry, dispatchOperation, type AdminCtx } from './operations.js'
import { handleAdminRead } from './reads.js'

// The admin console's request handler. Lives OUTSIDE createGateway on purpose:
// the gateway "only ever proxies as the caller's own token" (see worker.ts),
// and these handlers hold the service-role key. Chat sits outside the gateway
// for exactly the same reason.
//
// Mounted twice -- worker.ts and server/index.ts -- and framework-agnostic
// like the gateway itself, returning null for any path it does not own.
//
// The API prefix is /api/admin, NOT /admin. worker.ts serves the SPA fallback
// only for paths that fail its isGatewayPath check, so an /admin API prefix
// would make a browser navigation to /admin/users return 404 instead of
// loading the app. /api is already in that list.

export interface AdminConfig {
  supabaseUrl: string
  supabaseSecretKey: string
  jwksUrl: string
}

const PREFIX = '/api/admin'

// Pure and stateless, so module scope is safe in a long-lived Worker isolate.
// createRegistry throws on a duplicate name, making a collision a startup
// failure rather than a silently shadowed operation.
const REGISTRY = createRegistry(ADMIN_OPERATIONS)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function isAdminPath(path: string): boolean {
  return path === PREFIX || path.startsWith(`${PREFIX}/`)
}

export async function handleAdminRequest(
  config: AdminConfig,
  request: Request,
  lookup: AdminLookup
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!isAdminPath(url.pathname)) return null

  // Same CSRF posture as /auth and /db. Reused verbatim rather than
  // reimplemented so the admin surface cannot drift from the app's.
  const csrf = csrfViolation(request, url)
  if (csrf) return csrf

  const token = parseCookies(request)[cookieNames(url).accessToken]
  const claims = token ? await verifyAccessToken(token, config.jwksUrl, config.supabaseUrl) : null
  if (!claims) return json({ error: 'not authenticated' }, 401)

  // A guest is never an admin. The lookup below would return null anyway
  // (an anonymous user holds no platform_admins row), but stating it here
  // means a future bug that grants a row to an anonymous id still denies.
  if (claims.isAnonymous) return json({ error: 'not an admin' }, 403)

  const adminRole = await lookup.roleFor(claims.sub)
  // Fail-closed: a lookup outage resolves to null and therefore to a denial.
  // Deliberately indistinguishable from "not an admin" in the response --
  // whether a given account is an admin is not something to confirm to a
  // non-admin caller.
  if (!adminRole) return json({ error: 'not an admin' }, 403)

  const ctx: AdminCtx = {
    config: { supabaseUrl: config.supabaseUrl, supabaseSecretKey: config.supabaseSecretKey },
    adminId: claims.sub,
    adminRole,
    requestId: crypto.randomUUID(),
  }

  const segments = url.pathname.slice(PREFIX.length).split('/').filter(Boolean)

  // Confirms admin status to the frontend so it can render the nav link. This
  // replaces the /auth/session field the spec first proposed: the gateway has
  // no service-role key and so cannot read platform_admins.
  if (segments[0] === 'whoami' && request.method === 'GET') {
    return json({ role: adminRole, admin_id: claims.sub })
  }

  if (request.method === 'GET') {
    const read = await handleAdminRead(ctx, segments, url)
    if (read) return json(read.body, read.status)
    return json({ error: 'unknown admin route' }, 404)
  }

  if (request.method === 'POST' && segments[0] === 'op' && segments[1]) {
    let payload: any
    try {
      payload = await request.json()
    } catch {
      return json({ error: 'body must be JSON' }, 400)
    }
    const mode = payload?.mode === 'apply' ? 'apply' : 'preview'
    const result = await dispatchOperation(REGISTRY, ctx, segments[1], mode, payload?.input ?? {})
    return json(result.body, result.status)
  }

  return json({ error: 'unknown admin route' }, 404)
}
