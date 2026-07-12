import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import * as authClient from '../lib/authClient'
import type { AuthUser, OrgMembership } from '../lib/authClient'
import { supabase } from '../lib/supabase'

const CURRENT_ORG_STORAGE_KEY = 'ufwt_current_org_id'

interface AuthContextValue {
  user: AuthUser | null
  organizations: OrgMembership[]
  currentOrgId: number | null
  allowed: boolean
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  signup: (email: string, password: string) => Promise<{ confirmationRequired: boolean }>
  loginWithGoogle: () => void
  loginWithPasskey: () => Promise<void>
  logout: () => Promise<void>
  forgotPassword: (email: string) => Promise<void>
  switchOrg: (organizationId: number) => void
  createOrganization: (name: string) => Promise<void>
  joinOrganization: (organizationId: number) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

function readStoredOrgId(): number | null {
  const raw = localStorage.getItem(CURRENT_ORG_STORAGE_KEY)
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [organizations, setOrganizations] = useState<OrgMembership[]>([])
  const [currentOrgId, setCurrentOrgId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  const refreshSessionState = useCallback(async () => {
    const session = await authClient.getSession()
    setUser(session.user)
    setOrganizations(session.organizations)
    setCurrentOrgId(prev => {
      const stored = prev ?? readStoredOrgId()
      if (stored != null && session.organizations.some(o => o.organization_id === stored)) return stored
      return session.organizations[0]?.organization_id ?? null
    })
  }, [])

  useEffect(() => {
    refreshSessionState().finally(() => setLoading(false))
  }, [refreshSessionState])

  useEffect(() => {
    if (currentOrgId != null) localStorage.setItem(CURRENT_ORG_STORAGE_KEY, String(currentOrgId))
  }, [currentOrgId])

  const login = useCallback(
    async (email: string, password: string) => {
      await authClient.login(email, password)
      await refreshSessionState()
    },
    [refreshSessionState]
  )

  const signup = useCallback(
    async (email: string, password: string) => {
      const result = await authClient.signup(email, password)
      if (!result.confirmationRequired) await refreshSessionState()
      return { confirmationRequired: result.confirmationRequired }
    },
    [refreshSessionState]
  )

  const loginWithPasskey = useCallback(async () => {
    await authClient.signInWithPasskey()
    await refreshSessionState()
  }, [refreshSessionState])

  const logout = useCallback(async () => {
    await authClient.logout()
    setUser(null)
    setOrganizations([])
    setCurrentOrgId(null)
  }, [])

  const switchOrg = useCallback((organizationId: number) => {
    setCurrentOrgId(organizationId)
  }, [])

  // Creates a brand-new organization and joins the current user as its
  // owner, in the same action, then switches to it. Used both by the
  // "create your organization" onboarding screen (zero memberships) and by
  // an existing member creating an additional organization later.
  const createOrganization = useCallback(
    async (name: string) => {
      if (!user) throw new Error('not signed in')
      const { data: org, error: orgError } = await supabase
        .from('organizations')
        .insert({ name })
        .select()
        .single()
      if (orgError) throw new Error(orgError.message)
      const { error: memberError } = await supabase
        .from('organization_members')
        .insert({ organization_id: org.id, email: user.email, role: 'owner' })
      if (memberError) throw new Error(memberError.message)
      await refreshSessionState()
      setCurrentOrgId(org.id)
    },
    [user, refreshSessionState]
  )

  // Joins an existing organization as a regular member and switches to it.
  // Open self-join is intentional for now: access is fully open during the
  // soft launch (017_open_access_for_now.sql), and 016's RLS insert policy
  // already allows inserting a membership row for your own email.
  const joinOrganization = useCallback(
    async (organizationId: number) => {
      if (!user) throw new Error('not signed in')
      const { error } = await supabase
        .from('organization_members')
        .insert({ organization_id: organizationId, email: user.email, role: 'member' })
      if (error) throw new Error(error.message)
      await refreshSessionState()
      setCurrentOrgId(organizationId)
    },
    [user, refreshSessionState]
  )

  // Soft launch (app not released yet): every signed-in user gets write
  // access everywhere, matching the any-authenticated RLS in
  // 017_open_access_for_now.sql. When isolation is wanted, restore this to
  // membership in the current org:
  //   currentOrgId != null && organizations.some(o => o.organization_id === currentOrgId)
  const allowed = user != null

  return (
    <AuthContext.Provider
      value={{
        user,
        organizations,
        currentOrgId,
        allowed,
        loading,
        login,
        signup,
        loginWithGoogle: authClient.loginWithGoogle,
        loginWithPasskey,
        logout,
        forgotPassword: authClient.forgotPassword,
        switchOrg,
        createOrganization,
        joinOrganization,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
