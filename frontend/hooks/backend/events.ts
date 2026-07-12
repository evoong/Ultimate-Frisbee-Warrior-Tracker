import { useState, useCallback, useRef } from 'react'
import { supabase } from '../../lib/supabase'

type HookResult<T, P = void> = {
  data: T | undefined
  loading: boolean
  error: string | null
  trigger: P extends void ? () => Promise<T | undefined> : (params?: P) => Promise<T | undefined>
}

function useApiCall<T, P = void>(
  fn: (params: P) => Promise<T>
): HookResult<T, P> {
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

export function useGetGameEvents() {
  const fn = useCallback(async (params: { gameId: number }) => {
    const { data, error } = await supabase
      .from('game_events')
      .select('*')
      .eq('game_id', params.gameId)
      .order('event_timestamp', { ascending: false })
    if (error) throw new Error(error.message)
    return data as any[]
  }, [])
  return useApiCall<any[], { gameId: number }>(fn)
}

export function useGetEventTypes() {
  const fn = useCallback(async () => {
    const { data, error } = await supabase
      .from('event_types')
      .select('*')
      .order('name')
    if (error) throw new Error(error.message)
    return data as any[]
  }, [])
  return useApiCall<any[]>(fn)
}

export function useCreateGoalEvent() {
  const fn = useCallback(async (params: { organizationId: number | null; gameId: number; playerId: number | null; relatedPlayerId: number | null; eventType?: string; notes?: string }) => {
    const { data, error } = await supabase
      .from('game_events')
      .insert({
        organization_id: params.organizationId,
        game_id: params.gameId,
        player_id: params.playerId,
        related_player_id: params.relatedPlayerId,
        event_type: params.eventType || 'Goal',
        event_timestamp: new Date().toISOString(),
        notes: params.notes,
      })
      .select()
    if (error) throw new Error(error.message)
    return data?.[0]
  }, [])
  return useApiCall(fn)
}

export function useCreateOpponentGoalEvent() {
  const fn = useCallback(async (params: { organizationId: number | null; gameId: number }) => {
    const { data, error } = await supabase
      .from('game_events')
      .insert({
        organization_id: params.organizationId,
        game_id: params.gameId,
        event_type: 'Opponent Goal',
        event_timestamp: new Date().toISOString(),
      })
      .select()
    if (error) throw new Error(error.message)
    return data?.[0]
  }, [])
  return useApiCall(fn)
}

export function useDeleteEvent() {
  const fn = useCallback(async (params: { eventId: number }) => {
    const { data, error } = await supabase
      .from('game_events')
      .delete()
      .eq('id', params.eventId)
      .select()
    if (error) throw new Error(error.message)
    return data?.[0]
  }, [])
  return useApiCall(fn)
}

export function useUpdateEvent() {
  const fn = useCallback(async (params: { eventId: number; playerId: number | null; relatedPlayerId: number | null }) => {
    const { data, error } = await supabase
      .from('game_events')
      .update({
        player_id: params.playerId,
        related_player_id: params.relatedPlayerId,
      })
      .eq('id', params.eventId)
      .select()
    if (error) throw new Error(error.message)
    return data?.[0]
  }, [])
  return useApiCall(fn)
}
