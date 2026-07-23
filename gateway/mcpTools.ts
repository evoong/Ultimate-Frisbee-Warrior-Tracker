// Tool registrations shared by the Cloudflare-hosted MCP server
// (gateway/mcpAgent.ts, mounted at /mcp in worker.ts) and usable by any other
// McpServer host. This is a from-scratch REST port of mcp-server/index.ts's
// 13 tools (which talks to Supabase via @supabase/supabase-js over local
// stdio) so it can run inside a Workers bundle without that dependency —
// same "portable raw fetch" reasoning as gameActions.ts, which this module
// reuses for the fully generic pieces (ActionsConfig, resolvePlayer,
// resolveCurrentGame/getAllGames, the date helpers). The write tools
// (create_game_event, update_game_event, delete_game_event, add_to_lineup,
// remove_from_lineup, create_lineup_group) still take a numeric `gameId`
// (Claude, unlike the in-app Gemini chat, can see ids), which doesn't match
// gameActions.ts's gameDate/opponent-hint write functions, so those are
// reimplemented locally here rather than force-adapted — matching the
// project's existing accepted duplication between mcp-server/index.ts and
// gateway/gameActions.ts (see CLAUDE.md's "MCP server" section).

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  type ActionsConfig,
  resolvePlayer,
  resolveCurrentGame as resolveCurrentGameTrimmed,
  getAllGames as getAllGamesTrimmed,
  isPastGame,
  todayLocalStr,
  gameStartsAt,
  isTurnoverEvent,
  EVENT_TYPES,
  type EventType,
} from './gameActions.js'
import { sbGet, sbWrite, sbUpsertIgnore } from './supabaseRest.js'

type GameRow = {
  id: number; season_id: number | null; opponent: string; game_date: string; game_time: string | null
  game_type: string | null; notes: string | null; outcome_override: string | null
}
type SeasonRow = { id: number; name: string; year: number; organizer: string | null; location: string | null; start_date: string | null; end_date: string | null }

function seasonLabel(s: { name: string; year: number; organizer: string | null }): string {
  return [s.organizer, s.name, s.year].filter(Boolean).join(' ')
}

function sortGamesUpcomingFirst<T extends { game_date: string; game_time: string | null }>(games: T[], today = todayLocalStr()): T[] {
  const upcoming = games.filter(g => !isPastGame(g, today)).sort((a, b) => gameStartsAt(a).getTime() - gameStartsAt(b).getTime())
  const past = games.filter(g => isPastGame(g, today)).sort((a, b) => gameStartsAt(b).getTime() - gameStartsAt(a).getTime())
  return [...upcoming, ...past]
}

async function getAllGamesFull(config: ActionsConfig, orgId: number): Promise<GameRow[]> {
  return sbGet(config, `/games?organization_id=eq.${orgId}&select=id,season_id,opponent,game_date,game_time,game_type,notes,outcome_override`)
}

async function getGameFull(config: ActionsConfig, orgId: number, id: number): Promise<GameRow> {
  const rows: GameRow[] = await sbGet(config, `/games?id=eq.${id}&organization_id=eq.${orgId}&select=id,season_id,opponent,game_date,game_time,game_type,notes,outcome_override`)
  if (!rows[0]) throw new Error(`No game found with id ${id}.`)
  return rows[0]
}

// Resolution logic (imminent/today/most-recent-past/next-upcoming) lives once
// in gameActions.resolveCurrentGame, operating on a trimmed row; fetch the
// full row afterward only when it's actually needed.
async function resolveGame(config: ActionsConfig, orgId: number, gameId?: number): Promise<GameRow> {
  if (gameId != null) return getGameFull(config, orgId, gameId)
  const trimmed = await resolveCurrentGameTrimmed(config, orgId)
  return getGameFull(config, orgId, trimmed.id)
}

async function getAllSeasons(config: ActionsConfig, orgId: number): Promise<SeasonRow[]> {
  return sbGet(config, `/seasons?organization_id=eq.${orgId}&select=*&order=year.desc`)
}

async function resolveSeason(config: ActionsConfig, orgId: number, seasonId?: number, seasonName?: string): Promise<SeasonRow | undefined> {
  if (seasonId == null && !seasonName) return undefined
  const seasons = await getAllSeasons(config, orgId)
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

function computeScore(events: { event_type: string }[]): { ourScore: number; theirScore: number } {
  return {
    ourScore: events.filter(e => e.event_type === 'Goal').length,
    theirScore: events.filter(e => e.event_type === 'Opponent Goal').length,
  }
}

async function gameSummary(config: ActionsConfig, g: GameRow, seasons: SeasonRow[]) {
  const events: { event_type: string }[] = await sbGet(config, `/game_events?game_id=eq.${g.id}&select=event_type`)
  const { ourScore, theirScore } = computeScore(events)
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

function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
}
function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

export function registerUfwtMcpTools(server: McpServer, config: ActionsConfig, orgId: number) {
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
      const season = await resolveSeason(config, orgId, seasonId, seasonName)
      const seasons = await getAllSeasons(config, orgId)
      let games = await getAllGamesFull(config, orgId)
      if (season) games = games.filter(g => g.season_id === season.id)
      const today = todayLocalStr()
      if (status === 'upcoming') games = games.filter(g => !isPastGame(g, today))
      if (status === 'past') games = games.filter(g => isPastGame(g, today))
      games = sortGamesUpcomingFirst(games, today).slice(0, limit ?? 15)
      const summaries = await Promise.all(games.map(g => gameSummary(config, g, seasons)))
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
      const g = await resolveGame(config, orgId)
      const seasons = await getAllSeasons(config, orgId)
      return ok(await gameSummary(config, g, seasons))
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
      const g = await resolveGame(config, orgId, gameId)
      const seasons = await getAllSeasons(config, orgId)
      const summary = await gameSummary(config, g, seasons)
      const events = await sbGet(config, `/game_events?game_id=eq.${g.id}&select=id,event_type,event_timestamp,player_id,related_player_id,notes&order=event_timestamp.desc`)
      const players = await sbGet(config, `/players?organization_id=eq.${orgId}&select=id,display_name`)
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
      const game = await resolveGame(config, orgId, gameId)
      const player = playerName ? await resolvePlayer(config, orgId, playerName) : undefined
      const assister = assisterName ? await resolvePlayer(config, orgId, assisterName) : undefined
      const created = await sbWrite(config, 'POST', '/game_events', {
        organization_id: orgId,
        game_id: game.id,
        player_id: player?.id ?? null,
        related_player_id: eventType === 'Goal' ? (assister?.id ?? null) : null,
        event_type: eventType,
        event_timestamp: new Date().toISOString(),
        notes: notes ?? null,
      })
      return ok({
        created_event: created[0],
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
      const player = playerName !== undefined ? (playerName === '' ? null : await resolvePlayer(config, orgId, playerName)) : undefined
      const assister = assisterName !== undefined ? (assisterName === '' ? null : await resolvePlayer(config, orgId, assisterName)) : undefined
      const body: Record<string, unknown> = {}
      if (player !== undefined) body.player_id = player?.id ?? null
      if (assister !== undefined) body.related_player_id = assister?.id ?? null
      const updated = await sbWrite(config, 'PATCH', `/game_events?id=eq.${eventId}`, body)
      if (!updated[0]) throw new Error(`No event found with id ${eventId}.`)
      return ok(updated[0])
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
      const deleted = await sbWrite(config, 'DELETE', `/game_events?id=eq.${eventId}`)
      if (!deleted[0]) throw new Error(`No event found with id ${eventId}.`)
      return ok({ deleted: deleted[0] })
    } catch (err) {
      return fail(err)
    }
  })

  server.registerTool('list_game_events', {
    title: "List a game's events",
    description: 'The full "Recent Activity" log for one game (or the current/relevant game if gameId is omitted), most recent first.',
    inputSchema: { gameId: z.number().int().optional() },
  }, async ({ gameId }) => {
    try {
      const game = await resolveGame(config, orgId, gameId)
      const events = await sbGet(config, `/game_events?game_id=eq.${game.id}&select=id,event_type,event_timestamp,player_id,related_player_id,notes&order=event_timestamp.desc`)
      const players = await sbGet(config, `/players?organization_id=eq.${orgId}&select=id,display_name`)
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
      playerName: z.string().optional().describe("Return just this player's stats."),
    },
  }, async ({ seasonId, seasonName, playerName }) => {
    try {
      const season = await resolveSeason(config, orgId, seasonId, seasonName)
      let games = await getAllGamesTrimmed(config, orgId)
      if (season) games = games.filter(g => g.season_id === season.id)
      const gameIds = games.map(g => g.id)
      const today = todayLocalStr()
      const playedGameIds = new Set(games.filter(g => isPastGame(g, today)).map(g => g.id))

      const idsFilter = gameIds.length > 0 ? `(${gameIds.join(',')})` : '(-1)'
      const events = await sbGet(config, `/game_events?game_id=in.${idsFilter}&select=player_id,related_player_id,event_type,game_id`)
      const playersData: { id: number; display_name: string }[] = await sbGet(config, `/players?organization_id=eq.${orgId}&select=id,display_name`)
      const playersMap = new Map((playersData ?? []).map(p => [p.id, p] as const))

      const lineupRows = await sbGet(config, `/game_lineups?game_id=in.${idsFilter}&select=game_id,player_id`)
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
        const played = [...(attendance.get(s.player_id) ?? new Set<number>())].filter(gid => playedGameIds.has(gid)).length
        return { ...s, games_played: played }
      })
      if (playerName) {
        const player = await resolvePlayer(config, orgId, playerName)
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
      const seasons = await getAllSeasons(config, orgId)
      return ok(seasons.map(s => ({ id: s.id, label: seasonLabel(s), year: s.year, organizer: s.organizer, location: s.location, start_date: s.start_date, end_date: s.end_date })))
    } catch (err) {
      return fail(err)
    }
  })

  server.registerTool('list_roster', {
    title: "List a season's (or the whole org's) roster",
    description: "Players with Player/Sub status. Pass seasonId or seasonName to scope to one season's roster (Player/Sub is per-season); omit both for every player in the organization.",
    inputSchema: { seasonId: z.number().int().optional(), seasonName: z.string().optional() },
  }, async ({ seasonId, seasonName }) => {
    try {
      const season = await resolveSeason(config, orgId, seasonId, seasonName)
      if (season) {
        const rows = await sbGet(config, `/season_players?season_id=eq.${season.id}&select=is_sub,players(id,display_name,position,gender_match)`)
        return ok((rows ?? []).map((r: any) => ({
          id: r.players.id, display_name: r.players.display_name, position: r.players.position, gender_match: r.players.gender_match, is_sub: r.is_sub,
        })))
      }
      const rows = await sbGet(config, `/players?organization_id=eq.${orgId}&select=id,display_name,position,gender_match,is_sub`)
      return ok(rows ?? [])
    } catch (err) {
      return fail(err)
    }
  })

  server.registerTool('list_lineups', {
    title: "List a game's lineups",
    description: 'Lineup groups and the players placed in each (with their role), for one game (or the current/relevant game if gameId is omitted). Being placed in any lineup group is what counts as "attending" the game.',
    inputSchema: { gameId: z.number().int().optional() },
  }, async ({ gameId }) => {
    try {
      const game = await resolveGame(config, orgId, gameId)
      const groups = await sbGet(config, `/game_lineup_groups?game_id=eq.${game.id}&select=id,lineup_name,sort_order&order=sort_order`)
      const rows = await sbGet(config, `/game_lineups?game_id=eq.${game.id}&select=lineup_name,sort_order,role,players(display_name,position,gender_match)&order=sort_order`)
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
      const game = await resolveGame(config, orgId, gameId)
      const existing = await sbGet(config, `/game_lineup_groups?game_id=eq.${game.id}&select=sort_order&order=sort_order.desc&limit=1`)
      const nextSortOrder = existing && existing.length > 0 ? existing[0].sort_order + 1 : 0
      const created = await sbUpsertIgnore(config, '/game_lineup_groups', { organization_id: orgId, game_id: game.id, lineup_name: name, sort_order: nextSortOrder }, 'game_id,lineup_name')
      return ok(created?.[0] ?? { note: `A group named "${name}" already exists on this game.` })
    } catch (err) {
      return fail(err)
    }
  })

  server.registerTool('add_to_lineup', {
    title: "Add or move a player in a game's lineup",
    description: 'Places a player in a lineup group for a game (creating the group if it doesn\'t exist yet), removing them from any other group in that game first so a player only ever occupies one line. Being placed here is what makes them count as attending. Defaults to the game\'s first lineup group (creating "Lineup 1" if the game has none yet) when lineupGroupName is omitted.',
    inputSchema: {
      gameId: z.number().int().optional(),
      playerName: z.string(),
      lineupGroupName: z.string().optional(),
      role: z.string().optional().describe('e.g. "Handler", "Deep Cutter" — see frontend/lib/positions.ts for the standard set.'),
    },
  }, async ({ gameId, playerName, lineupGroupName, role }) => {
    try {
      const game = await resolveGame(config, orgId, gameId)
      const player = await resolvePlayer(config, orgId, playerName)

      const groups = await sbGet(config, `/game_lineup_groups?game_id=eq.${game.id}&select=id,lineup_name,sort_order&order=sort_order`)
      const targetName = lineupGroupName ?? groups?.[0]?.lineup_name ?? 'Lineup 1'
      const groupExists = (groups ?? []).some((g: any) => g.lineup_name.toLowerCase() === targetName.toLowerCase())
      if (!groupExists) {
        const nextSortOrder = groups && groups.length > 0 ? Math.max(...groups.map((g: any) => g.sort_order)) + 1 : 0
        await sbWrite(config, 'POST', '/game_lineup_groups', { organization_id: orgId, game_id: game.id, lineup_name: targetName, sort_order: nextSortOrder })
      }

      await sbWrite(config, 'DELETE', `/game_lineups?game_id=eq.${game.id}&player_id=eq.${player.id}`)
      const placed = await sbWrite(config, 'POST', '/game_lineups', { organization_id: orgId, game_id: game.id, player_id: player.id, lineup_name: targetName, role: role ?? null })

      // Same convention as useAddToLineup: also join the game's season roster
      // so the player isn't invisible to season-scoped filters.
      if (game.season_id) {
        await sbUpsertIgnore(config, '/season_players', { organization_id: orgId, season_id: game.season_id, player_id: player.id, is_sub: true }, 'season_id,player_id')
      }

      return ok({ placed: placed[0], player: player.display_name, lineup_group: targetName })
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
      const game = await resolveGame(config, orgId, gameId)
      const player = await resolvePlayer(config, orgId, playerName)
      const removed = await sbWrite(config, 'DELETE', `/game_lineups?game_id=eq.${game.id}&player_id=eq.${player.id}`)
      return ok({ removed_rows: removed?.length ?? 0, player: player.display_name })
    } catch (err) {
      return fail(err)
    }
  })
}
