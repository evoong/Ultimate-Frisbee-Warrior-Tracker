import { useCallback, useState } from 'react'
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
