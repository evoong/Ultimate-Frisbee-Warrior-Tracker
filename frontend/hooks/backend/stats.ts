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
    return [] as any[]
  }, [])
  return useApiCall<any[]>(fn)
}

export function useGetAllSeasons() {
  const fn = useCallback(async () => {
    return [] as any[]
  }, [])
  return useApiCall<any[]>(fn)
}

export function useGetSeasonsMeta() {
  const fn = useCallback(async () => {
    return [] as any[]
  }, [])
  return useApiCall(fn)
}

export function useCreateSeason() {
  const fn = useCallback(async (params: {
    name: string; year: number; location?: string; league_name?: string;
    organizer?: string; default_game_time?: string
  }) => {
    return {} as any
  }, [])
  return useApiCall(fn)
}

export function useGetPlayerStats() {
  const fn = useCallback(async (params?: { seasonIds?: number[]; gameIds?: number[] }) => {
    // Fetch events separately without relational joins to avoid ambiguous foreign key
    const { data: events, error: eventsError } = await supabase
      .from('game_events')
      .select('player_id, event_type, game_id')

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
    if (params?.seasonIds && params.seasonIds.length > 0) {
      filtered = events.filter((e: any) => {
        const game = gamesMap.get(e.game_id)
        return game && params.seasonIds?.includes(game.season_id)
      })
    }
    if (params?.gameIds && params.gameIds.length > 0) {
      filtered = events.filter((e: any) => params.gameIds?.includes(e.game_id))
    }

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
      else if (event.event_type === 'Turnover') stats.turnovers++
    })

    // Convert to array and calculate additional fields
    const result = Array.from(statsMap.values()).map((s: any) => ({
      ...s,
      games_played: s.games_played.size,
      ga_rank: 0,
    }))

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
      .select('player_id, event_type, game_id')

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

    return filtered.map((e: any) => {
      const game = gamesMap.get(e.game_id)
      const player = playersMap.get(e.player_id)
      return {
        game_id: game?.id,
        opponent: game?.opponent,
        game_date: game?.game_date,
        player_id: e.player_id,
        player_name: player?.display_name,
        goals: e.event_type === 'Goal' ? 1 : 0,
        assists: e.event_type === 'Assist' ? 1 : 0,
        turnovers: e.event_type === 'Turnover' ? 1 : 0,
      }
    })
  }, [])
  return useApiCall<any[], { seasonId?: number }>(fn)
}
