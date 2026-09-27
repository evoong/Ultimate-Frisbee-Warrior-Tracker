import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAuth } from '../contexts/AuthContext'

export const FLAG_KEYS = ['show_turnovers'] as const
const DEFAULT_FLAGS: Record<string, boolean> = { show_turnovers: false }

type FlagsResult = { flags: Record<string, boolean> | null; loading: boolean }
const FlagsContext = createContext<FlagsResult>({ flags: null, loading: false })

function keyFor(loading: boolean, userId: string | undefined, teamId: number | null, guest: boolean): string | null {
  return !loading && userId && !guest && teamId != null ? `${userId}:${teamId}` : null
}

export function FlagsProvider({ children }: { children: ReactNode }) {
  const { user, currentTeamId, isGuest, loading: authLoading } = useAuth()
  const [result, setResult] = useState<FlagsResult>({ flags: null, loading: false })
  const [identity, setIdentity] = useState<string | null>(null)

  const key = keyFor(authLoading, user?.id, currentTeamId, isGuest)

  const fetchFlags = useCallback(async (signal: AbortSignal, teamId: number) => {
    const response = await fetch('/api/flags', { credentials: 'include', signal })
    if (!response.ok) throw new Error('Flags unavailable')
    const data = await response.json()
    return { flags: { ...DEFAULT_FLAGS, ...data.flags?.[teamId] }, loading: false }
  }, [])

  useEffect(() => {
    if (identity !== key) {
      setIdentity(key)
      setResult(key ? { flags: null, loading: true } : { flags: null, loading: false })
    }
  }, [identity, key])

  useEffect(() => {
    if (!key || identity !== key || currentTeamId == null) return
    const controller = new AbortController()
    let cancelled = false
    fetchFlags(controller.signal, currentTeamId)
      .then(next => { if (!cancelled) setResult(next) })
      .catch(() => { if (!cancelled) setResult({ flags: DEFAULT_FLAGS, loading: false }) })
    return () => { cancelled = true; controller.abort() }
  }, [key, identity, currentTeamId, fetchFlags])

  const value = useMemo(() => result, [result])
  return <FlagsContext.Provider value={value}>{children}</FlagsContext.Provider>
}

export function useFlags(): FlagsResult {
  return useContext(FlagsContext)
}
