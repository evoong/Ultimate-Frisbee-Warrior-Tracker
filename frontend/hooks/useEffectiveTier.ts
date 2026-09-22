import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export type OrgTier = 'free' | 'plus' | 'premium'

export interface EffectiveTierResult {
  tier: OrgTier
  isEmployeeGranted: boolean
  trialEndsAt: string | null
  planSource: 'stripe' | 'employee_grant' | 'trial'
}

export async function fetchEffectiveTier(orgId: number): Promise<EffectiveTierResult> {
  const { data, error } = await supabase.rpc('effective_tier', { p_org_id: orgId })
  if (error) throw error

  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .select('is_employee_granted, trial_ends_at, plan_source')
    .eq('id', orgId)
    .single()

  if (orgError) throw orgError

  return {
    tier: data as OrgTier,
    isEmployeeGranted: org?.is_employee_granted ?? false,
    trialEndsAt: org?.trial_ends_at ?? null,
    planSource: org?.plan_source ?? 'trial',
  }
}

export function useEffectiveTier(orgId: number | null) {
  const [result, setResult] = useState<EffectiveTierResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    if (!orgId) {
      setResult(null)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    fetchEffectiveTier(orgId)
      .then((res) => {
        if (!cancelled) setResult(res)
      })
      .catch((err) => {
        if (!cancelled) setError(err)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [orgId, refreshKey])

  const refresh = useCallback(() => {
    setRefreshKey(k => k + 1)
  }, [])

  return { tier: result?.tier ?? null, ...result, loading, error, refresh }
}