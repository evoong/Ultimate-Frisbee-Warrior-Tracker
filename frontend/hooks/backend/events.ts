import { useState, useCallback } from 'react'

type HookResult<T, P = void> = {
  data: T | undefined
  loading: boolean
  error: string | null
  trigger: P extends void ? () => Promise<T | undefined> : (params: P) => Promise<T | undefined>
}

function useApiCall<T, P = void>(
  fn: (params: P) => Promise<T>
): HookResult<T, P> {
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

export function useGetGameEvents() {
  const fn = useCallback(async (params: { gameId: number }) => {
    const res = await fetch(`/api/events?gameId=${params.gameId}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall<unknown, { gameId: number }>(fn)
}

export function useGetEventTypes() {
  const fn = useCallback(async () => {
    const res = await fetch('/api/event-types')
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall(fn)
}

export function useCreateGoalEvent() {
  const fn = useCallback(async (params: { gameId: number; playerId: number | null; relatedPlayerId: number | null; eventType?: string; notes?: string }) => {
    const res = await fetch('/api/events/goal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall(fn)
}

export function useCreateOpponentGoalEvent() {
  const fn = useCallback(async (params: { gameId: number }) => {
    const res = await fetch('/api/events/opponent-goal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall(fn)
}

export function useDeleteEvent() {
  const fn = useCallback(async (params: { eventId: number }) => {
    const res = await fetch(`/api/events/${params.eventId}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall(fn)
}

export function useUpdateEvent() {
  const fn = useCallback(async (params: { eventId: number; playerId: number | null; relatedPlayerId: number | null }) => {
    const res = await fetch(`/api/events/${params.eventId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: params.playerId, relatedPlayerId: params.relatedPlayerId }),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall(fn)
}
