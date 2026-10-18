import { useState, useCallback, useRef } from 'react'
import { supabase } from '../../lib/supabase'
import { RankingMode } from './league'
import { isPastGame } from '../../lib/gameOrder'
import { calculatePoints } from '../../lib/scoring'

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
  const fn = useCallback(async (params: { organizationId: number | null; seasonIds?: number[]; gameIds?: number[]; tier?: string | null; mode?: RankingMode }) => {
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
      .select('player_id, related_player_id, secondary_assister_id, event_type, game_id')
    if (scopedGameIds) eventsQuery = eventsQuery.in('game_id', scopedGameIds)
    if (params.tier === 'free') {
      eventsQuery = eventsQuery.gte('event_timestamp', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
    }
    const { data: events, error: eventsError } = await eventsQuery
    if (eventsError) throw new Error(eventsError.message)
    if (!events) return []

    // Fetch all players
    const { data: players, error: playersError } = await supabase
      .from('players')
      .select('id, display_name, gender_match')
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

      // Credit the scorer (goals/blocks) only when the scorer is known.
      // This does NOT gate the assist credit below: a goal can have no
      // recorded scorer (e.g. an unregistered teammate scored) while still
      // having a recorded assister, and that assist should still count.
      if (playerId && playerData) {
        if (!statsMap.has(playerId)) {
          statsMap.set(playerId, {
            player_id: playerId,
            player_name: playerData.display_name,
            gender_match: playerData.gender_match,
            goals: 0,
            assists: 0,
            second_assists: 0,
            blocks: 0,
            games_played: new Set<number>(),
          })
        }

        const stats = statsMap.get(playerId)!
        stats.games_played.add(event.game_id)

        if (event.event_type === 'Goal') stats.goals++
        else if (event.event_type === 'Block') stats.blocks++
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
              gender_match: assisterData.gender_match,
              goals: 0,
              assists: 0,
              second_assists: 0,
              blocks: 0,
              games_played: new Set<number>(),
            })
          }
          const assisterStats = statsMap.get(assisterId)!
          assisterStats.assists++
          assisterStats.games_played.add(event.game_id)
        }
      }

      // Credit 2nd assist to the secondary assister on a Goal (2ND, half value)
      if (event.event_type === 'Goal' && event.secondary_assister_id) {
        const secondAssisterId = event.secondary_assister_id
        const secondAssisterData = playersMap.get(secondAssisterId)
        if (secondAssisterData) {
          if (!statsMap.has(secondAssisterId)) {
            statsMap.set(secondAssisterId, {
              player_id: secondAssisterId,
              player_name: secondAssisterData.display_name,
              gender_match: secondAssisterData.gender_match,
              goals: 0,
              assists: 0,
              second_assists: 0,
              blocks: 0,
              games_played: new Set<number>(),
            })
          }
          const secondAssisterStats = statsMap.get(secondAssisterId)!
          secondAssisterStats.second_assists++
          secondAssisterStats.games_played.add(event.game_id)
        }
      }
    })

    // Convert to array and calculate additional fields
    const result = Array.from(statsMap.values()).map((s: any) => {
      const attended = attendanceMap.get(s.player_id) ?? new Set<number>()
      const gamesPlayed = [...attended].filter(gid => playedGameIds.has(gid) && (!filteredGameIds || filteredGameIds.has(gid))).length
      // Warrior points: PTS 500, G 500, A 500, 2ND 250, BLK 500
      const points = calculatePoints({
        goals: s.goals,
        assists: s.assists,
        secondAssists: s.second_assists,
        blocks: s.blocks,
      })
      return {
        ...s,
        points,
        games_played: gamesPlayed,
        ga_rank: 0,
      }
    })

    // Rank by points descending
    result.sort((a: any, b: any) => {
      const pointsDiff = b.points - a.points
      if (pointsDiff !== 0) return pointsDiff
      
      const goalsDiff = b.goals - a.goals
      if (goalsDiff !== 0) return goalsDiff
      
      const aRate = a.games_played > 0 ? a.points / a.games_played : 0
      const bRate = b.games_played > 0 ? b.points / b.games_played : 0
      return bRate - aRate
    })

    // Ranking logic
    const mode = params.mode ?? 'standard'
    let rank = 0
    result.forEach((s: any, i: number) => {
        if (mode === 'row') {
            s.ga_rank = i + 1
        } else if (mode === 'standard') {
            if (i > 0 && s.points === result[i-1].points && s.goals === result[i-1].goals) {
                s.ga_rank = result[i-1].ga_rank
            } else {
                s.ga_rank = i + 1
            }
        } else {
            if (i === 0) rank = 1
            else if (s.points !== result[i-1].points || s.goals !== result[i-1].goals) {
                rank++
            }
            s.ga_rank = rank
        }
    })

    return result
  }, [])
  return useApiCall<any[], { organizationId: number | null; seasonIds?: number[]; gameIds?: number[]; tier?: string | null; mode?: RankingMode }>(fn)
}

export type PairingRow = {
  scorerId: number
  assisterId: number
  scorerName: string
  assisterName: string
  count: number
}

export function useGetAssistPairings() {
  const fn = useCallback(async (params: { organizationId: number | null; seasonIds?: number[]; gameIds?: number[]; limit?: number; tier?: string | null }) => {
    // Resolve the games in scope first, same three-way logic as useGetPlayerStats:
    // explicit gameIds wins, else games in seasonIds, else null (all-time).
    let gamesQuery = supabase.from('games').select('id, season_id').eq('organization_id', params.organizationId)
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

    let eventsQuery = supabase
      .from('game_events')
      .select('player_id, related_player_id, event_type')
    if (scopedGameIds) eventsQuery = eventsQuery.in('game_id', scopedGameIds)
    if (params.tier === 'free') {
      eventsQuery = eventsQuery.gte('event_timestamp', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
    }
    const { data: events, error: eventsError } = await eventsQuery
    if (eventsError) throw new Error(eventsError.message)

    const { data: players, error: playersError } = await supabase
      .from('players')
      .select('id, display_name')
      .eq('organization_id', params.organizationId)
    if (playersError) throw new Error(playersError.message)

    const playersMap = new Map(players?.map((p: any) => [p.id, p.display_name as string]) ?? [])

    const tally = new Map<string, { scorerId: number; assisterId: number; count: number }>()
    ;(events ?? []).forEach((e: any) => {
      if (e.event_type !== 'Goal' || !e.player_id || !e.related_player_id) return
      const key = `${e.player_id}:${e.related_player_id}`
      const row = tally.get(key) ?? { scorerId: e.player_id, assisterId: e.related_player_id, count: 0 }
      row.count++
      tally.set(key, row)
    })

    const rows: PairingRow[] = [...tally.values()]
      .filter(r => playersMap.has(r.scorerId) && playersMap.has(r.assisterId))
      .map(r => ({
        scorerId: r.scorerId,
        assisterId: r.assisterId,
        scorerName: playersMap.get(r.scorerId)!,
        assisterName: playersMap.get(r.assisterId)!,
        count: r.count,
      }))

    rows.sort((a, b) => b.count - a.count || a.scorerName.localeCompare(b.scorerName) || a.assisterName.localeCompare(b.assisterName))

    return rows.slice(0, params.limit ?? 10)
  }, [])
  return useApiCall<PairingRow[], { organizationId: number | null; seasonIds?: number[]; gameIds?: number[]; limit?: number; tier?: string | null }>(fn)
}

export function useGetCumulativeStats() {
  const fn = useCallback(async (params: { organizationId: number | null; seasonIds?: number[]; gameIds?: number[] }) => {
    // Fetch the games first so events can be filtered server-side
    // (supabase caps unfiltered fetches at 1000 rows)
    let gamesQuery = supabase.from('games').select('id, opponent, game_date, season_id').eq('organization_id', params.organizationId)
    if (params?.seasonIds != null && params.seasonIds.length > 0) {
      gamesQuery = gamesQuery.in('season_id', params.seasonIds)
    } else if (params?.gameIds != null && params.gameIds.length > 0) {
      gamesQuery = gamesQuery.in('id', params.gameIds)
    }
    const { data: games, error: gamesError } = await gamesQuery
    if (gamesError) throw new Error(gamesError.message)

    const gamesMap = new Map(games?.map((g: any) => [g.id, g]) ?? [])

    let eventsQuery = supabase
      .from('game_events')
      .select('player_id, related_player_id, secondary_assister_id, event_type, game_id')
    
    if ((games ?? []).length > 0) {
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

      // Row for the scorer (Goal or Block)
      if (e.player_id) {
        if (e.event_type === 'Goal') {
          rows.push({
            game_id: game?.id,
            opponent: game?.opponent,
            game_date: game?.game_date,
            player_id: e.player_id,
            player_name: playersMap.get(e.player_id)?.display_name,
            goals: 1,
            assists: 0,
            second_assists: 0,
            blocks: 0,
          })
        } else if (e.event_type === 'Block') {
          rows.push({
            game_id: game?.id,
            opponent: game?.opponent,
            game_date: game?.game_date,
            player_id: e.player_id,
            player_name: playersMap.get(e.player_id)?.display_name,
            goals: 0,
            assists: 0,
            second_assists: 0,
            blocks: 1,
          })
        }
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
          second_assists: 0,
          blocks: 0,
        })
      }

      // Separate row for the secondary assister (secondary_assister_id on a Goal)
      if (e.event_type === 'Goal' && e.secondary_assister_id) {
        rows.push({
          game_id: game?.id,
          opponent: game?.opponent,
          game_date: game?.game_date,
          player_id: e.secondary_assister_id,
          player_name: playersMap.get(e.secondary_assister_id)?.display_name,
          goals: 0,
          assists: 0,
          second_assists: 1,
          blocks: 0,
        })
      }
    })
    return rows
  }, [])
  return useApiCall<any[], { organizationId: number | null; seasonIds?: number[]; gameIds?: number[] }>(fn)
}
