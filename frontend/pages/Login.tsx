import { useMemo, useState, type FormEvent } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { Button } from '../lib/shadcn/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../lib/shadcn/card'
import { Input } from '../lib/shadcn/input'
import { Label } from '../lib/shadcn/label'
import { Loader2, LogOut } from 'lucide-react'

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  login_expired: 'The sign-in attempt took too long. Please try again.',
  oauth_exchange_failed: 'Google sign-in failed. Please try again.',
  verify_failed: 'That link is invalid or has expired. Request a new one.',
  missing_code: 'Sign-in was interrupted. Please try again.',
}

type Mode = 'login' | 'signup' | 'forgot'

export default function Login() {
  const { user, allowed, login, signup, loginWithGoogle, logout, forgotPassword } = useAuth()
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const urlError = useMemo(() => {
    const code = new URLSearchParams(window.location.search).get('auth_error')
    if (!code) return null
    return AUTH_ERROR_MESSAGES[code] ?? 'Sign-in failed. Please try again.'
  }, [])

  const notAllowed = user !== null && !allowed

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      if (mode === 'login') {
        await login(email, password)
      } else if (mode === 'signup') {
        const { confirmationRequired } = await signup(email, password)
        if (confirmationRequired) {
          setNotice('Almost there — check your email to confirm your account.')
        }
      } else {
        await forgotPassword(email)
        setNotice('If that email has an account, a reset link is on its way.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-primary">⚡ Warrior Tracker</h1>
          <p className="text-sm text-muted-foreground mt-1">Team access only</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>
              {mode === 'login' && 'Sign in'}
              {mode === 'signup' && 'Create account'}
              {mode === 'forgot' && 'Reset password'}
            </CardTitle>
            <CardDescription>
              {mode === 'forgot'
                ? 'Enter your email and we will send a reset link.'
                : 'Use your team email to continue.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {notAllowed ? (
              <div className="space-y-4">
                <p className="text-sm rounded-md border border-border bg-accent p-3">
                  You are signed in as <strong>{user.email}</strong>, but this account is not on
                  the team list yet. Ask the team admin to add your email.
                </p>
                <Button variant="outline" className="w-full" onClick={() => logout()}>
                  <LogOut className="w-4 h-4 mr-2" />
                  Sign out
                </Button>
              </div>
            ) : (
              <>
                {urlError && !error && !notice && (
                  <p className="text-sm text-destructive">{urlError}</p>
                )}
                {error && <p className="text-sm text-destructive">{error}</p>}
                {notice && <p className="text-sm text-primary">{notice}</p>}

                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      autoComplete="email"
                      required
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                    />
                  </div>
                  {mode !== 'forgot' && (
                    <div className="space-y-2">
                      <Label htmlFor="password">Password</Label>
                      <Input
                        id="password"
                        type="password"
                        autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                        required
                        minLength={8}
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                      />
                    </div>
                  )}
                  <Button type="submit" className="w-full" disabled={busy}>
                    {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    {mode === 'login' && 'Sign in'}
                    {mode === 'signup' && 'Sign up'}
                    {mode === 'forgot' && 'Send reset link'}
                  </Button>
                </form>

                {mode !== 'forgot' && (
                  <>
                    <div className="relative">
                      <div className="absolute inset-0 flex items-center">
                        <span className="w-full border-t border-border" />
                      </div>
                      <div className="relative flex justify-center text-xs">
                        <span className="bg-card px-2 text-muted-foreground">or</span>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      onClick={loginWithGoogle}
                    >
                      Continue with Google
                    </Button>
                  </>
                )}

                <div className="flex justify-between text-xs text-muted-foreground">
                  {mode === 'login' ? (
                    <>
                      <button
                        type="button"
                        className="hover:text-foreground underline-offset-2 hover:underline"
                        onClick={() => {
                          setMode('signup')
                          setError(null)
                          setNotice(null)
                        }}
                      >
                        Create account
                      </button>
                      <button
                        type="button"
                        className="hover:text-foreground underline-offset-2 hover:underline"
                        onClick={() => {
                          setMode('forgot')
                          setError(null)
                          setNotice(null)
                        }}
                      >
                        Forgot password?
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="hover:text-foreground underline-offset-2 hover:underline"
                      onClick={() => {
                        setMode('login')
                        setError(null)
                        setNotice(null)
                      }}
                    >
                      Back to sign in
                    </button>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
