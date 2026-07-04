import { GoogleGenAI } from '@google/genai'
import { createRequireAllowedUser, type GatewayConfig } from './index.js'
import { getVaultSecret } from './secrets.js'

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
  isEmailAllowed: (email: string) => Promise<boolean>
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

async function insertChatLogs(config: ChatConfig, rows: { session_id: string; role: string; content: string }[]): Promise<void> {
  await fetch(`${config.supabaseUrl}/rest/v1/chat_logs`, {
    method: 'POST',
    headers: {
      apikey: config.supabaseSecretKey,
      Authorization: `Bearer ${config.supabaseSecretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(rows),
  }).catch(() => void 0)
}

type Stat = { goals: number; assists: number; turnovers: number }

async function getTeamContext(config: ChatConfig): Promise<string> {
  const [players, seasons, games, events, seasonPlayers] = await Promise.all([
    supabaseServiceFetch(config, '/players?select=id,display_name,position,gender_match,is_sub&order=display_name.asc'),
    supabaseServiceFetch(config, '/seasons?select=id,name,year,organizer&order=id.asc'),
    supabaseServiceFetch(config, '/games?select=id,season_id,opponent,game_date,result,outcome_override&order=game_date.asc'),
    supabaseServiceFetch(config, '/game_events?select=player_id,related_player_id,event_type,game_id,event_timestamp'),
    supabaseServiceFetch(config, '/season_players?select=player_id,season_id&active=eq.true'),
  ])

  const seasonNames = new Map((seasons ?? []).map((s: any) => [s.id, `${s.organizer ?? ''} ${s.name} ${s.year}`.trim()]))
  const gameMap = new Map<number, any>((games ?? []).map((g: any) => [g.id, g]))
  const playerNames = new Map<number, string>((players ?? []).map((p: any) => [p.id, p.display_name]))

  const allTime = new Map<number, Stat>()
  const bySeason = new Map<number, Map<number, Stat>>()
  const byGame = new Map<number, Map<number, Stat>>()

  const ensure = (map: Map<number, Stat>, id: number) => {
    if (!map.has(id)) map.set(id, { goals: 0, assists: 0, turnovers: 0 })
    return map.get(id)!
  }
  const ensureNested = (outer: Map<number, Map<number, Stat>>, pid: number, inner: number) => {
    if (!outer.has(pid)) outer.set(pid, new Map())
    return ensure(outer.get(pid)!, inner)
  }

  ;(events ?? []).forEach((e: any) => {
    const game = gameMap.get(e.game_id)
    const sid = game?.season_id

    if (e.player_id) {
      ensure(allTime, e.player_id)
      if (sid) ensureNested(bySeason, e.player_id, sid)
      ensureNested(byGame, e.player_id, e.game_id)

      if (e.event_type === 'Goal') {
        allTime.get(e.player_id)!.goals++
        if (sid) bySeason.get(e.player_id)!.get(sid)!.goals++
        byGame.get(e.player_id)!.get(e.game_id)!.goals++
      } else if (['Turnover', 'Throwaway', 'Drop'].includes(e.event_type)) {
        allTime.get(e.player_id)!.turnovers++
        if (sid) bySeason.get(e.player_id)!.get(sid)!.turnovers++
        byGame.get(e.player_id)!.get(e.game_id)!.turnovers++
      }
    }

    if (e.event_type === 'Goal' && e.related_player_id) {
      const sid2 = gameMap.get(e.game_id)?.season_id
      ensure(allTime, e.related_player_id)
      if (sid2) ensureNested(bySeason, e.related_player_id, sid2)
      ensureNested(byGame, e.related_player_id, e.game_id)
      allTime.get(e.related_player_id)!.assists++
      if (sid2) bySeason.get(e.related_player_id)!.get(sid2)!.assists++
      byGame.get(e.related_player_id)!.get(e.game_id)!.assists++
    }
  })

  const playerSections = (players ?? []).map((p: any) => {
    const at = allTime.get(p.id) ?? { goals: 0, assists: 0, turnovers: 0 }
    const header = `${p.display_name}${p.position ? ` (${p.position})` : ''}${p.is_sub ? ' [sub]' : ''}. All-time: ${at.goals}G ${at.assists}A ${at.turnovers}TO`

    const playerSeasonIds = (seasonPlayers ?? [])
      .filter((sp: any) => sp.player_id === p.id)
      .map((sp: any) => sp.season_id)

    const seasonLines = playerSeasonIds.map((sid: number) => {
      const st = bySeason.get(p.id)?.get(sid) ?? { goals: 0, assists: 0, turnovers: 0 }
      const seasonGames = (games ?? []).filter((g: any) => g.season_id === sid)
      const gameLine = seasonGames.map((g: any) => {
        const gs = byGame.get(p.id)?.get(g.id) ?? { goals: 0, assists: 0, turnovers: 0 }
        const res = g.outcome_override || g.result || 'TBD'
        return `      - ${g.game_date} vs ${g.opponent} (${res}): ${gs.goals}G ${gs.assists}A ${gs.turnovers}TO`
      }).join('\n')
      return `  [${seasonNames.get(sid) ?? sid}]: ${st.goals}G ${st.assists}A ${st.turnovers}TO\n${gameLine}`
    })

    return `${header}\n${seasonLines.join('\n')}`
  })

  const gameResultLines = (games ?? []).map((g: any) => {
    const res = g.outcome_override || g.result || 'TBD'
    const goals = (events ?? []).filter((e: any) => e.game_id === g.id && e.event_type === 'Goal').length
    const opp = (events ?? []).filter((e: any) => e.game_id === g.id && e.event_type === 'Opponent Goal').length
    return `- ${g.game_date} vs ${g.opponent} [${seasonNames.get(g.season_id) ?? '?'}]: ${goals}-${opp} ${res}`
  })

  // Chronological, timestamped play-by-play per game — lets the assistant
  // answer "when"/"what time"/"first"/"last"/time-between-events questions.
  const eventsByGame = new Map<number, any[]>()
  ;(events ?? []).forEach((e: any) => {
    if (!eventsByGame.has(e.game_id)) eventsByGame.set(e.game_id, [])
    eventsByGame.get(e.game_id)!.push(e)
  })

  const formatEventTime = (ts: string | null) =>
    ts ? new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '?'

  const eventTimelines = (games ?? [])
    .map((g: any) => {
      const gameEvents = (eventsByGame.get(g.id) ?? [])
        .slice()
        .sort((a: any, b: any) => (a.event_timestamp ?? '').localeCompare(b.event_timestamp ?? ''))
      if (gameEvents.length === 0) return null

      const lines = gameEvents.map((e: any) => {
        const time = formatEventTime(e.event_timestamp)
        const scorer = e.player_id ? playerNames.get(e.player_id) ?? 'Unknown' : null
        const assister = e.related_player_id ? playerNames.get(e.related_player_id) : null
        if (e.event_type === 'Goal') {
          return `    ${time} - Goal: ${scorer ?? 'Unknown'}${assister ? ` (assist: ${assister})` : ''}`
        }
        if (e.event_type === 'Opponent Goal') {
          return `    ${time} - Opponent Goal`
        }
        return `    ${time} - ${e.event_type}${scorer ? `: ${scorer}` : ''}`
      })

      return `- ${g.game_date} vs ${g.opponent}:\n${lines.join('\n')}`
    })
    .filter((line: string | null): line is string => line !== null)

  const currentDate = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

  return `You are a helpful assistant for the Ultimate Frisbee Warriors team tracking app. You have access to the following live team data:

CURRENT DATE: ${currentDate} — use this to resolve relative date questions (today, this week, last game, upcoming, how long ago, etc).

SEASONS:
${(seasons ?? []).map((s: any) => `- ${seasonNames.get(s.id)}`).join('\n')}

GAME RESULTS:
${gameResultLines.join('\n')}

PLAYER STATS (All-time totals + breakdown by season + breakdown by game):
${playerSections.join('\n\n')}

EVENT TIMELINE (chronological, with timestamps — use this for "when"/"what time"/"first"/"last"/time-between-events questions):
${eventTimelines.join('\n\n')}

LANGUAGE STYLE: Respond ONLY in Jamaican Patois, in every message, no exceptions. Keep it warm and natural (e.g. "wah gwaan", "mi", "yuh", "di", "dem", "nuh", "ting"), but never let the patois obscure the actual answer — names, numbers, dates, and stats must stay exact and easy to read. If a question is complex, prioritize clarity: use simple patois phrasing over anything cute that risks confusing the user.

Answer questions about the team, players, stats, and games. Be concise and friendly. When giving stats, reference the season and game breakdowns where relevant. If asked to do something you can't (like edit data), explain that the app UI should be used for that — still in patois.`
}

function isTransientGeminiError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err)
  return text.includes('"code":500') || text.includes('INTERNAL') || text.includes('UNAVAILABLE')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function callGemini(apiKey: string, model: string, systemInstruction: string, history: { role: string; content: string }[], message: string): Promise<string> {
  const genai = new GoogleGenAI({ apiKey })

  const chatHistory = history.map(h => ({
    role: h.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: h.content }],
  }))

  // Retry transient Gemini errors (was tuned against gemma-4-31b-it, which
  // could fail its transient 500 several times in a row; kept as a general
  // safety net now that the model has switched to gemini-flash-lite).
  const MAX_ATTEMPTS = 5
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const chat = genai.chats.create({
        model,
        history: chatHistory,
        config: { systemInstruction },
      })
      const response = await chat.sendMessage({ message })
      return response.text ?? ''
    } catch (err) {
      if (attempt === MAX_ATTEMPTS || !isTransientGeminiError(err)) throw err
      await sleep(600 * attempt)
    }
  }
  throw new Error('unreachable')
}

export async function handleChatRequest(config: ChatConfig, request: Request): Promise<Response> {
  const user = await createRequireAllowedUser(config, config.isEmailAllowed)(request)
  if (!user) return json({ error: 'not authenticated' }, 401)

  try {
    const body: any = await request.json().catch(() => ({}))
    const { message, session_id, history = [] } = body as { message: string; session_id: string; history: { role: string; content: string }[] }
    if (!message || !session_id) return json({ error: 'message and session_id required' }, 400)

    const systemContext = await getTeamContext(config)
    const geminiApiKey = await getVaultSecret(config, 'gemini_api_key', config.geminiApiKey)
    const geminiModel = await getVaultSecret(config, 'gemini_model', config.geminiModel) ?? DEFAULT_GEMINI_MODEL
    if (!geminiApiKey) return json({ error: 'Gemini API key not configured' }, 500)
    const reply = await callGemini(geminiApiKey, geminiModel, systemContext, history, message)

    await insertChatLogs(config, [
      { session_id, role: 'user', content: message },
      { session_id, role: 'assistant', content: reply },
    ])

    return json({ reply })
  } catch (err: unknown) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
}

export async function handleChatHistoryRequest(config: ChatConfig, request: Request): Promise<Response> {
  const user = await createRequireAllowedUser(config, config.isEmailAllowed)(request)
  if (!user) return json({ error: 'not authenticated' }, 401)

  try {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('session_id')
    if (!sessionId) return json({ error: 'session_id required' }, 400)

    const rows = await supabaseServiceFetch(
      config,
      `/chat_logs?select=role,content,created_at&session_id=eq.${encodeURIComponent(sessionId)}&order=created_at.asc`
    )
    return json(rows ?? [])
  } catch (err: unknown) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
}

export async function handleChatHistoryDeleteRequest(config: ChatConfig, request: Request): Promise<Response> {
  const user = await createRequireAllowedUser(config, config.isEmailAllowed)(request)
  if (!user) return json({ error: 'not authenticated' }, 401)

  try {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('session_id')
    if (!sessionId) return json({ error: 'session_id required' }, 400)

    const res = await fetch(`${config.supabaseUrl}/rest/v1/chat_logs?session_id=eq.${encodeURIComponent(sessionId)}`, {
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
