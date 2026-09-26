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
  organization_id: number
  name: string
  role: string
  since: string
}

interface PlayerLink {
  link_id: number
  organization_id: number
  player_id: number
  display_name: string
  status: string
}

interface State {
  user: User
  memberships: Membership[]
  player_links: PlayerLink[]
  pending_invites: any[]
  feedback_report_count?: number
  metrics?: {
    events_recorded: number
    chat_messages: number
    last_event_at: string | null
  }
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="nav-mono mt-1 text-lg font-semibold">{value}</p>
    </div>
  )
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
      input: { team_id: membership.organization_id, user_id: userId!, role: 'editor' },
    })
  }

  function openApprovePlayerLink(link: PlayerLink) {
    setDialog({
      name: 'approve_player_link',
      title: 'Approve Player Link',
      input: { link_id: link.link_id },
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
          Last sign-in {data.user.last_sign_in_at ? new Date(data.user.last_sign_in_at).toLocaleDateString() : 'never'}
        </p>
      </div>

      {data.metrics && (
        <section>
          <h2 className="font-semibold mb-2">Usage</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Events recorded" value={data.metrics.events_recorded.toLocaleString()} />
            <Stat label="Chat messages" value={data.metrics.chat_messages.toLocaleString()} />
            <Stat
              label="Last event"
              value={data.metrics.last_event_at ? new Date(data.metrics.last_event_at).toLocaleDateString() : '—'}
            />
            <Stat label="Feedback reports" value={(data.feedback_report_count ?? 0).toLocaleString()} />
          </div>
        </section>
      )}

      <section>
        <h2 className="font-semibold mb-2">Memberships</h2>
        {data.memberships.length === 0 ? (
          <p className="text-sm text-muted-foreground">No team memberships.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.memberships.map(m => (
              <li key={m.organization_id} className="flex items-center justify-between rounded border bg-background p-3">
                <div>
                  <code className="font-medium">{m.name}</code>
                  <span className="ml-2 text-xs text-muted-foreground">({m.role})</span>
                  <span className="ml-2 text-xs text-muted-foreground">joined {new Date(m.since).toLocaleDateString()}</span>
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
              <li key={l.link_id} className="flex items-center justify-between rounded border bg-background p-3">
                <div>
                  <code className="font-medium">{l.display_name}</code>
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