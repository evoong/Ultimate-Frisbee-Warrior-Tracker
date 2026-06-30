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

export function useGetPlayers() {
  const fn = useCallback(async (params?: { seasonIds?: number[] }) => {
    let query = supabase.from('players').select('*').order('display_name')
    if (params?.seasonIds && params.seasonIds.length > 0) {
      query = query.in('season_id', params.seasonIds)
    }
    const { data, error } = await query
    if (error) throw new Error(error.message)
    return data as any[]
  }, [])
  return useApiCall<any[], { seasonIds?: number[] }>(fn)
}

export function useGetSeasonRoster() {
  const fn = useCallback(async (params: { gameId: number }) => {
    // Get players in this game's lineup
    const { data: lineupData, error: lineupError } = await supabase
      .from('game_lineups')
      .select('*')
      .eq('game_id', params.gameId)
    if (lineupError) throw new Error(lineupError.message)

    // Get full player details for those in the lineup
    if (!lineupData || lineupData.length === 0) return []

    const playerIds = lineupData.map((l: any) => l.player_id)
    const { data: playersData, error: playersError } = await supabase
      .from('players')
      .select('*')
      .in('id', playerIds)
    if (playersError) throw new Error(playersError.message)
    return playersData as any[]
  }, [])
  return useApiCall<any[], { gameId: number }>(fn)
}

export function useCreatePlayer() {
  const fn = useCallback(async (params: {
    display_name: string; first_name?: string; last_name?: string;
    gender_match?: string; phone?: string; number?: number; position?: string; is_sub?: boolean; season_ids?: number[]
  }) => {
    const { data, error } = await supabase
      .from('players')
      .insert(params)
      .select()
    if (error) throw new Error(error.message)
    return data?.[0]
  }, [])
  return useApiCall(fn)
}

export function useGetPlayersNotInSeason() {
  const fn = useCallback(async (params?: { gameId?: number }) => {
    // Load all available players - season relationship is through game_lineups only
    const { data, error } = await supabase
      .from('players')
      .select('*')
      .order('display_name')
    if (error) throw new Error(error.message)
    return data as any[]
  }, [])
  return useApiCall<any[], { gameId?: number }>(fn)
}

export function useCreatePlayerForGame() {
  const fn = useCallback(async (params: { gameId: number; display_name: string; position?: string; gender_match?: string }) => {
    const { data: playerData, error: playerError } = await supabase
      .from('players')
      .insert({ display_name: params.display_name, position: params.position, gender_match: params.gender_match })
      .select()
    if (playerError) throw new Error(playerError.message)
    
    const playerId = playerData?.[0]?.id
    if (!playerId) throw new Error('Failed to create player')

    const { data, error } = await supabase
      .from('game_lineups')
      .insert({ game_id: params.gameId, player_id: playerId, lineup_name: 'Starting' })
      .select()
    if (error) throw new Error(error.message)
    return data?.[0]
  }, [])
  return useApiCall(fn)
}

export function useDeleteSubPlayer() {
  const fn = useCallback(async (params: { gameId: number; playerId: number }) => {
    const { data, error } = await supabase
      .from('game_lineups')
      .delete()
      .eq('game_id', params.gameId)
      .eq('player_id', params.playerId)
      .select()
    if (error) throw new Error(error.message)
    return data?.[0]
  }, [])
  return useApiCall(fn)
}

export function useAddPlayerToGame() {
  const fn = useCallback(async (params: { gameId: number; playerId: number }) => {
    const { data, error } = await supabase
      .from('game_lineups')
      .insert({ game_id: params.gameId, player_id: params.playerId, lineup_name: 'Starting' })
      .select()
    if (error) throw new Error(error.message)
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
  const fn = useCallback(async (params: { playerId: number; display_name?: string; phone?: string; number?: number }) => {
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
  const fn = useCallback(async (params: { playerId: number; seasonIds: number[] }) => {
    const { data, error } = await supabase
      .from('players')
      .update({ season_id: params.seasonIds[0] })
      .eq('id', params.playerId)
      .select()
    if (error) throw new Error(error.message)
    return data?.[0]
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
    return data
  }, [])
  return useApiCall(fn)
}

export function useGetPlayerGameStats() {
  const fn = useCallback(async (params: { playerId: number }) => {
    const { data, error } = await supabase
      .from('game_events')
      .select('*')
      .eq('player_id', params.playerId)
    if (error) throw new Error(error.message)
    return data as any[]
  }, [])
  return useApiCall<any[], { playerId: number }>(fn)
}

export function useGetPlayerSeasons() {
  const fn = useCallback(async (params: { playerId: number }) => {
    const { data, error } = await supabase
      .from('players')
      .select('season_id')
      .eq('id', params.playerId)
    if (error) throw new Error(error.message)
    return data as any[]
  }, [])
  return useApiCall<any[], { playerId: number }>(fn)
}
