import { createRequireAllowedUser, type GatewayConfig } from './index.js'

// Chat needs privileged (service-role) Supabase access to read all team data
// regardless of caller identity, plus a Gemini key. Framework-agnostic (raw
// fetch, no SDKs) so it runs unchanged on both the Cloudflare Worker and the
// Express/Vercel server.
export interface ChatConfig extends GatewayConfig {
  supabaseSecretKey: string
  geminiApiKey: string
  isEmailAllowed: (email: string) => Promise<boolean>
}

const GEMINI_MODEL = 'gemma-4-31b-it'

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
    supabaseServiceFetch(config, '/game_events?select=player_id,related_player_id,event_type,game_id'),
    supabaseServiceFetch(config, '/season_players?select=player_id,season_id&active=eq.true'),
  ])

  const seasonNames = new Map((seasons ?? []).map((s: any) => [s.id, `${s.organizer ?? ''} ${s.name} ${s.year}`.trim()]))
  const gameMap = new Map<number, any>((games ?? []).map((g: any) => [g.id, g]))

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

  return `You are a helpful assistant for the Ultimate Frisbee Warriors team tracking app. You have access to the following live team data:

SEASONS:
${(seasons ?? []).map((s: any) => `- ${seasonNames.get(s.id)}`).join('\n')}

GAME RESULTS:
${gameResultLines.join('\n')}

PLAYER STATS (All-time totals + breakdown by season + breakdown by game):
${playerSections.join('\n\n')}

LANGUAGE STYLE: Respond ONLY in Jamaican Patois, in every message, no exceptions. Keep it warm and natural (e.g. "wah gwaan", "mi", "yuh", "di", "dem", "nuh", "ting"), but never let the patois obscure the actual answer — names, numbers, dates, and stats must stay exact and easy to read. If a question is complex, prioritize clarity: use simple patois phrasing over anything cute that risks confusing the user.

Answer questions about the team, players, stats, and games. Be concise and friendly. When giving stats, reference the season and game breakdowns where relevant. If asked to do something you can't (like edit data), explain that the app UI should be used for that — still in patois.`
}

async function callGemini(apiKey: string, systemInstruction: string, history: { role: string; content: string }[], message: string): Promise<string> {
  const contents = [
    ...history.map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] })),
    { role: 'user', parts: [{ text: message }] },
  ]

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents,
      }),
    }
  )
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Gemini request failed (${res.status}): ${text.slice(0, 300)}`)
  }
  const data: any = await res.json()
  return data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') ?? ''
}

export async function handleChatRequest(config: ChatConfig, request: Request): Promise<Response> {
  const user = await createRequireAllowedUser(config, config.isEmailAllowed)(request)
  if (!user) return json({ error: 'not authenticated' }, 401)

  try {
    const body: any = await request.json().catch(() => ({}))
    const { message, session_id, history = [] } = body as { message: string; session_id: string; history: { role: string; content: string }[] }
    if (!message || !session_id) return json({ error: 'message and session_id required' }, 400)

    const systemContext = await getTeamContext(config)
    const reply = await callGemini(config.geminiApiKey, systemContext, history, message)

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
