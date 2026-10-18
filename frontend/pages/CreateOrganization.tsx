import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useCancelJoinRequest, useGetJoinRequests, useRequestToJoin } from '../hooks/backend/teams'
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
  const { createTeam, logout, user, refreshSession } = useAuth()
  const [publicTeams, setPublicTeams] = useState<{ id: number; name: string }[]>([])
  const [checking, setChecking] = useState(false)
  const requests = useGetJoinRequests()
  const requestJoin = useRequestToJoin()
  const cancelRequest = useCancelJoinRequest()
  const myRequests = requests.data ?? []

  useEffect(() => {
    // A user on this screen belongs to no team, so the read policy returns
    // public teams only -- no is_public filter needed here.
    supabase.from('organizations').select('id,name').order('name')
      .then(({ data }) => setPublicTeams(data ?? []))
    void requests.trigger({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // accept_invite() only runs when the session is loaded, so an invite sent
  // after sign-in is invisible until something re-reads the session.
  async function checkForInvites() {
    setChecking(true)
    try {
      await refreshSession()
    } finally {
      setChecking(false)
    }
  }
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

  // Guests never reach this screen: App.tsx gates it on `!isGuest` and sends
  // a guest to the public-teams browser instead. That is also why there is no
  // guest branch here -- guests can't create a team (create_team rejects them
  // server-side) and have no invite to accept, so a create-team form would be
  // a control they cannot submit.
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
            Ask their captain to invite {user?.email}, then check below -- there's
            nothing to accept.
          </p>
          <Button variant="outline" size="sm" className="mt-2" onClick={checkForInvites} disabled={checking}>
            {checking && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Check for invites
          </Button>
        </div>

        {publicTeams.length > 0 && (
          <div className="rounded-md border p-3 text-sm">
            <p className="font-medium">Or request to join a public team</p>
            {(requestJoin.error || cancelRequest.error) && (
              <p className="mt-1 text-destructive">{requestJoin.error || cancelRequest.error}</p>
            )}
            <ul className="mt-2 space-y-2">
              {publicTeams.map(t => {
                const pending = myRequests.find(r => r.team_id === t.id)
                return (
                  <li key={t.id} className="flex items-center justify-between gap-2">
                    <span className="truncate">{t.name}</span>
                    <Button
                      size="sm"
                      variant={pending ? 'ghost' : 'outline'}
                      onClick={async () => {
                        const ok = pending
                          ? await cancelRequest.trigger({ id: pending.id })
                          : await requestJoin.trigger({ id: t.id })
                        if (ok) await requests.trigger({})
                      }}
                    >
                      {pending ? 'Requested · Cancel' : 'Request to join'}
                    </Button>
                  </li>
                )
              })}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              A captain or editor approves your request; check back with "Check for invites" afterwards.
            </p>
          </div>
        )}

        <Button variant="ghost" className="w-full" onClick={logout}>Sign out</Button>
      </CardContent>
    </Card>
  )
}
