import * as Sentry from '@sentry/cloudflare'
import { GoogleGenAI } from '@google/genai'
import { z } from 'zod'
import { getVaultSecret } from './secrets.js'
import { createMembershipLookup } from './membership.js'
import { requireTeamMember, resolveChatScope, insertChatLogs, type ChatConfig } from './chat.js'
import { getTeamContext } from './agent/context.js'
import { makeChatTools } from './agent/tools.js'
import { callChatFunction, type ActionsConfig } from './gameActions.js'
import { buildProposal } from './chatProposals.js'
import { isValidSessionId } from './sessionId.js'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export async function handleVoiceSessionRequest(config: ChatConfig, request: Request): Promise<Response> {
  try {
    const body: any = await request.json().catch(() => ({}))
    const { organization_id, session_id, voiceName } = body as { organization_id: number, session_id: string, voiceName?: string }
    if (!organization_id || !session_id) return json({ error: 'organization_id and session_id required' }, 400)
    if (!isValidSessionId(session_id)) return json({ error: 'session_id must be a UUID' }, 400)

    const lookup = createMembershipLookup({
      supabaseUrl: config.supabaseUrl,
      supabaseSecretKey: config.supabaseSecretKey,
      onLookupError: (err) => Sentry.captureException(err),
    })
    const user = await requireTeamMember(config, request, Number(organization_id), 'member', lookup)
    if (!user.ok) return json({ error: user.error }, user.status)

    const teamId = Number(organization_id)
    const scope = await resolveChatScope(config, user, teamId, lookup)
    const systemContext = await getTeamContext(config, teamId, scope)

    const geminiApiKey = await getVaultSecret(config, 'gemini_api_key', config.geminiApiKey)
    const geminiModel = await getVaultSecret(config, 'gemini_live_model', config.geminiModel) ?? 'gemini-3.8-live'
    const voice = voiceName ?? 'Charon'
    if (!geminiApiKey) return json({ error: 'Gemini API key not configured' }, 500)

    // Locked config per Eric's design
    const tools = makeChatTools({
      dispatch: async () => ({}), // Stubs for schema extraction
      role: user.role,
    })

    const functionDeclarations = tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(t.schema as any, { target: 'draft-7' })
    }))

    // Add client-handled tools
    functionDeclarations.push(
      {
        name: 'confirm_pending_action',
        description: 'Confirms the current pending proposal (the ActionCard shown in UI) after the user says "yes" or "do it".',
        parameters: { type: 'object', properties: {}, required: [] }
      } as any,
      {
        name: 'cancel_pending_action',
        description: 'Cancels the current pending proposal after the user says "no" or "cancel".',
        parameters: { type: 'object', properties: {}, required: [] }
      } as any
    )

    const ai = new GoogleGenAI({ apiKey: geminiApiKey, httpOptions: { apiVersion: 'v1alpha' } })
    const tokenResponse = await ai.authTokens.create({
      config: {
        uses: 1,
        liveConnectConstraints: {
          model: `models/${geminiModel}`,
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } }
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            contextWindowCompression: { slidingWindow: {} },
            systemInstruction: {
              parts: [{
                text: systemContext + '\n\nVOICE MODE RULES: Speak briefly. Do not use markdown. State every change clearly before making it. Only confirm an action (via confirm_pending_action) after the user explicitly says "yes" or "do it".'
              }]
            },
            tools: [{ functionDeclarations }]
          } as any
        }
      }
    })

    return json({ token: tokenResponse.name, model: geminiModel })
  } catch (err: unknown) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
}

export async function handleVoiceToolRequest(config: ChatConfig, request: Request): Promise<Response> {
  try {
    const body: any = await request.json().catch(() => ({}))
    const { organization_id, session_id, name, args } = body as {
      organization_id: number; session_id: string; name: string; args: Record<string, unknown>
    }
    if (!organization_id || !session_id || !name) return json({ error: 'organization_id, session_id and name required' }, 400)

    const lookup = createMembershipLookup({
      supabaseUrl: config.supabaseUrl,
      supabaseSecretKey: config.supabaseSecretKey,
      onLookupError: (err) => Sentry.captureException(err),
    })
    const user = await requireTeamMember(config, request, Number(organization_id), 'member', lookup)
    if (!user.ok) return json({ error: user.error }, user.status)

    const teamId = Number(organization_id)
    const scope = await resolveChatScope(config, user, teamId, lookup)
    const actionsConfig: ActionsConfig = { supabaseUrl: config.supabaseUrl, supabaseSecretKey: config.supabaseSecretKey }
    const requestId = crypto.randomUUID()

    let liveProposal: any = undefined
    const tools = makeChatTools({
      dispatch: (n, a) => callChatFunction(actionsConfig, teamId, n, a, scope),
      role: user.role,
      propose: async (n, a) => {
        const p = await buildProposal(actionsConfig, { organization_id: teamId, session_id, user_id: user.sub }, n, a)
        return { proposal_id: p.id, summary: p.summary }
      },
      onProposal: p => { liveProposal = p },
      recovery: { sessionId: session_id, userId: user.sub, requestId },
      actionsConfig,
      orgId: teamId,
      // onSpan/onActionReceipt stubs or real if needed.
    })

    const tool = tools.find(t => t.name === name)
    if (!tool) return json({ error: `Tool ${name} not found` }, 404)

    const output = await tool.func(args)
    return json({ output, proposal: liveProposal })
  } catch (err: unknown) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
}

export async function handleVoiceLogRequest(config: ChatConfig, request: Request): Promise<Response> {
  try {
    const body: any = await request.json().catch(() => ({}))
    const { organization_id, session_id, turns } = body as {
      organization_id: number; session_id: string; turns: { role: string; content: string }[]
    }
    if (!organization_id || !session_id || !turns) return json({ error: 'organization_id, session_id and turns required' }, 400)

    const user = await requireTeamMember(config, request, Number(organization_id))
    if (!user.ok) return json({ error: user.error }, user.status)

    await insertChatLogs(config, Number(organization_id), user.sub, turns.map(t => ({
      session_id,
      role: t.role,
      content: t.content,
      request_id: crypto.randomUUID()
    })))

    return json({ ok: true })
  } catch (err: unknown) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
}
