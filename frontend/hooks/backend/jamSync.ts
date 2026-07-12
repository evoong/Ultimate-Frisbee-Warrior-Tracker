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

export type JamSyncConflict = {
  id: number
  organization_id: number
  jam_uid: string
  organizer: string
  opponent: string
  event_date: string
  event_time: string
  location: string | null
  existing_game_id: number | null
  reason: string
  status: string
  created_at: string
}

export function useGetJamSyncConflicts() {
  const fn = useCallback(async (params: { organizationId: number | null }) => {
    const { data, error } = await supabase
      .from('jam_sync_conflicts')
      .select('*')
      .eq('organization_id', params.organizationId)
      .eq('status', 'pending')
      .order('event_date', { ascending: true })
    if (error) throw new Error(error.message)
    return (data ?? []) as JamSyncConflict[]
  }, [])
  return useApiCall<JamSyncConflict[], { organizationId: number | null }>(fn)
}

// Manual "sync now" trigger — the same import also runs automatically every
// hour (Cloudflare scheduled() trigger / Vercel cron), this just lets an
// allowlisted user kick it off on demand and see the result immediately.
export function useSyncJamNow() {
  const fn = useCallback(async () => {
    const res = await fetch('/api/schedule/sync-jam', { method: 'POST' })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body?.error ?? `sync failed (${res.status})`)
    return body as { fetched: number; created: number; updated: number; alreadySynced: number; conflicts: number; errors: string[] }
  }, [])
  return useApiCall(fn)
}

// "Create": insert a new game from the conflict's stored fields (optionally
// with a chosen season_id, e.g. when the conflict reason was no_season_match)
// and mark the conflict resolved.
export function useCreateGameFromConflict() {
  const fn = useCallback(async (params: { conflict: JamSyncConflict; seasonId: number | null }) => {
    const { conflict, seasonId } = params
    const { error: insertError } = await supabase.from('games').insert({
      organization_id: conflict.organization_id,
      season_id: seasonId,
      opponent: conflict.opponent,
      game_date: conflict.event_date,
      game_time: conflict.event_time,
      jam_uid: conflict.jam_uid,
    })
    if (insertError) throw new Error(insertError.message)

    const { error: updateError } = await supabase
      .from('jam_sync_conflicts')
      .update({ status: 'created', resolved_at: new Date().toISOString() })
      .eq('id', conflict.id)
    if (updateError) throw new Error(updateError.message)
  }, [])
  return useApiCall<void, { conflict: JamSyncConflict; seasonId: number | null }>(fn)
}

// "Link": this conflict is the same real game as an existing row — record
// the jam_uid on it instead of creating a duplicate, so future syncs
// recognize it by exact match.
export function useLinkConflictToGame() {
  const fn = useCallback(async (params: { conflict: JamSyncConflict; gameId: number }) => {
    const { conflict, gameId } = params
    const { error: linkError } = await supabase
      .from('games')
      .update({ jam_uid: conflict.jam_uid })
      .eq('id', gameId)
    if (linkError) throw new Error(linkError.message)

    const { error: updateError } = await supabase
      .from('jam_sync_conflicts')
      .update({ status: 'linked', resolved_at: new Date().toISOString() })
      .eq('id', conflict.id)
    if (updateError) throw new Error(updateError.message)
  }, [])
  return useApiCall<void, { conflict: JamSyncConflict; gameId: number }>(fn)
}

// "Dismiss": not a real game to import (or a duplicate that isn't actually
// wanted) — stays resolved forever, future syncs won't re-flag this jam_uid.
export function useDismissConflict() {
  const fn = useCallback(async (params: { conflictId: number }) => {
    const { error } = await supabase
      .from('jam_sync_conflicts')
      .update({ status: 'dismissed', resolved_at: new Date().toISOString() })
      .eq('id', params.conflictId)
    if (error) throw new Error(error.message)
  }, [])
  return useApiCall<void, { conflictId: number }>(fn)
}
