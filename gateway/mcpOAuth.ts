// Wraps the /mcp Durable Object (gateway/mcpAgent.ts) with a real OAuth 2.1
// authorization server (@cloudflare/workers-oauth-provider), so a remote MCP
// client (Claude Code, Claude Desktop) authenticates with the SAME login as
// the app itself — email + password against Supabase Auth — instead of a
// static shared bearer secret. Replaces the earlier MCP_AUTH_TOKEN approach.
//
// How it fits together: OAuthProvider owns the entire Worker's fetch()
// dispatch (see worker.ts). It handles /token and /register (dynamic client
// registration) internally; everything else — including /authorize and the
// rest of the actual app (the gateway, chat, static assets, ...) — falls
// through to `defaultHandler` below, since `authorizeEndpoint` is "used in
// OAuth metadata... not handled by the provider itself" per its own docs.
// `apiRoute: "/mcp"` is the only path OAuthProvider gates on a valid access
// token before invoking `apiHandler` (UfwtMcp.serve), injecting the
// authenticated user's `props` into `this.props` inside the Durable Object.
//
// Login itself is a plain HTML form POSTed back to /authorize, checking the
// entered credentials against Supabase's password grant
// (`/auth/v1/token?grant_type=password`) — the exact same Supabase project
// and identity system `gateway/auth-handlers.ts` uses for the web app's own
// login, just a different transport (no cookie, since there's no browser
// session for a headless MCP client to carry one in). That check only
// proves identity at login time: the props stored on the resulting grant
// are just `{ email }`, not the Supabase session itself — the MCP client's
// ongoing session (access + refresh tokens, ~1hr/30 days) is entirely
// OAuthProvider's own, independent of the Supabase session's lifetime, so
// there's no need to keep refreshing a Supabase token in lockstep. Tool
// calls still run under the service-role key (see gateway/mcpTools.ts),
// same trust model as the local stdio server; `email` is available via
// `this.props` inside gateway/mcpAgent.ts for future attribution if wanted.

import OAuthProvider, { type AuthRequest, type OAuthHelpers } from '@cloudflare/workers-oauth-provider'

export interface McpAuthProps {
  email: string
  [key: string]: unknown
}

interface OAuthEnv {
  SUPABASE_URL: string
  SUPABASE_PUBLISHABLE_KEY: string
  OAUTH_PROVIDER: OAuthHelpers
}

type AppFetch<Env> = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>

// Minimal local alias so this file doesn't need @cloudflare/workers-types as
// a hard dependency for the rest of the app (see worker.ts's own comment on
// the same tradeoff) — OAuthProvider's own .d.ts is the only place that
// actually requires the real ExecutionContext shape (see worker.ts's cast).
type ExecutionContext = { waitUntil: (promise: Promise<unknown>) => void }

const HIDDEN_FIELDS = ['response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'resource'] as const

function authRequestToHiddenFields(req: AuthRequest): Record<string, string> {
  return {
    response_type: req.responseType,
    client_id: req.clientId,
    redirect_uri: req.redirectUri,
    scope: req.scope.join(' '),
    state: req.state,
    code_challenge: req.codeChallenge ?? '',
    code_challenge_method: req.codeChallengeMethod ?? '',
    resource: Array.isArray(req.resource) ? req.resource[0] ?? '' : req.resource ?? '',
  }
}

function hiddenFieldsToAuthRequest(form: FormData): AuthRequest {
  return {
    responseType: String(form.get('response_type') ?? ''),
    clientId: String(form.get('client_id') ?? ''),
    redirectUri: String(form.get('redirect_uri') ?? ''),
    scope: String(form.get('scope') ?? '').split(' ').filter(Boolean),
    state: String(form.get('state') ?? ''),
    codeChallenge: String(form.get('code_challenge') ?? '') || undefined,
    codeChallengeMethod: String(form.get('code_challenge_method') ?? '') || undefined,
    resource: String(form.get('resource') ?? '') || undefined,
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderLoginPage(opts: { hidden: Record<string, string>; clientName?: string; email?: string; error?: string }): string {
  const hiddenInputs = HIDDEN_FIELDS.map(name => `<input type="hidden" name="${name}" value="${escapeHtml(opts.hidden[name] ?? '')}">`).join('\n    ')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — Ultimate Frisbee Warrior Tracker</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #1e293b; border-radius: 12px; padding: 2rem; width: 100%; max-width: 360px; box-shadow: 0 10px 30px rgba(0,0,0,0.3); }
  h1 { font-size: 1.25rem; margin: 0 0 0.25rem; }
  p.sub { color: #94a3b8; font-size: 0.875rem; margin: 0 0 1.5rem; }
  label { display: block; font-size: 0.8rem; color: #94a3b8; margin-bottom: 0.25rem; }
  input[type=email], input[type=password] { width: 100%; box-sizing: border-box; padding: 0.6rem 0.7rem; margin-bottom: 1rem; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: #e2e8f0; font-size: 0.95rem; }
  button { width: 100%; padding: 0.65rem; border-radius: 8px; border: none; background: #6366f1; color: white; font-size: 0.95rem; font-weight: 600; cursor: pointer; }
  button:hover { background: #4f46e5; }
  .error { background: #7f1d1d; color: #fecaca; padding: 0.6rem 0.8rem; border-radius: 8px; font-size: 0.85rem; margin-bottom: 1rem; }
</style>
</head>
<body>
  <div class="card">
    <h1>Sign in</h1>
    <p class="sub">${escapeHtml(opts.clientName ?? 'An MCP client')} wants to access your Ultimate Frisbee Warrior Tracker data. Use the same account you use to sign into the app.</p>
    ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ''}
    <form method="POST" action="/authorize">
      ${hiddenInputs}
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required autofocus value="${escapeHtml(opts.email ?? '')}">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required>
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`
}

async function supabasePasswordGrant(env: OAuthEnv, email: string, password: string): Promise<{ user: { email: string } } | null> {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) return null
  return res.json()
}

async function handleAuthorize(request: Request, env: OAuthEnv): Promise<Response> {
  if (request.method === 'GET') {
    const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request)
    const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId)
    return new Response(renderLoginPage({ hidden: authRequestToHiddenFields(authRequest), clientName: client?.clientName }), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }

  const form = await request.formData()
  const authRequest = hiddenFieldsToAuthRequest(form)
  const email = String(form.get('email') ?? '').trim()
  const password = String(form.get('password') ?? '')

  const rerender = (error: string) =>
    new Response(renderLoginPage({ hidden: authRequestToHiddenFields(authRequest), email, error }), {
      status: 401,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })

  if (!email || !password) return rerender('Enter your email and password.')

  const session = await supabasePasswordGrant(env, email, password)
  if (!session) return rerender('Invalid email or password.')

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest,
    userId: session.user.email,
    metadata: { email: session.user.email },
    scope: authRequest.scope,
    props: { email: session.user.email } satisfies McpAuthProps,
  })
  return Response.redirect(redirectTo, 302)
}

export function createUfwtOAuthProvider<Env extends OAuthEnv>(
  apiHandler: { fetch: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> },
  appFetch: AppFetch<Env>,
) {
  return new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: apiHandler as any,
    defaultHandler: {
      async fetch(request, env, ctx) {
        const url = new URL(request.url)
        if (url.pathname === '/authorize') return handleAuthorize(request, env as unknown as OAuthEnv)
        return appFetch(request, env, ctx as any)
      },
    },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
  })
}
