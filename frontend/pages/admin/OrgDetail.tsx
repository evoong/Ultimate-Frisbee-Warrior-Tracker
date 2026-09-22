import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { adminGet, adminOp } from '../../lib/adminClient'
import { Skeleton } from '../../lib/shadcn/skeleton'
import { Button } from '../../lib/shadcn/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from '../../lib/shadcn/dialog'
import { Input } from '../../lib/shadcn/input'
import { Label } from '../../lib/shadcn/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../lib/shadcn/select'

type Member = { user_id: string; email: string; role: 'captain' | 'editor' | 'viewer' }
type Org = {
  id: number; name: string; is_public: boolean; member_count: number; captain_id: string; members: Member[]
}

export default function OrgDetail({ orgId: propOrgId }: { orgId?: string }) {
  const { orgId: paramOrgId } = useParams<{ orgId: string }>()
  const orgId = propOrgId ?? paramOrgId!
  const [org, setOrg] = useState<Org | null>(null)
  const [loading, setLoading] = useState(true)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'captain' | 'editor' | 'viewer'>('editor')
  const [transferUserId, setTransferUserId] = useState<string | null>(null)
  const [transferReason, setTransferReason] = useState('')
  const [roleUserId, setRoleUserId] = useState<string | null>(null)

  async function changeRole(role: Member['role']) {
    if (!roleUserId) return
    await adminOp('set_member_role', { team_id: Number(orgId), user_id: roleUserId, role }, 'apply')
    setRoleUserId(null)
    refresh()
  }

  async function removeMember(userId: string) {
    if (!window.confirm('Remove this member?')) return
    await adminOp('remove_member', { team_id: Number(orgId), user_id: userId }, 'apply')
    refresh()
  }

  async function refresh() {
    setLoading(true)
    setOrg(await adminGet<Org>(`/org/${orgId}`))
    setLoading(false)
  }

  useEffect(() => { refresh() }, [orgId])

  async function invite() {
    await adminOp('create_invite_link', { org_id: Number(orgId), email: inviteEmail, role: inviteRole }, 'apply')
    refresh()
  }

  async function transfer() {
    if (!transferUserId) return
    await adminOp('transfer_captainship', { org_id: Number(orgId), new_captain_user_id: transferUserId, reason: transferReason }, 'apply')
    setTransferUserId(null)
    refresh()
  }

  if (loading) return <Skeleton className="h-64 w-full" />
  if (!org) return <div>Org not found.</div>

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{org.name}</h1>
          <p className="text-sm text-muted-foreground">Org #{org.id} · {org.is_public ? 'Public' : 'Private'} · {org.member_count} members</p>
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
              <SelectItem value="captain">Captain</SelectItem>
              <SelectItem value="editor">Editor</SelectItem>
              <SelectItem value="viewer">Viewer</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={invite}>Create invite</Button>
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
            {org.members.map(m => (
              <tr key={m.user_id} className="border-b">
                <td className="p-3">{m.email}</td>
                <td className="p-3 capitalize">{m.role}</td>
                <td className="p-3 text-right space-x-2">
                  <Dialog>
                    <DialogTrigger asChild><Button variant="outline" size="sm" aria-label={`Change role for ${m.email}`} onClick={() => setRoleUserId(m.user_id)}>Change role</Button></DialogTrigger>
                    <DialogContent>
                      <DialogHeader><DialogTitle>Change role for {m.email}</DialogTitle></DialogHeader>
                      <div className="flex flex-col gap-2">
                        {(['captain', 'editor', 'viewer'] as const).map(role => (
                          <Button key={role} variant="outline" className="justify-start capitalize" onClick={() => changeRole(role)}>Make {role}</Button>
                        ))}
                      </div>
                    </DialogContent>
                  </Dialog>
                  <Button variant="destructive" size="sm" aria-label={`Remove ${m.email}`} onClick={() => removeMember(m.user_id)}>Remove</Button>
                  {m.role !== 'captain' && (
                    <Dialog>
                      <DialogTrigger asChild><Button variant="outline" size="sm" aria-label={`Make captain ${m.email}`} onClick={() => setTransferUserId(m.user_id)}>Make captain</Button></DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Transfer captainship to {m.email}?</DialogTitle>
                        </DialogHeader>
                        <div className="space-y-2">
                          <Label htmlFor="transfer-reason">Reason</Label>
                          <Input id="transfer-reason" value={transferReason} onChange={e => setTransferReason(e.target.value)} placeholder="Reason for transfer" />
                        </div>
                        <DialogFooter>
                          <Button onClick={transfer}>Confirm transfer</Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
