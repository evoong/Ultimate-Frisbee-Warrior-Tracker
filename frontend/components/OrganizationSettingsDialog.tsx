import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Camera, Loader2, Trash2, UserPlus } from 'lucide-react'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../lib/shadcn/select'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import type { TeamRole } from '../lib/authClient'
import {
  useGetTeamMembers,
  useGetTeamInvites,
  useInviteMember,
  useRevokeInvite,
  useSetMemberRole,
  useRemoveMember,
  useUpdateTeam,
} from '../hooks/backend/teams'

type OrganizationSettingsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Gated on can.manageTeam (captain/editor), not a role literal: the database
// re-checks every one of these actions via RPC or a storage policy, so the
// gating here is only about not showing controls that would 403 anyway.
export default function OrganizationSettingsDialog({ open, onOpenChange }: OrganizationSettingsDialogProps) {
  const { can, user, currentTeamId, teams } = useAuth()
  const current = teams.find(t => t.organization_id === currentTeamId)

  const members = useGetTeamMembers()
  const invites = useGetTeamInvites()
  const invite = useInviteMember()
  const revoke = useRevokeInvite()
  const setRole = useSetMemberRole()
  const removeMember = useRemoveMember()
  const updateTeam = useUpdateTeam()

  const [name, setName] = useState(current?.name ?? '')
  const [isPublic, setIsPublic] = useState(current?.is_public ?? false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'member' | 'editor'>('member')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setName(current?.name ?? '')
      setIsPublic(current?.is_public ?? false)
      setSaveError(null)
      setPhotoError(null)
      if (currentTeamId != null && can.manageTeam) {
        void members.trigger({ teamId: currentTeamId })
        void invites.trigger({ teamId: currentTeamId })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentTeamId, can.manageTeam])

  async function handleSaveDetails(e: FormEvent) {
    e.preventDefault()
    if (currentTeamId == null) return
    setSaveError(null)
    setSaving(true)
    try {
      await updateTeam.trigger({ teamId: currentTeamId, name: name.trim(), isPublic })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save team settings')
    } finally {
      setSaving(false)
    }
  }

  async function uploadTeamPhoto(file: File) {
    if (!currentTeamId) return
    const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg'
    // The first path segment must be the team id: the storage policy reads it
    // to decide whether this upload is allowed at all.
    const path = `${currentTeamId}/logo.${ext}`
    const { error: upErr } = await supabase.storage
      .from('team-photos')
      .upload(path, file, { upsert: true })
    if (upErr) throw new Error(upErr.message)
    const { data } = supabase.storage.from('team-photos').getPublicUrl(path)
    await updateTeam.trigger({ teamId: currentTeamId, photoUrl: data.publicUrl })
  }

  async function handlePhotoChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setPhotoError(null)
    setUploadingPhoto(true)
    try {
      await uploadTeamPhoto(file)
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : 'Could not upload team photo')
    } finally {
      setUploadingPhoto(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Team settings</DialogTitle>
          <DialogDescription>Manage your team, its roster, and invites.</DialogDescription>
        </DialogHeader>

        {!current ? (
          <p className="text-sm text-muted-foreground">No team selected.</p>
        ) : !can.manageTeam ? (
          <div className="space-y-2 text-sm">
            <p><span className="text-muted-foreground">Name:</span> {current.name}</p>
            <p><span className="text-muted-foreground">Visibility:</span> {current.is_public ? 'Public' : 'Private'}</p>
            <p className="text-xs text-muted-foreground">Only a captain or editor can change team settings.</p>
          </div>
        ) : (
          <>
            {saveError && <p className="text-sm text-destructive">{saveError}</p>}
            <form onSubmit={handleSaveDetails} className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="team-settings-name">Name</Label>
                <Input id="team-settings-name" value={name} onChange={e => setName(e.target.value)} />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={isPublic}
                  onChange={e => setIsPublic(e.target.checked)}
                  className="accent-primary w-4 h-4 cursor-pointer"
                />
                Make this team's stats and schedule publicly viewable
              </label>

              <div className="space-y-2">
                <Label>Team photo</Label>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={uploadingPhoto}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {uploadingPhoto ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <Camera className="w-4 h-4 mr-2" />
                    )}
                    Upload photo
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handlePhotoChange}
                  />
                </div>
                {photoError && <p className="text-sm text-destructive">{photoError}</p>}
              </div>

              <Button type="submit" size="sm" disabled={saving}>
                {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Save
              </Button>
            </form>

            <div className="border-t border-border pt-3 space-y-2">
              <Label>Members</Label>
              {members.data === undefined ? (
                <>
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                </>
              ) : (
                members.data.map(m => (
                  <div key={m.id} className="flex items-center justify-between gap-2 py-1">
                    <span className="truncate text-sm">{m.email}</span>
                    <div className="flex items-center gap-2">
                      {can.manageRoles ? (
                        <Select
                          value={m.role}
                          onValueChange={async next => {
                            await setRole.trigger({ teamId: currentTeamId!, userId: m.user_id, role: next as TeamRole })
                            await members.trigger({ teamId: currentTeamId! })
                          }}
                        >
                          <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="captain">Captain</SelectItem>
                            <SelectItem value="editor">Editor</SelectItem>
                            <SelectItem value="member">Member</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <span className="text-xs capitalize text-muted-foreground">{m.role}</span>
                      )}
                      {/* An editor may remove a plain member only; the RPC enforces this
                          too, so this check is purely about not offering a dead button. */}
                      {(can.manageRoles || (can.manageTeam && m.role === 'member')) && m.user_id !== user?.id && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={async () => {
                            await removeMember.trigger({ teamId: currentTeamId!, userId: m.user_id })
                            await members.trigger({ teamId: currentTeamId! })
                          }}
                          aria-label={`Remove ${m.email}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="border-t border-border pt-3 space-y-2">
              <Label>Invite a teammate</Label>
              <form
                className="flex gap-2"
                onSubmit={async e => {
                  e.preventDefault()
                  if (currentTeamId == null) return
                  await invite.trigger({ teamId: currentTeamId, email: inviteEmail, role: inviteRole })
                  setInviteEmail('')
                  await invites.trigger({ teamId: currentTeamId })
                }}
              >
                <Input
                  type="email"
                  required
                  placeholder="teammate@example.com"
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                />
                <Select value={inviteRole} onValueChange={v => setInviteRole(v as 'member' | 'editor')}>
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">Member</SelectItem>
                    {/* Only a captain can grant editor; the RPC rejects it otherwise. */}
                    {can.manageRoles && <SelectItem value="editor">Editor</SelectItem>}
                  </SelectContent>
                </Select>
                <Button type="submit" size="sm">
                  <UserPlus className="w-4 h-4" />
                </Button>
              </form>

              {invite.error && <p className="text-sm text-destructive">{invite.error}</p>}

              {invites.data?.map(i => (
                <div key={i.id} className="flex items-center justify-between py-1 text-sm">
                  <span className="truncate text-muted-foreground">{i.email} · {i.role} · pending</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      await revoke.trigger({ inviteId: i.id })
                      if (currentTeamId != null) await invites.trigger({ teamId: currentTeamId })
                    }}
                  >
                    Revoke
                  </Button>
                </div>
              ))}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
