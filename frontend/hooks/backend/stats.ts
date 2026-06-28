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

export function useGetSeasons() {
  const fn = useCallback(async () => {
    const res = await fetch('/api/stats/seasons')
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall(fn)
}

export function useGetAllSeasons() {
  const fn = useCallback(async () => {
    const res = await fetch('/api/seasons')
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall(fn)
}

export function useCreateSeason() {
  const fn = useCallback(async (params: { name: string; year: number; location?: string; league_name?: string }) => {
    const res = await fetch('/api/seasons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall<unknown, { name: string; year: number; location?: string; league_name?: string }>(fn)
}

export function useGetCumulativeStats() {
  const fn = useCallback(async (params?: { seasonId?: number }) => {
    const url = new URL('/api/stats/cumulative', window.location.origin)
    if (params?.seasonId != null) url.searchParams.set('seasonId', String(params.seasonId))
    const res = await fetch(url.toString())
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall<unknown, { seasonId?: number } | undefined>(fn)
}

export function useGetPlayerStats() {
  const fn = useCallback(async (params?: { seasonId?: number; gameIds?: number[] }) => {
    const url = new URL('/api/stats/players', window.location.origin)
    if (params?.seasonId != null) {
      url.searchParams.set('seasonId', String(params.seasonId))
    }
    if (params?.gameIds && params.gameIds.length > 0) {
      for (const id of params.gameIds) {
        url.searchParams.append('gameIds', String(id))
      }
    }
    const res = await fetch(url.toString())
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall<unknown, { seasonId?: number; gameIds?: number[] } | undefined>(fn)
}
