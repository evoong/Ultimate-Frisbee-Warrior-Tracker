import { useState, useCallback, useRef } from 'react'
import { supabase } from '../../lib/supabase'
import { isTurnoverEvent } from '../../lib/eventUtils'

type HookResult<T, P = void> = {
  data: T | undefined
  loading: boolean
  error: string | null
  trigger: P extends void ? () => Promise<T | undefined> : (params?: P) => Promise<T | undefined>
}

function useApiCall<T, P = void>(fn: (params: P) => Promise<T>): HookResult<T, P> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seqRef = useRef(0)

  const trigger = useCallback(async (params?: P) => {
    // Guard against out-of-order responses: only the latest call may set state
    const callId = ++seqRef.current
    setLoading(true)
    setError(null)
    try {
      const result = await fn(params as P)
      if (callId === seqRef.current) setData(result)
      return result
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (callId === seqRef.current) setError(msg)
      return undefined
    } finally {
      if (callId === seqRef.current) setLoading(false)
    }
  }, [fn])

  return { data, loading, error, trigger: trigger as HookResult<T, P>['trigger'] }
}

export function useGetPlayers() {
  const fn = useCallback(async (params: { organizationId: number | null; seasonIds?: number[] }) => {
    if (!params.seasonIds || params.seasonIds.length === 0) {
      // No season filter - return all players, is_sub is the global default
      const { data, error } = await supabase
        .from('players')
        .select('*')
        .eq('organization_id', params.organizationId)
        .order('display_name')
      if (error) throw new Error(error.message)
      return data as any[]
    }

    // Get players for specific seasons through season_players table
    const { data: seasonPlayers, error: spError } = await supabase
      .from('season_players')
      .select('player_id, is_sub')
      .in('season_id', params.seasonIds)

    if (spError) throw new Error(spError.message)

    if (!seasonPlayers || seasonPlayers.length === 0) {
      return []
    }

    // Player/Sub status is per-season, so with more than one season selected
    // a player counts as a sub here only if they're a sub in every one of them.
    const subByPlayer = new Map<number, boolean>()
    for (const sp of seasonPlayers as any[]) {
      subByPlayer.set(sp.player_id, (subByPlayer.get(sp.player_id) ?? true) && sp.is_sub)
    }
    const playerIds = [...subByPlayer.keys()]

    // Get full player details
    const { data, error } = await supabase
      .from('players')
      .select('*')
      .in('id', playerIds)
      .order('display_name')

    if (error) throw new Error(error.message)
    return (data as any[]).map(p => ({ ...p, is_sub: subByPlayer.get(p.id) ?? p.is_sub }))
  }, [])
  return useApiCall<any[], { organizationId: number | null; seasonIds?: number[] }>(fn)
}

export function useGetSeasonRoster() {
  const fn = useCallback(async (params: { seasonId: number }) => {
    const { data: seasonPlayers, error: spError } = await supabase
      .from('season_players')
      .select('player_id, is_sub')
      .eq('season_id', params.seasonId)
    if (spError) throw new Error(spError.message)
    if (!seasonPlayers || seasonPlayers.length === 0) return []

    const subByPlayer = new Map((seasonPlayers as any[]).map((sp: any) => [sp.player_id, sp.is_sub]))
    const playerIds = [...subByPlayer.keys()]
    const { data: playersData, error: playersError } = await supabase
      .from('players')
      .select('*')
      .in('id', playerIds)
      .order('display_name')
    if (playersError) throw new Error(playersError.message)
    // is_sub here reflects this specific season, not the player's global default
    return (playersData as any[]).map(p => ({ ...p, is_sub: subByPlayer.get(p.id) ?? p.is_sub }))
  }, [])
  return useApiCall<any[], { seasonId: number }>(fn)
}

export function useCreatePlayer() {
  const fn = useCallback(async (params: {
    organizationId: number | null;
    display_name: string; first_name?: string; last_name?: string;
    gender_match?: string; phone?: string; number?: number; position?: string; is_sub?: boolean; season_ids?: number[]
  }) => {
    // season_ids lives in the season_players junction table, not on players
    const { season_ids, organizationId, ...playerFields } = params
    const { data, error } = await supabase
      .from('players')
      .insert({ ...playerFields, organization_id: organizationId })
      .select()
    if (error) throw new Error(error.message)
    const player = data?.[0]
    if (player && season_ids && season_ids.length > 0) {
      const rows = season_ids.map(sid => ({ organization_id: organizationId, player_id: (player as any).id, season_id: sid }))
      const { error: spError } = await supabase.from('season_players').insert(rows)
      if (spError) throw new Error(spError.message)
    }
    return player
  }, [])
  return useApiCall(fn)
}

export function useGetPlayersNotInSeason() {
  const fn = useCallback(async (params: { organizationId: number | null; gameId?: number; seasonId?: number }) => {
    if (!params.seasonId) {
      const { data, error } = await supabase
        .from('players')
        .select('*')
        .eq('organization_id', params.organizationId)
        .order('display_name')
      if (error) throw new Error(error.message)
      return data as any[]
    }

    // Get player IDs for this season from season_players junction table
    const { data: seasonPlayers, error: spError } = await supabase
      .from('season_players')
      .select('player_id')
      .eq('season_id', params.seasonId)

    if (spError) throw new Error(spError.message)

    // No one is on this season's roster yet, so every player counts as
    // "not in this season" (previously this short-circuited to [], which
    // hid subs created for other seasons/games from a brand-new season's
    // Add-player combobox until someone else joined the roster first).
    if (!seasonPlayers || seasonPlayers.length === 0) {
      const { data, error } = await supabase
        .from('players')
        .select('*')
        .eq('organization_id', params.organizationId)
        .order('display_name')
      if (error) throw new Error(error.message)
      return data as any[]
    }

    const playerIds = seasonPlayers.map(sp => (sp as any).player_id)

    // Get players NOT in this season
    const { data, error } = await supabase
      .from('players')
      .select('*')
      .eq('organization_id', params.organizationId)
      .not('id', 'in', `(${playerIds.join(',')})`)
      .order('display_name')

    if (error) throw new Error(error.message)
    return data as any[]
  }, [])
  return useApiCall<any[], { organizationId: number | null; gameId?: number; seasonId?: number }>(fn)
}

export function useCreatePlayerForGame() {
  const fn = useCallback(async (params: { organizationId: number | null; gameId: number; seasonId?: number | null; display_name: string; position?: string; gender_match?: string }) => {
    // Players created mid-game from Schedule/live scoring are subs
    const { data: playerData, error: playerError } = await supabase
      .from('players')
      .insert({ organization_id: params.organizationId, display_name: params.display_name, position: params.position, gender_match: params.gender_match, is_sub: true })
      .select()
    if (playerError) throw new Error(playerError.message)

    const playerId = playerData?.[0]?.id
    if (!playerId) throw new Error('Failed to create player')

    const { data, error } = await supabase
      .from('game_lineups')
      .insert({ organization_id: params.organizationId, game_id: params.gameId, player_id: playerId, lineup_name: 'Starting' })
      .select()
    if (error) throw new Error(error.message)

    // Also join the game's season roster (not just game_lineups) so the sub
    // shows up anywhere a season-scoped roster or attendance filter is
    // applied (Schedule, Strategy, ...), instead of being invisible
    // everywhere except this one game's lineup tab.
    if (params.seasonId) {
      const { error: spError } = await supabase.from('season_players').insert({ organization_id: params.organizationId, player_id: playerId, season_id: params.seasonId, is_sub: true })
      if (spError) throw new Error(spError.message)
    }
    // A new game backfills game_attendance for the season roster at that
    // moment (see trg_backfill_game_attendance), but that only fires once
    // at game creation; a player joining later needs its own row so
    // Schedule's Attendance tab (which lists existing rows, not the roster)
    // picks them up immediately instead of only from the next game onward.
    const { error: gaError } = await supabase
      .from('game_attendance')
      .upsert({ organization_id: params.organizationId, game_id: params.gameId, player_id: playerId, in: true }, { onConflict: 'game_id,player_id', ignoreDuplicates: true })
    if (gaError) throw new Error(gaError.message)
    return data?.[0]
  }, [])
  return useApiCall(fn)
}

export function useDeleteSubPlayer() {
  const fn = useCallback(async (params: { gameId: number; seasonId?: number | null; playerId: number }) => {
    const { data, error } = await supabase
      .from('game_lineups')
      .delete()
      .eq('game_id', params.gameId)
      .eq('player_id', params.playerId)
      .select()
    if (error) throw new Error(error.message)
    if (params.seasonId) {
      const { error: spError } = await supabase
        .from('season_players')
        .delete()
        .eq('season_id', params.seasonId)
        .eq('player_id', params.playerId)
      if (spError) throw new Error(spError.message)
    }
    const { error: gaError } = await supabase
      .from('game_attendance')
      .delete()
      .eq('game_id', params.gameId)
      .eq('player_id', params.playerId)
    if (gaError) throw new Error(gaError.message)
    return data?.[0]
  }, [])
  return useApiCall(fn)
}

export function useAddPlayerToGame() {
  const fn = useCallback(async (params: { organizationId: number | null; gameId: number; playerId: number; seasonId?: number | null }) => {
    const { data, error } = await supabase
      .from('game_lineups')
      .insert({ organization_id: params.organizationId, game_id: params.gameId, player_id: params.playerId, lineup_name: 'Starting' })
      .select()
    if (error) throw new Error(error.message)

    // Also join the game's season roster, same as useCreatePlayerForGame:
    // this may be an existing player from a *different* season, and without
    // a season_players row here they'd be invisible to this season's
    // attendance/roster filters. ignoreDuplicates since they may already be
    // a member of this season (in which case their existing Player/Sub
    // status is left alone) — a brand-new membership defaults to sub, since
    // this is someone being pulled in for a season they aren't normally
    // part of (Player/Sub is per-season: see season_players.is_sub).
    if (params.seasonId) {
      const { error: spError } = await supabase
        .from('season_players')
        .upsert({ organization_id: params.organizationId, player_id: params.playerId, season_id: params.seasonId, is_sub: true }, { onConflict: 'season_id,player_id', ignoreDuplicates: true })
      if (spError) throw new Error(spError.message)
    }
    // See useCreatePlayerForGame: a row for this specific game so the
    // Attendance tab (which lists existing rows, not the roster) shows them
    // immediately rather than only from the next game onward.
    const { error: gaError } = await supabase
      .from('game_attendance')
      .upsert({ organization_id: params.organizationId, game_id: params.gameId, player_id: params.playerId, in: true }, { onConflict: 'game_id,player_id', ignoreDuplicates: true })
    if (gaError) throw new Error(gaError.message)
    return data?.[0]
  }, [])
  return useApiCall(fn)
}

export function useDeletePlayer() {
  const fn = useCallback(async (params: { playerId: number }) => {
    const { data, error } = await supabase
      .from('players')
      .delete()
      .eq('id', params.playerId)
      .select()
    if (error) throw new Error(error.message)
    return data?.[0]
  }, [])
  return useApiCall(fn)
}

export function useUpdatePlayer() {
  const fn = useCallback(async (params: { playerId: number; display_name?: string; phone?: string; number?: number | null; gender_match?: string; position?: string | null; is_sub?: boolean }) => {
    const { playerId, ...body } = params
    const { data, error } = await supabase
      .from('players')
      .update(body)
      .eq('id', playerId)
      .select()
    if (error) throw new Error(error.message)
    return data?.[0]
  }, [])
  return useApiCall(fn)
}

export function useUpdatePlayerPosition() {
  const fn = useCallback(async (params: { playerId: number; position: string | null }) => {
    const { data, error } = await supabase
      .from('players')
      .update({ position: params.position })
      .eq('id', params.playerId)
      .select()
    if (error) throw new Error(error.message)
    return data?.[0]
  }, [])
  return useApiCall(fn)
}

export function useUpdatePlayerSeasons() {
  const fn = useCallback(async (params: { organizationId: number | null; playerId: number; seasonIds: number[]; subsBySeasonId?: Record<number, boolean> }) => {
    // Diff against existing memberships so jersey_number/active on removed rows are dropped
    const { data: existing, error: fetchError } = await supabase
      .from('season_players')
      .select('season_id')
      .eq('player_id', params.playerId)
    if (fetchError) throw new Error(fetchError.message)

    const current = new Set(((existing ?? []) as any[]).map((r: any) => r.season_id as number))
    const wanted = new Set(params.seasonIds)
    const toRemove = [...current].filter(sid => !wanted.has(sid))

    if (toRemove.length > 0) {
      const { error: deleteError } = await supabase
        .from('season_players')
        .delete()
        .eq('player_id', params.playerId)
        .in('season_id', toRemove)
      if (deleteError) throw new Error(deleteError.message)
    }
    if (params.seasonIds.length > 0) {
      // Upsert every kept/added season in one go: only touches is_sub (and
      // inserts player_id/season_id for new rows), leaving jersey_number/
      // active on already-existing rows untouched.
      const rows = params.seasonIds.map(sid => ({
        organization_id: params.organizationId, player_id: params.playerId, season_id: sid, is_sub: params.subsBySeasonId?.[sid] ?? false,
      }))
      const { error: upsertError } = await supabase
        .from('season_players')
        .upsert(rows, { onConflict: 'season_id,player_id' })
      if (upsertError) throw new Error(upsertError.message)
    }

    // A player promoted to full-player (is_sub: false) for a season is
    // expected to attend every game in that season by default, same as
    // the rest of the roster. Games created while they were a sub (or
    // before they joined) never got a game_attendance row for them, so
    // without this they'd be invisible in the Attendance tab (which lists
    // existing rows, not the roster) for every one of those games until
    // added back game-by-game via "Add player". Backfill the missing rows
    // for this season's existing games, mirroring the per-game upsert
    // useCreatePlayerForGame/useAddToLineup already do for a single game.
    const fullPlayerSeasonIds = params.seasonIds.filter(sid => !(params.subsBySeasonId?.[sid] ?? false))
    if (fullPlayerSeasonIds.length > 0) {
      const { data: seasonGames, error: gamesError } = await supabase
        .from('games')
        .select('id')
        .in('season_id', fullPlayerSeasonIds)
      if (gamesError) throw new Error(gamesError.message)
      const attendanceRows = ((seasonGames ?? []) as { id: number }[]).map(g => ({
        organization_id: params.organizationId, game_id: g.id, player_id: params.playerId, in: true,
      }))
      if (attendanceRows.length > 0) {
        const { error: gaError } = await supabase
          .from('game_attendance')
          .upsert(attendanceRows, { onConflict: 'game_id,player_id', ignoreDuplicates: true })
        if (gaError) throw new Error(gaError.message)
      }
    }
  }, [])
  return useApiCall(fn)
}

export function useUploadPlayerPhoto() {
  const fn = useCallback(async (params: { playerId: number; file: File }) => {
    const fileName = `player-${params.playerId}-${Date.now()}`
    const { data, error } = await supabase.storage
      .from('player-photos')
      .upload(fileName, params.file)
    if (error) throw new Error(error.message)

    // Store a domain-relative path, not an absolute URL: the app is served from
    // multiple origins (Vercel + Cloudflare), and getPublicUrl() bakes in
    // window.location.origin at upload time. An absolute URL only resolves
    // (with the session cookie the proxy needs) on the origin it was uploaded
    // from — viewed from any other deployment it's a cross-origin request with
    // no cookie, so the gateway 401s and the image never loads.
    const photo_url = `/db/storage/v1/object/public/player-photos/${data.path}`

    const { data: updated, error: updateError } = await supabase
      .from('players')
      .update({ photo_url })
      .eq('id', params.playerId)
      .select()
    if (updateError) throw new Error(updateError.message)
    return updated?.[0] as { photo_url: string } | undefined
  }, [])
  return useApiCall(fn)
}

export function useGetPlayerGameStats() {
  const fn = useCallback(async (params: { playerId: number }) => {
    // Fetch all game_attendance rows for this player (in = true or false)
    const { data: attendance, error: attendanceError } = await supabase
      .from('game_attendance')
      .select('game_id, in')
      .eq('player_id', params.playerId)
    if (attendanceError) throw new Error(attendanceError.message)

    const attendanceByGame = new Map<number, boolean>(
      ((attendance ?? []) as any[]).map((r: any) => [r.game_id as number, r.in as boolean])
    )
    const attendedGameIds = [...attendanceByGame.keys()]
    if (attendedGameIds.length === 0) return []

    // Fetch game details for all attended games
    const { data: games, error: gamesError } = await supabase
      .from('games')
      .select('id, opponent, game_date, game_type, season_id')
      .in('id', attendedGameIds)
    if (gamesError) throw new Error(gamesError.message)

    // Fetch events where this player scored
    const { data: scoringEvents, error } = await supabase
      .from('game_events')
      .select('game_id, event_type')
      .eq('player_id', params.playerId)
    if (error) throw new Error(error.message)

    // Fetch Goal events where this player assisted
    const { data: assistEvents, error: assistError } = await supabase
      .from('game_events')
      .select('game_id, event_type')
      .eq('related_player_id', params.playerId)
      .eq('event_type', 'Goal')
    if (assistError) throw new Error(assistError.message)

    const gamesMap = new Map((games ?? []).map((g: any) => [g.id, g]))

    // Seed every game (in or out) with zeroes so all season games appear
    const statsMap = new Map<number, any>()
    attendedGameIds.forEach((gameId: number) => {
      const g = gamesMap.get(gameId)
      statsMap.set(gameId, {
        game_id: gameId,
        opponent: g?.opponent ?? 'Unknown',
        game_date: g?.game_date ?? '',
        game_type: g?.game_type ?? '',
        season_id: g?.season_id ?? null,
        in: attendanceByGame.get(gameId) ?? true,
        goals: 0,
        assists: 0,
        turnovers: 0,
      })
    })

    // Overlay event stats
    ;(scoringEvents as any[] ?? []).forEach((e: any) => {
      const stat = statsMap.get(e.game_id)
      if (!stat) return
      if (e.event_type === 'Goal') stat.goals++
      else if (isTurnoverEvent(e.event_type)) stat.turnovers++
    })
    ;(assistEvents as any[] ?? []).forEach((e: any) => {
      const stat = statsMap.get(e.game_id)
      if (stat) stat.assists++
    })

    return [...statsMap.values()].sort((a, b) => b.game_date.localeCompare(a.game_date)) as any[]
  }, [])
  return useApiCall<any[], { playerId: number }>(fn)
}

export function useGetPlayerSeasons() {
  const fn = useCallback(async (params: { playerId: number }) => {
    const { data, error } = await supabase
      .from('season_players')
      .select('season_id, active, is_sub, seasons(id, name, year, organizer)')
      .eq('player_id', params.playerId)
    if (error) throw new Error(error.message)
    // Flatten: return array of season objects with active/is_sub flags
    return (data ?? []).map((row: any) => ({
      ...(row.seasons as object),
      active: row.active,
      is_sub: row.is_sub,
    })) as any[]
  }, [])
  return useApiCall<any[], { playerId: number }>(fn)
}
