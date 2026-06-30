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

// Returns all rows for a game: { player_id, in }
export function useGetGameAttendance() {
  const fn = useCallback(async (params: { gameId: number }) => {
    const { data, error } = await supabase
      .from('game_attendance')
      .select('player_id, in')
      .eq('game_id', params.gameId)
    if (error) throw new Error(error.message)
    return (data ?? []) as { player_id: number; in: boolean }[]
  }, [])
  return useApiCall<{ player_id: number; in: boolean }[], { gameId: number }>(fn)
}

// Flips the `in` boolean on an existing row (row always exists — backfilled at game creation)
export function useSetAttendance() {
  const fn = useCallback(async (params: { gameId: number; playerId: number; attending: boolean }) => {
    const { error } = await supabase
      .from('game_attendance')
      .update({ in: params.attending })
      .eq('game_id', params.gameId)
      .eq('player_id', params.playerId)
    if (error) throw new Error(error.message)
  }, [])
  return useApiCall<void, { gameId: number; playerId: number; attending: boolean }>(fn)
}
