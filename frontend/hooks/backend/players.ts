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

export function useGetPlayers() {
  const fn = useCallback(async (params?: { seasonIds?: number[] }) => {
    const url = new URL('/api/players', window.location.origin)
    if (params?.seasonIds && params.seasonIds.length > 0) {
      for (const id of params.seasonIds) url.searchParams.append('seasonIds', String(id))
    }
    const res = await fetch(url.toString())
    if (!res.ok) throw new Error(await res.text())
    return res.json() as Promise<any[]>
  }, [])
  return useApiCall<any[], { seasonIds?: number[] }>(fn)
}

export function useGetSeasonRoster() {
  const fn = useCallback(async (params: { gameId: number }) => {
    const res = await fetch(`/api/players/season-roster?gameId=${params.gameId}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json() as Promise<any[]>
  }, [])
  return useApiCall<any[], { gameId: number }>(fn)
}

export function useCreatePlayer() {
  const fn = useCallback(async (params: {
    display_name: string; first_name?: string; last_name?: string;
    gender_match?: string; phone?: string; number?: number; position?: string; is_sub?: boolean; season_ids?: number[]
  }) => {
    const res = await fetch('/api/players', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall(fn)
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

export function useDeletePlayer() {
  const fn = useCallback(async (params: { playerId: number }) => {
    const res = await fetch(`/api/players/${params.playerId}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall(fn)
}

export function useUpdatePlayer() {
  const fn = useCallback(async (params: {
    playerId: number; display_name?: string; first_name?: string; last_name?: string;
    gender_match?: string; phone?: string; number?: number | null; position?: string | null
  }) => {
    const { playerId, ...body } = params
    const res = await fetch(`/api/players/${playerId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
    return res.json() as Promise<any[]>
  }, [])
  return useApiCall<any[], { playerId: number }>(fn)
}

export function useGetPlayerSeasons() {
  const fn = useCallback(async (params: { playerId: number }) => {
    const res = await fetch(`/api/players/${params.playerId}/seasons`)
    if (!res.ok) throw new Error(await res.text())
    return res.json() as Promise<any[]>
  }, [])
  return useApiCall<any[], { playerId: number }>(fn)
}

export function useUpdatePlayerSeasons() {
  const fn = useCallback(async (params: { playerId: number; seasonIds: number[] }) => {
    const res = await fetch(`/api/players/${params.playerId}/seasons`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seasonIds: params.seasonIds }),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall(fn)
}

export function useGetPlayersNotInSeason() {
  const fn = useCallback(async (params: { gameId: number }) => {
    const res = await fetch(`/api/players/not-in-season?gameId=${params.gameId}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json() as Promise<{ id: number; display_name: string }[]>
  }, [])
  return useApiCall<{ id: number; display_name: string }[], { gameId: number }>(fn)
}

export function useAddPlayerToGame() {
  const fn = useCallback(async (params: { playerId: number; gameId: number }) => {
    const res = await fetch(`/api/players/${params.playerId}/add-to-game`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId: params.gameId }),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }, [])
  return useApiCall(fn)
}

export function useUploadPlayerPhoto() {
  const fn = useCallback(async (params: { playerId: number; file: File }) => {
    const form = new FormData()
    form.append('photo', params.file)
    const res = await fetch(`/api/players/${params.playerId}/photo`, {
      method: 'POST',
      body: form,
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json() as Promise<{ photo_url: string }>
  }, [])
  return useApiCall<{ photo_url: string }, { playerId: number; file: File }>(fn)
}
