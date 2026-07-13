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

// Finds the season's game immediately before this one (by date, then time to
// break same-day ties) and, if it has lineup groups set up, returns that
// structure so a brand-new game's lineups can be auto-seeded from it (see
// Schedule.tsx's ensureLineupSeeded). Returns null if there's no earlier
// game in the season, or the earlier one was never lineup'd.
export function useGetPreviousGameLineups() {
  const fn = useCallback(async (params: { organizationId: number | null; seasonId: number; gameId: number }) => {
    const { data: seasonGames, error: gamesError } = await supabase
      .from('games')
      .select('id, game_date, game_time')
      .eq('organization_id', params.organizationId)
      .eq('season_id', params.seasonId)
    if (gamesError) throw new Error(gamesError.message)

    const sorted = ((seasonGames ?? []) as { id: number; game_date: string; game_time: string | null }[])
      .sort((a, b) => `${a.game_date}T${a.game_time ?? '00:00:00'}`.localeCompare(`${b.game_date}T${b.game_time ?? '00:00:00'}`))
    const idx = sorted.findIndex(g => g.id === params.gameId)
    const previousGame = idx > 0 ? sorted[idx - 1] : null
    if (!previousGame) return null

    const { data: groups, error: groupsError } = await supabase
      .from('game_lineup_groups')
      .select('lineup_name, sort_order')
      .eq('game_id', previousGame.id)
      .order('sort_order')
    if (groupsError) throw new Error(groupsError.message)
    if (!groups || groups.length === 0) return null

    const { data: entries, error: entriesError } = await supabase
      .from('game_lineups')
      .select('player_id, lineup_name, sort_order')
      .eq('game_id', previousGame.id)
      .order('sort_order')
    if (entriesError) throw new Error(entriesError.message)

    return {
      groups: groups as { lineup_name: string; sort_order: number }[],
      entries: (entries ?? []) as { player_id: number; lineup_name: string; sort_order: number }[],
    }
  }, [])
  return useApiCall<
    { groups: { lineup_name: string; sort_order: number }[]; entries: { player_id: number; lineup_name: string; sort_order: number }[] } | null,
    { organizationId: number | null; seasonId: number; gameId: number }
  >(fn)
}

export function useAddToLineup() {
  const fn = useCallback(async (params: { organizationId: number | null; gameId: number; player_id: number; lineup_name?: string; seasonId?: number | null; sortOrder?: number; role?: string | null }) => {
    const { data, error } = await supabase
      .from('game_lineups')
      .insert({
        organization_id: params.organizationId,
        game_id: params.gameId,
        player_id: params.player_id,
        lineup_name: params.lineup_name ?? 'Starting',
        ...(params.sortOrder != null ? { sort_order: params.sortOrder } : {}),
        ...(params.role !== undefined ? { role: params.role } : {}),
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
    // so attendance (derived from lineup membership) reflects them
    // immediately. Must actually overwrite on conflict (not
    // ignoreDuplicates): a stale pre-existing row (e.g. from the
    // game-creation backfill trigger, or a previous removal) defaulting to
    // `in: false` would otherwise survive untouched, leaving them "in a
    // lineup" but not attending.
    const { error: gaError } = await supabase
      .from('game_attendance')
      .upsert({ organization_id: params.organizationId, game_id: params.gameId, player_id: params.player_id, in: true }, { onConflict: 'game_id,player_id' })
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

// Moves an existing lineup entry to a different lineup group (drag-between-
// lineups), updating in place rather than delete+re-insert so the row's id
// and role assignment survive the move.
export function useMoveLineupEntry() {
  const fn = useCallback(async (params: { id: number; lineupName: string; sortOrder: number }) => {
    const { data, error } = await supabase
      .from('game_lineups')
      .update({ lineup_name: params.lineupName, sort_order: params.sortOrder })
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

export type LineupTemplate = { id: number; name: string }

export function useGetLineupTemplates() {
  const fn = useCallback(async (params: { organizationId: number | null; seasonId: number }) => {
    const { data, error } = await supabase
      .from('lineup_templates')
      .select('id, name')
      .eq('organization_id', params.organizationId)
      .eq('season_id', params.seasonId)
      .order('name')
    if (error) throw new Error(error.message)
    return data as LineupTemplate[]
  }, [])
  return useApiCall<LineupTemplate[], { organizationId: number | null; seasonId: number }>(fn)
}

export function useGetLineupTemplateDetail() {
  const fn = useCallback(async (params: { templateId: number }) => {
    const { data: groups, error: groupsError } = await supabase
      .from('lineup_template_groups')
      .select('lineup_name, sort_order')
      .eq('template_id', params.templateId)
      .order('sort_order')
    if (groupsError) throw new Error(groupsError.message)
    const { data: players, error: playersError } = await supabase
      .from('lineup_template_players')
      .select('lineup_name, player_id, sort_order, role')
      .eq('template_id', params.templateId)
      .order('sort_order')
    if (playersError) throw new Error(playersError.message)
    return {
      groups: (groups ?? []) as { lineup_name: string; sort_order: number }[],
      players: (players ?? []) as { lineup_name: string; player_id: number; sort_order: number; role: string | null }[],
    }
  }, [])
  return useApiCall<
    { groups: { lineup_name: string; sort_order: number }[]; players: { lineup_name: string; player_id: number; sort_order: number; role: string | null }[] },
    { templateId: number }
  >(fn)
}

// Saving is "create or overwrite by name": a template is identified by
// (season_id, name), so re-saving under a name that already exists for
// this season replaces its groups/players rather than erroring or
// duplicating. Groups/players are matched by lineup_name text, not a
// group foreign key (same shape as game_lineup_groups/game_lineups), so
// both child tables need clearing explicitly before the fresh insert.
export function useSaveLineupTemplate() {
  const fn = useCallback(async (params: {
    organizationId: number | null
    seasonId: number
    name: string
    groups: { lineup_name: string; sort_order: number }[]
    players: { lineup_name: string; player_id: number; sort_order: number; role: string | null }[]
  }) => {
    const { data: templateRows, error: templateError } = await supabase
      .from('lineup_templates')
      .upsert({ organization_id: params.organizationId, season_id: params.seasonId, name: params.name }, { onConflict: 'season_id,name' })
      .select()
    if (templateError) throw new Error(templateError.message)
    const templateId = templateRows?.[0]?.id
    if (!templateId) throw new Error('Failed to save lineup template')

    const { error: delGroupsError } = await supabase.from('lineup_template_groups').delete().eq('template_id', templateId)
    if (delGroupsError) throw new Error(delGroupsError.message)
    const { error: delPlayersError } = await supabase.from('lineup_template_players').delete().eq('template_id', templateId)
    if (delPlayersError) throw new Error(delPlayersError.message)

    if (params.groups.length > 0) {
      const { error: groupsError } = await supabase.from('lineup_template_groups').insert(
        params.groups.map(g => ({ template_id: templateId, organization_id: params.organizationId, lineup_name: g.lineup_name, sort_order: g.sort_order }))
      )
      if (groupsError) throw new Error(groupsError.message)
    }
    if (params.players.length > 0) {
      const { error: playersError } = await supabase.from('lineup_template_players').insert(
        params.players.map(p => ({ template_id: templateId, organization_id: params.organizationId, lineup_name: p.lineup_name, player_id: p.player_id, sort_order: p.sort_order, role: p.role }))
      )
      if (playersError) throw new Error(playersError.message)
    }
    return templateId as number
  }, [])
  return useApiCall<number, {
    organizationId: number | null
    seasonId: number
    name: string
    groups: { lineup_name: string; sort_order: number }[]
    players: { lineup_name: string; player_id: number; sort_order: number; role: string | null }[]
  }>(fn)
}

export function useDeleteLineupTemplate() {
  const fn = useCallback(async (params: { templateId: number }) => {
    const { error } = await supabase.from('lineup_templates').delete().eq('id', params.templateId)
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { templateId: number }>(fn)
}
