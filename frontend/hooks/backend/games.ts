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

export function useGetGames() {
  const fn = useCallback(async () => {
    const res = await fetch('/api/games')
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall(fn)
}

export function useCreateGame() {
  const fn = useCallback(async (params: { opponent: string; game_date: string; game_time: string; game_type: string }) => {
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
