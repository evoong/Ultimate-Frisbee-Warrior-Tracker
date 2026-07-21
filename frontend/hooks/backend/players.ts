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
  const fn = useCallback(async (params: { organizationId: number | null; gameId: number; seasonId?: number | null; display_name: string; position?: string; gender_match?: string; lineupName?: string }) => {
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
      .insert({ organization_id: params.organizationId, game_id: params.gameId, player_id: playerId, lineup_name: params.lineupName ?? 'Starting' })
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
    return data?.[0]
  }, [])
  return useApiCall(fn)
}

export function useAddPlayerToGame() {
  const fn = useCallback(async (params: { organizationId: number | null; gameId: number; playerId: number; seasonId?: number | null; lineupName?: string }) => {
    const { data, error } = await supabase
      .from('game_lineups')
      .insert({ organization_id: params.organizationId, game_id: params.gameId, player_id: params.playerId, lineup_name: params.lineupName ?? 'Starting' })
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
    // Every game in every season this player belongs to appears here (not
    // just ones they were placed in a lineup for), so Roster's per-game
    // breakdown can show — and let you toggle — attendance for a game they
    // haven't been added to yet. `in` reflects live game_lineups membership;
    // attendance has no separate backing table (see useGetGameAttendance).
    const { data: seasonRows, error: seasonError } = await supabase
      .from('season_players')
      .select('season_id')
      .eq('player_id', params.playerId)
    if (seasonError) throw new Error(seasonError.message)
    const seasonIds = [...new Set(((seasonRows ?? []) as { season_id: number }[]).map(r => r.season_id))]
    if (seasonIds.length === 0) return []

    const { data: games, error: gamesError } = await supabase
      .from('games')
      .select('id, opponent, game_date, game_time, game_type, season_id')
      .in('season_id', seasonIds)
    if (gamesError) throw new Error(gamesError.message)
    const gameIds = (games ?? []).map((g: any) => g.id)
    if (gameIds.length === 0) return []

    const { data: lineupRows, error: lineupError } = await supabase
      .from('game_lineups')
      .select('game_id')
      .eq('player_id', params.playerId)
      .in('game_id', gameIds)
    if (lineupError) throw new Error(lineupError.message)
    const inGameIds = new Set(((lineupRows ?? []) as { game_id: number }[]).map(r => r.game_id))

    // Fetch events where this player scored
    const { data: scoringEvents, error } = await supabase
      .from('game_events')
      .select('game_id, event_type')
      .eq('player_id', params.playerId)
      .in('game_id', gameIds)
    if (error) throw new Error(error.message)

    // Fetch Goal events where this player assisted
    const { data: assistEvents, error: assistError } = await supabase
      .from('game_events')
      .select('game_id, event_type')
      .eq('related_player_id', params.playerId)
      .eq('event_type', 'Goal')
      .in('game_id', gameIds)
    if (assistError) throw new Error(assistError.message)

    // Seed every season game with zeroes so games with no recorded events still appear
    const statsMap = new Map<number, any>()
    ;(games ?? []).forEach((g: any) => {
      statsMap.set(g.id, {
        game_id: g.id,
        opponent: g.opponent ?? 'Unknown',
        game_date: g.game_date ?? '',
        game_time: g.game_time ?? null,
        game_type: g.game_type ?? '',
        season_id: g.season_id ?? null,
        in: inGameIds.has(g.id),
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

// Roster's per-game breakdown lets you toggle whether a player was in a
// specific game's lineup directly, since attendance has no separate write
// path anymore (see useGetGameAttendance) — this IS how you edit attendance
// now. Checking someone "in" places them in the game's first lineup group
// (by sort_order), creating one first if the game has none yet, same
// fallback other mid-game adds use (see Schedule.tsx's defaultLineupName).
// Unchecking removes every lineup entry they have for that game.
export function useSetGameAttendance() {
  const fn = useCallback(async (params: { organizationId: number | null; gameId: number; playerId: number; seasonId: number | null; attending: boolean }) => {
    if (!params.attending) {
      const { error } = await supabase
        .from('game_lineups')
        .delete()
        .eq('game_id', params.gameId)
        .eq('player_id', params.playerId)
      if (error) throw new Error(error.message)
      return
    }

    const { data: groups, error: groupsError } = await supabase
      .from('game_lineup_groups')
      .select('lineup_name')
      .eq('game_id', params.gameId)
      .order('sort_order')
      .limit(1)
    if (groupsError) throw new Error(groupsError.message)

    let lineupName = groups?.[0]?.lineup_name as string | undefined
    if (!lineupName) {
      const { data: newGroup, error: createError } = await supabase
        .from('game_lineup_groups')
        .insert({ game_id: params.gameId, organization_id: params.organizationId, lineup_name: 'Line 1', sort_order: 0 })
        .select()
      if (createError) throw new Error(createError.message)
      lineupName = newGroup?.[0]?.lineup_name ?? 'Line 1'
    }

    const { error: insertError } = await supabase
      .from('game_lineups')
      .upsert(
        { organization_id: params.organizationId, game_id: params.gameId, player_id: params.playerId, lineup_name: lineupName },
        { onConflict: 'game_id,player_id,lineup_name', ignoreDuplicates: true }
      )
    if (insertError) throw new Error(insertError.message)

    // Also join the game's season roster, same as useAddToLineup: without
    // this a player marked "in" straight from Roster (rather than through
    // the game's own Lineups tab) stays invisible to season-scoped filters.
    if (params.seasonId) {
      const { error: spError } = await supabase
        .from('season_players')
        .upsert(
          { organization_id: params.organizationId, player_id: params.playerId, season_id: params.seasonId },
          { onConflict: 'season_id,player_id', ignoreDuplicates: true }
        )
      if (spError) throw new Error(spError.message)
    }
  }, [])
  return useApiCall<void, { organizationId: number | null; gameId: number; playerId: number; seasonId: number | null; attending: boolean }>(fn)
}

// Adds one or more existing players to a season they aren't yet part of.
// Roster's "Manage Roster" dialog uses this to apply newly-checked players
// from its batch checklist. ignoreDuplicates so re-adding someone who's
// already a member of the target season leaves their existing Player/Sub
// status untouched, same convention as useAddPlayerToGame.
export function useCopyPlayersToSeason() {
  const fn = useCallback(async (params: { organizationId: number | null; playerIds: number[]; targetSeasonId: number; isSub: boolean }) => {
    if (params.playerIds.length === 0) return
    const rows = params.playerIds.map(playerId => ({
      organization_id: params.organizationId, player_id: playerId, season_id: params.targetSeasonId, is_sub: params.isSub,
    }))
    const { error } = await supabase
      .from('season_players')
      .upsert(rows, { onConflict: 'season_id,player_id', ignoreDuplicates: true })
    if (error) throw new Error(error.message)
  }, [])
  return useApiCall<void, { organizationId: number | null; playerIds: number[]; targetSeasonId: number; isSub: boolean }>(fn)
}

// Inverse of useCopyPlayersToSeason: bulk-removes players from a season,
// used to apply newly-unchecked players from the same batch checklist. Only
// deletes the season_players membership row, not the player itself.
export function useRemovePlayersFromSeason() {
  const fn = useCallback(async (params: { seasonId: number; playerIds: number[] }) => {
    if (params.playerIds.length === 0) return
    const { error } = await supabase
      .from('season_players')
      .delete()
      .eq('season_id', params.seasonId)
      .in('player_id', params.playerIds)
    if (error) throw new Error(error.message)
  }, [])
  return useApiCall<void, { seasonId: number; playerIds: number[] }>(fn)
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
