import { useState, useCallback } from 'react'

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
    const url = new URL('/api/games', window.location.origin)
    if (params?.seasonIds && params.seasonIds.length > 0) {
      for (const id of params.seasonIds) url.searchParams.append('seasonIds', String(id))
    }
    const res = await fetch(url.toString())
    if (!res.ok) throw new Error(await res.text())
    return res.json() as Promise<any[]>
  }, [])
  return useApiCall<any[], { seasonIds?: number[] }>(fn)
}

export function useCreateGame() {
  const fn = useCallback(async (params: { opponent: string; game_date: string; game_time: string; game_type: string; season_id?: number | null; notes?: string }) => {
    const res = await fetch('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall(fn)
}

export function useUpdateGame() {
  const fn = useCallback(async (params: { gameId: number; notes?: string; outcome_override?: string | null; result?: string }) => {
    const { gameId, ...body } = params
    const res = await fetch(`/api/games/${gameId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall(fn)
}

export function useDeleteGame() {
  const fn = useCallback(async (params: { gameId: number }) => {
    const res = await fetch(`/api/games/${params.gameId}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall(fn)
}

export function useGetLineups() {
  const fn = useCallback(async (params: { gameId: number }) => {
    const res = await fetch(`/api/games/${params.gameId}/lineups`)
    if (!res.ok) throw new Error(await res.text())
    return res.json() as Promise<any[]>
  }, [])
  return useApiCall<any[], { gameId: number }>(fn)
}

export function useAddToLineup() {
  const fn = useCallback(async (params: { gameId: number; player_id: number; lineup_name?: string }) => {
    const res = await fetch(`/api/games/${params.gameId}/lineups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_id: params.player_id, lineup_name: params.lineup_name ?? 'Starting' }),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall(fn)
}

export function useRemoveFromLineup() {
  const fn = useCallback(async (params: { gameId: number; playerId: number; lineup_name?: string }) => {
    const url = new URL(`/api/games/${params.gameId}/lineups/${params.playerId}`, window.location.origin)
    if (params.lineup_name) url.searchParams.set('lineup_name', params.lineup_name)
    const res = await fetch(url.toString(), { method: 'DELETE' })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall(fn)
}
