// Shared team-context builder for the chat assistants (Cloudflare gateway
// chat.ts and the Express server both re-export it). Moved verbatim out of
// gateway/chat.ts; the scope param is the only addition (Task 6).
import { getOrgEffectiveTier, gameDateWithinFreeWindow } from '../supabaseRest.js'

// Player-scoped context for a linked member (spec: linked = scoped,
// unlinked/captain/editor = full). playerId filters the DB queries and the
// derived player-facing sections; team-level facts (game results) stay
// intact because a game's score is not a player's data.
export interface ChatScope {
  playerId: number
  playerName: string
}

export type TeamContextConfig = { supabaseUrl: string; supabaseSecretKey: string }

async function supabaseServiceFetch(config: TeamContextConfig, path: string): Promise<any> {
  const res = await fetch(`${config.supabaseUrl}/rest/v1${path}`, {
    headers: {
      apikey: config.supabaseSecretKey,
      Authorization: `Bearer ${config.supabaseSecretKey}`,
    },
  })
  if (!res.ok) throw new Error(`Supabase query failed (${res.status}): ${path}`)
  return res.json()
}

type Stat = { goals: number; assists: number; turnovers: number }

export async function getTeamContext(config: TeamContextConfig, organizationId: number, scope?: ChatScope): Promise<string> {
  const orgFilter = `organization_id=eq.${organizationId}`
  const [players, seasons, games, seasonPlayers, freeTier] = await Promise.all([
    supabaseServiceFetch(config, `/players?select=id,display_name,position,gender_match,is_sub&${orgFilter}${scope ? `&id=eq.${scope.playerId}` : ''}&order=display_name.asc`),
    supabaseServiceFetch(config, `/seasons?select=id,name,year,organizer&${orgFilter}&order=id.asc`),
    supabaseServiceFetch(config, `/games?select=id,season_id,opponent,game_date,result,outcome_override&${orgFilter}&order=game_date.asc`),
    supabaseServiceFetch(config, `/season_players?select=player_id,season_id&active=eq.true&${orgFilter}${scope ? `&player_id=eq.${scope.playerId}` : ''}`),
    getOrgEffectiveTier(config, organizationId).then(tier => tier === 'free'),
  ])

  // Free-tier read gate: push filtering to the database query by deriving
  // allowed game IDs (games within the 30-day window) so service-role reads
  // do not over-fetch past events, mirroring the game_events RLS policy.
  let eventsQuery = `/game_events?select=player_id,related_player_id,event_type,game_id,event_timestamp&${orgFilter}`
  if (freeTier) {
    const allowedGameIds = (games ?? []).filter((g: any) => gameDateWithinFreeWindow(g.game_date)).map((g: any) => g.id)
    const idsFilter = allowedGameIds.length > 0 ? allowedGameIds.join(',') : '-1'
    eventsQuery += `&game_id=in.(${idsFilter})`
  }
  const events = await supabaseServiceFetch(config, eventsQuery)

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
        .filter((e: any) => !scope || e.player_id === scope.playerId || e.related_player_id === scope.playerId)
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

  const eventsNote = freeTier
    ? `\nDATA WINDOW: this team is on the Free plan — the data above covers only the last 30 days of games. Older history exists but is not available; never state an "all-time" total as complete, and if asked about totals or history beyond the window, say the Free plan only shows the last 30 days.`
    : ''

  const scopeNote = scope
    ? `\nSCOPED VIEW: the user is linked to player ${scope.playerName}, and the data above contains only THAT player's individual stats. If asked about another player's individual stats or totals, say in patois that yuh can only see data for ${scope.playerName} and suggest they ask a captain or editor. Team-level facts (game results, season names) are fine to discuss.`
    : ''

  return `You are a helpful assistant for the Ultimate Frisbee Warriors team tracking app. You have access to the following live team data:

CURRENT DATE: ${currentDate} — use this to resolve relative date questions (today, this week, last game, upcoming, how long ago, etc).
${eventsNote}${scopeNote}
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
