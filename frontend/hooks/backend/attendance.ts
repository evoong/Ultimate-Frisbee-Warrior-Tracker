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

// Attendance is a pure read derived from lineup membership: a player
// "attends" a game exactly when they're placed in any of its lineup groups.
// This has no backing table of its own (game_attendance is retired) and no
// write side — attend/un-attend happens by adding/removing someone from a
// lineup (see useAddToLineup, useCreatePlayerForGame, useAddPlayerToGame,
// and Schedule.tsx's handleRemoveFromLineup/handleDeleteLineupGroup).
// Returns the same { player_id, in } shape callers already expect, always
// `in: true` per row, since a row's presence in game_lineups is what "in"
// means now — there is no "in: false" state to represent.
export function useGetGameAttendance() {
  const fn = useCallback(async (params: { gameId: number }) => {
    const { data, error } = await supabase
      .from('game_lineups')
      .select('player_id')
      .eq('game_id', params.gameId)
    if (error) throw new Error(error.message)
    const playerIds = new Set(((data ?? []) as { player_id: number }[]).map(r => r.player_id))
    return [...playerIds].map(player_id => ({ player_id, in: true })) as { player_id: number; in: boolean }[]
  }, [])
  return useApiCall<{ player_id: number; in: boolean }[], { gameId: number }>(fn)
}
