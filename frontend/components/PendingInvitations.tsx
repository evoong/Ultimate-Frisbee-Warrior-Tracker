import { useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { useMyInvites, useRespondToInvite, type MyInvite } from '../hooks/backend/teams'
import { track } from '../lib/analytics'
import { Button } from '../lib/shadcn/button'

// Invitations addressed to the signed-in user's own email. Nothing is joined
// until they press Accept; Decline deletes the invite.
export function InviteCards({ invites, onChanged }: { invites: MyInvite[]; onChanged: () => Promise<void> }) {
  const { refreshSession } = useAuth()
  const respond = useRespondToInvite()
  return (
    <div className="space-y-2">
      {respond.error && <p className="text-sm text-destructive">{respond.error}</p>}
      {invites.map(i => (
        <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
          <div className="min-w-0">
            <p className="font-medium">
              {i.team_name} <span className="font-normal text-muted-foreground">· {i.role}</span>
            </p>
            {i.invited_by_email && (
              <p className="truncate text-xs text-muted-foreground">Invited by {i.invited_by_email}</p>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={respond.loading}
              onClick={async () => {
                if (await respond.trigger({ inviteId: i.id, accept: false })) {
                  track('team_invite_declined', { invite_id: i.id })
                  await onChanged()
                }
              }}
            >
              Decline
            </Button>
            <Button
              size="sm"
              disabled={respond.loading}
              onClick={async () => {
                if (await respond.trigger({ inviteId: i.id, accept: true })) {
                  track('team_invite_accepted', { invite_id: i.id })
                  await refreshSession()
                  await onChanged()
                }
              }}
            >
              {respond.loading && <Loader2 className="mr-2 size-4 animate-spin" />}
              Accept
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}

// Banner for users who are already on a team and get invited to another.
export default function PendingInvitations() {
  const invites = useMyInvites()
  useEffect(() => {
    void invites.trigger()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (!invites.data?.length) return null
  return (
    <div className="border-b bg-muted/60 px-4 py-3">
      <p className="mb-2 text-sm font-medium">You've been invited to a team</p>
      <InviteCards invites={invites.data} onChanged={async () => { await invites.trigger() }} />
    </div>
  )
}
