import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { AlertCircle, Camera, Check, Loader2, Mail, Trash2, UserPlus } from 'lucide-react'
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
import { cn } from '../lib/shadcn/utils'
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

const DETAILS_FORM_ID = 'team-settings-details'

// Roles are a ladder, so they read as one: captain is the single filled chip,
// editor is outlined, member is quiet. Rank is legible at a glance without
// anyone having to read the words.
const ROLE_CHIP: Record<TeamRole, string> = {
  captain: 'border-transparent bg-primary text-primary-foreground',
  editor: 'border-border bg-transparent text-foreground',
  member: 'border-transparent bg-secondary text-muted-foreground',
}

function RoleChip({ role }: { role: TeamRole }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold capitalize leading-5',
        ROLE_CHIP[role]
      )}
    >
      {role}
    </span>
  )
}

// The discs give the member list a left rail to scan down, which a column of
// ragged-length email addresses otherwise lacks entirely.
function InitialDisc({ initials, className }: { initials: string; className?: string }) {
  return (
    <span
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold uppercase text-secondary-foreground',
        className
      )}
      aria-hidden
    >
      {initials}
    </span>
  )
}

function SectionHeading({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {children}
      </h3>
      {count !== undefined && (
        <span className="text-[11px] font-medium tabular-nums text-muted-foreground/70">{count}</span>
      )}
    </div>
  )
}

function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <AlertCircle className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  )
}

function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
      {children}
    </p>
  )
}

function teamInitials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  return (words.slice(0, 2).map(w => w[0]).join('') || name.slice(0, 2)).toUpperCase()
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
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
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

  // The object URL is the only handle we have on the uploaded image --
  // my_organizations() returns no photo_url, so there is nothing to render
  // for a photo uploaded in an earlier session. Revoked on replacement and
  // unmount so the blob does not leak.
  useEffect(() => {
    if (!photoPreview) return
    return () => URL.revokeObjectURL(photoPreview)
  }, [photoPreview])

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
    if (ok) {
      setPhotoPreview(URL.createObjectURL(file))
      await refreshSession()
    }
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

  const pendingClaims = playerLinks.data?.filter(l => l.status === 'pending') ?? []
  const memberCount = members.data?.length
  const canEdit = Boolean(current) && can.manageTeam

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* p-0/gap-0/flex override DialogContent's own p-6 grid gap-4: the header
          and footer are pinned and only the middle scrolls, so padding has to
          live on the three bands rather than on the shell. max-h + the
          scrolling body are what stop a long roster from running off both
          ends of the viewport, which is what it did before. */}
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl flex-col gap-0 overflow-hidden p-0 sm:max-h-[85dvh]">
        {/* pr-14 clears the primitive's absolutely positioned close button. */}
        <DialogHeader className="shrink-0 flex-row items-center gap-3 space-y-0 border-b border-border bg-card/50 px-5 py-4 pr-14 text-left">
          {photoPreview ? (
            <img src={photoPreview} alt="" className="size-9 shrink-0 rounded-full object-cover" />
          ) : (
            <InitialDisc initials={teamInitials(current?.name ?? '??')} className="size-9 text-sm" />
          )}
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-base">{current?.name ?? 'Team settings'}</DialogTitle>
            <DialogDescription className="mt-0.5 truncate text-xs">
              {!current ? (
                'No team selected'
              ) : (
                <>
                  {current.is_public ? 'Public' : 'Private'}
                  {memberCount !== undefined && ` · ${memberCount} ${memberCount === 1 ? 'person' : 'people'}`}
                  {!can.manageTeam && ' · view only'}
                </>
              )}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">
          {!current ? (
            <EmptyNote>Pick a team from the switcher to manage it.</EmptyNote>
          ) : !canEdit ? (
            <section>
              <SectionHeading>Team</SectionHeading>
              <dl className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <dt className="text-xs text-muted-foreground">Name</dt>
                  <dd className="min-w-0 truncate text-sm font-medium">{current.name}</dd>
                </div>
                <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <dt className="text-xs text-muted-foreground">Visibility</dt>
                  <dd className="text-sm font-medium">{current.is_public ? 'Public' : 'Private'}</dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">
                Only a captain or editor can change team settings.
              </p>
            </section>
          ) : (
            <div className="space-y-8">
              <section>
                <SectionHeading>Team</SectionHeading>
                <form id={DETAILS_FORM_ID} onSubmit={handleSaveDetails} className="space-y-4">
                  {updateTeam.error && <ErrorNote>{updateTeam.error}</ErrorNote>}

                  <div className="space-y-1.5">
                    <Label htmlFor="team-settings-name">Name</Label>
                    {/* text-base below sm: iOS Safari zooms the whole page in
                        when a focused input's font is under 16px, and the
                        shared Input primitive is text-sm. */}
                    <Input
                      id="team-settings-name"
                      value={name}
                      onChange={e => setName(e.target.value)}
                      className="text-base sm:text-sm"
                    />
                  </div>

                  {/* The whole block is the hit target, and the consequence is
                      spelled out: "public" here means the tier-A read policy
                      (schedule and stats), never player contact details, which
                      live in player_private and stay members-only. */}
                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-secondary/30 p-3 transition-colors hover:bg-secondary/60">
                    <input
                      type="checkbox"
                      checked={isPublic}
                      onChange={e => setIsPublic(e.target.checked)}
                      className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium leading-tight">Publicly viewable</span>
                      <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                        Guests and signed-out visitors can browse this team's schedule and
                        stats. Roster contact details stay members-only either way.
                      </span>
                    </span>
                  </label>

                  <div className="space-y-1.5">
                    <Label>Team photo</Label>
                    <div className="flex items-center gap-3">
                      {photoPreview ? (
                        <img src={photoPreview} alt="" className="size-10 shrink-0 rounded-full object-cover" />
                      ) : (
                        <InitialDisc initials={teamInitials(current.name)} className="size-10 text-sm" />
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={uploadingPhoto}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        {uploadingPhoto ? (
                          <Loader2 className="mr-2 size-4 animate-spin" />
                        ) : (
                          <Camera className="mr-2 size-4" />
                        )}
                        {uploadingPhoto ? 'Uploading…' : 'Upload photo'}
                      </Button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={handlePhotoChange}
                      />
                    </div>
                    {photoError && <ErrorNote>{photoError}</ErrorNote>}
                  </div>
                </form>
              </section>

              <section>
                <SectionHeading count={memberCount}>Members</SectionHeading>
                {(setRole.error || removeMember.error) && (
                  <div className="mb-3">
                    <ErrorNote>{setRole.error || removeMember.error}</ErrorNote>
                  </div>
                )}
                {members.data === undefined ? (
                  members.error ? (
                    <ErrorNote>{members.error}</ErrorNote>
                  ) : (
                    <div className="space-y-2">
                      <Skeleton className="h-12 w-full" />
                      <Skeleton className="h-12 w-full" />
                      <Skeleton className="h-12 w-full" />
                    </div>
                  )
                ) : (
                  <ul className="-mx-2 divide-y divide-border/60">
                    {members.data.map(m => (
                      <li
                        key={m.id}
                        className="group flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-2 py-2 transition-colors hover:bg-secondary/40"
                      >
                        <InitialDisc initials={m.email.slice(0, 1)} />
                        {/* min-w-0 is what makes `truncate` actually truncate:
                            a flex item defaults to min-width:auto and refuses
                            to shrink below its content, so long addresses used
                            to overflow the dialog instead of ellipsizing. */}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm leading-tight">{m.email}</p>
                          {m.user_id === user?.id && (
                            <p className="mt-0.5 text-[11px] text-muted-foreground">You</p>
                          )}
                        </div>
                        {/* A role Select is ~120px and cannot share a line with
                            an email address on a 320px phone, so in the captain
                            view the controls drop to their own row, indented by
                            the disc's width so they line up under the address.
                            The read-only chip is narrow enough to stay inline at
                            every width. */}
                        <div
                          className={cn(
                            'flex items-center justify-end gap-1',
                            can.manageRoles ? 'ml-11 w-full sm:ml-0 sm:w-auto' : 'shrink-0'
                          )}
                        >
                          {can.manageRoles ? (
                            <Select
                              value={m.role}
                              onValueChange={async next => {
                                await setRole.trigger({ teamId: currentTeamId!, userId: m.user_id, role: next as TeamRole })
                                await members.trigger({ teamId: currentTeamId! })
                              }}
                            >
                              <SelectTrigger className="h-8 w-[7.5rem] shrink-0"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="captain">Captain</SelectItem>
                                <SelectItem value="editor">Editor</SelectItem>
                                <SelectItem value="member">Member</SelectItem>
                              </SelectContent>
                            </Select>
                          ) : (
                            <RoleChip role={m.role} />
                          )}
                          {/* An editor may remove a plain member only; the RPC enforces this
                              too, so this check is purely about not offering a dead button.
                              Always visible (and a 36px target) on touch, revealed on
                              hover/focus on desktop. */}
                          {(can.manageRoles || (can.manageTeam && m.role === 'member')) && m.user_id !== user?.id ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-9 shrink-0 text-muted-foreground hover:text-destructive sm:size-8 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                              onClick={async () => {
                                await removeMember.trigger({ teamId: currentTeamId!, userId: m.user_id })
                                await members.trigger({ teamId: currentTeamId! })
                              }}
                              aria-label={`Remove ${m.email}`}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          ) : (
                            // Keeps every row's role control on the same vertical
                            // line whether or not that row has a remove button.
                            <span className="size-9 shrink-0 sm:size-8" aria-hidden />
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <SectionHeading count={invites.data?.length}>Pending invites</SectionHeading>
                <form
                  className="flex flex-col gap-2 sm:flex-row"
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
                    className="min-w-0 flex-1 text-base sm:text-sm"
                  />
                  {/* Below sm the email input takes its own full-width line and
                      the role + submit share the next one, so neither is ever
                      squeezed to an unusable width. */}
                  <div className="flex gap-2">
                    <Select value={inviteRole} onValueChange={v => setInviteRole(v as 'member' | 'editor')}>
                      <SelectTrigger className="flex-1 sm:w-28 sm:flex-none"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="member">Member</SelectItem>
                        {/* Only a captain can grant editor; the RPC rejects it otherwise. */}
                        {can.manageRoles && <SelectItem value="editor">Editor</SelectItem>}
                      </SelectContent>
                    </Select>
                    <Button type="submit" className="shrink-0">
                      <UserPlus className="mr-2 size-4" />
                      Invite
                    </Button>
                  </div>
                </form>

                {(invite.error || revoke.error) && (
                  <div className="mt-3">
                    <ErrorNote>{invite.error || revoke.error}</ErrorNote>
                  </div>
                )}

                <div className="mt-3">
                  {invites.data && invites.data.length === 0 ? (
                    <EmptyNote>No invites waiting to be accepted.</EmptyNote>
                  ) : (
                    <ul className="-mx-2 divide-y divide-border/60">
                      {invites.data?.map(i => (
                        <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-2 py-2 transition-colors hover:bg-secondary/40">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground" aria-hidden>
                            <Mail className="size-3.5" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm leading-tight text-muted-foreground">{i.email}</p>
                            <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                              Expires {new Date(i.expires_at).toLocaleDateString()}
                            </p>
                          </div>
                          {/* Chip plus a text button is ~130px, too wide to sit
                              beside an address on a phone, so it wraps under it. */}
                          <div className="ml-11 flex w-full items-center justify-end gap-2 sm:ml-0 sm:w-auto">
                            <RoleChip role={i.role} />
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-9 shrink-0 px-2 text-xs text-muted-foreground hover:text-destructive sm:h-8"
                              onClick={async () => {
                                await revoke.trigger({ inviteId: i.id })
                                if (currentTeamId != null) await invites.trigger({ teamId: currentTeamId })
                              }}
                            >
                              Revoke
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>

              {/* Player claims: a member picked which roster player is them
                  (player_links, status = 'pending'). Approving just confirms
                  whose stats are whose -- it never changes what that person
                  can do, so this list is purely informational plus one RPC
                  call, no role picker involved. */}
              <section>
                <SectionHeading count={playerLinks.data ? pendingClaims.length : undefined}>
                  Player claims
                </SectionHeading>
                {approveClaim.error && (
                  <div className="mb-3">
                    <ErrorNote>{approveClaim.error}</ErrorNote>
                  </div>
                )}
                {playerLinks.data === undefined || members.data === undefined ? (
                  // Gated on both: `claimant` below is derived from
                  // members.data, fetched by an independent parallel trigger
                  // alongside playerLinks -- without this, a claim could
                  // render as "Unknown member" until members.data happened
                  // to arrive on a later render.
                  playerLinks.error || members.error ? (
                    <ErrorNote>{playerLinks.error || members.error}</ErrorNote>
                  ) : (
                    <Skeleton className="h-12 w-full" />
                  )
                ) : pendingClaims.length === 0 ? (
                  <EmptyNote>No one is waiting to be matched to a roster spot.</EmptyNote>
                ) : (
                  <ul className="-mx-2 divide-y divide-border/60">
                    {pendingClaims.map(l => {
                      const claimant = members.data?.find(m => m.user_id === l.user_id)
                      return (
                        <li key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-2 py-2">
                          <InitialDisc initials={(claimant?.email ?? '?').slice(0, 1)} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium leading-tight">{l.player_name}</p>
                            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                              claimed by {claimant?.email ?? 'an unknown member'}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            className="h-9 shrink-0 sm:h-8"
                            onClick={async () => {
                              const ok = await approveClaim.trigger({ linkId: l.id })
                              if (ok && currentTeamId != null) await playerLinks.trigger({ teamId: currentTeamId })
                            }}
                          >
                            <Check className="mr-1.5 size-3.5" />
                            Approve
                          </Button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>
            </div>
          )}
        </div>

        {canEdit && (
          // Pinned so Save never scrolls out of reach below a long roster --
          // the form itself is up in the body, reached by `form=`.
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-card/50 px-5 py-3">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button type="submit" form={DETAILS_FORM_ID} size="sm" disabled={saving}>
              {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
              Save changes
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
