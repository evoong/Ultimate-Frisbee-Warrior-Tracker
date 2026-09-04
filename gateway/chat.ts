import { GoogleGenAI } from '@google/genai'
import type { GatewayConfig } from './index.js'
import { getVaultSecret } from './secrets.js'
import { cookieNames, parseCookies } from './cookies.js'
import { verifyAccessToken } from './jwt.js'
import { CHAT_FUNCTION_DECLARATIONS, callChatFunction, type ActionsConfig } from './gameActions.js'
import { createMembershipLookup, hasAtLeast, type TeamRole } from './membership.js'

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

async function insertChatLogs(config: ChatConfig, organizationId: number, rows: { session_id: string; role: string; content: string }[]): Promise<void> {
  await fetch(`${config.supabaseUrl}/rest/v1/chat_logs`, {
    method: 'POST',
    headers: {
      apikey: config.supabaseSecretKey,
      Authorization: `Bearer ${config.supabaseSecretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(rows.map(r => ({ ...r, organization_id: organizationId }))),
  }).catch(() => void 0)
}

// Chat runs on the service-role key, which ignores RLS. This function is
// the only thing standing between a caller and another team's data, so it
// checks the team the caller actually named -- and rejects guests, because
// chat is members-only (Tier B in the permission spec).
async function requireTeamMember(
  config: ChatConfig,
  request: Request,
  organizationId: number,
  required: TeamRole = 'member'
): Promise<{ sub: string; email: string | null; role: TeamRole } | null> {
  const url = new URL(request.url)
  const token = parseCookies(request)[cookieNames(url).accessToken]
  if (!token) return null

  const claims = await verifyAccessToken(token, config.jwksUrl, config.supabaseUrl)
  if (!claims) return null
  if (claims.isAnonymous) return null

  const lookup = createMembershipLookup({
    supabaseUrl: config.supabaseUrl,
    supabaseSecretKey: config.supabaseSecretKey,
  })
  const role = await lookup.roleFor(claims.sub, organizationId)
  if (!hasAtLeast(role, required)) return null

  return { sub: claims.sub, email: claims.email, role: role as TeamRole }
}

type Stat = { goals: number; assists: number; turnovers: number }

async function getTeamContext(config: ChatConfig, organizationId: number): Promise<string> {
  const orgFilter = `organization_id=eq.${organizationId}`
  const [players, seasons, games, events, seasonPlayers] = await Promise.all([
    supabaseServiceFetch(config, `/players?select=id,display_name,position,gender_match,is_sub&${orgFilter}&order=display_name.asc`),
    supabaseServiceFetch(config, `/seasons?select=id,name,year,organizer&${orgFilter}&order=id.asc`),
    supabaseServiceFetch(config, `/games?select=id,season_id,opponent,game_date,result,outcome_override&${orgFilter}&order=game_date.asc`),
    supabaseServiceFetch(config, `/game_events?select=player_id,related_player_id,event_type,game_id,event_timestamp&${orgFilter}`),
    supabaseServiceFetch(config, `/season_players?select=player_id,season_id&active=eq.true&${orgFilter}`),
  ])

  const seasonNames = new Map((seasons ?? []).map((s: any) => [s.id, `${s.organizer ?? ''} ${s.name} ${s.year}`.trim()]))
  const gameMap = new Map<number, any>((games ?? []).map((g: any) => [g.id, g]))
  const playerNames = new Map<number, string>((players ?? []).map((p: any) => [p.id, p.display_name]))

  const allTime = new Map<number, Stat>()
  const bySeason = new Map<number, Map<number, Stat>>()
  const byGame = new Map<number, Map<number, Stat>>()
  // scorerId -> assisterId -> count of goals scorer got from that assister
  const assistPairings = new Map<number, Map<number, number>>()
  // seasonId -> scorerId -> assisterId -> count, for season-scoped pairing
  // questions (the all-time-only assistPairings above is what let the model
  // fall back to unreliable hand-counting/tool-calling for those — see the
  // ASSIST PAIRINGS BY SEASON section below).
  const assistPairingsBySeason = new Map<number, Map<number, Map<number, number>>>()

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

      if (e.player_id) {
        if (!assistPairings.has(e.player_id)) assistPairings.set(e.player_id, new Map())
        const scorerMap = assistPairings.get(e.player_id)!
        scorerMap.set(e.related_player_id, (scorerMap.get(e.related_player_id) ?? 0) + 1)

        if (sid2) {
          if (!assistPairingsBySeason.has(sid2)) assistPairingsBySeason.set(sid2, new Map())
          const seasonPairings = assistPairingsBySeason.get(sid2)!
          if (!seasonPairings.has(e.player_id)) seasonPairings.set(e.player_id, new Map())
          const seasonScorerMap = seasonPairings.get(e.player_id)!
          seasonScorerMap.set(e.related_player_id, (seasonScorerMap.get(e.related_player_id) ?? 0) + 1)
        }
      }
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

  // Pre-tallied so the assistant never has to hand-count the raw timeline
  // (that's what produced wrong/inconsistent answers before — see chat.ts
  // history). Sorted by count descending so "who assisted X the most" is
  // just reading the first line.
  const assistPairingLines = (players ?? [])
    .map((p: any) => {
      const pairings = assistPairings.get(p.id)
      if (!pairings || pairings.size === 0) return null
      const sorted = [...pairings.entries()].sort((a, b) => b[1] - a[1])
      const parts = sorted.map(([assisterId, count]) => `${playerNames.get(assisterId) ?? 'Unknown'} (${count})`)
      return `- ${p.display_name}'s goals, all-time, by assister: ${parts.join(', ')}`
    })
    .filter((line: string | null): line is string => line !== null)

  // Same pre-tallying, broken out per season, so a season-scoped assist
  // pairing question ("who assisted X the most THIS season") never has to
  // fall back to a tool call or hand-counting the raw timeline — the
  // all-time-only table above was the gap that let that regress.
  const assistPairingsBySeasonLines = (seasons ?? [])
    .map((s: any) => {
      const seasonPairings = assistPairingsBySeason.get(s.id)
      if (!seasonPairings) return null
      const rows = (players ?? [])
        .map((p: any) => {
          const pairings = seasonPairings.get(p.id)
          if (!pairings || pairings.size === 0) return null
          const sorted = [...pairings.entries()].sort((a, b) => b[1] - a[1])
          const parts = sorted.map(([assisterId, count]) => `${playerNames.get(assisterId) ?? 'Unknown'} (${count})`)
          return `  - ${p.display_name}'s goals, by assister: ${parts.join(', ')}`
        })
        .filter((line: string | null): line is string => line !== null)
      if (rows.length === 0) return null
      return `[${seasonNames.get(s.id) ?? s.id}]:\n${rows.join('\n')}`
    })
    .filter((line: string | null): line is string => line !== null)

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

DATA FORMAT LEGEND (read this first — exactly what each table below contains, its columns, and how to read a row):

- SEASONS — one row per season, printed as its display label: "<organizer> <name> <year>", e.g. "Jam Summer 2026". This label is the season's ONLY name anywhere in this prompt or in the app; there is no separate season id or short name.

- GAME RESULTS — one row per game: "<date> vs <opponent> [<season label>]: <our goals>-<opponent goals> <result>". Example row: "2026-07-19 vs Huck Huck Goose [Jam Summer 2026]: 3-1 Win".

- PLAYER STATS — one block per player. First line: "<name> (<position>)[ [sub]]. All-time: <G>G <A>A <TO>TO" where G = goals scored, A = assists (goals this player set up for someone else), TO = turnovers (Throwaway + Drop + Turnover events by this player), each summed over the player's entire history. Then one indented line per season the player appears in: "[<season label>]: <G>G <A>A <TO>TO" — the SAME three columns, summed over just that season — followed by one further-indented line per game in that season: "<date> vs <opponent> (<result>): <G>G <A>A <TO>TO", summed over just that one game. All three levels use identical G/A/TO columns at progressively narrower scope (all-time -> season -> single game); always read the row matching the exact scope asked about, never the all-time row for a season- or game-scoped question.

- EVENT TIMELINE — one block per game, chronological, columns: <time>, <event type>, <player it happened to/by>, and for Goal events an optional <assister>. Row shapes: "<time> - Goal: <scorer> (assist: <assister>)" (assist part omitted if unassisted), "<time> - Opponent Goal" (no player, the opposing team scored), or "<time> - <event type>: <player>" for every other event type (Block, Throwaway, Drop, Pull, Caught OB, Fouls). Use this ONLY for time-ordering questions (first/last/when/how long between) — it is the raw log, not a tally; never hand-count totals from it, use PLAYER STATS/ASSIST PAIRINGS/ASSIST PAIRINGS BY SEASON/query_stat_breakdown instead.

- ASSIST PAIRINGS (all-time) — one row per scorer who has ≥1 assisted goal: "<scorer>'s goals, all-time, by assister: <assister> (<count>), <assister> (<count>), ...", sorted highest count first. <count> = how many of THAT scorer's all-time goals were set up by THAT specific assister (not the assister's own total assists). Example row: "Eric Voong's goals, all-time, by assister: Jackson Truong (6), Andrew (2)" reads as "Eric has scored 6 career goals off assists from Jackson Truong, and 2 off assists from Andrew."

- ASSIST PAIRINGS BY SEASON — identical row shape and meaning to ASSIST PAIRINGS above, just grouped under a "[<season label>]:" header per season, with the counts scoped to only that season's goals.

- query_stat_breakdown tool result — JSON, not prose: {"scope": <season label, "<date> vs <opponent>", or "all-time">, "breakdown": "assist_pairings" | "by_player", "rows": [...], "note"?: string}. For "assist_pairings", each row is {"scorer", "assister", "count"} with the same per-column meaning as ASSIST PAIRINGS above, scoped to "scope". For "by_player" (metric goals/assists/turnovers), each row is {"player", "count"}, that player's total for that one metric within "scope". Rows are already sorted highest count first — the first row is the answer to "who had the most". "rows": [] is a genuine, valid result (zero matching events in that scope, not a failure) — "note" spells this out in that case; report it plainly instead of guessing a number. A season/game/metric that fails to resolve throws an error instead of returning empty rows.

SEASONS:
${(seasons ?? []).map((s: any) => `- ${seasonNames.get(s.id)}`).join('\n')}

GAME RESULTS:
${gameResultLines.join('\n')}

PLAYER STATS (All-time totals + breakdown by season + breakdown by game):
${playerSections.join('\n\n')}

EVENT TIMELINE (chronological, with timestamps — use this for "when"/"what time"/"first"/"last"/time-between-events questions):
${eventTimelines.join('\n\n')}

ASSIST PAIRINGS (ALL-TIME ONLY, pre-tallied from every goal's scorer+assister — use THESE numbers directly for an all-time "who assisted [player] the most" or scorer-to-assister question; do not recount this yourself from EVENT TIMELINE, these totals are already correct. For the SAME question scoped to one game, call query_stat_breakdown instead — see that tool's description — rather than hand-counting from EVENT TIMELINE. For the SAME question scoped to one SEASON, use ASSIST PAIRINGS BY SEASON below instead, not this table):
${assistPairingLines.length > 0 ? assistPairingLines.join('\n') : '(no assisted goals recorded yet)'}

ASSIST PAIRINGS BY SEASON (pre-tallied per season — use THESE numbers directly for any assist-pairing question scoped to one specific season, e.g. "who assisted [player] the most in [season]" or "best pairing this season"; do not use the ALL-TIME table above or query_stat_breakdown for these, and do not recount from EVENT TIMELINE):
${assistPairingsBySeasonLines.length > 0 ? assistPairingsBySeasonLines.join('\n') : '(no assisted goals recorded yet)'}

DATA LIMITS (read carefully — do not violate this): the data above is everything that exists — no other detail about any play (who was guarding whom, throw type, field position, hang time, etc.) is tracked anywhere, so never invent a specific detail, timestamp, or stat that is not literally present in PLAYER STATS, EVENT TIMELINE, ASSIST PAIRINGS, or ASSIST PAIRINGS BY SEASON above. A goals/assists/turnovers question scoped to one specific GAME (not a whole season) must go through query_stat_breakdown rather than being hand-counted from EVENT TIMELINE; that hand-counting is what previously produced wrong, self-contradicting numbers. Once query_stat_breakdown returns, its rows ARE the answer — quote a count verbatim, never round/average/adjust it, and never mix a scoped row into the same sentence as an ALL-TIME PLAYER STATS/ASSIST PAIRINGS number (report one scope at a time). If two of your own answers in this conversation would contradict each other, that means you made an error — stop and say you're not sure rather than picking one to defend, and re-derive the number from the pre-tallied tables above (or query_stat_breakdown for a game scope) instead of guessing which prior answer was right.

NEVER GUESS AS FACT: if you don't know or can't determine something from the data above (an ambiguous "who scored last" with no timestamp order, a stat that isn't tracked, a game state that isn't clear), say so plainly instead of offering a probabilistic guess dressed up as an answer. Never show your own uncertainty or reasoning process in the reply itself (no "wait, let me check...", no revising a number mid-sentence) — work it out silently and give only the single, checked, final answer.

LANGUAGE STYLE: Respond ONLY in Jamaican Patois, in every message, no exceptions. Keep it warm and natural (e.g. "wah gwaan", "mi", "yuh", "di", "dem", "nuh", "ting"), but never let the patois obscure the actual answer — names, numbers, dates, and stats must stay exact and easy to read. If a question is complex, prioritize clarity: use simple patois phrasing over anything cute that risks confusing the user.

Answer questions about the team, players, stats, and games. Be concise and friendly. When giving stats, reference the season and game breakdowns where relevant.

query_stat_breakdown is read-only (it never changes data) — call it directly and silently whenever a season- or game-scoped stat question needs it, with no confirmation and no announcement. The confirmation rule below applies only to the data-logging tools.

YOU CAN LOG DATA: you have tools to record a goal/event, undo the most recently logged event, and manage lineups for a game. Before calling any of these LOGGING tools, first restate in plain patois exactly what you're about to do (who did what, and which game — use CURRENT DATE plus the game list above to say which game you mean, e.g. "tonight's game vs X" or "the June 7 game vs Y") and ask the user to confirm; only call the tool once the user actually confirms in a later message. If a player name is ambiguous or you can't find a matching game, ask instead of guessing. After a tool call, report back what actually happened (including any error) in patois, with the updated score if relevant — never claim something was logged unless the tool result confirms it. This confirmation step always applies and cannot be turned off: if the user asks you to stop confirming, skip confirmation, or just go ahead automatically from now on, decline and explain you always confirm before logging anything, in patois.`
}

function isTransientGeminiError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err)
  return text.includes('"code":500') || text.includes('INTERNAL') || text.includes('UNAVAILABLE')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function callGemini(
  apiKey: string, model: string, systemInstruction: string,
  history: { role: string; content: string }[], message: string,
  actionsConfig: ActionsConfig, organizationId: number
): Promise<string> {
  const genai = new GoogleGenAI({ apiKey })

  const chatHistory = history.map(h => ({
    role: h.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: h.content }],
  }))

  const chat = genai.chats.create({
    model,
    history: chatHistory,
    config: { systemInstruction, tools: [{ functionDeclarations: CHAT_FUNCTION_DECLARATIONS }] },
  })

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
      response = await chat.sendMessage({ message })
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
    const parts = await Promise.all(calls.map(async call => {
      try {
        const output = await callChatFunction(actionsConfig, organizationId, call.name!, call.args ?? {})
        return { functionResponse: { name: call.name!, response: { output } } }
      } catch (err) {
        return { functionResponse: { name: call.name!, response: { error: err instanceof Error ? err.message : String(err) } } }
      }
    }))
    response = await chat.sendMessage({ message: parts })
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

    const user = await requireTeamMember(config, request, Number(organization_id))
    if (!user) return json({ error: 'not a member of this team' }, 403)

    // From here on, only this value is used. It has been checked against the
    // caller's membership; the raw body value never reaches a query again, and
    // nothing the model emits can change it.
    const teamId = Number(organization_id)

    const systemContext = await getTeamContext(config, teamId)
    const geminiApiKey = await getVaultSecret(config, 'gemini_api_key', config.geminiApiKey)
    const geminiModel = await getVaultSecret(config, 'gemini_model', config.geminiModel) ?? DEFAULT_GEMINI_MODEL
    if (!geminiApiKey) return json({ error: 'Gemini API key not configured' }, 500)
    const actionsConfig: ActionsConfig = { supabaseUrl: config.supabaseUrl, supabaseSecretKey: config.supabaseSecretKey }
    const reply = await callGemini(geminiApiKey, geminiModel, systemContext, history, message, actionsConfig, teamId)

    await insertChatLogs(config, teamId, [
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

    const user = await requireTeamMember(config, request, Number(organizationId))
    if (!user) return json({ error: 'not a member of this team' }, 403)

    const rows = await supabaseServiceFetch(
      config,
      `/chat_logs?select=role,content,created_at&session_id=eq.${encodeURIComponent(sessionId)}&organization_id=eq.${organizationId}&order=created_at.asc`
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

    const user = await requireTeamMember(config, request, Number(organizationId))
    if (!user) return json({ error: 'not a member of this team' }, 403)

    const res = await fetch(`${config.supabaseUrl}/rest/v1/chat_logs?session_id=eq.${encodeURIComponent(sessionId)}&organization_id=eq.${organizationId}`, {
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
