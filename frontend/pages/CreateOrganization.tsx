import { useState, type FormEvent } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { Button } from '../lib/shadcn/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../lib/shadcn/card'
import { Input } from '../lib/shadcn/input'
import { Loader2 } from 'lucide-react'

// Blocking onboarding screen: shown whenever a signed-in user has zero team
// memberships. Every domain table requires an organization_id, so there is
// nothing to show until the user has a team.
//
// There used to be a second path here -- browse every organization and join
// one directly. That was an open self-join: any signed-in user could insert
// themselves into any team. Membership now only arrives via an invite issued
// by someone who already holds the power to grant it (captain/editor), so
// the only actions left are "create a new team" or "wait for an invite".
export default function CreateOrganization() {
  const { createTeam, logout, user, isGuest } = useAuth()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    try {
      await createTeam(trimmed)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create your team')
    } finally {
      setBusy(false)
    }
  }

  // Guests can't create a team (the create_team RPC rejects them server-side)
  // and have no invite to accept either, so the create-team form -- a
  // control that writes -- must never render for them. A dedicated public
  // teams browser for guests is Task 10; until that lands, give guests an
  // explanation instead of a form they cannot submit.
  if (isGuest) {
    return (
      <Card className="mx-auto mt-16 max-w-md">
        <CardHeader>
          <CardTitle>You're browsing as a guest</CardTitle>
          <CardDescription>
            Guests can't create or join a team. Sign in with an account and
            ask a captain to invite you, or look for a public team to follow.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="ghost" className="w-full" onClick={logout}>Sign out</Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="mx-auto mt-16 max-w-md">
      <CardHeader>
        <CardTitle>Create your team</CardTitle>
        <CardDescription>
          You're signed in as {user?.email}, but you're not on a team yet.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleCreate} className="space-y-3">
          <Input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Team name"
            autoFocus
          />
          <Button type="submit" className="w-full" disabled={busy || !name.trim()}>
            {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Create team
          </Button>
        </form>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Joining someone else's team?</p>
          <p className="mt-1">
            Ask their captain to invite {user?.email}. Once they do, sign in
            again and you'll be on the team -- there's nothing to accept.
          </p>
        </div>

        <Button variant="ghost" className="w-full" onClick={logout}>Sign out</Button>
      </CardContent>
    </Card>
  )
}
