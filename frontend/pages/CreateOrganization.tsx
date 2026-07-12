import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { Button } from '../lib/shadcn/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../lib/shadcn/card'
import { Input } from '../lib/shadcn/input'
import { Label } from '../lib/shadcn/label'
import { Loader2, Users } from 'lucide-react'

type JoinableOrg = { id: number; name: string }

// Blocking onboarding screen: shown whenever a signed-in user has zero
// organization memberships. They either create a brand-new team (becoming
// its owner) or join one that already exists. Every domain table requires
// an organization_id, so there is nothing to show until one of the two
// happens.
export default function CreateOrganization() {
  const { createOrganization, joinOrganization, logout, user } = useAuth()
  const [name, setName] = useState('')
  const [existingOrgs, setExistingOrgs] = useState<JoinableOrg[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    supabase
      .from('organizations')
      .select('id, name')
      .order('name')
      .then(({ data }) => setExistingOrgs((data ?? []) as JoinableOrg[]))
  }, [])

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Give your team a name.')
      return
    }
    setBusy(true)
    try {
      await createOrganization(trimmed)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create your team')
    } finally {
      setBusy(false)
    }
  }

  async function handleJoin(orgId: number) {
    setError(null)
    setBusy(true)
    try {
      await joinOrganization(orgId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join that team')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Join or create a team</CardTitle>
          <CardDescription>
            {user?.email ? `Signed in as ${user.email}. ` : ''}
            A team holds your seasons, games, roster, and stats.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <p className="text-sm text-destructive">{error}</p>}

          {existingOrgs === null ? (
            <div className="flex justify-center py-2">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          ) : existingOrgs.length > 0 ? (
            <div className="space-y-2">
              <Label>Join an existing team</Label>
              {existingOrgs.map(org => (
                <div key={org.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
                  <Users className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="flex-1 text-sm truncate">{org.name}</span>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => handleJoin(org.id)}>
                    Join
                  </Button>
                </div>
              ))}
              <div className="flex items-center gap-3 py-1">
                <div className="h-px flex-1 bg-border" />
                <span className="text-xs text-muted-foreground">or</span>
                <div className="h-px flex-1 bg-border" />
              </div>
            </div>
          ) : null}

          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="org-name">Create a new team</Label>
              <Input
                id="org-name"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Disc-iples"
              />
            </div>

            <Button type="submit" className="w-full" disabled={busy}>
              {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Create team
            </Button>

            <button
              type="button"
              onClick={() => logout()}
              className="w-full text-xs text-muted-foreground hover:text-foreground text-center"
            >
              Sign out
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
