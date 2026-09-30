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
import { buildProposal, confirmProposal, ConfirmError } from './chatProposals.js'
import { createMembershipLookup, hasAtLeast, type TeamRole } from './membership.js'
import { isValidSessionId } from './sessionId.js'
import { executeRollback, type ChatActionReceipt } from './chatRecovery.js'

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

async function insertChatLogs(config: ChatConfig, organizationId: number, userId: string, rows: { session_id: string; role: string; content: string; request_id?: string }[]): Promise<void> {
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


// Maps executeRollback's thrown errors (chatRecovery.ts, sealed in Task 2)
// to HTTP responses. The thrown messages are chatRecovery's only stable
// contract surface, so this matches stable substrings, not exact sentences,
// keeping the HTTP contract resilient to wording drift. Both runtimes route
// through this one function — the Worker handlers below and the Express
// mirrors in server/index.ts import it — so the error contract cannot
// diverge between them. The 500 body is generic on purpose: rollback
// internals (table names, statuses, paths) never leak.
export function mapRollbackError(err: unknown): { status: number; body: { error: string } } {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('action not found')) return { status: 404, body: { error: 'action not found' } }
  if (msg.includes('not in applied state')) return { status: 409, body: { error: 'action already undone or in progress' } }
  if (msg.includes('MISMATCH') || msg.includes('cannot be undone')) {
    return { status: 409, body: { error: 'action cannot be undone: the affected data has changed since the action was taken' } }
  }
  return { status: 500, body: { error: 'undo failed' } }
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
    // One id per request: links the chat_logs rows to any chat_actions
    // receipts this turn's tool calls produce (see the migration header in
    // 20260929120000_chat_actions.sql).
    const requestId = crypto.randomUUID()
    const actionReceipts: ChatActionReceipt[] = []

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
    // The proposal (if any write tool fired) rides back on the reply; last
    // wins — the UI shows one card at a time, earlier proposals just expire.
    let liveProposal: { id: string; tool_name: string; args: Record<string, unknown>; summary: string } | undefined
    try {
      const traceId = crypto.randomUUID()
      const tools = makeChatTools({
        dispatch: (name, args) => callChatFunction(actionsConfig, teamId, name, args, scope),
        role: user.role,
        // ChatToolDeps.propose returns { proposal_id, summary } — map
        // buildProposal's { id, ... } shape.
        propose: async (name, args) => {
          const p = await buildProposal(actionsConfig, { organization_id: teamId, session_id, user_id: user.sub }, name, args)
          return { proposal_id: p.id, summary: p.summary }
        },
        onProposal: p => { liveProposal = p },
        recovery: { sessionId: session_id, userId: user.sub, requestId },
        actionsConfig,
        orgId: teamId,
        onActionReceipt: (receipt) => { actionReceipts.push(receipt) },
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
      { session_id, role: 'user', content: message, request_id: requestId },
      { session_id, role: 'assistant', content: reply, request_id: requestId },
    ])

    return json({ reply, proposal: liveProposal, actions: actionReceipts })
  } catch (err: unknown) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
}

export async function handleChatConfirmRequest(config: ChatConfig, request: Request): Promise<Response> {
  try {
    const body: any = await request.json().catch(() => ({}))
    const { proposal_id, session_id, organization_id } = body as {
      proposal_id?: string; session_id?: string; organization_id?: number
    }
    if (!proposal_id || !session_id || !organization_id) return json({ error: 'proposal_id, session_id and organization_id required' }, 400)
    if (!isValidSessionId(session_id)) return json({ error: 'session_id must be a UUID' }, 400)

    const lookup = createMembershipLookup({
      supabaseUrl: config.supabaseUrl,
      supabaseSecretKey: config.supabaseSecretKey,
      onLookupError: (err) => Sentry.captureException(err),
    })
    const user = await requireTeamMember(config, request, Number(organization_id), 'member', lookup)
    if (!user.ok) return json({ error: user.error }, user.status)

    const actionsConfig: ActionsConfig = { supabaseUrl: config.supabaseUrl, supabaseSecretKey: config.supabaseSecretKey }
    const requestId = crypto.randomUUID()
    try {
      const result = await confirmProposal(actionsConfig, {
        id: proposal_id, session_id, organization_id: Number(organization_id), user_id: user.sub, role: user.role,
        recovery: { sessionId: session_id, userId: user.sub, requestId },
      })
      return json({ result, receipt: (result as { receipt?: unknown }).receipt ?? null })
    } catch (err) {
      if (err instanceof ConfirmError) return json({ error: err.message }, err.status)
      throw err
    }
  } catch (err: unknown) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
}

export async function handleChatUndoRequest(config: ChatConfig, request: Request): Promise<Response> {
  try {
    const body: any = await request.json().catch(() => ({}))
    const { action_id, organization_id, session_id } = body as {
      action_id?: string; organization_id?: number; session_id?: string
    }
    if (!action_id || !isValidSessionId(action_id)) return json({ error: 'action_id must be a UUID' }, 400)
    if (!organization_id) return json({ error: 'organization_id required' }, 400)

    // Undo rewrites team data, so it clears the same bar the write tools
    // do (the tools layer gates chat writes on editor); there is no tool
    // layer on this route, so the endpoint gates directly.
    const lookup = createMembershipLookup({
      supabaseUrl: config.supabaseUrl,
      supabaseSecretKey: config.supabaseSecretKey,
      onLookupError: (err) => Sentry.captureException(err),
    })
    const user = await requireTeamMember(config, request, Number(organization_id), 'editor', lookup)
    if (!user.ok) return json({ error: user.error }, user.status)

    // Scopes by action_id + org + verified user. session_id, when the client
    // sends one, is deliberately NOT a scoping key: ownership of a receipt
    // is the user, not the session, so a stale or wrong session_id cannot
    // widen or narrow what an undo matches.
    const action = await executeRollback(
      { supabaseUrl: config.supabaseUrl, supabaseSecretKey: config.supabaseSecretKey },
      Number(organization_id),
      action_id,
      user.sub,
    )
    return json({ ok: true, action })
  } catch (err: unknown) {
    const mapped = mapRollbackError(err)
    if (mapped.status >= 500) Sentry.captureException(err)
    return json(mapped.body, mapped.status)
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
    // Receipts ride along with history so the UI can attach Undo to the
    // message whose request_id produced the action. before_rows/after_rows
    // are deliberately never selected: snapshots are server-side undo
    // mechanics, not client data.
    const actions = await supabaseServiceFetch(
      config,
      `/chat_actions?select=id,request_id,description,status&session_id=eq.${encodeURIComponent(sessionId)}&organization_id=eq.${organizationId}&user_id=eq.${encodeURIComponent(user.sub)}&order=created_at.desc&limit=50`
    )
    return json({ messages: rows ?? [], actions: actions ?? [] })
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

    // Deliberately deletes chat_logs ONLY: chat_actions receipts survive
    // history clearing (binding spec rule) so an action stays undoable
    // after the messages describing it are gone. Never add chat_actions here.
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
