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

export function useGetGames() {
  const fn = useCallback(async (params?: { seasonIds?: number[] }) => {
    let query = supabase.from('games').select('*').order('game_date', { ascending: false })
    if (params?.seasonIds && params.seasonIds.length > 0) {
      query = query.in('season_id', params.seasonIds)
    }
    const { data, error } = await query
    if (error) throw new Error(error.message)
    return data as any[]
  }, [])
  return useApiCall<any[], { seasonIds?: number[] }>(fn)
}

export function useCreateGame() {
  const fn = useCallback(async (params: { opponent: string; game_date: string; game_time: string; game_type: string; season_id?: number | null; notes?: string }) => {
    const { data, error } = await supabase
      .from('games')
      .insert(params)
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
    const { data, error } = await supabase
      .from('game_lineups')
      .select('*')
      .eq('game_id', params.gameId)
    if (error) throw new Error(error.message)
    return data as any[]
  }, [])
  return useApiCall<any[], { gameId: number }>(fn)
}

export function useAddToLineup() {
  const fn = useCallback(async (params: { gameId: number; player_id: number; lineup_name?: string }) => {
    const { data, error } = await supabase
      .from('game_lineups')
      .insert({
        game_id: params.gameId,
        player_id: params.player_id,
        lineup_name: params.lineup_name ?? 'Starting',
      })
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
