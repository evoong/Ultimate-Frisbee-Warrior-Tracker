// Write-side actions the Chat assistant can call as Gemini function calls
// (see callGemini/getTeamContext in chat.ts) to actually record game events
// and manage lineups, rather than only answering questions about them. Kept
// deliberately separate from mcp-server/index.ts (which does the same thing
// for MCP clients like Claude): that server talks to Supabase via
// @supabase/supabase-js, while this module uses raw fetch like the rest of
// gateway/ so it stays portable across Cloudflare Workers, Vercel, and
// Express (see chat.ts's own supabaseServiceFetch for the same reasoning).
// The small pure helpers below (isPastGame, isTurnoverEvent, ...) are
// intentionally duplicated from frontend/lib rather than imported, matching
// how chat.ts's getTeamContext already inlines its own turnover-type check
// rather than pulling frontend code into the gateway bundle.

export interface ActionsConfig {
  supabaseUrl: string
  supabaseSecretKey: string
}

async function sbGet(config: ActionsConfig, path: string): Promise<any> {
  const res = await fetch(`${config.supabaseUrl}/rest/v1${path}`, {
    headers: { apikey: config.supabaseSecretKey, Authorization: `Bearer ${config.supabaseSecretKey}` },
  })
  if (!res.ok) throw new Error(`Supabase query failed (${res.status}): ${path}`)
  return res.json()
}

async function sbWrite(config: ActionsConfig, method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${config.supabaseUrl}/rest/v1${path}`, {
    method,
    headers: {
      apikey: config.supabaseSecretKey,
      Authorization: `Bearer ${config.supabaseSecretKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase ${method} failed (${res.status}): ${text || path}`)
  }
  const text = await res.text()
  return text ? JSON.parse(text) : []
}

// Upsert that silently no-ops on a conflict against `onConflict` (e.g. a
// player already on a season's roster, or a lineup group name that already
// exists on this game) instead of erroring — matches the `ignoreDuplicates`
// upserts already used for the same tables in frontend/hooks/backend/*.ts.
async function sbUpsertIgnore(config: ActionsConfig, path: string, body: unknown, onConflict: string): Promise<any> {
  const sep = path.includes('?') ? '&' : '?'
  const res = await fetch(`${config.supabaseUrl}/rest/v1${path}${sep}on_conflict=${onConflict}`, {
    method: 'POST',
    headers: {
      apikey: config.supabaseSecretKey,
      Authorization: `Bearer ${config.supabaseSecretKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation,resolution=ignore-duplicates',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase upsert failed (${res.status}): ${text || path}`)
  }
  const text = await res.text()
  return text ? JSON.parse(text) : []
}

// Matches Schedule.tsx's IMMINENT_WINDOW_MS.
const IMMINENT_WINDOW_MS = 30 * 60 * 1000

function todayLocalStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function isPastGame(g: { game_date: string }, today = todayLocalStr()): boolean {
  return g.game_date < today
}
function isTurnoverEvent(eventType: string): boolean {
  return ['Turnover', 'Throwaway', 'Drop'].includes(eventType)
}
function gameStartsAt(g: { game_date: string; game_time: string | null }): Date {
  return new Date(`${g.game_date}T${g.game_time || '00:00:00'}`)
}

type GameRow = { id: number; season_id: number | null; opponent: string; game_date: string; game_time: string | null }

async function getAllGames(config: ActionsConfig, orgId: number): Promise<GameRow[]> {
  return sbGet(config, `/games?organization_id=eq.${orgId}&select=id,season_id,opponent,game_date,game_time`)
}

// Same fallback chain as mcp-server's resolveCurrentGame / Schedule.tsx's
// imminent-game auto-select: imminent, else today, else most recently
// played, else next upcoming.
async function resolveCurrentGame(config: ActionsConfig, orgId: number): Promise<GameRow> {
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
async function resolveGame(config: ActionsConfig, orgId: number, hint?: { gameDate?: string; opponent?: string }): Promise<GameRow> {
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

type PlayerRow = { id: number; display_name: string }

async function resolvePlayer(config: ActionsConfig, orgId: number, nameQuery: string): Promise<PlayerRow> {
  const players: PlayerRow[] = await sbGet(config, `/players?organization_id=eq.${orgId}&select=id,display_name`)
  const q = nameQuery.trim().toLowerCase()
  let matches = players.filter(p => p.display_name.toLowerCase() === q)
  if (matches.length === 0) matches = players.filter(p => p.display_name.toLowerCase().includes(q))
  if (matches.length === 0) throw new Error(`No player found matching "${nameQuery}".`)
  if (matches.length > 1) throw new Error(`Multiple players match "${nameQuery}": ${matches.map(m => m.display_name).join(', ')}. Be more specific.`)
  return matches[0]!
}

async function currentScore(config: ActionsConfig, gameId: number): Promise<{ our_score: number; their_score: number }> {
  const events: { event_type: string }[] = await sbGet(config, `/game_events?game_id=eq.${gameId}&select=event_type`)
  return {
    our_score: events.filter(e => e.event_type === 'Goal').length,
    their_score: events.filter(e => e.event_type === 'Opponent Goal').length,
  }
}

const EVENT_TYPES = ['Goal', 'Opponent Goal', 'Block', 'Throwaway', 'Drop', 'Pull', 'Caught OB', 'Fouls'] as const
export type EventType = (typeof EVENT_TYPES)[number]

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

export async function callChatFunction(config: ActionsConfig, orgId: number, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'create_game_event': return createGameEvent(config, orgId, args as any)
    case 'undo_last_event': return undoLastEvent(config, orgId, args as any)
    case 'add_to_lineup': return addToLineup(config, orgId, args as any)
    case 'remove_from_lineup': return removeFromLineup(config, orgId, args as any)
    case 'create_lineup_group': return createLineupGroup(config, orgId, args as any)
    default: throw new Error(`Unknown function: ${name}`)
  }
}
