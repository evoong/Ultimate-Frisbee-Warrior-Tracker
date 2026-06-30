import { useState, useCallback } from 'react'
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

  const trigger = useCallback(async (params?: P) => {
    setLoading(true)
    setError(null)
    try {
      const result = await fn(params as P)
      setData(result)
      return result
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      return undefined
    } finally {
      setLoading(false)
    }
  }, [fn])

  return { data, loading, error, trigger: trigger as HookResult<T, P>['trigger'] }
}

export function useGetSeasons() {
  const fn = useCallback(async () => {
    const { data, error } = await supabase
      .from('seasons')
      .select('*')
      .order('year', { ascending: false })
    if (error) throw new Error(error.message)
    return data as any[]
  }, [])
  return useApiCall<any[]>(fn)
}

export function useGetAllSeasons() {
  const fn = useCallback(async () => {
    const { data, error } = await supabase
      .from('seasons')
      .select('*')
      .order('year', { ascending: false })
    if (error) throw new Error(error.message)
    return data as any[]
  }, [])
  return useApiCall<any[]>(fn)
}

export function useGetSeasonsMeta() {
  const fn = useCallback(async () => {
    const { data, error } = await supabase
      .from('seasons')
      .select('id, name, year, organizer')
      .order('year', { ascending: false })
    if (error) throw new Error(error.message)
    return data as any[]
  }, [])
  return useApiCall(fn)
}

export function useCreateSeason() {
  const fn = useCallback(async (params: {
    name: string; year: number; location?: string; league_name?: string;
    organizer?: string; default_game_time?: string
  }) => {
    const { data, error } = await supabase
      .from('seasons')
      .insert(params)
      .select()
    if (error) throw new Error(error.message)
    return data?.[0]
  }, [])
  return useApiCall(fn)
}

export function useGetPlayerStats() {
  const fn = useCallback(async (params?: { seasonIds?: number[]; gameIds?: number[] }) => {
    // Fetch events separately without relational joins to avoid ambiguous foreign key
    const { data: events, error: eventsError } = await supabase
      .from('game_events')
      .select('player_id, related_player_id, event_type, game_id')

    if (eventsError) throw new Error(eventsError.message)
    if (!events) return []

    // Fetch games to get season_id
    const { data: games, error: gamesError } = await supabase
      .from('games')
      .select('id, season_id')

    if (gamesError) throw new Error(gamesError.message)

    const gamesMap = new Map(games?.map((g: any) => [g.id, g]) ?? [])

    // Fetch all players
    const { data: players, error: playersError } = await supabase
      .from('players')
      .select('id, display_name')

    if (playersError) throw new Error(playersError.message)

    const playersMap = new Map(players?.map((p: any) => [p.id, p]) ?? [])

    // Filter by seasons or games if specified
    let filtered = events
    let filteredSeasonIds: number[] | null = null
    if (params?.seasonIds && params.seasonIds.length > 0) {
      filteredSeasonIds = params.seasonIds
      filtered = events.filter((e: any) => {
        const game = gamesMap.get(e.game_id)
        return game && params.seasonIds?.includes(game.season_id)
      })
    }
    if (params?.gameIds && params.gameIds.length > 0) {
      filtered = events.filter((e: any) => params.gameIds?.includes(e.game_id))
    }

    // games_played = games the player actually attended (game_attendance table)
    const { data: attendanceRows } = await supabase
      .from('game_attendance')
      .select('game_id, player_id')
    const attendanceMap = new Map<number, Set<number>>() // player_id → Set<game_id>
    ;(attendanceRows ?? []).forEach((r: any) => {
      if (!attendanceMap.has(r.player_id)) attendanceMap.set(r.player_id, new Set())
      attendanceMap.get(r.player_id)!.add(r.game_id)
    })

    // When season/game filter is active, restrict attendance to those games
    const filteredGameIds = filteredSeasonIds
      ? new Set(games?.filter((g: any) => filteredSeasonIds.includes(g.season_id)).map((g: any) => g.id) ?? [])
      : params?.gameIds?.length
        ? new Set(params.gameIds)
        : null

    // Aggregate stats by player
    const statsMap = new Map<number, any>()
    filtered.forEach((event: any) => {
      const playerId = event.player_id
      const playerData = playersMap.get(playerId)
      if (!playerId || !playerData) return

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
      else if (event.event_type === 'Turnover' || event.event_type === 'Throwaway' || event.event_type === 'Drop') stats.turnovers++

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
      const gamesPlayed = filteredGameIds
        ? [...attended].filter(gid => filteredGameIds.has(gid)).length
        : attended.size
      return { ...s, games_played: gamesPlayed, ga_rank: 0 }
    })

    // Sort by goals + assists descending
    result.sort((a: any, b: any) => (b.goals + b.assists) - (a.goals + a.assists))

    // Add ranking
    result.forEach((s: any, i: number) => { s.ga_rank = i + 1 })

    return result
  }, [])
  return useApiCall<any[], { seasonIds?: number[]; gameIds?: number[] }>(fn)
}

export function useGetCumulativeStats() {
  const fn = useCallback(async (params?: { seasonId?: number }) => {
    // Fetch events without relational joins to avoid ambiguous foreign key
    const { data: events, error: eventsError } = await supabase
      .from('game_events')
      .select('player_id, related_player_id, event_type, game_id')

    if (eventsError) throw new Error(eventsError.message)
    if (!events) return []

    // Fetch games
    const { data: games, error: gamesError } = await supabase
      .from('games')
      .select('id, opponent, game_date, season_id')

    if (gamesError) throw new Error(gamesError.message)

    const gamesMap = new Map(games?.map((g: any) => [g.id, g]) ?? [])

    // Fetch players
    const { data: players, error: playersError } = await supabase
      .from('players')
      .select('id, display_name')

    if (playersError) throw new Error(playersError.message)

    const playersMap = new Map(players?.map((p: any) => [p.id, p]) ?? [])

    // Filter by season if specified
    let filtered = events
    if (params?.seasonId != null) {
      filtered = events.filter((e: any) => {
        const game = gamesMap.get(e.game_id)
        return game && game.season_id === params.seasonId
      })
    }

    const rows: any[] = []
    filtered.forEach((e: any) => {
      const game = gamesMap.get(e.game_id)
      const isTurnover = e.event_type === 'Turnover' || e.event_type === 'Throwaway' || e.event_type === 'Drop'

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
  return useApiCall<any[], { seasonId?: number }>(fn)
}
