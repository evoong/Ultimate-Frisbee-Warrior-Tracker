import { useState, useCallback, useRef } from 'react'
import { supabase } from '../../lib/supabase'

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

export function useGetGames() {
  const fn = useCallback(async (params?: { organizationId: number | null; seasonIds?: number[] }) => {
    let query = supabase.from('games').select('*').eq('organization_id', params?.organizationId).order('game_date', { ascending: false })
    if (params?.seasonIds && params.seasonIds.length > 0) {
      query = query.in('season_id', params.seasonIds)
    }
    const { data, error } = await query
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) return []

    // Compute live scores from game_events (our_score/their_score in DB are not updated)
    const gameIds = data.map((g: any) => g.id)
    const { data: goalEvents } = await supabase
      .from('game_events')
      .select('game_id, event_type')
      .in('game_id', gameIds)
      .in('event_type', ['Goal', 'Opponent Goal'])

    const scoreMap = new Map<number, { our: number; their: number }>()
    ;(goalEvents ?? []).forEach((e: any) => {
      if (!scoreMap.has(e.game_id)) scoreMap.set(e.game_id, { our: 0, their: 0 })
      const s = scoreMap.get(e.game_id)!
      if (e.event_type === 'Goal') s.our++
      else s.their++
    })

    return data.map((g: any) => {
      const s = scoreMap.get(g.id)
      return s ? { ...g, our_score: s.our, their_score: s.their } : g
    }) as any[]
  }, [])
  return useApiCall<any[], { organizationId: number | null; seasonIds?: number[] }>(fn)
}

// Every game we play is also a matchup in the league schedule. Database
// triggers (010_league_tracking.sql) resolve games.opponent text to a
// league_teams row and maintain the paired league_games row on every
// insert/update/delete, so all creation paths (this hook, Jam calendar
// sync, conflict resolution) stay consistent without app plumbing.
export function useCreateGame() {
  const fn = useCallback(async (params: { organizationId: number | null; opponent: string; game_date: string; game_time: string; game_type: string; season_id?: number | null; notes?: string }) => {
    const { organizationId, ...rest } = params
    const { data, error } = await supabase
      .from('games')
      .insert({ ...rest, organization_id: organizationId })
      .select()
    if (error) throw new Error(error.message)
    return data?.[0]
  }, [])
  return useApiCall(fn)
}

export function useUpdateGame() {
  const fn = useCallback(async (params: { gameId: number; notes?: string; outcome_override?: string | null; result?: string }) => {
    const { gameId, ...body } = params
    const { data, error } = await supabase
      .from('games')
      .update(body)
      .eq('id', gameId)
      .select()
    if (error) throw new Error(error.message)
    return data?.[0]
  }, [])
  return useApiCall(fn)
}

export function useDeleteGame() {
  const fn = useCallback(async (params: { gameId: number }) => {
    const { data, error } = await supabase
      .from('games')
      .delete()
      .eq('id', params.gameId)
      .select()
    if (error) throw new Error(error.message)
    return data?.[0]
  }, [])
  return useApiCall(fn)
}

export function useGetLineups() {
  const fn = useCallback(async (params: { gameId: number }) => {
    // Join players so the UI can render names/positions directly. Ordered
    // by sort_order so the list reflects manual drag-reordering rather than
    // insertion order (which Postgres doesn't guarantee anyway).
    const { data, error } = await supabase
      .from('game_lineups')
      .select('*, players(display_name, position, gender_match, photo_url)')
      .eq('game_id', params.gameId)
      .order('sort_order')
    if (error) throw new Error(error.message)
    return ((data ?? []) as any[]).map((row: any) => ({
      ...row,
      display_name: row.players?.display_name ?? null,
      position: row.players?.position ?? null,
      gender_match: row.players?.gender_match ?? null,
      photo_url: row.players?.photo_url ?? null,
    }))
  }, [])
  return useApiCall<any[], { gameId: number }>(fn)
}

export function useAddToLineup() {
  const fn = useCallback(async (params: { organizationId: number | null; gameId: number; player_id: number; lineup_name?: string; seasonId?: number | null; sortOrder?: number }) => {
    const { data, error } = await supabase
      .from('game_lineups')
      .insert({
        organization_id: params.organizationId,
        game_id: params.gameId,
        player_id: params.player_id,
        lineup_name: params.lineup_name ?? 'Starting',
        ...(params.sortOrder != null ? { sort_order: params.sortOrder } : {}),
      })
      .select()
    if (error) throw new Error(error.message)

    // Also join the game's season roster, same as useCreatePlayerForGame:
    // without this a player added straight to a lineup (rather than through
    // Roster) stays invisible to season-scoped attendance/roster filters.
    // ignoreDuplicates since they may already be a member of this season.
    if (params.seasonId) {
      const { error: spError } = await supabase
        .from('season_players')
        .upsert({ organization_id: params.organizationId, player_id: params.player_id, season_id: params.seasonId }, { onConflict: 'season_id,player_id', ignoreDuplicates: true })
      if (spError) throw new Error(spError.message)
    }
    // See useCreatePlayerForGame (players.ts): a row for this specific game
    // so the Attendance tab (which lists existing rows, not the roster)
    // shows them immediately rather than only from the next game onward.
    const { error: gaError } = await supabase
      .from('game_attendance')
      .upsert({ organization_id: params.organizationId, game_id: params.gameId, player_id: params.player_id, in: true }, { onConflict: 'game_id,player_id', ignoreDuplicates: true })
    if (gaError) throw new Error(gaError.message)
    return data?.[0]
  }, [])
  return useApiCall(fn)
}

export function useUpdateLineupSortOrder() {
  const fn = useCallback(async (params: { id: number; sortOrder: number }) => {
    const { data, error } = await supabase
      .from('game_lineups')
      .update({ sort_order: params.sortOrder })
      .eq('id', params.id)
      .select()
    if (error) throw new Error(error.message)
    return data?.[0]
  }, [])
  return useApiCall(fn)
}

export function useRemoveFromLineup() {
  const fn = useCallback(async (params: { gameId: number; playerId: number; lineup_name?: string }) => {
    let query = supabase
      .from('game_lineups')
      .delete()
      .eq('game_id', params.gameId)
      .eq('player_id', params.playerId)

    if (params.lineup_name) {
      query = query.eq('lineup_name', params.lineup_name)
    }

    const { data, error } = await query.select()
    if (error) throw new Error(error.message)
    return data?.[0]
  }, [])
  return useApiCall(fn)
}

export function useUpdateLineupRole() {
  const fn = useCallback(async (params: { id: number; role: string | null }) => {
    const { error } = await supabase.from('game_lineups').update({ role: params.role }).eq('id', params.id)
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { id: number; role: string | null }>(fn)
}

export type LineupGroup = { id: number; lineup_name: string; sort_order: number }

export function useGetLineupGroups() {
  const fn = useCallback(async (params: { gameId: number }) => {
    const { data, error } = await supabase
      .from('game_lineup_groups')
      .select('id, lineup_name, sort_order')
      .eq('game_id', params.gameId)
      .order('sort_order')
    if (error) throw new Error(error.message)
    return (data ?? []) as LineupGroup[]
  }, [])
  return useApiCall<LineupGroup[], { gameId: number }>(fn)
}

export function useCreateLineupGroup() {
  const fn = useCallback(async (params: { organizationId: number | null; gameId: number; lineupName: string; sortOrder: number }) => {
    const { data, error } = await supabase
      .from('game_lineup_groups')
      .upsert(
        { organization_id: params.organizationId, game_id: params.gameId, lineup_name: params.lineupName, sort_order: params.sortOrder },
        { onConflict: 'game_id,lineup_name', ignoreDuplicates: true },
      )
      .select()
    if (error) throw new Error(error.message)
    return data?.[0] as LineupGroup | undefined
  }, [])
  return useApiCall<LineupGroup | undefined, { organizationId: number | null; gameId: number; lineupName: string; sortOrder: number }>(fn)
}

// Renaming a group must also repoint its players: game_lineups.lineup_name
// is a plain text match against game_lineup_groups.lineup_name, not a real
// foreign key, so both rows need updating in the same action.
export function useRenameLineupGroup() {
  const fn = useCallback(async (params: { gameId: number; groupId: number; oldName: string; newName: string }) => {
    const { error: groupError } = await supabase
      .from('game_lineup_groups')
      .update({ lineup_name: params.newName })
      .eq('id', params.groupId)
    if (groupError) throw new Error(groupError.message)
    const { error: playersError } = await supabase
      .from('game_lineups')
      .update({ lineup_name: params.newName })
      .eq('game_id', params.gameId)
      .eq('lineup_name', params.oldName)
    if (playersError) throw new Error(playersError.message)
    return true
  }, [])
  return useApiCall<boolean, { gameId: number; groupId: number; oldName: string; newName: string }>(fn)
}

export function useReorderLineupGroups() {
  const fn = useCallback(async (params: { updates: { id: number; sortOrder: number }[] }) => {
    await Promise.all(params.updates.map(u =>
      supabase.from('game_lineup_groups').update({ sort_order: u.sortOrder }).eq('id', u.id)
    ))
    return true
  }, [])
  return useApiCall<boolean, { updates: { id: number; sortOrder: number }[] }>(fn)
}

// Deleting a lineup group removes its players from game_lineups too — an
// empty group with nothing assigned to it has nothing left to keep.
export function useDeleteLineupGroup() {
  const fn = useCallback(async (params: { gameId: number; lineupName: string; groupId: number }) => {
    const { error: playersError } = await supabase
      .from('game_lineups')
      .delete()
      .eq('game_id', params.gameId)
      .eq('lineup_name', params.lineupName)
    if (playersError) throw new Error(playersError.message)
    const { error: groupError } = await supabase
      .from('game_lineup_groups')
      .delete()
      .eq('id', params.groupId)
    if (groupError) throw new Error(groupError.message)
    return true
  }, [])
  return useApiCall<boolean, { gameId: number; lineupName: string; groupId: number }>(fn)
}
