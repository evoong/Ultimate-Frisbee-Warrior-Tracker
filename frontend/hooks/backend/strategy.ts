import { useState, useCallback, useRef } from 'react'
import { supabase } from '../../lib/supabase'

export type StrategyPlay = { id: number; name: string; created_at: string }
export type StrategyPosition = { player_id: number; x: number; y: number }

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

export function useGetStrategyPlays() {
  const fn = useCallback(async () => {
    const { data, error } = await supabase
      .from('strategy_plays')
      .select('*')
      .order('created_at')
    if (error) throw new Error(error.message)
    return (data ?? []) as StrategyPlay[]
  }, [])
  return useApiCall<StrategyPlay[]>(fn)
}

export function useCreateStrategyPlay() {
  const fn = useCallback(async (params: { name: string }) => {
    const { data, error } = await supabase
      .from('strategy_plays')
      .insert({ name: params.name })
      .select()
    if (error) throw new Error(error.message)
    return data?.[0] as StrategyPlay
  }, [])
  return useApiCall<StrategyPlay, { name: string }>(fn)
}

export function useRenameStrategyPlay() {
  const fn = useCallback(async (params: { id: number; name: string }) => {
    const { error } = await supabase
      .from('strategy_plays')
      .update({ name: params.name })
      .eq('id', params.id)
    if (error) throw new Error(error.message)
  }, [])
  return useApiCall<void, { id: number; name: string }>(fn)
}

// Deleting a play cascades to its strategy_positions rows.
export function useDeleteStrategyPlay() {
  const fn = useCallback(async (params: { id: number }) => {
    const { error } = await supabase
      .from('strategy_plays')
      .delete()
      .eq('id', params.id)
    if (error) throw new Error(error.message)
  }, [])
  return useApiCall<void, { id: number }>(fn)
}

export function useGetStrategyPositions() {
  const fn = useCallback(async (params: { playId: number }) => {
    const { data, error } = await supabase
      .from('strategy_positions')
      .select('player_id, x, y')
      .eq('play_id', params.playId)
    if (error) throw new Error(error.message)
    return (data ?? []) as StrategyPosition[]
  }, [])
  return useApiCall<StrategyPosition[], { playId: number }>(fn)
}

// Upsert so moving an already-placed player writes the same row (see
// useSetAttendance for the same onConflict pattern). Returns true so the
// caller can tell success from a failed trigger (which returns undefined),
// letting the page revert its optimistic update.
export function useUpsertStrategyPosition() {
  const fn = useCallback(async (params: { playId: number; playerId: number; x: number; y: number }) => {
    const { error } = await supabase
      .from('strategy_positions')
      .upsert(
        { play_id: params.playId, player_id: params.playerId, x: params.x, y: params.y },
        { onConflict: 'play_id,player_id' }
      )
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { playId: number; playerId: number; x: number; y: number }>(fn)
}

export function useDeleteStrategyPosition() {
  const fn = useCallback(async (params: { playId: number; playerId: number }) => {
    const { error } = await supabase
      .from('strategy_positions')
      .delete()
      .eq('play_id', params.playId)
      .eq('player_id', params.playerId)
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { playId: number; playerId: number }>(fn)
}
