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

export type PlayerLink = {
  id: number
  team_id: number
  player_id: number
  user_id: string
  status: 'pending' | 'approved'
}

export function useMyPlayerLink() {
  const fn = useCallback(async (params: { teamId: number; userId: string }) => {
    const { data, error } = await supabase
      .from('player_links')
      .select('*')
      .eq('team_id', params.teamId)
      .eq('user_id', params.userId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    return (data ?? null) as PlayerLink | null
  }, [])
  return useApiCall<PlayerLink | null, { teamId: number; userId: string }>(fn)
}

export function useClaimPlayer() {
  const fn = useCallback(async (params: { playerId: number }) => {
    const { error } = await supabase.rpc('claim_player', { p_player_id: params.playerId })
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { playerId: number }>(fn)
}

export function useApprovePlayerClaim() {
  const fn = useCallback(async (params: { linkId: number }) => {
    const { error } = await supabase.rpc('approve_claim', { p_link_id: params.linkId })
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { linkId: number }>(fn)
}

// Every player_links row for a team, regardless of status, with the
// claimed player's name joined in via the player_links_player_id_fkey (an
// authenticated member can read `players` directly -- tier A in
// 20260903001200_strict_rls.sql -- so this join needs no extra grant).
// Two call sites need this, neither of which is "my own link":
//   - Stats.tsx's claim picker must exclude players who already have a
//     link, pending or approved alike -- player_links carries a
//     `unique(player_id)` constraint, so a second claim on an already-
//     linked player is impossible and would just 403.
//   - OrganizationSettingsDialog's approval list needs every
//     status = 'pending' row for the team, with a name to show next to
//     the Approve button.
export type TeamPlayerLink = PlayerLink & { player_name: string }

export function useGetTeamPlayerLinks() {
  const fn = useCallback(async (params: { teamId: number }) => {
    const { data, error } = await supabase
      .from('player_links')
      .select('id, team_id, player_id, user_id, status, players(display_name)')
      .eq('team_id', params.teamId)
    if (error) throw new Error(error.message)
    return (data ?? []).map((row: any) => ({
      id: row.id,
      team_id: row.team_id,
      player_id: row.player_id,
      user_id: row.user_id,
      status: row.status,
      player_name: row.players?.display_name ?? 'Unknown player',
    })) as TeamPlayerLink[]
  }, [])
  return useApiCall<TeamPlayerLink[], { teamId: number }>(fn)
}
