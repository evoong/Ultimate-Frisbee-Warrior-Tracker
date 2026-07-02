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

// Upsert so players added to a season after the game was created (no backfilled row) still work
export function useSetAttendance() {
  const fn = useCallback(async (params: { gameId: number; playerId: number; attending: boolean }) => {
    const { error } = await supabase
      .from('game_attendance')
      .upsert(
        { game_id: params.gameId, player_id: params.playerId, in: params.attending },
        { onConflict: 'game_id,player_id' }
      )
    if (error) throw new Error(error.message)
  }, [])
  return useApiCall<void, { gameId: number; playerId: number; attending: boolean }>(fn)
}

// Sets `in` for a specific set of playerIds in one update, sets everyone else to false
export function useSetAllAttendance() {
  const fn = useCallback(async (params: { gameId: number; attending: boolean; playerIds?: number[] }) => {
    if (params.playerIds && params.playerIds.length > 0) {
      const { error } = await supabase
        .from('game_attendance')
        .update({ in: params.attending })
        .eq('game_id', params.gameId)
        .in('player_id', params.playerIds)
      if (error) throw new Error(error.message)
    } else {
      const { error } = await supabase
        .from('game_attendance')
        .update({ in: params.attending })
        .eq('game_id', params.gameId)
      if (error) throw new Error(error.message)
    }
  }, [])
  return useApiCall<void, { gameId: number; attending: boolean; playerIds?: number[] }>(fn)
}
