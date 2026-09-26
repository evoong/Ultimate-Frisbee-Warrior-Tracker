import { PostHog } from 'posthog-node'
import * as Sentry from '@sentry/cloudflare'
import type { GatewayConfig } from './index.js'
import { getVaultSecret } from './secrets.js'
import { cookieNames, parseCookies } from './cookies.js'
import { verifyAccessToken } from './jwt.js'
import { getTeamContext as buildTeamContext, type ChatScope } from './agent/context.js'
export { getTeamContext } from './agent/context.js'
import { runChatAgent } from './agent/agent.js'
import { makeChatTools } from './agent/tools.js'
import { callChatFunction, type ActionsConfig } from './gameActions.js'
import { createMembershipLookup, hasAtLeast, type TeamRole } from './membership.js'
import { isValidSessionId } from './sessionId.js'

// Chat needs privileged (service-role) Supabase access to read all team data
// regardless of caller identity, plus a Gemini key. Team-context/log queries
// use raw fetch (portable); the model round-trips go through the shared
// LangGraph agent (agent/agent.ts), which owns retries and tool rounds.
export interface ChatConfig extends GatewayConfig {
  supabaseSecretKey: string
  // Optional: Supabase Vault (see secrets.ts) is the primary source for
  // these now. These fields are only a fallback/override, e.g. for local
  // dev before Vault is populated.
  geminiApiKey?: string
  geminiModel?: string
  posthogProjectToken?: string
  posthogHost?: string
  // LangSmith tracing: absent/blank key = tracing fully off (Global
  // Constraint #5).
  langsmithApiKey?: string
  langsmithProject?: string
}

// Switched from gemma-4-31b-it: side-by-side timing showed gemini-flash-lite
// averaging ~0.6s per reply vs gemma's ~20s+ (and occasional transient 500s).
// Overridable via the GEMINI_MODEL env var (see worker.ts).
const DEFAULT_GEMINI_MODEL = 'gemini-flash-lite-latest'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function supabaseServiceFetch(config: ChatConfig, path: string): Promise<any> {
  const res = await fetch(`${config.supabaseUrl}/rest/v1${path}`, {
    headers: {
      apikey: config.supabaseSecretKey,
      Authorization: `Bearer ${config.supabaseSecretKey}`,
    },
  })
  if (!res.ok) throw new Error(`Supabase query failed (${res.status}): ${path}`)
  return res.json()
}

async function insertChatLogs(config: ChatConfig, organizationId: number, userId: string, rows: { session_id: string; role: string; content: string }[]): Promise<void> {
  await fetch(`${config.supabaseUrl}/rest/v1/chat_logs`, {
    method: 'POST',
    headers: {
      apikey: config.supabaseSecretKey,
      Authorization: `Bearer ${config.supabaseSecretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(rows.map(r => ({ ...r, organization_id: organizationId, user_id: userId }))),
  }).catch(() => void 0)
}

// Chat runs on the service-role key, which ignores RLS. This function is
// the only thing standing between a caller and another team's data, so it
// checks the team the caller actually named -- and rejects guests, because
// chat is members-only (Tier B in the permission spec).
// 401 means "authenticate", 403 means "authenticated, but not on this team".
// Returning null for both, as an earlier version did, made an unauthenticated
// caller look identical to a rejected member and put this runtime out of step
// with Express, which distinguishes them.
type ChatCaller =
  | { ok: true; sub: string; email: string | null; role: TeamRole }
  | { ok: false; status: 401 | 403; error: string }

async function requireTeamMember(
  config: ChatConfig,
  request: Request,
  organizationId: number,
  required: TeamRole = 'member',
  lookup?: ReturnType<typeof createMembershipLookup>
): Promise<ChatCaller> {
  const url = new URL(request.url)
  const token = parseCookies(request)[cookieNames(url).accessToken]
  if (!token) return { ok: false, status: 401, error: 'not authenticated' }

  const claims = await verifyAccessToken(token, config.jwksUrl, config.supabaseUrl)
  if (!claims) return { ok: false, status: 401, error: 'not authenticated' }
  // A guest holds a real, verified anonymous JWT: authenticated, not permitted.
  if (claims.isAnonymous) return { ok: false, status: 403, error: 'not a member of this team' }

  const resolved = lookup ?? createMembershipLookup({
    supabaseUrl: config.supabaseUrl,
    supabaseSecretKey: config.supabaseSecretKey,
    onLookupError: (err) => Sentry.captureException(err),
  })
  const role = await resolved.roleFor(claims.sub, organizationId)
  if (!hasAtLeast(role, required)) {
    return { ok: false, status: 403, error: 'not a member of this team' }
  }

  return { ok: true, sub: claims.sub, email: claims.email, role: role as TeamRole }
}


export async function handleChatRequest(config: ChatConfig, request: Request): Promise<Response> {
  try {
    const body: any = await request.json().catch(() => ({}))
    const { message, session_id, history = [], organization_id } = body as {
      message: string; session_id: string; history: { role: string; content: string }[]; organization_id: number
    }
    if (!message || !session_id) return json({ error: 'message and session_id required' }, 400)
    if (!organization_id) return json({ error: 'organization_id required' }, 400)
    if (!isValidSessionId(session_id)) return json({ error: 'session_id must be a UUID' }, 400)

    const lookup = createMembershipLookup({
      supabaseUrl: config.supabaseUrl,
      supabaseSecretKey: config.supabaseSecretKey,
      onLookupError: (err) => Sentry.captureException(err),
    })
    const user = await requireTeamMember(config, request, Number(organization_id), 'member', lookup)
    if (!user.ok) return json({ error: user.error }, user.status)

    const teamId = Number(organization_id)

    // Player scope (spec: captain/editor = full team; member with an
    // approved link = their player only; member unlinked = full team).
    // playerLinkFor throws on outage so a broken lookup can never widen
    // the context (Task 3).
    let scope: ChatScope | undefined
    if (user.role === 'member') {
      const linkedId = await lookup.playerLinkFor(user.sub, teamId)
      if (linkedId != null) {
        const rows = await supabaseServiceFetch(config, `/players?select=display_name&id=eq.${linkedId}`)
        const name = Array.isArray(rows) && rows[0]?.display_name ? rows[0].display_name : null
        if (name) scope = { playerId: linkedId, playerName: name }
      }
    }

    const systemContext = await buildTeamContext(config, teamId, scope)
    // (buildTeamContext is the local alias for agent/context.ts's
    // getTeamContext, imported in Task 6; the re-export stays for
    // freeTierHistory.test.mjs.)
    const geminiApiKey = await getVaultSecret(config, 'gemini_api_key', config.geminiApiKey)
    const geminiModel = await getVaultSecret(config, 'gemini_model', config.geminiModel) ?? DEFAULT_GEMINI_MODEL
    if (!geminiApiKey) return json({ error: 'Gemini API key not configured' }, 500)
    const actionsConfig: ActionsConfig = { supabaseUrl: config.supabaseUrl, supabaseSecretKey: config.supabaseSecretKey }

    const posthog = new PostHog(config.posthogProjectToken!, { host: config.posthogHost, flushAt: 1, flushInterval: 0 })
    let reply: string
    try {
      const traceId = crypto.randomUUID()
      const tools = makeChatTools({
        dispatch: (name, args) => callChatFunction(actionsConfig, teamId, name, args, scope),
        role: user.role,
        onSpan: (name, args, result, latencyMs) => posthog.capture({
          distinctId: user.sub,
          event: '$ai_span',
          properties: {
            $ai_trace_id: traceId,
            $ai_session_id: session_id,
            $ai_span_id: crypto.randomUUID(),
            $ai_span_name: name,
            $ai_input_state: args,
            $ai_output_state: result.error ? { error: result.error } : result.output,
            $ai_latency: latencyMs / 1000,
          },
        }),
      })
      const agentStart = Date.now()
      reply = await runChatAgent({
        apiKey: geminiApiKey,
        model: geminiModel,
        systemPrompt: systemContext,
        history,
        message,
        tools,
        langSmith: config.langsmithApiKey ? { apiKey: config.langsmithApiKey, project: config.langsmithProject ?? 'ufwt-chat' } : undefined,
      })
      // Replaces the @posthog/ai wrapper's auto $ai_generation: one manual
      // event per request keeps PostHog's AI observability dashboards alive.
      posthog.capture({
        distinctId: user.sub,
        event: '$ai_generation',
        properties: {
          $ai_trace_id: traceId,
          $ai_session_id: session_id,
          $ai_model: geminiModel,
          $ai_latency: (Date.now() - agentStart) / 1000,
          $ai_output: reply,
          $ai_org_id: teamId,
        },
      })
    } finally {
      await posthog.shutdown()
    }

    await insertChatLogs(config, teamId, user.sub, [
      { session_id, role: 'user', content: message },
      { session_id, role: 'assistant', content: reply },
    ])

    return json({ reply })
  } catch (err: unknown) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
}

export async function handleChatHistoryRequest(config: ChatConfig, request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('session_id')
    const organizationId = Number(url.searchParams.get('organization_id'))
    if (!sessionId) return json({ error: 'session_id required' }, 400)
    if (!organizationId) return json({ error: 'organization_id required' }, 400)
    if (!isValidSessionId(sessionId)) return json({ error: 'session_id must be a UUID' }, 400)

    const user = await requireTeamMember(config, request, Number(organizationId))
    if (!user.ok) return json({ error: user.error }, user.status)

    const rows = await supabaseServiceFetch(
      config,
      `/chat_logs?select=role,content,created_at&session_id=eq.${encodeURIComponent(sessionId)}&organization_id=eq.${organizationId}&user_id=eq.${encodeURIComponent(user.sub)}&order=created_at.asc`
    )
    return json(rows ?? [])
  } catch (err: unknown) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
}

export async function handleChatHistoryDeleteRequest(config: ChatConfig, request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('session_id')
    const organizationId = Number(url.searchParams.get('organization_id'))
    if (!sessionId) return json({ error: 'session_id required' }, 400)
    if (!organizationId) return json({ error: 'organization_id required' }, 400)
    if (!isValidSessionId(sessionId)) return json({ error: 'session_id must be a UUID' }, 400)

    const user = await requireTeamMember(config, request, Number(organizationId))
    if (!user.ok) return json({ error: user.error }, user.status)

    const res = await fetch(`${config.supabaseUrl}/rest/v1/chat_logs?session_id=eq.${encodeURIComponent(sessionId)}&organization_id=eq.${organizationId}&user_id=eq.${encodeURIComponent(user.sub)}`, {
      method: 'DELETE',
      headers: {
        apikey: config.supabaseSecretKey,
        Authorization: `Bearer ${config.supabaseSecretKey}`,
      },
    })
    if (!res.ok) throw new Error(`Supabase delete failed (${res.status})`)

    return json({ ok: true })
  } catch (err: unknown) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
}
