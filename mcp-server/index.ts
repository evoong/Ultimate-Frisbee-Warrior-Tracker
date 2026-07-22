// MCP server exposing this app's game/roster data as tools an LLM client
// (Claude Desktop, Claude Code, or the in-app AI chat) can call directly:
// logging/editing game events, reading stats, managing lineups, and
// answering "what's the next/last game" questions. Runs as a local stdio
// process against Supabase using the service-role key (same trust model as
// server/index.ts's privileged endpoints), so it is meant to run on a
// machine/account you trust, not to be exposed to untrusted callers.
//
// Setup and tool reference: see the "MCP server" section of CLAUDE.md.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { todayLocalStr } from '../frontend/lib/seasonUtils.ts'
import { isPastGame, sortGamesUpcomingFirst } from '../frontend/lib/gameOrder.ts'
import { isTurnoverEvent } from '../frontend/lib/eventUtils.ts'

// Load the repo-root .env by resolved path (not dotenv's cwd-relative
// default) so this runs correctly regardless of the working directory the
// MCP client spawns it from.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../.env') })

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SECRET_KEY || '')

// This server operates on a single organization per the multi-tenant model
// in CLAUDE.md, since there's no signed-in "current user" in this headless
// context to derive one from. Defaults to org 1 ("My Team", the pre-016
// backfill org) — override via MCP_ORGANIZATION_ID for any other org.
const ORG_ID = process.env.MCP_ORGANIZATION_ID ? parseInt(process.env.MCP_ORGANIZATION_ID) : 1

// Matches Schedule.tsx's IMMINENT_WINDOW_MS: a game starting within 30
// minutes (either direction) is the one you're about to score or already are.
const IMMINENT_WINDOW_MS = 30 * 60 * 1000

type GameRow = {
  id: number; season_id: number | null; opponent: string; game_date: string; game_time: string | null
  game_type: string | null; notes: string | null; outcome_override: string | null; organization_id: number
}
type PlayerRow = { id: number; display_name: string; is_sub: boolean; position: string | null; gender_match: string | null }
type SeasonRow = { id: number; name: string; year: number; organizer: string | null; location: string | null; start_date: string | null; end_date: string | null }

function gameStartsAt(g: { game_date: string; game_time: string | null }): Date {
  return new Date(`${g.game_date}T${g.game_time || '00:00:00'}`)
}

function seasonLabel(s: { name: string; year: number; organizer: string | null }): string {
  return [s.organizer, s.name, s.year].filter(Boolean).join(' ')
}

async function getAllGames(): Promise<GameRow[]> {
  const { data, error } = await supabase.from('games').select('*').eq('organization_id', ORG_ID)
  if (error) throw new Error(error.message)
  return (data ?? []) as GameRow[]
}

async function getAllSeasons(): Promise<SeasonRow[]> {
  const { data, error } = await supabase.from('seasons').select('*').eq('organization_id', ORG_ID).order('year', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as SeasonRow[]
}

// "Which game" when the caller doesn't say: prefer a game that's imminent
// (about to start or in progress), else a game scheduled today, else the
// most recently played game (you just finished, still logging it), else the
// next upcoming one. Mirrors Schedule.tsx's own imminent-game auto-select.
async function resolveCurrentGame(): Promise<GameRow> {
  const games = await getAllGames()
  if (games.length === 0) throw new Error('No games found for this organization.')
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

async function resolveGame(gameId?: number): Promise<GameRow> {
  if (gameId == null) return resolveCurrentGame()
  const { data, error } = await supabase.from('games').select('*').eq('id', gameId).eq('organization_id', ORG_ID).single()
  if (error || !data) throw new Error(`No game found with id ${gameId}.`)
  return data as GameRow
}

async function resolveSeason(seasonId?: number, seasonName?: string): Promise<SeasonRow | undefined> {
  if (seasonId == null && !seasonName) return undefined
  const seasons = await getAllSeasons()
  if (seasonId != null) {
    const found = seasons.find(s => s.id === seasonId)
    if (!found) throw new Error(`No season found with id ${seasonId}.`)
    return found
  }
  const q = seasonName!.trim().toLowerCase()
  const matches = seasons.filter(s => seasonLabel(s).toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
  if (matches.length === 0) throw new Error(`No season matching "${seasonName}". Known seasons: ${seasons.map(seasonLabel).join(', ')}.`)
  if (matches.length > 1) throw new Error(`Multiple seasons match "${seasonName}": ${matches.map(seasonLabel).join(', ')}. Please be more specific.`)
  return matches[0]
}

// Fuzzy player lookup by display name, scoped to the org (not a season) since
// a name can be resolved before we know which season/game context applies.
async function resolvePlayer(nameQuery: string): Promise<PlayerRow> {
  const { data, error } = await supabase.from('players').select('id, display_name, is_sub, position, gender_match').eq('organization_id', ORG_ID)
  if (error) throw new Error(error.message)
  const players = (data ?? []) as PlayerRow[]
  const q = nameQuery.trim().toLowerCase()
  let matches = players.filter(p => p.display_name.toLowerCase() === q)
  if (matches.length === 0) matches = players.filter(p => p.display_name.toLowerCase().includes(q))
  if (matches.length === 0) throw new Error(`No player found matching "${nameQuery}".`)
  if (matches.length > 1) throw new Error(`Multiple players match "${nameQuery}": ${matches.map(m => m.display_name).join(', ')}. Please be more specific.`)
  return matches[0]!
}

// Score is always derived live from game_events (Goal / Opponent Goal
// counts), same convention the live scoreboard uses in Schedule.tsx, rather
// than trusting games.our_score/their_score which aren't kept in sync by
// app writes.
function computeScore(events: { event_type: string }[]): { ourScore: number; theirScore: number } {
  return {
    ourScore: events.filter(e => e.event_type === 'Goal').length,
    theirScore: events.filter(e => e.event_type === 'Opponent Goal').length,
  }
}

async function gameSummary(g: GameRow, seasons: SeasonRow[]) {
  const { data: events, error } = await supabase.from('game_events').select('event_type').eq('game_id', g.id)
  if (error) throw new Error(error.message)
  const { ourScore, theirScore } = computeScore(events ?? [])
  const season = g.season_id != null ? seasons.find(s => s.id === g.season_id) : undefined
  return {
    id: g.id,
    opponent: g.opponent,
    date: g.game_date,
    time: g.game_time,
    season: season ? seasonLabel(season) : null,
    game_type: g.game_type,
    our_score: ourScore,
    their_score: theirScore,
    outcome_override: g.outcome_override,
    is_past: isPastGame(g),
    notes: g.notes,
  }
}

const EVENT_TYPES = ['Goal', 'Opponent Goal', 'Block', 'Throwaway', 'Drop', 'Pull', 'Caught OB', 'Fouls'] as const

function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
}
function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

const server = new McpServer({ name: 'ultimate-frisbee-warrior-tracker', version: '1.0.0' })

server.registerTool('list_games', {
  title: 'List games',
  description: 'List upcoming and/or past games, with derived score (from logged goal events) and season. Defaults to all games, most relevant first (next upcoming, then most recent past).',
  inputSchema: {
    status: z.enum(['upcoming', 'past', 'all']).optional().describe('Filter to only upcoming or only past games. Defaults to all.'),
    seasonId: z.number().int().optional(),
    seasonName: z.string().optional().describe('e.g. "Jam Summer 2026" or just "Summer" — matched loosely.'),
    limit: z.number().int().positive().optional().describe('Max games to return. Defaults to 15.'),
  },
}, async ({ status, seasonId, seasonName, limit }) => {
  try {
    const season = await resolveSeason(seasonId, seasonName)
    const seasons = await getAllSeasons()
    let games = await getAllGames()
    if (season) games = games.filter(g => g.season_id === season.id)
    const today = todayLocalStr()
    if (status === 'upcoming') games = games.filter(g => !isPastGame(g, today))
    if (status === 'past') games = games.filter(g => isPastGame(g, today))
    games = sortGamesUpcomingFirst(games, today).slice(0, limit ?? 15)
    const summaries = await Promise.all(games.map(g => gameSummary(g, seasons)))
    return ok(summaries)
  } catch (err) {
    return fail(err)
  }
})

server.registerTool('get_current_game', {
  title: 'Get the current/relevant game',
  description: 'Resolves "the" game to act on right now by date proximity: an imminent game (starting within 30 min or in progress), else a game scheduled today, else the most recently played game, else the next upcoming one. Use this before create_game_event/lineup tools when the user hasn\'t named a specific game.',
  inputSchema: {},
}, async () => {
  try {
    const g = await resolveGame(undefined)
    const seasons = await getAllSeasons()
    return ok(await gameSummary(g, seasons))
  } catch (err) {
    return fail(err)
  }
})

server.registerTool('get_game_details', {
  title: 'Get full game details',
  description: 'Score, season, notes, and recent events for one game (or the current/relevant game if gameId is omitted).',
  inputSchema: { gameId: z.number().int().optional() },
}, async ({ gameId }) => {
  try {
    const g = await resolveGame(gameId)
    const seasons = await getAllSeasons()
    const summary = await gameSummary(g, seasons)
    const { data: events, error } = await supabase
      .from('game_events')
      .select('id, event_type, event_timestamp, player_id, related_player_id, notes')
      .eq('game_id', g.id)
      .order('event_timestamp', { ascending: false })
    if (error) throw new Error(error.message)
    const { data: players } = await supabase.from('players').select('id, display_name').eq('organization_id', ORG_ID)
    const nameById = new Map((players ?? []).map((p: any) => [p.id, p.display_name]))
    const recentEvents = (events ?? []).map((e: any) => ({
      id: e.id,
      event_type: e.event_type,
      timestamp: e.event_timestamp,
      player: e.player_id ? nameById.get(e.player_id) ?? null : null,
      related_player: e.related_player_id ? nameById.get(e.related_player_id) ?? null : null,
      notes: e.notes,
    }))
    return ok({ ...summary, recent_events: recentEvents })
  } catch (err) {
    return fail(err)
  }
})

server.registerTool('create_game_event', {
  title: 'Log a game event',
  description: `Logs a scoring or game event. Valid eventType values: ${EVENT_TYPES.join(', ')}. For "Goal", playerName is the scorer and assisterName (optional) credits the assist. For "Opponent Goal", no player names are needed. For other types (Block, Throwaway, Drop, Pull, Caught OB, Fouls), playerName is whoever the event happened to/by. If gameId is omitted, resolves the current/relevant game automatically (see get_current_game).`,
  inputSchema: {
    gameId: z.number().int().optional(),
    eventType: z.enum(EVENT_TYPES),
    playerName: z.string().optional(),
    assisterName: z.string().optional().describe('Only meaningful when eventType is "Goal".'),
    notes: z.string().optional(),
  },
}, async ({ gameId, eventType, playerName, assisterName, notes }) => {
  try {
    const game = await resolveGame(gameId)
    const player = playerName ? await resolvePlayer(playerName) : undefined
    const assister = assisterName ? await resolvePlayer(assisterName) : undefined
    const { data, error } = await supabase
      .from('game_events')
      .insert({
        organization_id: ORG_ID,
        game_id: game.id,
        player_id: player?.id ?? null,
        related_player_id: eventType === 'Goal' ? (assister?.id ?? null) : null,
        event_type: eventType,
        event_timestamp: new Date().toISOString(),
        notes: notes ?? null,
      })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return ok({
      created_event: data,
      game: { id: game.id, opponent: game.opponent, date: game.game_date },
      player: player?.display_name ?? null,
      assister: assister?.display_name ?? null,
    })
  } catch (err) {
    return fail(err)
  }
})

server.registerTool('update_game_event', {
  title: 'Update a logged event',
  description: 'Changes the scorer and/or assister on an already-logged event (e.g. fixing a mis-attributed goal). Use list_game_events or get_game_details to find the eventId first.',
  inputSchema: {
    eventId: z.number().int(),
    playerName: z.string().optional().describe('New scorer/actor. Omit to leave unchanged; pass an empty string to clear it.'),
    assisterName: z.string().optional().describe('New assister. Omit to leave unchanged; pass an empty string to clear it.'),
  },
}, async ({ eventId, playerName, assisterName }) => {
  try {
    const player = playerName !== undefined ? (playerName === '' ? null : await resolvePlayer(playerName)) : undefined
    const assister = assisterName !== undefined ? (assisterName === '' ? null : await resolvePlayer(assisterName)) : undefined
    const body: Record<string, unknown> = {}
    if (player !== undefined) body.player_id = player?.id ?? null
    if (assister !== undefined) body.related_player_id = assister?.id ?? null
    const { data, error } = await supabase.from('game_events').update(body).eq('id', eventId).select().single()
    if (error) throw new Error(error.message)
    return ok(data)
  } catch (err) {
    return fail(err)
  }
})

server.registerTool('delete_game_event', {
  title: 'Delete a logged event',
  description: 'Permanently removes a logged event (e.g. undoing an accidental log). Use list_game_events or get_game_details to find the eventId first.',
  inputSchema: { eventId: z.number().int() },
}, async ({ eventId }) => {
  try {
    const { data, error } = await supabase.from('game_events').delete().eq('id', eventId).select().single()
    if (error) throw new Error(error.message)
    return ok({ deleted: data })
  } catch (err) {
    return fail(err)
  }
})

server.registerTool('list_game_events', {
  title: 'List a game\'s events',
  description: 'The full "Recent Activity" log for one game (or the current/relevant game if gameId is omitted), most recent first.',
  inputSchema: { gameId: z.number().int().optional() },
}, async ({ gameId }) => {
  try {
    const game = await resolveGame(gameId)
    const { data: events, error } = await supabase
      .from('game_events')
      .select('id, event_type, event_timestamp, player_id, related_player_id, notes')
      .eq('game_id', game.id)
      .order('event_timestamp', { ascending: false })
    if (error) throw new Error(error.message)
    const { data: players } = await supabase.from('players').select('id, display_name').eq('organization_id', ORG_ID)
    const nameById = new Map((players ?? []).map((p: any) => [p.id, p.display_name]))
    return ok((events ?? []).map((e: any) => ({
      id: e.id,
      event_type: e.event_type,
      timestamp: e.event_timestamp,
      player: e.player_id ? nameById.get(e.player_id) ?? null : null,
      related_player: e.related_player_id ? nameById.get(e.related_player_id) ?? null : null,
      notes: e.notes,
    })))
  } catch (err) {
    return fail(err)
  }
})

server.registerTool('get_player_stats', {
  title: 'Get player stats',
  description: 'Goals, assists, turnovers, and games played per player, optionally scoped to one season. Mirrors the Stats page\'s Player Rankings. With no filters, aggregates across every game in the organization.',
  inputSchema: {
    seasonId: z.number().int().optional(),
    seasonName: z.string().optional(),
    playerName: z.string().optional().describe('Return just this player\'s stats.'),
  },
}, async ({ seasonId, seasonName, playerName }) => {
  try {
    const season = await resolveSeason(seasonId, seasonName)
    let games = await getAllGames()
    if (season) games = games.filter(g => g.season_id === season.id)
    const gameIds = games.map(g => g.id)
    const today = todayLocalStr()
    const playedGameIds = new Set(games.filter(g => isPastGame(g, today)).map(g => g.id))

    const { data: events, error: eventsError } = await supabase
      .from('game_events')
      .select('player_id, related_player_id, event_type, game_id')
      .in('game_id', gameIds.length > 0 ? gameIds : [-1])
    if (eventsError) throw new Error(eventsError.message)

    const { data: playersData, error: playersError } = await supabase.from('players').select('id, display_name').eq('organization_id', ORG_ID)
    if (playersError) throw new Error(playersError.message)
    const playersMap = new Map((playersData ?? []).map((p: any) => [p.id, p]))

    const { data: lineupRows } = await supabase.from('game_lineups').select('game_id, player_id').in('game_id', gameIds.length > 0 ? gameIds : [-1])
    const attendance = new Map<number, Set<number>>()
    ;(lineupRows ?? []).forEach((r: any) => {
      if (!attendance.has(r.player_id)) attendance.set(r.player_id, new Set())
      attendance.get(r.player_id)!.add(r.game_id)
    })

    type Agg = { player_id: number; player_name: string; goals: number; assists: number; turnovers: number }
    const statsMap = new Map<number, Agg>()
    const ensure = (id: number) => {
      if (!statsMap.has(id)) {
        const p = playersMap.get(id)
        statsMap.set(id, { player_id: id, player_name: p?.display_name ?? `#${id}`, goals: 0, assists: 0, turnovers: 0 })
      }
      return statsMap.get(id)!
    }
    ;(events ?? []).forEach((e: any) => {
      if (e.player_id && playersMap.has(e.player_id)) {
        const s = ensure(e.player_id)
        if (e.event_type === 'Goal') s.goals++
        else if (isTurnoverEvent(e.event_type)) s.turnovers++
      }
      if (e.event_type === 'Goal' && e.related_player_id && playersMap.has(e.related_player_id)) {
        ensure(e.related_player_id).assists++
      }
    })

    let result = Array.from(statsMap.values()).map(s => {
      const played = [...(attendance.get(s.player_id) ?? new Set())].filter(gid => playedGameIds.has(gid)).length
      return { ...s, games_played: played }
    })
    if (playerName) {
      const player = await resolvePlayer(playerName)
      result = result.filter(s => s.player_id === player.id)
      if (result.length === 0) result = [{ player_id: player.id, player_name: player.display_name, goals: 0, assists: 0, turnovers: 0, games_played: 0 }]
    }
    result.sort((a, b) => (b.goals + b.assists) - (a.goals + a.assists))
    return ok(result)
  } catch (err) {
    return fail(err)
  }
})

server.registerTool('list_seasons', {
  title: 'List seasons',
  description: 'All seasons for this organization (id, name, year, organizer, dates) — use to resolve a season name/id for other tools.',
  inputSchema: {},
}, async () => {
  try {
    const seasons = await getAllSeasons()
    return ok(seasons.map(s => ({ id: s.id, label: seasonLabel(s), year: s.year, organizer: s.organizer, location: s.location, start_date: s.start_date, end_date: s.end_date })))
  } catch (err) {
    return fail(err)
  }
})

server.registerTool('list_roster', {
  title: 'List a season\'s (or the whole org\'s) roster',
  description: 'Players with Player/Sub status. Pass seasonId or seasonName to scope to one season\'s roster (Player/Sub is per-season); omit both for every player in the organization.',
  inputSchema: { seasonId: z.number().int().optional(), seasonName: z.string().optional() },
}, async ({ seasonId, seasonName }) => {
  try {
    const season = await resolveSeason(seasonId, seasonName)
    if (season) {
      const { data, error } = await supabase
        .from('season_players')
        .select('is_sub, players(id, display_name, position, gender_match)')
        .eq('season_id', season.id)
      if (error) throw new Error(error.message)
      return ok((data ?? []).map((r: any) => ({
        id: r.players.id, display_name: r.players.display_name, position: r.players.position, gender_match: r.players.gender_match, is_sub: r.is_sub,
      })))
    }
    const { data, error } = await supabase.from('players').select('id, display_name, position, gender_match, is_sub').eq('organization_id', ORG_ID)
    if (error) throw new Error(error.message)
    return ok(data ?? [])
  } catch (err) {
    return fail(err)
  }
})

server.registerTool('list_lineups', {
  title: 'List a game\'s lineups',
  description: 'Lineup groups and the players placed in each (with their role), for one game (or the current/relevant game if gameId is omitted). Being placed in any lineup group is what counts as "attending" the game.',
  inputSchema: { gameId: z.number().int().optional() },
}, async ({ gameId }) => {
  try {
    const game = await resolveGame(gameId)
    const { data: groups, error: groupsError } = await supabase.from('game_lineup_groups').select('id, lineup_name, sort_order').eq('game_id', game.id).order('sort_order')
    if (groupsError) throw new Error(groupsError.message)
    const { data: rows, error: rowsError } = await supabase
      .from('game_lineups')
      .select('lineup_name, sort_order, role, players(display_name, position, gender_match)')
      .eq('game_id', game.id)
      .order('sort_order')
    if (rowsError) throw new Error(rowsError.message)
    const byGroup = new Map<string, any[]>()
    ;(rows ?? []).forEach((r: any) => {
      if (!byGroup.has(r.lineup_name)) byGroup.set(r.lineup_name, [])
      byGroup.get(r.lineup_name)!.push({ display_name: r.players?.display_name, position: r.players?.position, gender_match: r.players?.gender_match, role: r.role })
    })
    return ok((groups ?? []).map((g: any) => ({ lineup_name: g.lineup_name, players: byGroup.get(g.lineup_name) ?? [] })))
  } catch (err) {
    return fail(err)
  }
})

server.registerTool('create_lineup_group', {
  title: 'Create a lineup group',
  description: 'Adds a new, initially empty lineup group (e.g. "Line 2") to a game.',
  inputSchema: { gameId: z.number().int().optional(), name: z.string() },
}, async ({ gameId, name }) => {
  try {
    const game = await resolveGame(gameId)
    const { data: existing, error: existingError } = await supabase.from('game_lineup_groups').select('sort_order').eq('game_id', game.id).order('sort_order', { ascending: false }).limit(1)
    if (existingError) throw new Error(existingError.message)
    const nextSortOrder = existing && existing.length > 0 ? existing[0]!.sort_order + 1 : 0
    const { data, error } = await supabase
      .from('game_lineup_groups')
      .upsert({ organization_id: ORG_ID, game_id: game.id, lineup_name: name, sort_order: nextSortOrder }, { onConflict: 'game_id,lineup_name', ignoreDuplicates: true })
      .select()
    if (error) throw new Error(error.message)
    return ok(data?.[0] ?? { note: `A group named "${name}" already exists on this game.` })
  } catch (err) {
    return fail(err)
  }
})

server.registerTool('add_to_lineup', {
  title: 'Add or move a player in a game\'s lineup',
  description: 'Places a player in a lineup group for a game (creating the group if it doesn\'t exist yet), removing them from any other group in that game first so a player only ever occupies one line. Being placed here is what makes them count as attending. Defaults to the game\'s first lineup group (creating "Lineup 1" if the game has none yet) when lineupGroupName is omitted.',
  inputSchema: {
    gameId: z.number().int().optional(),
    playerName: z.string(),
    lineupGroupName: z.string().optional(),
    role: z.string().optional().describe('e.g. "Handler", "Deep Cutter" — see frontend/lib/positions.ts for the standard set.'),
  },
}, async ({ gameId, playerName, lineupGroupName, role }) => {
  try {
    const game = await resolveGame(gameId)
    const player = await resolvePlayer(playerName)

    const { data: groups, error: groupsError } = await supabase.from('game_lineup_groups').select('id, lineup_name, sort_order').eq('game_id', game.id).order('sort_order')
    if (groupsError) throw new Error(groupsError.message)

    let targetName = lineupGroupName
    if (!targetName) {
      targetName = groups?.[0]?.lineup_name ?? 'Lineup 1'
    }
    const groupExists = (groups ?? []).some((g: any) => g.lineup_name.toLowerCase() === targetName!.toLowerCase())
    if (!groupExists) {
      const nextSortOrder = groups && groups.length > 0 ? Math.max(...groups.map((g: any) => g.sort_order)) + 1 : 0
      const { error: createError } = await supabase.from('game_lineup_groups').insert({ organization_id: ORG_ID, game_id: game.id, lineup_name: targetName, sort_order: nextSortOrder })
      if (createError) throw new Error(createError.message)
    }

    const { error: removeError } = await supabase.from('game_lineups').delete().eq('game_id', game.id).eq('player_id', player.id)
    if (removeError) throw new Error(removeError.message)

    const { data, error } = await supabase
      .from('game_lineups')
      .insert({ organization_id: ORG_ID, game_id: game.id, player_id: player.id, lineup_name: targetName, role: role ?? null })
      .select()
      .single()
    if (error) throw new Error(error.message)

    // Same convention as useAddToLineup: also join the game's season roster
    // so the player isn't invisible to season-scoped filters.
    if (game.season_id) {
      await supabase.from('season_players').upsert(
        { organization_id: ORG_ID, season_id: game.season_id, player_id: player.id, is_sub: true },
        { onConflict: 'season_id,player_id', ignoreDuplicates: true },
      )
    }

    return ok({ placed: data, player: player.display_name, lineup_group: targetName })
  } catch (err) {
    return fail(err)
  }
})

server.registerTool('remove_from_lineup', {
  title: 'Remove a player from a game entirely',
  description: 'Removes a player from every lineup group in a game, which is what makes them stop counting as attending that game.',
  inputSchema: { gameId: z.number().int().optional(), playerName: z.string() },
}, async ({ gameId, playerName }) => {
  try {
    const game = await resolveGame(gameId)
    const player = await resolvePlayer(playerName)
    const { data, error } = await supabase.from('game_lineups').delete().eq('game_id', game.id).eq('player_id', player.id).select()
    if (error) throw new Error(error.message)
    return ok({ removed_rows: data?.length ?? 0, player: player.display_name })
  } catch (err) {
    return fail(err)
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
