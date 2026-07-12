import { useCallback, useState } from 'react'
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

export type OrganizationMember = { id: number; organization_id: number; email: string; role: 'owner' | 'member' }

export function useGetOrganizationMembers() {
  const fn = useCallback(async (params: { organizationId: number }) => {
    const { data, error } = await supabase
      .from('organization_members')
      .select('*')
      .eq('organization_id', params.organizationId)
      .order('role')
      .order('email')
    if (error) throw new Error(error.message)
    return (data ?? []) as OrganizationMember[]
  }, [])
  return useApiCall<OrganizationMember[], { organizationId: number }>(fn)
}

export function useAddOrganizationMember() {
  const fn = useCallback(async (params: { organizationId: number; email: string }) => {
    const { error } = await supabase
      .from('organization_members')
      .insert({ organization_id: params.organizationId, email: params.email.trim().toLowerCase(), role: 'member' })
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { organizationId: number; email: string }>(fn)
}

export function useRemoveOrganizationMember() {
  const fn = useCallback(async (params: { memberId: number }) => {
    const { error } = await supabase.from('organization_members').delete().eq('id', params.memberId)
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { memberId: number }>(fn)
}

export function useUpdateOrganization() {
  const fn = useCallback(async (params: { organizationId: number; name?: string; isPublic?: boolean }) => {
    const body: Record<string, unknown> = {}
    if (params.name !== undefined) body.name = params.name
    if (params.isPublic !== undefined) body.is_public = params.isPublic
    const { error } = await supabase.from('organizations').update(body).eq('id', params.organizationId)
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { organizationId: number; name?: string; isPublic?: boolean }>(fn)
}
