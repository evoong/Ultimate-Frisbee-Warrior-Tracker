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
import { useGetTeamPlayerLinks, useApprovePlayerClaim } from '../hooks/backend/playerLink'

type OrganizationSettingsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Gated on can.manageTeam (captain/editor), not a role literal: the database
// re-checks every one of these actions via RPC or a storage policy, so the
// gating here is only about not showing controls that would 403 anyway.
export default function OrganizationSettingsDialog({ open, onOpenChange }: OrganizationSettingsDialogProps) {
  const { can, user, currentTeamId, teams, refreshSession } = useAuth()
  const current = teams.find(t => t.organization_id === currentTeamId)

  const members = useGetTeamMembers()
  const invites = useGetTeamInvites()
  const invite = useInviteMember()
  const revoke = useRevokeInvite()
  const setRole = useSetMemberRole()
  const removeMember = useRemoveMember()
  const updateTeam = useUpdateTeam()
  const playerLinks = useGetTeamPlayerLinks()
  const approveClaim = useApprovePlayerClaim()

  const [name, setName] = useState(current?.name ?? '')
  const [isPublic, setIsPublic] = useState(current?.is_public ?? false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'member' | 'editor'>('member')
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setName(current?.name ?? '')
      setIsPublic(current?.is_public ?? false)
      setPhotoError(null)
      if (currentTeamId != null && can.manageTeam) {
        void members.trigger({ teamId: currentTeamId })
        void invites.trigger({ teamId: currentTeamId })
        void playerLinks.trigger({ teamId: currentTeamId })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentTeamId, can.manageTeam])

  async function handleSaveDetails(e: FormEvent) {
    e.preventDefault()
    if (currentTeamId == null) return
    setSaving(true)
    // useUpdateTeam's trigger never throws -- it swallows the RPC/PostgREST
    // error into its own `error` state and resolves to undefined on failure.
    // There is nothing useful to catch here; `updateTeam.error` is rendered
    // in JSX below and will be current on the next render regardless.
    const ok = await updateTeam.trigger({ teamId: currentTeamId, name: name.trim(), isPublic })
    // Nothing else refreshes AuthContext's `teams` after this UPDATE, so
    // without this the dialog and team switcher keep showing the old name
    // until a full page reload -- refresh only on success so a failed save
    // still leaves `updateTeam.error` visible instead of being masked by a
    // refresh that just re-fetches the unchanged team.
    if (ok) await refreshSession()
    setSaving(false)
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
    // Domain-relative, not absolute: the app is served from multiple origins
    // (Vercel + Cloudflare), and the storage client's public-URL helper would
    // bake in whichever origin the uploader was on. See players.ts's
    // useUploadPlayerPhoto for the full explanation of why an absolute URL
    // breaks on other origins.
    const photo_url = `/db/storage/v1/object/public/team-photos/${path}`
    // As above: if persisting the URL fails, the file is still in storage but
    // never linked to the team. That failure surfaces via `updateTeam.error`
    // in JSX, not via a thrown exception here.
    const ok = await updateTeam.trigger({ teamId: currentTeamId, photoUrl: photo_url })
    if (ok) await refreshSession()
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
            {updateTeam.error && <p className="text-sm text-destructive">{updateTeam.error}</p>}
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
              {(setRole.error || removeMember.error) && (
                <p className="text-sm text-destructive">{setRole.error || removeMember.error}</p>
              )}
              {members.data === undefined ? (
                members.error ? (
                  <p className="text-sm text-destructive">{members.error}</p>
                ) : (
                  <>
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-full" />
                  </>
                )
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

              {(invite.error || revoke.error) && (
                <p className="text-sm text-destructive">{invite.error || revoke.error}</p>
              )}

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

            {/* Player claims: a member picked which roster player is them
                (player_links, status = 'pending'). Approving just confirms
                whose stats are whose -- it never changes what that person
                can do, so this list is purely informational plus one RPC
                call, no role picker involved. */}
            <div className="border-t border-border pt-3 space-y-2">
              <Label>Player claims</Label>
              {approveClaim.error && <p className="text-sm text-destructive">{approveClaim.error}</p>}
              {playerLinks.data === undefined || members.data === undefined ? (
                // Gated on both: `claimant` below is derived from
                // members.data, fetched by an independent parallel trigger
                // alongside playerLinks -- without this, a claim could
                // render as "Unknown member" until members.data happened
                // to arrive on a later render.
                playerLinks.error || members.error ? (
                  <p className="text-sm text-destructive">{playerLinks.error || members.error}</p>
                ) : (
                  <Skeleton className="h-9 w-full" />
                )
              ) : playerLinks.data.filter(l => l.status === 'pending').length === 0 ? (
                <p className="text-xs text-muted-foreground">No pending claims.</p>
              ) : (
                playerLinks.data.filter(l => l.status === 'pending').map(l => {
                  const claimant = members.data?.find(m => m.user_id === l.user_id)
                  return (
                    <div key={l.id} className="flex items-center justify-between gap-2 py-1 text-sm">
                      <span className="truncate">
                        {claimant?.email ?? 'Unknown member'} claims <span className="font-medium">{l.player_name}</span>
                      </span>
                      <Button
                        size="sm"
                        onClick={async () => {
                          const ok = await approveClaim.trigger({ linkId: l.id })
                          if (ok && currentTeamId != null) await playerLinks.trigger({ teamId: currentTeamId })
                        }}
                      >
                        Approve
                      </Button>
                    </div>
                  )
                })
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
