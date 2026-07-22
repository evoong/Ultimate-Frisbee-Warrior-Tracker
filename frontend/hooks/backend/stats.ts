import { useState, useCallback, useRef } from 'react'
import { supabase } from '../../lib/supabase'
import { isTurnoverEvent } from '../../lib/eventUtils'
import { isPastGame } from '../../lib/gameOrder'

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

export function useGetSeasons() {
  const fn = useCallback(async (params: { organizationId: number | null }) => {
    const { data, error } = await supabase
      .from('seasons')
      .select('*')
      .eq('organization_id', params.organizationId)
      .order('year', { ascending: false })
    if (error) throw new Error(error.message)
    return data as any[]
  }, [])
  return useApiCall<any[], { organizationId: number | null }>(fn)
}

export function useGetAllSeasons() {
  const fn = useCallback(async (params: { organizationId: number | null }) => {
    const { data, error } = await supabase
      .from('seasons')
      .select('*')
      .eq('organization_id', params.organizationId)
      .order('year', { ascending: false })
    if (error) throw new Error(error.message)
    return data as any[]
  }, [])
  return useApiCall<any[], { organizationId: number | null }>(fn)
}

export function useGetSeasonsMeta() {
  const fn = useCallback(async (params: { organizationId: number | null }) => {
    const { data, error } = await supabase
      .from('seasons')
      .select('id, name, year, organizer, location')
      .eq('organization_id', params.organizationId)
      .order('year', { ascending: false })
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as { name: string | null; year: number | null; organizer: string | null; location: string | null }[]
    const uniq = <T,>(vals: (T | null)[]) => [...new Set(vals.filter((v): v is T => v != null && v !== ('' as unknown as T)))]
    return {
      organizers: uniq(rows.map(r => r.organizer)),
      names: uniq(rows.map(r => r.name)),
      years: uniq(rows.map(r => r.year)).sort((a, b) => b - a),
      locations: uniq(rows.map(r => r.location)),
    }
  }, [])
  return useApiCall<{ organizers: any[]; names: any[]; years: any[]; locations: any[] }, { organizationId: number | null }>(fn)
}

export function useCreateSeason() {
  const fn = useCallback(async (params: {
    organizationId: number | null;
    name: string; year: number; location?: string; league_name?: string;
    organizer?: string; default_game_time?: string
  }) => {
    const { organizationId, ...rest } = params
    const { data, error } = await supabase
      .from('seasons')
      .insert({ ...rest, organization_id: organizationId })
      .select()
    if (error) throw new Error(error.message)
    return data?.[0]
  }, [])
  return useApiCall(fn)
}

export function useUpdateSeason() {
  const fn = useCallback(async (params: {
    seasonId: number; name?: string; year?: number; organizer?: string | null
    location?: string | null; league_name?: string | null; default_game_time?: string | null
    start_date?: string | null; end_date?: string | null
  }) => {
    const { seasonId, ...body } = params
    const { data, error } = await supabase.from('seasons').update(body).eq('id', seasonId).select()
    if (error) throw new Error(error.message)
    return data?.[0]
  }, [])
  return useApiCall(fn)
}

export function useGetPlayerStats() {
  const fn = useCallback(async (params: { organizationId: number | null; seasonIds?: number[]; gameIds?: number[] }) => {
    // Resolve the games in scope first so events/attendance can be filtered
    // server-side (supabase caps unfiltered fetches at 1000 rows).
    let gamesQuery = supabase.from('games').select('id, season_id, game_date, game_time').eq('organization_id', params.organizationId)
    if (params?.seasonIds && params.seasonIds.length > 0) {
      gamesQuery = gamesQuery.in('season_id', params.seasonIds)
    }
    const { data: games, error: gamesError } = await gamesQuery
    if (gamesError) throw new Error(gamesError.message)

    const scopedGameIds = params?.gameIds && params.gameIds.length > 0
      ? params.gameIds
      : params?.seasonIds && params.seasonIds.length > 0
        ? (games ?? []).map((g: any) => g.id)
        : null

    // games_played (and the G/gm, A/gm averages derived from it) should only
    // count games that have actually happened, not ones merely marked
    // attending in advance. Same calendar-day "past" definition as
    // Schedule's Upcoming/Played split (see lib/gameOrder.ts).
    const playedGameIds = new Set((games ?? []).filter((g: any) => isPastGame(g)).map((g: any) => g.id))

    let eventsQuery = supabase
      .from('game_events')
      .select('player_id, related_player_id, event_type, game_id')
    if (scopedGameIds) eventsQuery = eventsQuery.in('game_id', scopedGameIds)
    const { data: events, error: eventsError } = await eventsQuery
    if (eventsError) throw new Error(eventsError.message)
    if (!events) return []

    // Fetch all players
    const { data: players, error: playersError } = await supabase
      .from('players')
      .select('id, display_name')
      .eq('organization_id', params.organizationId)

    if (playersError) throw new Error(playersError.message)

    const playersMap = new Map(players?.map((p: any) => [p.id, p]) ?? [])

    const filtered = events

    // games_played = games the player was placed in a lineup for. Read
    // straight from game_lineups (the source of truth attendance is derived
    // from — see CLAUDE.md's "Lineups (attendance is derived from them)")
    // rather than game_attendance, so this can't drift from what the
    // Lineups tab actually shows even if attendance sync ever lags.
    let lineupQuery = supabase
      .from('game_lineups')
      .select('game_id, player_id')
    if (scopedGameIds) lineupQuery = lineupQuery.in('game_id', scopedGameIds)
    const { data: lineupRows } = await lineupQuery
    const attendanceMap = new Map<number, Set<number>>() // player_id → Set<game_id>
    ;(lineupRows ?? []).forEach((r: any) => {
      if (!attendanceMap.has(r.player_id)) attendanceMap.set(r.player_id, new Set())
      attendanceMap.get(r.player_id)!.add(r.game_id)
    })

    const filteredGameIds = scopedGameIds ? new Set(scopedGameIds) : null

    // Aggregate stats by player
    const statsMap = new Map<number, any>()
    filtered.forEach((event: any) => {
      const playerId = event.player_id
      const playerData = playerId ? playersMap.get(playerId) : undefined

      // Credit the scorer (goals/turnovers) only when the scorer is known.
      // This does NOT gate the assist credit below: a goal can have no
      // recorded scorer (e.g. an unregistered teammate scored) while still
      // having a recorded assister, and that assist should still count.
      if (playerId && playerData) {
        if (!statsMap.has(playerId)) {
          statsMap.set(playerId, {
            player_id: playerId,
            player_name: playerData.display_name,
            goals: 0,
            assists: 0,
            turnovers: 0,
            games_played: new Set<number>(),
          })
        }

        const stats = statsMap.get(playerId)!
        stats.games_played.add(event.game_id)

        if (event.event_type === 'Goal') stats.goals++
        else if (isTurnoverEvent(event.event_type)) stats.turnovers++
      }

      // Credit assist to the related player on a Goal
      if (event.event_type === 'Goal' && event.related_player_id) {
        const assisterId = event.related_player_id
        const assisterData = playersMap.get(assisterId)
        if (assisterData) {
          if (!statsMap.has(assisterId)) {
            statsMap.set(assisterId, {
              player_id: assisterId,
              player_name: assisterData.display_name,
              goals: 0,
              assists: 0,
              turnovers: 0,
              games_played: new Set<number>(),
            })
          }
          const assisterStats = statsMap.get(assisterId)!
          assisterStats.assists++
          assisterStats.games_played.add(event.game_id)
        }
      }
    })

    // Convert to array and calculate additional fields
    const result = Array.from(statsMap.values()).map((s: any) => {
      const attended = attendanceMap.get(s.player_id) ?? new Set<number>()
      const gamesPlayed = [...attended].filter(gid => playedGameIds.has(gid) && (!filteredGameIds || filteredGameIds.has(gid))).length
      return { ...s, games_played: gamesPlayed, ga_rank: 0 }
    })

    // Sort by goals + assists descending
    result.sort((a: any, b: any) => (b.goals + b.assists) - (a.goals + a.assists))

    // Add ranking
    result.forEach((s: any, i: number) => { s.ga_rank = i + 1 })

    return result
  }, [])
  return useApiCall<any[], { organizationId: number | null; seasonIds?: number[]; gameIds?: number[] }>(fn)
}

export function useGetCumulativeStats() {
  const fn = useCallback(async (params: { organizationId: number | null; seasonId?: number }) => {
    // Fetch the season's games first so events can be filtered server-side
    // (supabase caps unfiltered fetches at 1000 rows)
    let gamesQuery = supabase.from('games').select('id, opponent, game_date, season_id').eq('organization_id', params.organizationId)
    if (params?.seasonId != null) gamesQuery = gamesQuery.eq('season_id', params.seasonId)
    const { data: games, error: gamesError } = await gamesQuery
    if (gamesError) throw new Error(gamesError.message)

    const gamesMap = new Map(games?.map((g: any) => [g.id, g]) ?? [])

    let eventsQuery = supabase
      .from('game_events')
      .select('player_id, related_player_id, event_type, game_id')
    if (params?.seasonId != null) {
      eventsQuery = eventsQuery.in('game_id', (games ?? []).map((g: any) => g.id))
    }
    const { data: events, error: eventsError } = await eventsQuery
    if (eventsError) throw new Error(eventsError.message)
    if (!events) return []

    // Fetch players
    const { data: players, error: playersError } = await supabase
      .from('players')
      .select('id, display_name')
      .eq('organization_id', params.organizationId)

    if (playersError) throw new Error(playersError.message)

    const playersMap = new Map(players?.map((p: any) => [p.id, p]) ?? [])

    const filtered = events

    const rows: any[] = []
    filtered.forEach((e: any) => {
      const game = gamesMap.get(e.game_id)
      const isTurnover = isTurnoverEvent(e.event_type)

      // Row for the primary player (scorer / turnover player)
      if (e.player_id && (e.event_type === 'Goal' || isTurnover)) {
        rows.push({
          game_id: game?.id,
          opponent: game?.opponent,
          game_date: game?.game_date,
          player_id: e.player_id,
          player_name: playersMap.get(e.player_id)?.display_name,
          goals: e.event_type === 'Goal' ? 1 : 0,
          assists: 0,
          turnovers: isTurnover ? 1 : 0,
        })
      }

      // Separate row for the assister (related_player_id on a Goal)
      if (e.event_type === 'Goal' && e.related_player_id) {
        rows.push({
          game_id: game?.id,
          opponent: game?.opponent,
          game_date: game?.game_date,
          player_id: e.related_player_id,
          player_name: playersMap.get(e.related_player_id)?.display_name,
          goals: 0,
          assists: 1,
          turnovers: 0,
        })
      }
    })
    return rows
  }, [])
  return useApiCall<any[], { organizationId: number | null; seasonId?: number }>(fn)
}
