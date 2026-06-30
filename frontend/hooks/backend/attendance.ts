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

export function useGetGameAttendance() {
  const fn = useCallback(async (params: { gameId: number }) => {
    const { data, error } = await supabase
      .from('game_attendance')
      .select('player_id')
      .eq('game_id', params.gameId)
    if (error) throw new Error(error.message)
    return (data ?? []).map((r: any) => r.player_id as number)
  }, [])
  return useApiCall<number[], { gameId: number }>(fn)
}

export function useSetAttendance() {
  const fn = useCallback(async (params: { gameId: number; playerId: number; attending: boolean }) => {
    if (params.attending) {
      const { error } = await supabase
        .from('game_attendance')
        .upsert({ game_id: params.gameId, player_id: params.playerId }, { onConflict: 'game_id,player_id' })
      if (error) throw new Error(error.message)
    } else {
      const { error } = await supabase
        .from('game_attendance')
        .delete()
        .eq('game_id', params.gameId)
        .eq('player_id', params.playerId)
      if (error) throw new Error(error.message)
    }
  }, [])
  return useApiCall<void, { gameId: number; playerId: number; attending: boolean }>(fn)
}
