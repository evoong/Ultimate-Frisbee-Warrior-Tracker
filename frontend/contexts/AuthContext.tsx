import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import * as authClient from '../lib/authClient'
import type { AuthUser, TeamMembership, TeamRole } from '../lib/authClient'
import { supabase } from '../lib/supabase'
import { posthog } from '../lib/posthog'
import { track } from '../lib/analytics'

const CURRENT_TEAM_STORAGE_KEY = 'ufwt_current_team_id'

export interface Capabilities {
  /**
   * Enter game data: events, scores, lineups, strategy. Member and up.
   * This also covers creating a player or a season in the flow of
   * recording a game or building a lineup (Schedule.tsx, Strategy.tsx),
   * which matches the database: `players` and `seasons` are member-tier
   * for insert/update/delete, not manage-tier.
   */
  record: boolean
  /**
   * Team-level settings (name, photo, public/private) plus roster
   * ADMINISTRATION on the Roster page -- editing a player's details or
   * photo, and season membership. Editor and up.
   *
   * The database is more permissive than this gate: `players` and
   * `seasons` are member-tier there too, so a plain member could do this
   * over the RPC/REST layer directly. Roster.tsx gating on manageTeam is
   * deliberately stricter than the database requires -- this is UX
   * policy (keep casual roster edits to editor/captain), not the
   * security boundary. Do not read this gate as a statement of what the
   * database enforces.
   */
  manageTeam: boolean
  /** Grant roles, remove editors and captains, delete the team. Captain. */
  manageRoles: boolean
}

interface AuthContextValue {
  user: AuthUser | null
  teams: TeamMembership[]
  currentTeamId: number | null
  role: TeamRole | null
  can: Capabilities
  isGuest: boolean
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  signup: (email: string, password: string) => Promise<{ confirmationRequired: boolean }>
  loginWithGoogle: () => void
  loginWithPasskey: () => Promise<void>
  loginAsGuest: () => Promise<void>
  logout: () => Promise<void>
  forgotPassword: (email: string) => Promise<void>
  switchTeam: (teamId: number) => void
  createTeam: (name: string) => Promise<void>
  /**
   * Re-fetch session state (user, teams, current team) without a full
   * login. Nothing else refreshes `teams` after a team UPDATE -- call
   * this after a successful team rename/photo/visibility save so the
   * settings dialog and team switcher reflect the change immediately
   * instead of only after a page reload.
   */
  refreshSession: () => Promise<void>
}

const NO_CAPABILITIES: Capabilities = { record: false, manageTeam: false, manageRoles: false }

function capabilitiesFor(role: TeamRole | null): Capabilities {
  switch (role) {
    case 'captain': return { record: true, manageTeam: true, manageRoles: true }
    case 'editor':  return { record: true, manageTeam: true, manageRoles: false }
    case 'member':  return { record: true, manageTeam: false, manageRoles: false }
    default:        return NO_CAPABILITIES
  }
}

const AuthContext = createContext<AuthContextValue | null>(null)

function readStoredTeamId(): number | null {
  const raw = localStorage.getItem(CURRENT_TEAM_STORAGE_KEY)
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [teams, setTeams] = useState<TeamMembership[]>([])
  const [isGuest, setIsGuest] = useState(false)
  const [currentTeamId, setCurrentTeamId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  const refreshSessionState = useCallback(async () => {
    const session = await authClient.getSession()
    setUser(session.user)
    if (session.user) posthog.identify(session.user.id, { email: session.user.email })
    setTeams(session.teams)
    setIsGuest(session.isAnonymous)
    setCurrentTeamId(prev => {
      const stored = prev ?? readStoredTeamId()
      if (stored != null && session.teams.some(t => t.organization_id === stored)) return stored
      return session.teams[0]?.organization_id ?? null
    })
  }, [])

  useEffect(() => {
    refreshSessionState().finally(() => setLoading(false))
  }, [refreshSessionState])

  useEffect(() => {
    if (currentTeamId != null) localStorage.setItem(CURRENT_TEAM_STORAGE_KEY, String(currentTeamId))
  }, [currentTeamId])

  const role = useMemo(
    () => teams.find(t => t.organization_id === currentTeamId)?.role ?? null,
    [teams, currentTeamId]
  )
  // A guest holds no role on any team, so capabilities collapse to nothing
  // without a separate guest branch. The database agrees independently.
  const can = useMemo(() => (isGuest ? NO_CAPABILITIES : capabilitiesFor(role)), [isGuest, role])

  const login = useCallback(
    async (email: string, password: string) => {
      await authClient.login(email, password)
      await refreshSessionState()
      track('user_logged_in')
    },
    [refreshSessionState]
  )

  const signup = useCallback(
    async (email: string, password: string) => {
      const result = await authClient.signup(email, password)
      track('user_signed_up')
      if (!result.confirmationRequired) await refreshSessionState()
      return { confirmationRequired: result.confirmationRequired }
    },
    [refreshSessionState]
  )

  const loginWithPasskey = useCallback(async () => {
    await authClient.signInWithPasskey()
    await refreshSessionState()
    track('user_logged_in', { via: 'passkey' })
  }, [refreshSessionState])

  const loginAsGuest = useCallback(async () => {
    await authClient.loginAsGuest()
    await refreshSessionState()
  }, [refreshSessionState])

  const logout = useCallback(async () => {
    await authClient.logout()
    track('user_logged_out')
    posthog.reset()
    setUser(null)
    setTeams([])
    setIsGuest(false)
    setCurrentTeamId(null)
  }, [])

  const forgotPassword = useCallback(async (email: string) => {
    await authClient.forgotPassword(email)
    track('password_reset_requested')
  }, [])

  const switchTeam = useCallback((teamId: number) => {
    setCurrentTeamId(teamId)
  }, [])

  // One RPC, not an insert plus an insert. The atomicity is why team_members
  // needs no self-insert policy at all -- see the design spec.
  const createTeam = useCallback(
    async (name: string) => {
      const { data, error } = await supabase.rpc('create_team', { p_name: name })
      if (error) throw new Error(error.message)
      await refreshSessionState()
      setCurrentTeamId(Number(data))
      track('team_created', { organization_id: Number(data) })
    },
    [refreshSessionState]
  )

  // joinOrganization was removed deliberately. Open self-join let any signed-in
  // user insert themselves into any team; membership now originates only from
  // an invite issued by someone who already holds the power to grant it.

  return (
    <AuthContext.Provider
      value={{
        user,
        teams,
        currentTeamId,
        role,
        can,
        isGuest,
        loading,
        login,
        signup,
        loginWithGoogle: authClient.loginWithGoogle,
        loginWithPasskey,
        loginAsGuest,
        logout,
        forgotPassword,
        switchTeam,
        createTeam,
        refreshSession: refreshSessionState,
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
