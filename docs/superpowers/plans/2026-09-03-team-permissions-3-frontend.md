# Team Permissions — Plan 3: Frontend

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `allowed = user != null` with a real capability model,
add guest browsing, build team management (roles, invites, photo), move
player contact details onto `player_private`, and ship the My Stats view.

**Architecture:** The UI hides what you cannot do; the database decides what
you can. Every capability check here is UX — no policy depends on one, and
every one of them is already enforced by Plan 1's RLS underneath.

**Tech Stack:** React 18, TypeScript, Vite, Tailwind, shadcn/ui,
`@supabase/supabase-js` pointed at the gateway proxy.

**Spec:** `docs/superpowers/specs/2026-09-03-team-permissions-design.md`
**Depends on:** Plans 1 and 2 complete. `/auth/session` must already return
`{ user, is_anonymous, teams: [{ organization_id, name, role, is_public }] }`.

## Global Constraints

- Tenant column is still `organization_id`. The rename is Plan 4.
- Roles are `'captain' | 'editor' | 'member'`. `'owner'` no longer exists
  anywhere in the frontend.
- Guests: `is_anonymous === true`, zero teams. They never see the Plays or
  AI tabs, and never see a control that writes.
- Membership and role changes go through RPCs (`supabase.rpc(...)`), never
  through `.from('team_members').insert(...)` — those tables have no client
  write grant, so a direct write fails with a 403 the user cannot act on.
- Photo uploads use the path `{team_id}/{player_id}.<ext>` — Plan 1's
  storage policies key on that first segment.
- Verify each task in the running app (`npm run frontend`, port 5199)
  against the local Supabase, signed in as the role the task concerns.
- Commit after every task. Never push to `main`.

---

### Task 1: Session types and the guest endpoint client

**Files:**
- Modify: `frontend/lib/authClient.ts:6-46`

**Interfaces:**
- Produces:
  - `type TeamRole = 'captain' | 'editor' | 'member'`
  - `interface TeamMembership { organization_id: number; name: string; role: TeamRole; is_public: boolean }`
  - `interface SessionInfo { user: AuthUser | null; isAnonymous: boolean; teams: TeamMembership[] }`
  - `loginAsGuest(): Promise<void>`
- Consumed by: every later task.

- [ ] **Step 1: Replace the types**

In `frontend/lib/authClient.ts`, replace `OrgMembership` and `SessionInfo`:

```ts
export interface AuthUser {
  id: string
  /** Null for guest (anonymous) sessions. */
  email: string | null
}

export type TeamRole = 'captain' | 'editor' | 'member'

export interface TeamMembership {
  organization_id: number
  name: string
  role: TeamRole
  is_public: boolean
}

export interface SessionInfo {
  user: AuthUser | null
  isAnonymous: boolean
  teams: TeamMembership[]
}
```

- [ ] **Step 2: Update getSession**

```ts
export async function getSession(): Promise<SessionInfo> {
  const res = await fetch('/auth/session', { credentials: 'include' })
  if (!res.ok) return { user: null, isAnonymous: false, teams: [] }
  const data = await res.json()
  return {
    user: data.user ?? null,
    isAnonymous: data.is_anonymous === true,
    teams: Array.isArray(data.teams) ? data.teams : [],
  }
}
```

- [ ] **Step 3: Add the guest client**

```ts
// Anonymous sign-in. The resulting session is a real session in every
// mechanical sense -- same cookies, same refresh -- it simply belongs to no
// team, which is what makes every read policy return nothing but public data.
export async function loginAsGuest(): Promise<void> {
  const res = await post('/auth/guest')
  if (!res.ok) throw new Error(await readError(res))
}
```

- [ ] **Step 4: Typecheck**

```bash
cd frontend && npx tsc --noEmit
```

Expected: errors in `AuthContext.tsx` and anything importing `OrgMembership`.
Those are Task 2. List them and move on.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/authClient.ts
git commit -m "Add team role types and guest sign-in to the auth client"
```

---

### Task 2: Capability model in AuthContext

**Files:**
- Modify: `frontend/contexts/AuthContext.tsx` (whole file)

**Interfaces:**
- Produces from `useAuth()`:
  - `user`, `teams`, `currentTeamId`, `switchTeam(id)`, `loading`
  - `isGuest: boolean`
  - `role: TeamRole | null` (on the current team)
  - `can: { record: boolean; manageTeam: boolean; manageRoles: boolean }`
  - `createTeam(name: string): Promise<void>`
  - `loginAsGuest(): Promise<void>`
  - existing: `login`, `signup`, `loginWithGoogle`, `loginWithPasskey`,
    `logout`, `forgotPassword`
- **Removed:** `allowed`, `organizations`, `currentOrgId`, `switchOrg`,
  `createOrganization`, `joinOrganization`.

`joinOrganization` is deleted, not fixed. Open self-join is the escalation
path the whole feature closes; there is no client-side version of it that is
safe.

- [ ] **Step 1: Rewrite the context value**

Replace the interface and the state block:

```tsx
const CURRENT_TEAM_STORAGE_KEY = 'ufwt_current_team_id'

export interface Capabilities {
  /** Enter game data: events, scores, lineups, strategy. Member and up. */
  record: boolean
  /** Team name, photo, public/private, and the roster. Editor and up. */
  manageTeam: boolean
  /** Grant roles, remove editors and captains, delete the team. Captain. */
  manageRoles: boolean
}

interface AuthContextValue {
  user: AuthUser | null
  teams: TeamMembership[]
  currentTeamId: number | null
  role: TeamRole | null
  can: Capabilities
  isGuest: boolean
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  signup: (email: string, password: string) => Promise<{ confirmationRequired: boolean }>
  loginWithGoogle: () => void
  loginWithPasskey: () => Promise<void>
  loginAsGuest: () => Promise<void>
  logout: () => Promise<void>
  forgotPassword: (email: string) => Promise<void>
  switchTeam: (teamId: number) => void
  createTeam: (name: string) => Promise<void>
}

const NO_CAPABILITIES: Capabilities = { record: false, manageTeam: false, manageRoles: false }

function capabilitiesFor(role: TeamRole | null): Capabilities {
  switch (role) {
    case 'captain': return { record: true, manageTeam: true, manageRoles: true }
    case 'editor':  return { record: true, manageTeam: true, manageRoles: false }
    case 'member':  return { record: true, manageTeam: false, manageRoles: false }
    default:        return NO_CAPABILITIES
  }
}
```

- [ ] **Step 2: Rewrite the session refresh**

```tsx
const [user, setUser] = useState<AuthUser | null>(null)
const [teams, setTeams] = useState<TeamMembership[]>([])
const [isGuest, setIsGuest] = useState(false)
const [currentTeamId, setCurrentTeamId] = useState<number | null>(null)
const [loading, setLoading] = useState(true)

const refreshSessionState = useCallback(async () => {
  const session = await authClient.getSession()
  setUser(session.user)
  setTeams(session.teams)
  setIsGuest(session.isAnonymous)
  setCurrentTeamId(prev => {
    const stored = prev ?? readStoredTeamId()
    if (stored != null && session.teams.some(t => t.organization_id === stored)) return stored
    return session.teams[0]?.organization_id ?? null
  })
}, [])

const role = useMemo(
  () => teams.find(t => t.organization_id === currentTeamId)?.role ?? null,
  [teams, currentTeamId]
)
// A guest holds no role on any team, so capabilities collapse to nothing
// without a separate guest branch. The database agrees independently.
const can = useMemo(() => (isGuest ? NO_CAPABILITIES : capabilitiesFor(role)), [isGuest, role])
```

- [ ] **Step 3: Replace createOrganization with the RPC**

```tsx
// One RPC, not an insert plus an insert. The atomicity is why team_members
// needs no self-insert policy at all -- see the design spec.
const createTeam = useCallback(
  async (name: string) => {
    const { data, error } = await supabase.rpc('create_team', { p_name: name })
    if (error) throw new Error(error.message)
    await refreshSessionState()
    setCurrentTeamId(Number(data))
  },
  [refreshSessionState]
)

const loginAsGuest = useCallback(async () => {
  await authClient.loginAsGuest()
  await refreshSessionState()
}, [refreshSessionState])
```

- [ ] **Step 4: Delete joinOrganization**

Remove the whole `joinOrganization` callback and its entry in the provider
value. Leave this comment where it was:

```tsx
// joinOrganization was removed deliberately. Open self-join let any signed-in
// user insert themselves into any team; membership now originates only from
// an invite issued by someone who already holds the power to grant it.
```

- [ ] **Step 5: Verify in the app**

```bash
npm run db:reset
cd frontend && npm run dev
```

Sign in as `captain@local.test` / `localdev123`. In the browser console:

```js
// Should be denied by the missing grant, not by a policy.
await window.__supabase?.from('team_members').insert({ team_id: 1, user_id: 'x', role: 'captain' })
```

Expected: an error mentioning permission. (If `window.__supabase` is not
exposed, check via the Network tab that the request 403s.)

- [ ] **Step 6: Commit**

```bash
git add frontend/contexts/AuthContext.tsx
git commit -m "Replace the allowed flag with a per-team capability model"
```

---

### Task 3: Team and membership hooks

**Files:**
- Delete: `frontend/hooks/backend/organizations.ts`
- Create: `frontend/hooks/backend/teams.ts`

**Interfaces:**
- Produces:
  - `useGetTeamMembers()` → `{ id, team_id, user_id, role, email }[]`
  - `useGetTeamInvites()` → `{ id, email, role, expires_at }[]`
  - `useInviteMember()` → `{ teamId, email, role }`
  - `useRevokeInvite()` → `{ inviteId }`
  - `useSetMemberRole()` → `{ teamId, userId, role }`
  - `useRemoveMember()` → `{ teamId, userId }`
  - `useUpdateTeam()` → `{ teamId, name?, isPublic?, photoUrl? }`
- Consumed by: Tasks 5 and 6.

`team_members` stores `user_id`, not email, so the members list needs emails
from somewhere. Add a view in a migration rather than exposing `auth.users`.

- [ ] **Step 1: Add the roster view migration**

Create `supabase/migrations/20260903001600_team_roster_view.sql`:

```sql
-- Roster with display emails. security_invoker means the caller's own RLS
-- on team_members applies, so this view leaks nothing that the table would
-- not already show them.
create or replace view public.team_roster
with (security_invoker = true)
as
  select m.id, m.team_id, m.user_id, m.role, m.created_at,
         u.email,
         l.player_id
    from public.team_members m
    join auth.users u on u.id = m.user_id
    left join public.player_links l
           on l.user_id = m.user_id and l.team_id = m.team_id and l.status = 'approved';

revoke all on public.team_roster from anon;
grant select on public.team_roster to authenticated;
```

Run `npm run db:reset && npm run db:test`; the meta-tests should still pass
(a view is not a table, so the RLS meta-test does not cover it — the
`security_invoker` setting is what makes it safe).

- [ ] **Step 2: Write the hooks module**

Create `frontend/hooks/backend/teams.ts`, keeping the existing
`useApiCall` helper shape copied from the deleted file:

```ts
import { useCallback, useState } from 'react'
import { supabase } from '../../lib/supabase'
import type { TeamRole } from '../../lib/authClient'

type HookResult<T, P = void> = {
  data: T | undefined
  loading: boolean
  error: string | null
  trigger: P extends void ? () => Promise<T | undefined> : (params?: P) => Promise<T | undefined>
}

function useApiCall<T, P = void>(fn: (params: P) => Promise<T>): HookResult<T, P> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trigger = useCallback(async (params?: P) => {
    setLoading(true)
    setError(null)
    try {
      const result = await fn(params as P)
      setData(result)
      return result
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
      return undefined
    } finally {
      setLoading(false)
    }
  }, [fn])

  return { data, loading, error, trigger: trigger as HookResult<T, P>['trigger'] }
}

export type TeamMember = {
  id: number
  team_id: number
  user_id: string
  role: TeamRole
  email: string
  player_id: number | null
}

export type TeamInvite = {
  id: number
  team_id: number
  email: string
  role: Exclude<TeamRole, 'captain'>
  expires_at: string
}

export function useGetTeamMembers() {
  const fn = useCallback(async (params: { teamId: number }) => {
    const { data, error } = await supabase
      .from('team_roster')
      .select('*')
      .eq('team_id', params.teamId)
      .order('role')
      .order('email')
    if (error) throw new Error(error.message)
    return (data ?? []) as TeamMember[]
  }, [])
  return useApiCall<TeamMember[], { teamId: number }>(fn)
}

export function useGetTeamInvites() {
  const fn = useCallback(async (params: { teamId: number }) => {
    const { data, error } = await supabase
      .from('team_invites')
      .select('id,team_id,email,role,expires_at')
      .eq('team_id', params.teamId)
      .is('accepted_at', null)
      .order('email')
    if (error) throw new Error(error.message)
    return (data ?? []) as TeamInvite[]
  }, [])
  return useApiCall<TeamInvite[], { teamId: number }>(fn)
}

// Every mutation below is an RPC. team_members and team_invites carry no
// client write grant, so a direct .insert()/.update() would 403 -- and that
// is the point: there is no client-side path to a role change at all.
export function useInviteMember() {
  const fn = useCallback(async (params: { teamId: number; email: string; role: 'member' | 'editor' }) => {
    const { error } = await supabase.rpc('invite_member', {
      p_team_id: params.teamId,
      p_email: params.email,
      p_role: params.role,
    })
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { teamId: number; email: string; role: 'member' | 'editor' }>(fn)
}

export function useRevokeInvite() {
  const fn = useCallback(async (params: { inviteId: number }) => {
    const { error } = await supabase.rpc('revoke_invite', { p_invite_id: params.inviteId })
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { inviteId: number }>(fn)
}

export function useSetMemberRole() {
  const fn = useCallback(async (params: { teamId: number; userId: string; role: TeamRole }) => {
    const { error } = await supabase.rpc('set_member_role', {
      p_team_id: params.teamId,
      p_user_id: params.userId,
      p_role: params.role,
    })
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { teamId: number; userId: string; role: TeamRole }>(fn)
}

export function useRemoveMember() {
  const fn = useCallback(async (params: { teamId: number; userId: string }) => {
    const { error } = await supabase.rpc('remove_member', {
      p_team_id: params.teamId,
      p_user_id: params.userId,
    })
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { teamId: number; userId: string }>(fn)
}

export function useUpdateTeam() {
  const fn = useCallback(
    async (params: { teamId: number; name?: string; isPublic?: boolean; photoUrl?: string }) => {
      const body: Record<string, unknown> = {}
      if (params.name !== undefined) body.name = params.name
      if (params.isPublic !== undefined) body.is_public = params.isPublic
      if (params.photoUrl !== undefined) body.photo_url = params.photoUrl
      const { error } = await supabase.from('organizations').update(body).eq('id', params.teamId)
      if (error) throw new Error(error.message)
      return true
    },
    []
  )
  return useApiCall<boolean, { teamId: number; name?: string; isPublic?: boolean; photoUrl?: string }>(fn)
}
```

- [ ] **Step 3: Delete the old module and fix imports**

```bash
rm frontend/hooks/backend/organizations.ts
grep -rn "backend/organizations" frontend --include=*.tsx --include=*.ts
```

Update each import to `backend/teams` with the renamed hooks.

- [ ] **Step 4: Typecheck and commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/hooks/backend/teams.ts supabase/migrations/20260903001600_team_roster_view.sql
git rm frontend/hooks/backend/organizations.ts
git commit -m "Replace organization hooks with RPC-based team management hooks"
```

---

### Task 4: Guest sign-in on the login page

**Files:**
- Modify: `frontend/pages/Login.tsx`

**Interfaces:**
- Consumes: `useAuth().loginAsGuest` (Task 2).

- [ ] **Step 1: Add the control**

Below the existing sign-in form's submit button and any passkey control, add:

```tsx
<div className="relative my-4">
  <div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div>
  <div className="relative flex justify-center text-xs uppercase">
    <span className="bg-background px-2 text-muted-foreground">or</span>
  </div>
</div>

<Button
  type="button"
  variant="outline"
  className="w-full"
  disabled={busy}
  onClick={async () => {
    setBusy(true)
    setError(null)
    try {
      await loginAsGuest()
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not continue as a guest')
    } finally {
      setBusy(false)
    }
  }}
>
  Continue as a guest
</Button>
<p className="mt-2 text-center text-xs text-muted-foreground">
  Browse public teams and league schedules. You won't be able to change anything.
</p>
```

Add `loginAsGuest` to the `useAuth()` destructure at the top of the
component. Reuse whatever `busy`/`error`/`navigate` identifiers the file
already defines rather than introducing new ones.

- [ ] **Step 2: Verify in the app**

Click "Continue as a guest". Expected: you land in the app, and
`/auth/session` (Network tab) shows `is_anonymous: true` with `teams: []`.

- [ ] **Step 3: Commit**

```bash
git add frontend/pages/Login.tsx
git commit -m "Add continue-as-guest to the login page"
```

---

### Task 5: Onboarding without self-join

**Files:**
- Modify: `frontend/pages/CreateOrganization.tsx`

**Interfaces:**
- Consumes: `useAuth().createTeam`, `useAuth().isGuest`.

Today this screen lists every organization and lets the user join any of
them. That list is the escalation path. It is removed, and replaced with an
explanation of how joining actually works now.

- [ ] **Step 1: Remove the joinable-org query**

Delete the `existingOrgs` state, the `useEffect` that queries
`supabase.from('organizations').select(...)`, the `JoinableOrg` type, and the
whole join UI block including its handler.

- [ ] **Step 2: Rewrite the card body**

```tsx
export default function CreateTeam() {
  const { createTeam, logout, user, isGuest } = useAuth()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    try {
      await createTeam(trimmed)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create your team')
    } finally {
      setBusy(false)
    }
  }

  if (isGuest) return <PublicTeamsBrowser />   // Task 10

  return (
    <Card className="mx-auto mt-16 max-w-md">
      <CardHeader>
        <CardTitle>Create your team</CardTitle>
        <CardDescription>
          You're signed in as {user?.email}, but you're not on a team yet.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleCreate} className="space-y-3">
          <Input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Team name"
            autoFocus
          />
          <Button type="submit" className="w-full" disabled={busy || !name.trim()}>
            Create team
          </Button>
        </form>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Joining someone else's team?</p>
          <p className="mt-1">
            Ask their captain to invite {user?.email}. Once they do, sign in
            again and you'll be on the team — there's nothing to accept.
          </p>
        </div>

        <Button variant="ghost" className="w-full" onClick={logout}>Sign out</Button>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 3: Verify the invite round trip**

As `captain@local.test`, invite `unconfirmed@local.test`... no — use a fresh
confirmed address. In Studio (http://127.0.0.1:54323) create a user
`newbie@local.test` with confirm on, then as the captain run the invite from
the settings dialog (Task 6, or via SQL for now). Sign in as `newbie` and
confirm the team appears with no accept step.

- [ ] **Step 4: Commit**

```bash
git add frontend/pages/CreateOrganization.tsx
git commit -m "Remove open self-join from onboarding"
```

---

### Task 6: Team settings and member management

**Files:**
- Modify: `frontend/components/OrganizationSettingsDialog.tsx`

**Interfaces:**
- Consumes: every hook from Task 3; `useAuth().can`, `.role`, `.user`.

- [ ] **Step 1: Gate the whole dialog on manage rights**

At the top of the component:

```tsx
const { can, role, user, currentTeamId, teams } = useAuth()
const current = teams.find(t => t.organization_id === currentTeamId)
```

Render the settings form only when `can.manageTeam`; otherwise show a
read-only summary of the team name and privacy with the line
"Only a captain or editor can change team settings."

- [ ] **Step 2: Add the photo upload**

```tsx
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
```

- [ ] **Step 3: Build the members list**

```tsx
{members.data?.map(m => (
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
          variant="ghost" size="sm"
          onClick={async () => {
            await removeMember.trigger({ teamId: currentTeamId!, userId: m.user_id })
            await members.trigger({ teamId: currentTeamId! })
          }}
        >
          Remove
        </Button>
      )}
    </div>
  </div>
))}
```

- [ ] **Step 4: Build the invite form and pending list**

```tsx
<form
  className="flex gap-2"
  onSubmit={async e => {
    e.preventDefault()
    await invite.trigger({ teamId: currentTeamId!, email: inviteEmail, role: inviteRole })
    setInviteEmail('')
    await invites.trigger({ teamId: currentTeamId! })
  }}
>
  <Input
    type="email" required placeholder="teammate@example.com"
    value={inviteEmail} onChange={e => setInviteEmail(e.target.value)}
  />
  <Select value={inviteRole} onValueChange={v => setInviteRole(v as 'member' | 'editor')}>
    <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
    <SelectContent>
      <SelectItem value="member">Member</SelectItem>
      {/* Only a captain can grant editor; the RPC rejects it otherwise. */}
      {can.manageRoles && <SelectItem value="editor">Editor</SelectItem>}
    </SelectContent>
  </Select>
  <Button type="submit">Invite</Button>
</form>

{invite.error && <p className="text-sm text-destructive">{invite.error}</p>}

{invites.data?.map(i => (
  <div key={i.id} className="flex items-center justify-between py-1 text-sm">
    <span className="truncate text-muted-foreground">{i.email} · {i.role} · pending</span>
    <Button variant="ghost" size="sm" onClick={async () => {
      await revoke.trigger({ inviteId: i.id })
      await invites.trigger({ teamId: currentTeamId! })
    }}>Revoke</Button>
  </div>
))}
```

- [ ] **Step 5: Verify each role in the app**

Sign in as each of `captain@`, `editor@`, `member@`:

| Role | Expected |
|---|---|
| captain | role dropdowns, editor option in invites, remove on anyone |
| editor | no role dropdowns, member-only invites, remove on members only |
| member | read-only summary, no invite form |

Also confirm the editor's attempt to invite an editor is impossible in the
UI **and** that calling the RPC directly from the console still fails.

- [ ] **Step 6: Commit**

```bash
git add frontend/components/OrganizationSettingsDialog.tsx
git commit -m "Add role management, invites, and team photo to team settings"
```

---

### Task 7: Move player contact details to player_private

**Files:**
- Modify: `frontend/hooks/backend/players.ts`
- Modify: `frontend/pages/Roster.tsx`

**Interfaces:**
- Produces: player reads no longer select `phone`, `first_name_edit`,
  `last_name_edit`; a separate read/write against `player_private`.

Plan 1 dropped those three columns from `players`. Any surviving `select`
that names them now errors, and any surviving write silently loses data.

- [ ] **Step 1: Find every reference**

```bash
grep -rn "phone\|first_name_edit\|last_name_edit" frontend --include=*.ts --include=*.tsx
```

- [ ] **Step 2: Split the player read**

In `frontend/hooks/backend/players.ts`, remove the three columns from the
`players` select and add:

```ts
export type PlayerPrivate = {
  player_id: number
  phone: string | null
  first_name_edit: string | null
  last_name_edit: string | null
}

// Members-only by policy. A guest reading this gets an empty array rather
// than an error, so callers must treat "absent" as normal, not exceptional.
export function useGetPlayerPrivate() {
  const fn = useCallback(async (params: { teamId: number }) => {
    const { data, error } = await supabase
      .from('player_private')
      .select('player_id,phone,first_name_edit,last_name_edit')
      .eq('team_id', params.teamId)
    if (error) throw new Error(error.message)
    return (data ?? []) as PlayerPrivate[]
  }, [])
  return useApiCall<PlayerPrivate[], { teamId: number }>(fn)
}

export function useUpsertPlayerPrivate() {
  const fn = useCallback(
    async (params: { teamId: number; playerId: number; phone?: string | null;
                     firstNameEdit?: string | null; lastNameEdit?: string | null }) => {
      const row: Record<string, unknown> = { player_id: params.playerId, team_id: params.teamId }
      if (params.phone !== undefined) row.phone = params.phone
      if (params.firstNameEdit !== undefined) row.first_name_edit = params.firstNameEdit
      if (params.lastNameEdit !== undefined) row.last_name_edit = params.lastNameEdit
      const { error } = await supabase.from('player_private').upsert(row, { onConflict: 'player_id' })
      if (error) throw new Error(error.message)
      return true
    },
    []
  )
  return useApiCall<boolean, { teamId: number; playerId: number; phone?: string | null;
                               firstNameEdit?: string | null; lastNameEdit?: string | null }>(fn)
}
```

- [ ] **Step 3: Wire the Roster page**

In `Roster.tsx`, fetch both and merge by `player_id` for display. Render the
phone field only when a matching `player_private` row exists — for a guest
there will be none, which is the policy doing its job rather than an error
to report.

- [ ] **Step 4: Fix the player photo upload path**

```bash
grep -rn "player-photos" frontend --include=*.tsx --include=*.ts
```

Change the object name to `${teamId}/${playerId}.${ext}` with
`upsert: true`, matching the storage policy from Plan 1 Task 15.

- [ ] **Step 5: Verify**

As `member@local.test`, edit a player's phone number and reload — it
persists. Sign in as a guest, open a public team's roster, and confirm no
phone numbers render and no console error appears.

- [ ] **Step 6: Commit**

```bash
git add frontend/hooks/backend/players.ts frontend/pages/Roster.tsx
git commit -m "Read and write player contact details from player_private"
```

---

### Task 8: Guest navigation and read-only chrome

**Files:**
- Modify: `frontend/lib/nav.ts`
- Modify: `frontend/components/AppSidebar.tsx`
- Modify: `frontend/App.tsx`

**Interfaces:**
- Produces: `visibleNavItems(isGuest: boolean)`.

Plays and chat are Tier B — members only, with no public branch in the
policy. A guest who reaches `/plays` sees an empty board and a chat that
403s, so the tabs are removed rather than shown broken.

- [ ] **Step 1: Filter the nav**

In `frontend/lib/nav.ts`:

```ts
// Plays and AI read strategy_* and chat_logs, which are members-only with no
// public branch at all. Hiding them for guests matches what the database
// will do anyway.
const MEMBER_ONLY_TABS: Tab[] = ['strategy', 'chat']

export function visibleNavItems(isGuest: boolean) {
  return isGuest ? NAV_ITEMS.filter(i => !MEMBER_ONLY_TABS.includes(i.key)) : NAV_ITEMS
}
```

- [ ] **Step 2: Use it in the sidebar**

In `AppSidebar.tsx`, replace `NAV_ITEMS.map(...)` with
`visibleNavItems(isGuest).map(...)`, taking `isGuest` from `useAuth()`.

- [ ] **Step 3: Block the routes too**

In `App.tsx`, replace the `allowed` destructure with `can`/`isGuest` and
guard the two member-only routes:

```tsx
{!isGuest && <Route path="/plays" element={<Strategy />} />}
{!isGuest && <Route path="/plays/:playId" element={<Strategy />} />}
{!isGuest && <Route path="/ai" element={<Chat />} />}
```

Hiding a tab is UX; removing the route is what stops a typed URL.

- [ ] **Step 4: Replace the read-only notice**

The existing `readOnlyNotice` keys on `!allowed`. Replace it:

```tsx
const guestNotice = isGuest && (
  <div className="border-b bg-muted/60 px-4 py-2 text-center text-sm">
    You're browsing as a guest.{' '}
    <Link to="/login" className="font-medium underline">Sign up</Link>{' '}
    to join a team and track your own stats.
  </div>
)

const readOnlyNotice = !isGuest && !can.record && (
  <div className="border-b bg-muted/60 px-4 py-2 text-center text-sm">
    You don't have permission to change this team's data.
  </div>
)
```

- [ ] **Step 5: Hide write controls**

```bash
grep -rn "allowed" frontend --include=*.tsx
```

Replace every remaining `allowed` with the right capability:
`can.record` for anything that writes game data, `can.manageTeam` for team
settings and roster membership, `can.manageRoles` for role controls.

- [ ] **Step 6: Verify as a guest**

Sign in as a guest. Expected: no Plays or AI tab; typing `/plays` renders the
fallback rather than the board; the guest banner shows; Schedule, Roster and
Stats display **team B only** (the public one), with no add/edit buttons.

- [ ] **Step 7: Commit**

```bash
git add frontend/lib/nav.ts frontend/components/AppSidebar.tsx frontend/App.tsx
git commit -m "Hide member-only tabs and write controls from guests"
```

---

### Task 9: My Stats

**Files:**
- Modify: `frontend/pages/Stats.tsx`
- Create: `frontend/hooks/backend/playerLink.ts`

**Interfaces:**
- Produces: `useMyPlayerLink()`, `useClaimPlayer()`, `useApprovePlayerClaim()`.

- [ ] **Step 1: Write the link hooks**

Create `frontend/hooks/backend/playerLink.ts` (same `useApiCall` helper):

```ts
export type PlayerLink = {
  id: number
  team_id: number
  player_id: number
  user_id: string
  status: 'pending' | 'approved'
}

export function useMyPlayerLink() {
  const fn = useCallback(async (params: { teamId: number; userId: string }) => {
    const { data, error } = await supabase
      .from('player_links')
      .select('*')
      .eq('team_id', params.teamId)
      .eq('user_id', params.userId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    return (data ?? null) as PlayerLink | null
  }, [])
  return useApiCall<PlayerLink | null, { teamId: number; userId: string }>(fn)
}

export function useClaimPlayer() {
  const fn = useCallback(async (params: { playerId: number }) => {
    const { error } = await supabase.rpc('claim_player', { p_player_id: params.playerId })
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { playerId: number }>(fn)
}

export function useApprovePlayerClaim() {
  const fn = useCallback(async (params: { linkId: number }) => {
    const { error } = await supabase.rpc('approve_claim', { p_link_id: params.linkId })
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall<boolean, { linkId: number }>(fn)
}
```

- [ ] **Step 2: Add the tab**

In `Stats.tsx`, add a `"me"` tab, first in the list, shown only when
`!isGuest`. Its content has three states:

```tsx
// No link yet: offer to claim a roster spot. A link never grants any
// permission -- it only answers "whose stats are these" -- so a pending
// claim is harmless while it waits for approval.
if (!link.data) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Which player are you?</CardTitle>
        <CardDescription>
          Pick your name on the roster to see your own stats. A captain or
          editor confirms it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <PlayerCombobox
          players={unclaimedPlayers}
          onSelect={async p => {
            await claim.trigger({ playerId: p.id })
            await link.trigger({ teamId: currentTeamId!, userId: user!.id })
          }}
        />
        {claim.error && <p className="mt-2 text-sm text-destructive">{claim.error}</p>}
      </CardContent>
    </Card>
  )
}

if (link.data.status === 'pending') {
  return (
    <Card>
      <CardHeader><CardTitle>Waiting for confirmation</CardTitle></CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        You've claimed a roster spot. A captain or editor needs to confirm it
        before your stats show up here.
      </CardContent>
    </Card>
  )
}

// Approved: reuse the existing per-player stat computation, filtered to one
// player. No new aggregate query -- the same numbers the Table tab shows.
const mine = stats?.find(s => s.player_id === link.data!.player_id)
```

Render `mine` with the existing stat card components used elsewhere on the
page — career totals plus the per-season breakdown the Overview tab already
computes.

- [ ] **Step 3: Add claim approval to team settings**

In `OrganizationSettingsDialog.tsx`, when `can.manageTeam`, list
`player_links` rows with `status = 'pending'` and an Approve button calling
`useApprovePlayerClaim`.

- [ ] **Step 4: Verify**

As `member@local.test` (seeded with no link), open Stats → Me, claim player
`Mem`, and confirm the pending state. As `captain@local.test`, approve it.
Back as the member, confirm the stats render and match that player's row in
the Table tab.

- [ ] **Step 5: Commit**

```bash
git add frontend/pages/Stats.tsx frontend/hooks/backend/playerLink.ts frontend/components/OrganizationSettingsDialog.tsx
git commit -m "Add My Stats with player claim and approval"
```

---

### Task 10: Public teams browser for guests

**Files:**
- Create: `frontend/pages/PublicTeams.tsx`
- Modify: `frontend/App.tsx`

**Interfaces:**
- Consumes: `organizations` filtered by RLS to public teams plus the
  caller's own.

A guest has no current team, so the team-scoped Schedule page has nothing to
render. Give them a list to choose from instead.

- [ ] **Step 1: Write the page**

Create `frontend/pages/PublicTeams.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

type PublicTeam = { id: number; name: string; photo_url: string | null }

export default function PublicTeams() {
  const { switchTeam } = useAuth()
  const [teams, setTeams] = useState<PublicTeam[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // No is_public filter needed: the read policy already limits this to
    // public teams plus any the caller belongs to. Filtering here as well
    // would imply the client is the thing enforcing it.
    supabase
      .from('organizations')
      .select('id,name,photo_url')
      .order('name')
      .then(({ data, error }) => {
        if (error) setError(error.message)
        else setTeams((data ?? []) as PublicTeam[])
      })
  }, [])

  if (error) return <p className="p-6 text-sm text-destructive">{error}</p>
  if (!teams) return <p className="p-6 text-sm text-muted-foreground">Loading teams…</p>
  if (teams.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        No teams have made themselves public yet.
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl space-y-2 p-6">
      <h1 className="text-lg font-semibold">Public teams</h1>
      {teams.map(t => (
        <button
          key={t.id}
          onClick={() => switchTeam(t.id)}
          className="flex w-full items-center gap-3 rounded-md border p-3 text-left hover:bg-muted"
        >
          {t.photo_url && <img src={t.photo_url} alt="" className="h-8 w-8 rounded-full object-cover" />}
          <span>{t.name}</span>
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Let a guest hold a current team**

`AuthContext.switchTeam` currently only accepts ids from `teams`. Allow a
guest to select a public team they do not belong to:

```tsx
const switchTeam = useCallback((teamId: number) => {
  setCurrentTeamId(teamId)
}, [])
```

The capability computation still returns `NO_CAPABILITIES`, because `role`
is derived from `teams` — which for a guest is empty. Selecting a team gives
a guest something to read, never anything to do.

- [ ] **Step 3: Route it**

In `App.tsx`, when `isGuest && currentTeamId == null`, render `PublicTeams`
instead of the normal shell. Add `<Route path="/teams" element={<PublicTeams />} />`
so a guest can get back to the list.

- [ ] **Step 4: Verify**

As a guest: the list shows "Team B (public)" and **not** "Team A (private)".
Selecting Team B renders its schedule and stats read-only.

- [ ] **Step 5: Commit**

```bash
git add frontend/pages/PublicTeams.tsx frontend/App.tsx frontend/contexts/AuthContext.tsx
git commit -m "Add public teams browser for guest sessions"
```

---

### Task 11: Full-app verification pass

**Files:** none (verification only)

- [ ] **Step 1: Build clean**

```bash
cd frontend && npx tsc --noEmit && npm run build
```

Expected: no type errors, successful build.

- [ ] **Step 2: Confirm no stale identifiers survive**

```bash
grep -rn "allowed\b\|organizations\b\|currentOrgId\|switchOrg\|joinOrganization\|OrgMembership" \
  frontend --include=*.tsx --include=*.ts | grep -v "from('organizations')" | grep -v node_modules
```

Expected: only `supabase.from('organizations')` table references remain
(the table keeps its name until Plan 4).

- [ ] **Step 3: Walk the matrix by hand**

For each identity, confirm the expected surface:

| Sign in as | Expect |
|---|---|
| `captain@local.test` | all tabs; role dropdowns; can invite editors; can delete team |
| `editor@local.test` | all tabs; team settings; member-only invites; no role dropdowns |
| `member@local.test` | all tabs; can record games; no team settings |
| `unlinked@local.test` | Stats → Me offers a claim |
| `outsider@local.test` | sees team B only; team A invisible |
| guest | no Plays/AI; public team only; no write controls; banner shown |

- [ ] **Step 4: Re-run everything**

```bash
npm run db:test && npm test && npm run test:authz
```

Expected: all suites pass.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "Fix issues found in the full-app verification pass"
```

---

## Done when

- No component reads `allowed`; every gate is a `can.*` capability.
- A guest sees no Plays tab, no AI tab, no write control, and no private
  team — and typing the URL does not get them in either.
- Captains see role controls; editors do not; members see neither.
- My Stats renders for a linked member and offers a claim for an unlinked one.
- `npm run db:test && npm test && npm run test:authz` all pass, and the
  frontend builds clean.

## Next

`docs/superpowers/plans/2026-09-03-team-permissions-4-rename.md`
