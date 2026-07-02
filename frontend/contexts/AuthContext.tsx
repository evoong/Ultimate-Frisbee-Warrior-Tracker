import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import * as authClient from '../lib/authClient'
import type { AuthUser } from '../lib/authClient'

interface AuthContextValue {
  user: AuthUser | null
  allowed: boolean
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  signup: (email: string, password: string) => Promise<{ confirmationRequired: boolean }>
  loginWithGoogle: () => void
  logout: () => Promise<void>
  forgotPassword: (email: string) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [allowed, setAllowed] = useState(false)
  const [loading, setLoading] = useState(true)

  const refreshSessionState = useCallback(async () => {
    const session = await authClient.getSession()
    setUser(session.user)
    setAllowed(session.allowed)
  }, [])

  useEffect(() => {
    refreshSessionState().finally(() => setLoading(false))
  }, [refreshSessionState])

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

  const logout = useCallback(async () => {
    await authClient.logout()
    setUser(null)
    setAllowed(false)
  }, [])

  return (
    <AuthContext.Provider
      value={{
        user,
        allowed,
        loading,
        login,
        signup,
        loginWithGoogle: authClient.loginWithGoogle,
        logout,
        forgotPassword: authClient.forgotPassword,
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
