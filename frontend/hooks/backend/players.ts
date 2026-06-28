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

export function useGetPlayers() {
  const fn = useCallback(async (params?: { seasonId?: number | null }) => {
    const url = params?.seasonId != null
      ? `/api/players?seasonId=${params.seasonId}`
      : '/api/players'
    const res = await fetch(url)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall<unknown, { seasonId?: number | null } | undefined>(fn)
}

export function useGetSeasonRoster() {
  const fn = useCallback(async (params: { gameId: number }) => {
    const res = await fetch(`/api/players/season-roster?gameId=${params.gameId}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall<unknown, { gameId: number }>(fn)
}

export function useCreatePlayerForGame() {
  const fn = useCallback(async (params: { displayName: string; gameId: number }) => {
    const res = await fetch('/api/players/for-game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall(fn)
}

export function useDeleteSubPlayer() {
  const fn = useCallback(async (params: { playerId: number; gameId: number }) => {
    const res = await fetch(`/api/players/${params.playerId}/sub`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId: params.gameId }),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall(fn)
}

export function useUpdatePlayerPosition() {
  const fn = useCallback(async (params: { playerId: number; position: string | null }) => {
    const res = await fetch(`/api/players/${params.playerId}/position`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: params.position }),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall(fn)
}

export function useGetPlayerGameStats() {
  const fn = useCallback(async (params: { playerId: number }) => {
    const res = await fetch(`/api/players/${params.playerId}/game-stats`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall<unknown, { playerId: number }>(fn)
}
