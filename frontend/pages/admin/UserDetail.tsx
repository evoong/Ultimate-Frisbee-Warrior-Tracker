import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { AdminRequestError, adminGet, adminOp } from '../../lib/adminClient'
import OperationDialog from './OperationDialog'

interface User {
  id: string
  email: string
  created_at: string
  last_sign_in_at: string
}

interface Membership {
  team_id: number
  organization_name: string
  role: string
  created_at: string
}

interface PlayerLink {
  id: number
  team_id: number
  player_id: number
  player_name: string
  status: string
}

interface State {
  user: User
  memberships: Membership[]
  player_links: PlayerLink[]
}

export default function UserDetail() {
  const { userId } = useParams<{ userId: string }>()
  const [data, setData] = useState<State | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const [dialog, setDialog] = useState<{
    name: string
    title: string
    input: Record<string, unknown>
    confirmPhrase?: string
  } | null>(null)

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    setBusy(true)
    setError(null)
    adminGet<State>(`/user/${encodeURIComponent(userId)}`)
      .then(res => { if (!cancelled) setData(res) })
      .catch(err => { if (!cancelled) setError((err as AdminRequestError).message) })
      .finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [userId])

  function openSetMemberRole(membership: Membership) {
    setDialog({
      name: 'set_member_role',
      title: 'Change Member Role',
      input: { team_id: membership.team_id, user_id: userId!, role: 'editor' },
    })
  }

  function openApprovePlayerLink(link: PlayerLink) {
    setDialog({
      name: 'approve_player_link',
      title: 'Approve Player Link',
      input: { link_id: link.id },
    })
  }

  function closeDialog() {
    setDialog(null)
  }

  if (busy) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (error) return <p className="text-sm text-destructive">Could not load user: {error}</p>
  if (!data) return null

  return (
    <div className="flex flex-col gap-6 text-sm">
      <div>
        <h1 className="text-xl font-semibold">{data.user.email}</h1>
        <p className="text-xs text-muted-foreground">
          Created {new Date(data.user.created_at).toLocaleDateString()} ·
          Last sign-in {new Date(data.user.last_sign_in_at).toLocaleDateString()}
        </p>
      </div>

      <section>
        <h2 className="font-semibold mb-2">Memberships</h2>
        {data.memberships.length === 0 ? (
          <p className="text-sm text-muted-foreground">No team memberships.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.memberships.map(m => (
              <li key={m.team_id} className="flex items-center justify-between rounded border bg-background p-3">
                <div>
                  <code className="font-medium">{m.organization_name}</code>
                  <span className="ml-2 text-xs text-muted-foreground">({m.role})</span>
                </div>
                <button
                  className="rounded border px-2 py-1 text-xs"
                  onClick={() => openSetMemberRole(m)}
                >
                  Change Role
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="font-semibold mb-2">Player Links</h2>
        {data.player_links.length === 0 ? (
          <p className="text-sm text-muted-foreground">No pending player links.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.player_links.map(l => (
              <li key={l.id} className="flex items-center justify-between rounded border bg-background p-3">
                <div>
                  <code className="font-medium">{l.player_name}</code>
                  <span className="ml-2 text-xs text-muted-foreground">({l.status})</span>
                </div>
                {l.status === 'pending' && (
                  <button
                    className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground"
                    onClick={() => openApprovePlayerLink(l)}
                  >
                    Approve
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {dialog && (
        <OperationDialog
          name={dialog.name}
          title={dialog.title}
          input={dialog.input}
          confirmPhrase={dialog.confirmPhrase}
          onDone={closeDialog}
          onCancel={closeDialog}
        />
      )}
    </div>
  )
}