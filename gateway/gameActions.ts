// Write-side actions the Chat assistant can call as Gemini function calls
// (see callGemini/getTeamContext in chat.ts) to actually record game events
// and manage lineups, rather than only answering questions about them.
// Shared with mcpTools.ts (the Cloudflare-hosted MCP server), which reuses
// the write functions below directly and the resolve/get helpers via
// exports — the two used to duplicate this logic (mcpTools.ts's predecessor,
// mcp-server/index.ts, talks to Supabase via @supabase/supabase-js since it
// runs locally over stdio) but the Workers-hosted path has no reason not to
// share. The small pure helpers below (isPastGame, isTurnoverEvent, ...) are
// intentionally duplicated from frontend/lib rather than imported, matching
// how chat.ts's getTeamContext already inlines its own turnover-type check
// rather than pulling frontend code into the gateway bundle.

import { type ActionsConfig, sbGet, sbWrite, sbUpsertIgnore } from './supabaseRest.js'

export type { ActionsConfig }

// Matches Schedule.tsx's IMMINENT_WINDOW_MS.
const IMMINENT_WINDOW_MS = 30 * 60 * 1000

export function todayLocalStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export function isPastGame(g: { game_date: string }, today = todayLocalStr()): boolean {
  return g.game_date < today
}
export function isTurnoverEvent(eventType: string): boolean {
  return ['Turnover', 'Throwaway', 'Drop'].includes(eventType)
}
export function gameStartsAt(g: { game_date: string; game_time: string | null }): Date {
  return new Date(`${g.game_date}T${g.game_time || '00:00:00'}`)
}

export type GameRow = { id: number; season_id: number | null; opponent: string; game_date: string; game_time: string | null }

export async function getAllGames(config: ActionsConfig, orgId: number): Promise<GameRow[]> {
  return sbGet(config, `/games?organization_id=eq.${orgId}&select=id,season_id,opponent,game_date,game_time`)
}

// Same fallback chain as mcp-server's resolveCurrentGame / Schedule.tsx's
// imminent-game auto-select: imminent, else today, else most recently
// played, else next upcoming.
export async function resolveCurrentGame(config: ActionsConfig, orgId: number): Promise<GameRow> {
  const games = await getAllGames(config, orgId)
  if (games.length === 0) throw new Error('No games found.')
  const now = Date.now()

  const imminent = games.find(g => Math.abs(gameStartsAt(g).getTime() - now) <= IMMINENT_WINDOW_MS)
  if (imminent) return imminent

  const today = todayLocalStr()
  const todays = games.filter(g => g.game_date === today).sort((a, b) => gameStartsAt(a).getTime() - gameStartsAt(b).getTime())
  if (todays.length > 0) return todays[0]!

  const past = games.filter(g => isPastGame(g, today)).sort((a, b) => gameStartsAt(b).getTime() - gameStartsAt(a).getTime())
  if (past.length > 0) return past[0]!

  const upcoming = games.filter(g => !isPastGame(g, today)).sort((a, b) => gameStartsAt(a).getTime() - gameStartsAt(b).getTime())
  return upcoming[0]!
}

// The assistant only knows a game's date/opponent from the team-context
// system prompt (no numeric ids are ever surfaced to it), so a specific
// game is targeted by those rather than by id; omitting both resolves the
// current/relevant game the same way the MCP server does.
export async function resolveGame(config: ActionsConfig, orgId: number, hint?: { gameDate?: string; opponent?: string }): Promise<GameRow> {
  if (hint?.gameDate || hint?.opponent) {
    const games = await getAllGames(config, orgId)
    let matches = games
    if (hint.gameDate) matches = matches.filter(g => g.game_date === hint.gameDate)
    if (hint.opponent) matches = matches.filter(g => g.opponent.toLowerCase().includes(hint.opponent!.toLowerCase()))
    if (matches.length === 0) throw new Error(`No game found matching ${JSON.stringify(hint)}.`)
    if (matches.length > 1) throw new Error(`Multiple games match ${JSON.stringify(hint)}: ${matches.map(g => `${g.game_date} vs ${g.opponent}`).join(', ')}. Be more specific.`)
    return matches[0]!
  }
  return resolveCurrentGame(config, orgId)
}

export type PlayerRow = { id: number; display_name: string }

export async function resolvePlayer(config: ActionsConfig, orgId: number, nameQuery: string): Promise<PlayerRow> {
  const players: PlayerRow[] = await sbGet(config, `/players?organization_id=eq.${orgId}&select=id,display_name`)
  const q = nameQuery.trim().toLowerCase()
  let matches = players.filter(p => p.display_name.toLowerCase() === q)
  if (matches.length === 0) matches = players.filter(p => p.display_name.toLowerCase().includes(q))
  if (matches.length === 0) throw new Error(`No player found matching "${nameQuery}".`)
  if (matches.length > 1) throw new Error(`Multiple players match "${nameQuery}": ${matches.map(m => m.display_name).join(', ')}. Be more specific.`)
  return matches[0]!
}

export type SeasonRow = { id: number; label: string }

// The assistant never sees the raw `name` column ("Summer") on its own —
// getTeamContext only ever shows it the composite label built the same way
// as chat.ts's seasonNames map (`${organizer} ${name} ${year}`, e.g. "Jam
// Summer 2026"), so a season must be resolved against that same composite,
// not the bare name (matching it against `name` alone silently failed to
// resolve any season the model actually asked about).
export async function resolveSeason(config: ActionsConfig, orgId: number, nameQuery: string): Promise<SeasonRow> {
  const raw: { id: number; name: string; year: number; organizer: string | null }[] =
    await sbGet(config, `/seasons?organization_id=eq.${orgId}&select=id,name,year,organizer`)
  const seasons: SeasonRow[] = raw.map(s => ({ id: s.id, label: `${s.organizer ?? ''} ${s.name} ${s.year}`.trim() }))
  const q = nameQuery.trim().toLowerCase()
  let matches = seasons.filter(s => s.label.toLowerCase() === q)
  if (matches.length === 0) matches = seasons.filter(s => s.label.toLowerCase().includes(q) || q.includes(s.label.toLowerCase()))
  if (matches.length === 0) throw new Error(`No season found matching "${nameQuery}".`)
  if (matches.length > 1) throw new Error(`Multiple seasons match "${nameQuery}": ${matches.map(m => m.label).join(', ')}. Be more specific.`)
  return matches[0]!
}

export async function currentScore(config: ActionsConfig, gameId: number): Promise<{ our_score: number; their_score: number }> {
  const events: { event_type: string }[] = await sbGet(config, `/game_events?game_id=eq.${gameId}&select=event_type`)
  return {
    our_score: events.filter(e => e.event_type === 'Goal').length,
    their_score: events.filter(e => e.event_type === 'Opponent Goal').length,
  }
}

export const EVENT_TYPES = ['Goal', 'Opponent Goal', 'Block', 'Throwaway', 'Drop', 'Pull', 'Caught OB', 'Fouls'] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const STAT_METRICS = ['goals', 'assists', 'turnovers'] as const
export type StatMetric = (typeof STAT_METRICS)[number]

export const CHAT_FUNCTION_DECLARATIONS = [
  {
    name: 'create_game_event',
    description: `Logs a scoring or game event. Valid eventType values: ${EVENT_TYPES.join(', ')}. For "Goal", playerName is the scorer and assisterName (optional) credits the assist. For "Opponent Goal", omit both player names. For other types, playerName is whoever the event happened to/by. Omit gameDate/opponent to target the current/most relevant game; only pass them to target a different, specific game the user named.`,
    parametersJsonSchema: {
      type: 'object',
      properties: {
        eventType: { type: 'string', enum: EVENT_TYPES },
        playerName: { type: 'string' },
        assisterName: { type: 'string', description: 'Only meaningful when eventType is "Goal".' },
        notes: { type: 'string' },
        gameDate: { type: 'string', description: 'YYYY-MM-DD, only to target a specific non-current game.' },
        opponent: { type: 'string', description: 'Opponent name/substring, only to target a specific non-current game.' },
      },
      required: ['eventType'],
    },
  },
  {
    name: 'undo_last_event',
    description: 'Deletes the most recently logged event for a game (same as the app\'s "Undo last event" button). Use when the user says something like "undo that" or "that\'s wrong, remove it" right after logging.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        gameDate: { type: 'string', description: 'YYYY-MM-DD, only to target a specific non-current game.' },
        opponent: { type: 'string', description: 'Opponent name/substring, only to target a specific non-current game.' },
      },
    },
  },
  {
    name: 'add_to_lineup',
    description: 'Places a player in a lineup group for a game (creating the group if needed), which is what makes them count as attending. Defaults to the game\'s first lineup group if lineupGroupName is omitted.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        playerName: { type: 'string' },
        lineupGroupName: { type: 'string' },
        role: { type: 'string', description: 'e.g. "Handler", "Deep Cutter".' },
        gameDate: { type: 'string' },
        opponent: { type: 'string' },
      },
      required: ['playerName'],
    },
  },
  {
    name: 'remove_from_lineup',
    description: 'Removes a player from every lineup group in a game, which is what makes them stop counting as attending.',
    parametersJsonSchema: {
      type: 'object',
      properties: { playerName: { type: 'string' }, gameDate: { type: 'string' }, opponent: { type: 'string' } },
      required: ['playerName'],
    },
  },
  {
    name: 'create_lineup_group',
    description: 'Adds a new, initially empty lineup group (e.g. "Line 2") to a game.',
    parametersJsonSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, gameDate: { type: 'string' }, opponent: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'query_stat_breakdown',
    description: `Computes an exact, code-verified stat breakdown. The system prompt's PLAYER STATS and ASSIST PAIRINGS tables are pre-tallied but ALL-TIME ONLY — call this tool instead of counting from EVENT TIMELINE yourself whenever a question is scoped to one specific season or one specific game. Examples: "who assisted Eric the most this season" -> {metric: "assists", byAssistPairing: true, seasonName: "Jam Summer 2026"}. "top scorers in the game vs Huck Huck Goose" -> {metric: "goals", opponent: "Huck Huck Goose"}. "who had the most turnovers in Jam Summer 2026" -> {metric: "turnovers", seasonName: "Jam Summer 2026"}. "best pairing so far this season" -> {metric: "assists", byAssistPairing: true, seasonName: "<current season>"}. Omit seasonName/gameDate/opponent only for an all-time breakdown (rarely needed since PLAYER STATS/ASSIST PAIRINGS already cover all-time).
STRICT OUTPUT RULE: the "rows" you get back are the complete, final, already-correct answer for exactly the scope you asked for — quote a row's "count" verbatim, character for character, in your reply. Never recalculate, round, average, or "estimate" a count; never blend a scoped row with the separate ALL-TIME PLAYER STATS/ASSIST PAIRINGS numbers in the same sentence (e.g. do not say "4 this season (6 all-time)" — pick the one scope the user asked about and report only that). An empty "rows" array is a real, valid answer meaning zero matching events for that exact scope (check the "note" field, which spells this out) — say so plainly, do not treat it as a failure or fall back to guessing a number. If seasonName/gameDate/opponent fails to resolve, or metric is invalid, the call errors out instead of returning empty rows — tell the user you couldn't find that season/game/metric by name instead of guessing a number.`,
    parametersJsonSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: [...STAT_METRICS] },
        byAssistPairing: { type: 'boolean', description: 'Only for metric "assists": group by scorer+assister pair instead of by player.' },
        seasonName: { type: 'string', description: 'Season name/substring, e.g. "Jam Summer 2026". Scopes the breakdown to that season.' },
        gameDate: { type: 'string', description: 'YYYY-MM-DD. Scopes the breakdown to that one game.' },
        opponent: { type: 'string', description: 'Opponent name/substring. Scopes the breakdown to that one game.' },
      },
      required: ['metric'],
    },
  },
]

export async function createGameEvent(
  config: ActionsConfig, orgId: number,
  params: { eventType: EventType; playerName?: string; assisterName?: string; notes?: string; gameDate?: string; opponent?: string }
) {
  const game = await resolveGame(config, orgId, params)
  const player = params.playerName ? await resolvePlayer(config, orgId, params.playerName) : undefined
  const assister = params.assisterName ? await resolvePlayer(config, orgId, params.assisterName) : undefined
  await sbWrite(config, 'POST', '/game_events', {
    organization_id: orgId,
    game_id: game.id,
    player_id: player?.id ?? null,
    related_player_id: params.eventType === 'Goal' ? (assister?.id ?? null) : null,
    event_type: params.eventType,
    event_timestamp: new Date().toISOString(),
    notes: params.notes ?? null,
  })
  const score = await currentScore(config, game.id)
  return { game: { date: game.game_date, opponent: game.opponent }, player: player?.display_name ?? null, assister: assister?.display_name ?? null, ...score }
}

export async function undoLastEvent(config: ActionsConfig, orgId: number, params: { gameDate?: string; opponent?: string }) {
  const game = await resolveGame(config, orgId, params)
  const events = await sbGet(config, `/game_events?game_id=eq.${game.id}&select=id,event_type,player_id,related_player_id&order=event_timestamp.desc&limit=1`)
  if (events.length === 0) throw new Error(`No events logged yet for the game vs ${game.opponent} on ${game.game_date}.`)
  const deleted = await sbWrite(config, 'DELETE', `/game_events?id=eq.${events[0].id}`)
  const score = await currentScore(config, game.id)
  return { game: { date: game.game_date, opponent: game.opponent }, undone: deleted[0], ...score }
}

export async function addToLineup(
  config: ActionsConfig, orgId: number,
  params: { playerName: string; lineupGroupName?: string; role?: string; gameDate?: string; opponent?: string }
) {
  const game = await resolveGame(config, orgId, params)
  const player = await resolvePlayer(config, orgId, params.playerName)

  const groups: { lineup_name: string; sort_order: number }[] = await sbGet(config, `/game_lineup_groups?game_id=eq.${game.id}&select=lineup_name,sort_order&order=sort_order`)
  const targetName = params.lineupGroupName ?? groups[0]?.lineup_name ?? 'Lineup 1'
  const groupExists = groups.some(g => g.lineup_name.toLowerCase() === targetName.toLowerCase())
  if (!groupExists) {
    const nextSortOrder = groups.length > 0 ? Math.max(...groups.map(g => g.sort_order)) + 1 : 0
    await sbUpsertIgnore(config, '/game_lineup_groups', { organization_id: orgId, game_id: game.id, lineup_name: targetName, sort_order: nextSortOrder }, 'game_id,lineup_name')
  }

  await sbWrite(config, 'DELETE', `/game_lineups?game_id=eq.${game.id}&player_id=eq.${player.id}`)
  await sbWrite(config, 'POST', '/game_lineups', { organization_id: orgId, game_id: game.id, player_id: player.id, lineup_name: targetName, role: params.role ?? null })

  if (game.season_id) {
    await sbUpsertIgnore(config, '/season_players', { organization_id: orgId, season_id: game.season_id, player_id: player.id, is_sub: true }, 'season_id,player_id')
  }

  return { game: { date: game.game_date, opponent: game.opponent }, player: player.display_name, lineup_group: targetName }
}

export async function removeFromLineup(config: ActionsConfig, orgId: number, params: { playerName: string; gameDate?: string; opponent?: string }) {
  const game = await resolveGame(config, orgId, params)
  const player = await resolvePlayer(config, orgId, params.playerName)
  const removed = await sbWrite(config, 'DELETE', `/game_lineups?game_id=eq.${game.id}&player_id=eq.${player.id}`)
  return { game: { date: game.game_date, opponent: game.opponent }, player: player.display_name, removed_rows: removed.length }
}

export async function createLineupGroup(config: ActionsConfig, orgId: number, params: { name: string; gameDate?: string; opponent?: string }) {
  const game = await resolveGame(config, orgId, params)
  const groups: { sort_order: number }[] = await sbGet(config, `/game_lineup_groups?game_id=eq.${game.id}&select=sort_order&order=sort_order.desc&limit=1`)
  const nextSortOrder = groups.length > 0 ? groups[0]!.sort_order + 1 : 0
  const created = await sbUpsertIgnore(config, '/game_lineup_groups', { organization_id: orgId, game_id: game.id, lineup_name: params.name, sort_order: nextSortOrder }, 'game_id,lineup_name')
  return { game: { date: game.game_date, opponent: game.opponent }, created: created[0] ?? { note: `A group named "${params.name}" already exists.` } }
}

// Read-only, code-computed stat breakdown for the chat assistant to call
// instead of hand-tallying from EVENT TIMELINE (see query_stat_breakdown's
// declaration above). getTeamContext's own PLAYER STATS/ASSIST PAIRINGS
// sections only pre-tally all-time totals, so any season- or game-scoped
// question needs this instead — that gap is what let the model regress to
// hand-counting (and self-contradicting) despite the earlier all-time fix.
export async function queryStatBreakdown(
  config: ActionsConfig, orgId: number,
  params: { metric: StatMetric; seasonName?: string; gameDate?: string; opponent?: string; byAssistPairing?: boolean }
): Promise<unknown> {
  // A silently-mistyped metric (e.g. "assist" instead of "assists") would
  // otherwise match no branch below and produce an empty tally that's
  // indistinguishable from "this scope genuinely has zero events" — fail
  // loudly instead so the caller sees a real error, not a false zero.
  if (!STAT_METRICS.includes(params.metric)) {
    throw new Error(`Invalid metric "${params.metric}". Must be one of: ${STAT_METRICS.join(', ')}.`)
  }

  let gameIds: number[] | null = null
  let scope = 'all-time'

  if (params.gameDate || params.opponent) {
    const game = await resolveGame(config, orgId, params)
    gameIds = [game.id]
    scope = `${game.game_date} vs ${game.opponent}`
  } else if (params.seasonName) {
    const season = await resolveSeason(config, orgId, params.seasonName)
    const games: { id: number }[] = await sbGet(config, `/games?organization_id=eq.${orgId}&season_id=eq.${season.id}&select=id`)
    gameIds = games.map(g => g.id)
    scope = season.label
  }

  const eventsPath = gameIds
    ? `/game_events?organization_id=eq.${orgId}&game_id=in.(${gameIds.join(',') || '0'})&select=event_type,player_id,related_player_id`
    : `/game_events?organization_id=eq.${orgId}&select=event_type,player_id,related_player_id`
  const events: { event_type: string; player_id: number | null; related_player_id: number | null }[] = await sbGet(config, eventsPath)
  const players: PlayerRow[] = await sbGet(config, `/players?organization_id=eq.${orgId}&select=id,display_name`)
  const nameOf = (id: number | null) => players.find(p => p.id === id)?.display_name ?? 'Unknown'

  if (params.metric === 'assists' && params.byAssistPairing) {
    const tally = new Map<string, { scorer: number; assister: number; count: number }>()
    for (const e of events) {
      if (e.event_type !== 'Goal' || !e.player_id || !e.related_player_id) continue
      const key = `${e.player_id}:${e.related_player_id}`
      const row = tally.get(key) ?? { scorer: e.player_id, assister: e.related_player_id, count: 0 }
      row.count++
      tally.set(key, row)
    }
    const rows = [...tally.values()]
      .sort((a, b) => b.count - a.count)
      .map(r => ({ scorer: nameOf(r.scorer), assister: nameOf(r.assister), count: r.count }))
    return { scope, breakdown: 'assist_pairings', rows, note: rows.length === 0 ? `No assisted goals recorded for ${scope}.` : undefined }
  }

  const tally = new Map<number, number>()
  for (const e of events) {
    if (params.metric === 'goals' && e.event_type === 'Goal' && e.player_id) {
      tally.set(e.player_id, (tally.get(e.player_id) ?? 0) + 1)
    } else if (params.metric === 'assists' && e.event_type === 'Goal' && e.related_player_id) {
      tally.set(e.related_player_id, (tally.get(e.related_player_id) ?? 0) + 1)
    } else if (params.metric === 'turnovers' && isTurnoverEvent(e.event_type) && e.player_id) {
      tally.set(e.player_id, (tally.get(e.player_id) ?? 0) + 1)
    }
  }
  const rows = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ player: nameOf(id), count }))
  return {
    scope, breakdown: 'by_player', metric: params.metric, rows,
    note: rows.length === 0 ? `No ${params.metric} recorded for ${scope}.` : undefined,
  }
}

// Functions whose handlers write data (call sbWrite/sbUpsertIgnore), as
// opposed to query_stat_breakdown, the one read-only function. chat.ts uses
// this to gate writes on the caller's team role before dispatching a
// model-requested function call -- kept here, next to the switch it
// classifies, so it stays correct when a handler is added or changed.
export const WRITE_FUNCTIONS: ReadonlySet<string> = new Set([
  'create_game_event',
  'undo_last_event',
  'add_to_lineup',
  'remove_from_lineup',
  'create_lineup_group',
])

export async function callChatFunction(config: ActionsConfig, orgId: number, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'create_game_event': return createGameEvent(config, orgId, args as any)
    case 'undo_last_event': return undoLastEvent(config, orgId, args as any)
    case 'add_to_lineup': return addToLineup(config, orgId, args as any)
    case 'remove_from_lineup': return removeFromLineup(config, orgId, args as any)
    case 'create_lineup_group': return createLineupGroup(config, orgId, args as any)
    case 'query_stat_breakdown': return queryStatBreakdown(config, orgId, args as any)
    default: throw new Error(`Unknown function: ${name}`)
  }
}
