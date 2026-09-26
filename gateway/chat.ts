import { GoogleGenAI } from '@posthog/ai/gemini'
import type { Content } from '@google/genai'
import { PostHog } from 'posthog-node'
import * as Sentry from '@sentry/cloudflare'
import type { GatewayConfig } from './index.js'
import { getVaultSecret } from './secrets.js'
import { cookieNames, parseCookies } from './cookies.js'
import { verifyAccessToken } from './jwt.js'
import { getTeamContext as buildTeamContext, type ChatScope } from './agent/context.js'
export { getTeamContext } from './agent/context.js'
import { CHAT_FUNCTION_DECLARATIONS, WRITE_FUNCTIONS, callChatFunction, type ActionsConfig } from './gameActions.js'
import { createMembershipLookup, hasAtLeast, type TeamRole } from './membership.js'
import { isValidSessionId } from './sessionId.js'

// Chat needs privileged (service-role) Supabase access to read all team data
// regardless of caller identity, plus a Gemini key. Team-context/log queries
// use raw fetch (portable), but the Gemini call itself uses the official SDK
// — same as server/index.ts — via its browser/fetch build, so behavior matches
// Vercel exactly. The SDK itself does not retry transient errors, so this
// module retries them itself (see isTransientGeminiError).
export interface ChatConfig extends GatewayConfig {
  supabaseSecretKey: string
  // Optional: Supabase Vault (see secrets.ts) is the primary source for
  // these now. These fields are only a fallback/override, e.g. for local
  // dev before Vault is populated.
  geminiApiKey?: string
  geminiModel?: string
  posthogProjectToken?: string
  posthogHost?: string
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
  required: TeamRole = 'member'
): Promise<ChatCaller> {
  const url = new URL(request.url)
  const token = parseCookies(request)[cookieNames(url).accessToken]
  if (!token) return { ok: false, status: 401, error: 'not authenticated' }

  const claims = await verifyAccessToken(token, config.jwksUrl, config.supabaseUrl)
  if (!claims) return { ok: false, status: 401, error: 'not authenticated' }
  // A guest holds a real, verified anonymous JWT: authenticated, not permitted.
  if (claims.isAnonymous) return { ok: false, status: 403, error: 'not a member of this team' }

  const lookup = createMembershipLookup({
    supabaseUrl: config.supabaseUrl,
    supabaseSecretKey: config.supabaseSecretKey,
    onLookupError: (err) => Sentry.captureException(err),
  })
  const role = await lookup.roleFor(claims.sub, organizationId)
  if (!hasAtLeast(role, required)) {
    return { ok: false, status: 403, error: 'not a member of this team' }
  }

  return { ok: true, sub: claims.sub, email: claims.email, role: role as TeamRole }
}


function isTransientGeminiError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err)
  return text.includes('"code":500') || text.includes('INTERNAL') || text.includes('UNAVAILABLE')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function callGemini(
  posthog: PostHog, apiKey: string, model: string, systemInstruction: string,
  history: { role: string; content: string }[], message: string,
  actionsConfig: ActionsConfig, organizationId: number, callerRole: TeamRole,
  sessionId: string, distinctId: string
): Promise<string> {
  // PostHog's Gemini wrapper only instruments models.generateContent (not
  // the chats.create()/sendMessage() session helper), so the conversation
  // history is threaded through generateContent calls by hand below —
  // mirroring what Chat.sendMessage does internally in @google/genai.
  const genai = new GoogleGenAI({ apiKey, posthog })
  const traceId = crypto.randomUUID()
  const posthogProperties = { $ai_session_id: sessionId }
  const config = { systemInstruction, tools: [{ functionDeclarations: CHAT_FUNCTION_DECLARATIONS }] }

  const contents: Content[] = history.map(h => ({
    role: h.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: h.content }],
  }))
  contents.push({ role: 'user', parts: [{ text: message }] })

  // Retry transient Gemini errors, but only for this first turn (was tuned
  // against gemma-4-31b-it, which could fail its transient 500 several
  // times in a row). Once a function call round below has actually
  // executed a real DB write, blindly retrying on a later transient error
  // could log the same event twice, so anything past this point surfaces
  // the error instead of retrying.
  const MAX_ATTEMPTS = 5
  let response
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      response = await genai.models.generateContent({
        model, contents, config,
        posthogDistinctId: distinctId,
        posthogTraceId: traceId,
        posthogProperties,
      })
      break
    } catch (err) {
      if (attempt === MAX_ATTEMPTS || !isTransientGeminiError(err)) throw err
      await sleep(600 * attempt)
    }
  }
  if (!response) throw new Error('unreachable')

  // The model confirms with the user in plain text before calling anything
  // (see the system prompt's "YOU CAN LOG DATA" instructions), so a
  // function call here means the user just confirmed — execute it for
  // real and hand the result back so the model can report what happened.
  const MAX_FUNCTION_ROUNDS = 4
  for (let round = 0; round < MAX_FUNCTION_ROUNDS; round++) {
    const calls = response.functionCalls
    if (!calls || calls.length === 0) break

    const modelContent = response.candidates?.[0]?.content
    if (modelContent) contents.push(modelContent)

    const parts = await Promise.all(calls.map(async call => {
      const start = Date.now()
      let output: unknown
      let error: string | undefined
      try {
        // Writes require member-tier on this team. A guest never reaches
        // here (requireTeamMember rejects anonymous/non-member callers
        // before callGemini is even invoked), but a future read-only role
        // would, and the model must not be the thing that decides.
        output = WRITE_FUNCTIONS.has(call.name!) && !hasAtLeast(callerRole, 'member')
          ? { error: "you do not have permission to change this team's data" }
          : await callChatFunction(actionsConfig, organizationId, call.name!, call.args ?? {})
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
      posthog.capture({
        distinctId,
        event: '$ai_span',
        properties: {
          $ai_trace_id: traceId,
          $ai_session_id: sessionId,
          $ai_span_id: crypto.randomUUID(),
          $ai_span_name: call.name,
          $ai_input_state: call.args,
          $ai_output_state: error ? { error } : output,
          $ai_latency: (Date.now() - start) / 1000,
        },
      })
      return error
        ? { functionResponse: { name: call.name!, response: { error } } }
        : { functionResponse: { name: call.name!, response: { output } } }
    }))
    contents.push({ role: 'user', parts })

    response = await genai.models.generateContent({
      model, contents, config,
      posthogDistinctId: distinctId,
      posthogTraceId: traceId,
      posthogProperties,
    })
  }

  return response.text ?? ''
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

    const user = await requireTeamMember(config, request, Number(organization_id))
    if (!user.ok) return json({ error: user.error }, user.status)

    // From here on, only this value is used. It has been checked against the
    // caller's membership; the raw body value never reaches a query again, and
    // nothing the model emits can change it.
    const teamId = Number(organization_id)

    const systemContext = await buildTeamContext(config, teamId)
    const geminiApiKey = await getVaultSecret(config, 'gemini_api_key', config.geminiApiKey)
    const geminiModel = await getVaultSecret(config, 'gemini_model', config.geminiModel) ?? DEFAULT_GEMINI_MODEL
    if (!geminiApiKey) return json({ error: 'Gemini API key not configured' }, 500)
    const actionsConfig: ActionsConfig = { supabaseUrl: config.supabaseUrl, supabaseSecretKey: config.supabaseSecretKey }

    // Per-request client (Workers has no module-scope access to `env`), so
    // it's shut down (not flushed) once this request's events are queued.
    const posthog = new PostHog(config.posthogProjectToken!, { host: config.posthogHost, flushAt: 1, flushInterval: 0 })
    let reply: string
    try {
      reply = await callGemini(posthog, geminiApiKey, geminiModel, systemContext, history, message, actionsConfig, teamId, user.role, session_id, user.sub)
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
