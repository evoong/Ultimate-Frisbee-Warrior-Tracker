import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { adminGet, adminOp } from '../../lib/adminClient'
import { Skeleton } from '../../lib/shadcn/skeleton'
import { Button } from '../../lib/shadcn/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from '../../lib/shadcn/dialog'
import { Input } from '../../lib/shadcn/input'
import { Label } from '../../lib/shadcn/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../lib/shadcn/select'
import OperationDialog from './OperationDialog'

type Member = { user_id: string; email: string; role: 'captain' | 'editor' | 'member' }
type OrgDetailPayload = {
  organization: { id: number; name: string; is_public: boolean; created_at: string }
  members: Member[]
  teams: { id: number; name: string }[]
  counts: { games: number; players: number; seasons: number }
  pending_invites: { id: number; email: string; role: string; expires_at: string }[]
  legacy_organization_members: { role: string; email: string }[]
}

const TEAM_ROLES = ['captain', 'editor', 'member'] as const
const INVITE_ROLES = ['editor', 'member'] as const

export default function OrgDetail({ orgId: propOrgId }: { orgId?: string }) {
  const { orgId: paramOrgId } = useParams<{ orgId: string }>()
  const orgId = propOrgId ?? paramOrgId!
  const navigate = useNavigate()
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

  function closeDialog() {
    setDialog(null)
  }

  if (loading) return <Skeleton className="h-64 w-full" />
  if (!data || !data.organization) return <div>Org not found.</div>

  const org = data.organization
  const captain = data.members.find(m => m.role === 'captain')

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{org.name}</h1>
          <p className="text-sm text-muted-foreground">Org #{org.id} · {org.is_public ? 'Public' : 'Private'} · {data.members.length} members</p>
        </div>
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
    </section>
  )
}