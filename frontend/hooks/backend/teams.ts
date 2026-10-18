import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import type { TeamRole } from '../../lib/authClient'

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
      setError(err instanceof Error ? err.message : String(err))
      return undefined
    } finally {
      setLoading(false)
    }
  }, [fn])

  return { data, loading, error, trigger: trigger as HookResult<T, P>['trigger'] }
}

export type TeamMember = {
  id: number
  team_id: number
  user_id: string
  role: TeamRole
  email: string
  player_id: number | null
}

export type TeamInvite = {
  id: number
  team_id: number
  email: string
  role: Exclude<TeamRole, 'captain'>
  expires_at: string
}

export function useGetTeamMembers() {
  const fn = useCallback(async (params: { teamId: number }) => {
    const { data, error } = await supabase
      .from('team_roster')
      .select('*')
      .eq('team_id', params.teamId)
      .order('role')
      .order('email')
    if (error) throw new Error(error.message)
    return (data ?? []) as TeamMember[]
  }, [])
  return useApiCall<TeamMember[], { teamId: number }>(fn)
}

export function useGetTeamInvites() {
  const fn = useCallback(async (params: { teamId: number }) => {
    const { data, error } = await supabase
      .from('team_invites')
      .select('id,team_id,email,role,expires_at')
      .eq('team_id', params.teamId)
      .is('accepted_at', null)
      .order('email')
    if (error) throw new Error(error.message)
    return (data ?? []) as TeamInvite[]
  }, [])
  return useApiCall<TeamInvite[], { teamId: number }>(fn)
}

// Every mutation below is an RPC. team_members and team_invites carry no
// client write grant, so a direct .insert()/.update() would 403 -- and that
// is the point: there is no client-side path to a role change at all.
export function useInviteMember() {
  const fn = useCallback(async (params: { teamId: number; email: string; role: 'member' | 'editor' }) => {
    const { error } = await supabase.rpc('invite_member', {
      p_team_id: params.teamId,
      p_email: params.email,
      p_role: params.role,
    })
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { teamId: number; email: string; role: 'member' | 'editor' }>(fn)
}

export type JoinRequest = {
  id: number
  team_id: number
  user_id: string
  email: string
}

// RLS returns the caller's own requests plus, for managers, their teams'.
export function useGetJoinRequests() {
  const fn = useCallback(async (params: { teamId?: number } = {}) => {
    let q = supabase.from('team_join_requests').select('id,team_id,user_id,email').order('created_at')
    if (params.teamId != null) q = q.eq('team_id', params.teamId)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return (data ?? []) as JoinRequest[]
  }, [])
  return useApiCall<JoinRequest[], { teamId?: number }>(fn)
}

// Count of requests waiting on a team the caller manages. RLS already limits
// the rows to the caller's own requests plus their managed teams', and the
// teamId filter narrows it to one team. `refreshKey` re-reads on demand.
export function usePendingJoinRequestCount(teamId: number | null, enabled: boolean, refreshKey?: unknown) {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!enabled || teamId == null) {
      setCount(0)
      return
    }
    let live = true
    void supabase
      .from('team_join_requests')
      .select('id', { count: 'exact', head: true })
      .eq('team_id', teamId)
      .then(({ count: n }) => {
        if (live) setCount(n ?? 0)
      })
    return () => {
      live = false
    }
  }, [teamId, enabled, refreshKey])
  return count
}

function useJoinRequestRpc(rpc: string, arg: 'p_team_id' | 'p_request_id') {
  const fn = useCallback(async (params: { id: number }) => {
    const { error } = await supabase.rpc(rpc, { [arg]: params.id })
    if (error) throw new Error(error.message)
    return true
  }, [rpc, arg])
  return useApiCall<boolean, { id: number }>(fn)
}

export const useRequestToJoin = () => useJoinRequestRpc('request_to_join', 'p_team_id')
export const useCancelJoinRequest = () => useJoinRequestRpc('cancel_join_request', 'p_request_id')
export const useApproveJoinRequest = () => useJoinRequestRpc('approve_join_request', 'p_request_id')
export const useDenyJoinRequest = () => useJoinRequestRpc('deny_join_request', 'p_request_id')

export function useRevokeInvite() {
  const fn = useCallback(async (params: { inviteId: number }) => {
    const { error } = await supabase.rpc('revoke_invite', { p_invite_id: params.inviteId })
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { inviteId: number }>(fn)
}

export function useSetMemberRole() {
  const fn = useCallback(async (params: { teamId: number; userId: string; role: TeamRole }) => {
    const { error } = await supabase.rpc('set_member_role', {
      p_team_id: params.teamId,
      p_user_id: params.userId,
      p_role: params.role,
    })
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { teamId: number; userId: string; role: TeamRole }>(fn)
}

export function useRemoveMember() {
  const fn = useCallback(async (params: { teamId: number; userId: string }) => {
    const { error } = await supabase.rpc('remove_member', {
      p_team_id: params.teamId,
      p_user_id: params.userId,
    })
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { teamId: number; userId: string }>(fn)
}

// One transaction on purpose: promote + demote must land together so the
// last-captain trigger can never see an empty captain set mid-transfer.
// transfer_captainship.sql documents the promote-before-demote ordering.
export function useTransferCaptainship() {
  const fn = useCallback(async (params: { teamId: number; newCaptainUserId: string }) => {
    const { error } = await supabase.rpc('transfer_captainship', {
      p_team_id: params.teamId,
      p_new_captain_id: params.newCaptainUserId,
    })
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { teamId: number; newCaptainUserId: string }>(fn)
}

export function useDeleteTeam() {
  const fn = useCallback(async (params: { teamId: number }) => {
    const { error } = await supabase.from('organizations').delete().eq('id', params.teamId)
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { teamId: number }>(fn)
}

export function useUpdateTeam() {
  const fn = useCallback(
    async (params: { teamId: number; name?: string; isPublic?: boolean; photoUrl?: string }) => {
      const body: Record<string, unknown> = {}
      if (params.name !== undefined) body.name = params.name
      if (params.isPublic !== undefined) body.is_public = params.isPublic
      if (params.photoUrl !== undefined) body.photo_url = params.photoUrl
      const { error } = await supabase.from('organizations').update(body).eq('id', params.teamId)
      if (error) throw new Error(error.message)
      return true
    },
    []
  )
  return useApiCall<boolean, { teamId: number; name?: string; isPublic?: boolean; photoUrl?: string }>(fn)
}
