// CSRF defense for the gateway. Session cookies are SameSite=Lax, which
// already blocks cross-site POSTs from browsers; these header checks add a
// second layer and cover older browsers.
//
// Rules for state-changing (non-GET/HEAD) requests under /auth and /db:
//   - If Sec-Fetch-Site is present it must be same-origin (or none, e.g.
//     direct navigation / tooling).
//   - If Origin is present its host must match the request host.
// Requests without either header (curl, server-to-server) pass — cookies are
// the credential, and a cross-site browser attack always sends Origin.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function csrfViolation(request: Request, url: URL): Response | null {
  if (SAFE_METHODS.has(request.method)) return null

  const secFetchSite = request.headers.get('sec-fetch-site')
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return forbidden('cross-site request blocked')
  }

  const origin = request.headers.get('origin')
  if (origin && origin !== 'null') {
    try {
      if (new URL(origin).host !== url.host) {
        return forbidden('origin mismatch')
      }
    } catch {
      return forbidden('malformed origin')
    }
  } else if (origin === 'null') {
    return forbidden('opaque origin blocked')
  }

  return null
}

function forbidden(reason: string): Response {
  return new Response(JSON.stringify({ error: `CSRF check failed: ${reason}` }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  })
}
