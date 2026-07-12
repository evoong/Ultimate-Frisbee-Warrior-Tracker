import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Loader2, Trash2, UserPlus } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../lib/shadcn/dialog'
import { Button } from '../lib/shadcn/button'
import { Input } from '../lib/shadcn/input'
import { Label } from '../lib/shadcn/label'
import { Skeleton } from '../lib/shadcn/skeleton'
import { useAuth } from '../contexts/AuthContext'
import {
  useGetOrganizationMembers,
  useAddOrganizationMember,
  useRemoveOrganizationMember,
  useUpdateOrganization,
} from '../hooks/backend/organizations'

type OrganizationSettingsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Owner-only surface: rename the organization, toggle its public/private
// visibility, and manage members by email (no invite-token/email-send
// step, matching the app's existing simplicity elsewhere).
export default function OrganizationSettingsDialog({ open, onOpenChange }: OrganizationSettingsDialogProps) {
  const { organizations, currentOrgId, user } = useAuth()
  const current = organizations.find(o => o.organization_id === currentOrgId)
  const isOwner = current?.role === 'owner'

  const { data: members, trigger: fetchMembers } = useGetOrganizationMembers()
  const { trigger: addMember } = useAddOrganizationMember()
  const { trigger: removeMember } = useRemoveOrganizationMember()
  const { trigger: updateOrg } = useUpdateOrganization()

  const [name, setName] = useState(current?.name ?? '')
  const [isPublic, setIsPublic] = useState(current?.is_public ?? false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(() => {
    if (currentOrgId != null) void fetchMembers({ organizationId: currentOrgId })
  }, [currentOrgId, fetchMembers])

  useEffect(() => {
    if (open) {
      setName(current?.name ?? '')
      setIsPublic(current?.is_public ?? false)
      setError(null)
      reload()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentOrgId])

  async function handleSaveDetails(e: FormEvent) {
    e.preventDefault()
    if (currentOrgId == null) return
    setError(null)
    setBusy(true)
    try {
      await updateOrg({ organizationId: currentOrgId, name: name.trim(), isPublic })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save organization settings')
    } finally {
      setBusy(false)
    }
  }

  async function handleInvite(e: FormEvent) {
    e.preventDefault()
    if (currentOrgId == null || !inviteEmail.trim()) return
    setError(null)
    setBusy(true)
    try {
      await addMember({ organizationId: currentOrgId, email: inviteEmail })
      setInviteEmail('')
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add that member')
    } finally {
      setBusy(false)
    }
  }

  async function handleRemove(memberId: number) {
    setError(null)
    setBusy(true)
    try {
      await removeMember({ memberId })
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove that member')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Organization settings</DialogTitle>
          <DialogDescription>
            {isOwner ? 'Manage your organization and its members.' : 'Only an owner can edit these settings.'}
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <form onSubmit={handleSaveDetails} className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="org-settings-name">Name</Label>
            <Input
              id="org-settings-name"
              value={name}
              onChange={e => setName(e.target.value)}
              disabled={!isOwner}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isPublic}
              disabled={!isOwner}
              onChange={e => setIsPublic(e.target.checked)}
              className={`accent-primary w-4 h-4 ${isOwner ? 'cursor-pointer' : 'cursor-default'}`}
            />
            Make this organization's stats and schedule publicly viewable
          </label>
          {isOwner && (
            <Button type="submit" size="sm" disabled={busy}>
              {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Save
            </Button>
          )}
        </form>

        <div className="border-t border-border pt-3 space-y-2">
          <Label>Members</Label>
          {members === undefined ? (
            <>
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </>
          ) : (
            members.map(m => (
              <div key={m.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{m.email}</p>
                  <p className="text-xs text-muted-foreground capitalize">{m.role}</p>
                </div>
                {isOwner && m.email !== user?.email && (
                  <button
                    onClick={() => handleRemove(m.id)}
                    disabled={busy}
                    className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-accent transition-colors"
                    aria-label={`Remove ${m.email}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))
          )}
        </div>

        {isOwner && (
          <form onSubmit={handleInvite} className="flex items-center gap-2">
            <Input
              type="email"
              placeholder="teammate@email.com"
              value={inviteEmail}
              onChange={e => setInviteEmail(e.target.value)}
              className="flex-1"
            />
            <Button type="submit" size="sm" disabled={busy || !inviteEmail.trim()}>
              <UserPlus className="w-4 h-4" />
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
