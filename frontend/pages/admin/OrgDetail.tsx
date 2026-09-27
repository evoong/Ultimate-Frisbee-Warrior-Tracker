import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { adminGet, adminOp, adminRoleAtLeast, useAdminRole } from '../../lib/adminClient'
import { Skeleton } from '../../lib/shadcn/skeleton'
import { Button } from '../../lib/shadcn/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from '../../lib/shadcn/dialog'
import { Input } from '../../lib/shadcn/input'
import { Label } from '../../lib/shadcn/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../lib/shadcn/select'
import OperationDialog from './OperationDialog'

type Member = { user_id: string; email: string; role: 'captain' | 'editor' | 'member' }
type FlagRow = {
  key: string
  description: string
  default_on: boolean
  override: boolean | null
  effective: boolean
}
type OrgDetailPayload = {
  organization: { id: number; name: string; is_public: boolean; created_at: string }
  members: Member[]
  teams: { id: number; name: string }[]
  counts: { games: number; players: number; seasons: number }
  pending_invites: { id: number; email: string; role: string; expires_at: string }[]
  legacy_organization_members: { role: string; email: string }[]
  metrics?: {
    chat_messages: number
    game_events: number
    strategy_plays: number
    attendance: number
    last_activity: string | null
  }
  feature_flags?: FlagRow[]
}

const TEAM_ROLES = ['captain', 'editor', 'member'] as const
const INVITE_ROLES = ['editor', 'member'] as const

export default function OrgDetail({ orgId: propOrgId }: { orgId?: string }) {
  const { orgId: paramOrgId } = useParams<{ orgId: string }>()
  const orgId = propOrgId ?? paramOrgId!
  const navigate = useNavigate()
  const { role } = useAdminRole()
  const [data, setData] = useState<OrgDetailPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'editor' | 'member'>('editor')
  const [dialog, setDialog] = useState<{
    name: string
    title: string
    input: Record<string, unknown>
    confirmPhrase?: string
  } | null>(null)

  async function refresh() {
    setLoading(true)
    setData(await adminGet<OrgDetailPayload>(`/org/${orgId}`))
    setLoading(false)
  }

  useEffect(() => { refresh() }, [orgId])

  function openSetMemberRole(membership: Member) {
    setDialog({
      name: 'set_member_role',
      title: 'Change Member Role',
      input: { team_id: Number(orgId), user_id: membership.user_id, role: 'editor' },
    })
  }

  function openRemoveMember(userId: string) {
    setDialog({
      name: 'remove_member',
      title: 'Remove Member',
      input: { team_id: Number(orgId), user_id: userId },
      confirmPhrase: 'remove',
    })
  }

  function openInvite() {
    setDialog({
      name: 'create_invite_link',
      title: 'Create Invite Link',
      input: { org_id: Number(orgId), email: inviteEmail, role: inviteRole },
    })
  }

  function openTransferCaptain(userId: string) {
    setDialog({
      name: 'transfer_captainship',
      title: 'Transfer Captainship',
      input: { org_id: Number(orgId), new_captain_user_id: userId, reason: 'Admin transfer' },
      confirmPhrase: 'transfer',
    })
  }

  function openSetFlag(flag: FlagRow) {
    setDialog({
      name: 'set_flag',
      title: `Toggle Feature Flag: ${flag.key}`,
      input: { key: flag.key, org_id: Number(orgId), enabled: !flag.effective },
    })
  }

  function closeDialog() {
    setDialog(null)
  }

  function dialogDone() {
    setDialog(null)
    void refresh()
  }

  if (loading) return <Skeleton className="h-64 w-full" />
  if (!data || !data.organization) return <div>Org not found.</div>

  const org = data.organization
  const captain = data.members.find(m => m.role === 'captain')
  const isSuperadmin = adminRoleAtLeast(role, 'superadmin')

  const stats = [
    { label: 'Members', value: data.members.length },
    { label: 'Teams', value: data.teams.length },
    { label: 'Players', value: data.counts?.players ?? 0 },
    { label: 'Seasons', value: data.counts?.seasons ?? 0 },
    { label: 'Games', value: data.counts?.games ?? 0 },
    { label: 'Game events', value: data.metrics?.game_events ?? 0 },
    { label: 'AI messages', value: data.metrics?.chat_messages ?? 0 },
    { label: 'Strategy plays', value: data.metrics?.strategy_plays ?? 0 },
    { label: 'Attendance', value: data.metrics?.attendance ?? 0 },
    {
      label: 'Last activity',
      value: data.metrics?.last_activity
        ? new Date(data.metrics.last_activity).toLocaleDateString()
        : 'None',
    },
  ]

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{org.name}</h1>
          <p className="text-sm text-muted-foreground">Org #{org.id} · {org.is_public ? 'Public' : 'Private'} · {data.members.length} members</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
        {stats.map(s => (
          <div key={s.label} className="rounded border bg-card p-3 text-card-foreground">
            <div className="text-xs text-muted-foreground">{s.label}</div>
            <div className="mt-1 text-xl font-semibold">{s.value}</div>
          </div>
        ))}
      </div>

      <div className="rounded border p-4 space-y-4">
        <h2 className="font-semibold">Invite member</h2>
        <div className="flex gap-2">
          <div className="flex-1">
            <Label htmlFor="invite-email" className="sr-only">Email</Label>
            <Input id="invite-email" placeholder="Email" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} />
          </div>
          <Select value={inviteRole} onValueChange={(r: any) => setInviteRole(r)}>
            <SelectTrigger className="w-32" aria-label="Role"><SelectValue /></SelectTrigger>
            <SelectContent>
              {INVITE_ROLES.map(r => <SelectItem key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button onClick={openInvite}>Create invite</Button>
          {captain && (
            <Button variant="outline" onClick={() => navigate(`/admin/view-as/${captain.user_id}`)}>View as captain</Button>
          )}
        </div>
      </div>

      <div className="rounded border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-left">
              <th className="p-3">Member</th>
              <th className="p-3">Role</th>
              <th className="p-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.members.map(m => (
              <tr key={m.user_id} className="border-b">
                <td className="p-3">{m.email}</td>
                <td className="p-3 capitalize">{m.role}</td>
                <td className="p-3 text-right space-x-2">
                  <Button variant="outline" size="sm" aria-label={`Change role for ${m.email}`} onClick={() => openSetMemberRole(m)}>Change role</Button>
                  <Button variant="destructive" size="sm" aria-label={`Remove ${m.email}`} onClick={() => openRemoveMember(m.user_id)}>Remove</Button>
                  {m.role !== 'captain' && (
                    <Button variant="outline" size="sm" aria-label={`Make captain ${m.email}`} onClick={() => openTransferCaptain(m.user_id)}>Make captain</Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded border p-4 space-y-4">
        <div>
          <h2 className="font-semibold">Feature flags</h2>
          <p className="text-xs text-muted-foreground">Runtime flags and organization-level overrides.</p>
        </div>
        {(!data.feature_flags || data.feature_flags.length === 0) ? (
          <p className="text-sm text-muted-foreground">No feature flags registered.</p>
        ) : (
          <div className="divide-y rounded border">
            {data.feature_flags.map(flag => (
              <div key={flag.key} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium">{flag.key}</span>
                    <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium">
                      {flag.override === null ? 'Default' : `Override (${flag.override ? 'On' : 'Off'})`}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{flag.description}</p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="space-x-2 text-xs text-muted-foreground">
                    <span>Default: {flag.default_on ? 'On' : 'Off'}</span>
                    <span>·</span>
                    <span>Effective: {flag.effective ? 'On' : 'Off'}</span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!isSuperadmin}
                    title={!isSuperadmin ? 'Requires superadmin role' : undefined}
                    onClick={() => openSetFlag(flag)}
                  >
                    {flag.effective ? 'Turn off' : 'Turn on'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {dialog && (
        <OperationDialog
          name={dialog.name}
          title={dialog.title}
          input={dialog.input}
          confirmPhrase={dialog.confirmPhrase}
          onDone={dialogDone}
          onCancel={closeDialog}
        />
      )}
    </section>
  )
}