# Account Deletion (Soft) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to self-serve delete their account while preserving the `auth.users` row and recording a tombstone to permanently block re-signup, re-login, and trial reuse.

**Architecture:** A new `deleted_accounts` tombstone table stores deleted email/trial metadata; a security-definer helper `is_email_deleted()` gates signup endpoints; GoTrue's admin ban API blocks subsequent authentication; and a dedicated service-role handler outside the gateway orchestrates blocker checks, tombstone insertion, and membership cleanup.

**Tech Stack:** Postgres / Supabase RLS, Cloudflare Workers / Node Express gateway, TypeScript, Vitest, React + Phosphor icons.

**Spec:** `docs/superpowers/specs/2026-09-29-account-deletion-design.md`

## Global Constraints

- Never run `npm test` at repo root (reads production database).
- Do not run `npx supabase start` unless explicitly instructed; keep QA stack stopped.
- Run offline tests with `npm run test:gateway:offline`.
- In `frontend/`, run unit tests with `npm test`.
- New tables in `public` without client policies must be explicitly added to `supabase/tests/00_meta.test.sql` allowlist.
- Handlers requiring `SUPABASE_SECRET_KEY` must live outside `createGateway` and be mounted in both `worker.ts` and `server/index.ts`.
- Phosphor icons (`@phosphor-icons/react`), never `lucide-react`, in the nav shell and new nav dialogs.
- DO NOT ADD ANY COMMENTS unless asked.

## Review Focus

1. Email casing mismatch (e.g., user deletes `User@Example.com` then tries to sign up with `user@example.com` or vice versa) must be case-insensitively blocked.
2. User who is a platform admin attempts deletion via API directly without UI; must receive 409 error with blocker details.
3. Idempotent deletion retry: if tombstone row already exists (e.g. earlier request failed during ban call), second delete must succeed (200 OK) and re-apply ban.
4. User who is the sole captain of a team attempts deletion; must be rejected with 409 and team list.
5. User deletion removes `team_members` and `player_links` without violating foreign key constraints or triggering `enforce_last_captain()`.

---

### Task 1: Database Migration and Meta Allowlist

**Files:**
- Create: `supabase/migrations/20260929000000_account_deletion_tombstone.sql`
- Modify: `supabase/tests/00_meta.test.sql:59-70`

**Interfaces:**
- Produces: `public.deleted_accounts` table:
  - `email text primary key`
  - `user_id uuid not null references auth.users(id) on delete restrict`
  - `deleted_at timestamptz not null default now()`
  - `trial_used boolean not null default false`
  - `stripe_customer_id text null`
- Produces: `public.is_email_deleted(p_email text) returns boolean` (SECURITY DEFINER, STABLE)

- [ ] **Step 1: Write database migration SQL**

Create `supabase/migrations/20260929000000_account_deletion_tombstone.sql`:
```sql
create table if not exists public.deleted_accounts (
  email text primary key,
  user_id uuid not null references auth.users(id) on delete restrict,
  deleted_at timestamptz not null default now(),
  trial_used boolean not null default false,
  stripe_customer_id text null
);

alter table public.deleted_accounts enable row level security;
revoke all on public.deleted_accounts from anon, authenticated;

create or replace function public.is_email_deleted(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.deleted_accounts
    where email = lower(trim(p_email))
  );
$$;

grant execute on function public.is_email_deleted(text) to anon, authenticated;
```

- [ ] **Step 2: Update `supabase/tests/00_meta.test.sql` allowlist**

Edit `supabase/tests/00_meta.test.sql` to include `'deleted_accounts'` in the zero-policy exclusion list alongside `'processed_stripe_events'`, `'feature_flags'`, etc.

- [ ] **Step 3: Commit migration and allowlist update**

```bash
git add supabase/migrations/20260929000000_account_deletion_tombstone.sql supabase/tests/00_meta.test.sql
git commit -m "feat(db): add deleted_accounts tombstone table and is_email_deleted function"
```

---

### Task 2: Gateway Signup Gate for Deleted Emails

**Files:**
- Modify: `gateway/auth-handlers.ts:204-275`
- Test: `gateway/auth-deleted-signup.test.mjs`
- Modify: `package.json:27` (append to `test:gateway:offline`)

**Interfaces:**
- Consumes: `is_email_deleted(p_email: string)` via Supabase RPC or direct REST endpoint
- Modifies: `POST /auth/signup` and `GET /auth/callback` error responses

- [ ] **Step 1: Write the failing unit test for signup block**

Create `gateway/auth-deleted-signup.test.mjs`:
```javascript
import assert from 'node:assert/strict'
import { handleAuthRequest } from './auth-handlers.ts'

let failed = 0
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'}  ${name}`)
  if (!cond) failed++
}

const config = {
  supabaseUrl: 'https://example.test',
  publishableKey: 'pub-key',
  jwksUrl: 'https://example.test/.well-known/jwks.json',
}

const realFetch = globalThis.fetch
function stub(impl) {
  globalThis.fetch = async (url, init) => {
    return impl(String(url), init)
  }
}

try {
  // Test: signup with deleted email returns 403
  stub(async (url) => {
    if (url.includes('/rest/v1/rpc/is_email_deleted')) {
      return new Response(JSON.stringify(true), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('unexpected', { status: 500 })
  })

  const req = new Request('https://app.test/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'Deleted@Example.com', password: 'password123' }),
  })

  const res = await handleAuthRequest(config, req, new URL(req.url))
  check('signup with deleted email returns 403', res.status === 403)
  const body = await res.json()
  check('returns account deleted error message', body.error && body.error.includes('deleted'))

  // Test: signup with non-deleted email proceeds to GoTrue
  let signupCalled = false
  stub(async (url) => {
    if (url.includes('/rest/v1/rpc/is_email_deleted')) {
      return new Response(JSON.stringify(false), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.includes('/auth/v1/signup')) {
      signupCalled = true
      return new Response(JSON.stringify({ user: { id: 'u1', email: 'active@example.com' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('unexpected', { status: 500 })
  })

  const validReq = new Request('https://app.test/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'active@example.com', password: 'password123' }),
  })
  const validRes = await handleAuthRequest(config, validReq, new URL(validReq.url))
  check('active email proceeds to signup', validRes.status === 200 && signupCalled)

} finally {
  globalThis.fetch = realFetch
}

if (failed > 0) {
  process.exit(1)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/tsx/dist/cli.mjs gateway/auth-deleted-signup.test.mjs`
Expected: FAIL (deleted email does not return 403)

- [ ] **Step 3: Implement signup check in `gateway/auth-handlers.ts`**

In `gateway/auth-handlers.ts`, add a helper to check if email is deleted:
```typescript
async function checkEmailDeleted(config: GatewayConfig, email: string): Promise<boolean> {
  try {
    const res = await fetch(`${config.supabaseUrl}/rest/v1/rpc/is_email_deleted`, {
      method: 'POST',
      headers: {
        'apikey': config.publishableKey,
        'Authorization': `Bearer ${config.publishableKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_email: email }),
    })
    if (!res.ok) return false
    return await res.json() === true
  } catch {
    return false
  }
}
```
In `POST /auth/signup` handling (around line 204), call `checkEmailDeleted`:
```typescript
if (await checkEmailDeleted(config, email)) {
  return json({ error: 'This account was deleted and cannot be recreated. Contact support.' }, 403)
}
```
In `GET /auth/callback` after exchange if user email is present, check `checkEmailDeleted(config, data.user?.email)` and redirect with error if deleted.

- [ ] **Step 4: Run test to verify it passes and wire to `package.json`**

Run: `node node_modules/tsx/dist/cli.mjs gateway/auth-deleted-signup.test.mjs`
Expected: PASS

Update `package.json`: append ` && node node_modules/tsx/dist/cli.mjs gateway/auth-deleted-signup.test.mjs` to `test:gateway:offline`.
Run: `npm run test:gateway:offline`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add gateway/auth-handlers.ts gateway/auth-deleted-signup.test.mjs package.json
git commit -m "feat(auth): block signup for deleted accounts"
```

---

### Task 3: Account Deletion Service Handler

**Files:**
- Create: `gateway/account/deleteAccount.ts`
- Test: `gateway/account/deleteAccount.test.mjs`
- Modify: `package.json:27` (append to `test:gateway:offline`)

**Interfaces:**
- Produces: `handleAccountDeleteRequest(config: ServiceConfig, request: Request): Promise<Response | null>`
  - Handles `GET /api/account/delete/blockers`
  - Handles `POST /api/account/delete`
- ServiceConfig: `{ supabaseUrl: string, supabaseSecretKey: string }`

- [ ] **Step 1: Write failing unit test for delete account logic**

Create `gateway/account/deleteAccount.test.mjs`:
```javascript
import assert from 'node:assert/strict'
import { handleAccountDeleteRequest } from './deleteAccount.ts'

let failed = 0
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'}  ${name}`)
  if (!cond) failed++
}

const config = {
  supabaseUrl: 'https://example.test',
  supabaseSecretKey: 'secret-key',
}

const realFetch = globalThis.fetch
function stub(impl) {
  globalThis.fetch = async (url, init) => {
    return impl(String(url), init)
  }
}

try {
  // Test 1: Unauthenticated request returns 401
  stub(async () => new Response('unauthorized', { status: 401 }))
  const unauthReq = new Request('https://app.test/api/account/delete/blockers', {
    method: 'GET',
    headers: {},
  })
  const res1 = await handleAccountDeleteRequest(config, unauthReq)
  check('unauthenticated request returns 401', res1.status === 401)

  // Test 2: Platform admin is blocked
  stub(async (url) => {
    if (url.includes('/auth/v1/user')) {
      return new Response(JSON.stringify({ id: 'u-admin', email: 'admin@test.com' }), { status: 200 })
    }
    if (url.includes('/rest/v1/platform_admins')) {
      return new Response(JSON.stringify([{ user_id: 'u-admin' }]), { status: 200 })
    }
    if (url.includes('/rest/v1/team_members')) {
      return new Response(JSON.stringify([]), { status: 200 })
    }
    return new Response('[]', { status: 200 })
  })

  const adminReq = new Request('https://app.test/api/account/delete/blockers', {
    method: 'GET',
    headers: { Authorization: 'Bearer token-123' },
  })
  const res2 = await handleAccountDeleteRequest(config, adminReq)
  const body2 = await res2.json()
  check('platform admin has blocker', body2.deletable === false && body2.isPlatformAdmin === true)

  // Test 3: Sole captain is blocked
  stub(async (url) => {
    if (url.includes('/auth/v1/user')) {
      return new Response(JSON.stringify({ id: 'u-captain', email: 'captain@test.com' }), { status: 200 })
    }
    if (url.includes('/rest/v1/platform_admins')) {
      return new Response(JSON.stringify([]), { status: 200 })
    }
    if (url.includes('/rest/v1/team_members')) {
      // Mock team_members for user query
      return new Response(JSON.stringify([{ team_id: 10, role: 'captain', teams: { id: 10, name: 'Sole Team' } }]), { status: 200 })
    }
    if (url.includes('rpc/sole_captain_teams')) {
      return new Response(JSON.stringify([{ team_id: 10, name: 'Sole Team' }]), { status: 200 })
    }
    return new Response('[]', { status: 200 })
  })

  const captainReq = new Request('https://app.test/api/account/delete/blockers', {
    method: 'GET',
    headers: { Authorization: 'Bearer token-123' },
  })
  const res3 = await handleAccountDeleteRequest(config, captainReq)
  const body3 = await res3.json()
  check('sole captain has blocker', body3.deletable === false && body3.soleCaptainTeams.length === 1)

  // Test 4: Delete execution when clean
  let deletedMembers = false
  let deletedLinks = false
  let tombstoneInserted = false
  let banned = false

  stub(async (url, init) => {
    if (url.includes('/auth/v1/user')) {
      return new Response(JSON.stringify({ id: 'u-clean', email: 'clean@test.com' }), { status: 200 })
    }
    if (url.includes('/rest/v1/platform_admins')) {
      return new Response(JSON.stringify([]), { status: 200 })
    }
    if (url.includes('rpc/sole_captain_teams') || url.includes('/rest/v1/team_members?user_id=')) {
      return new Response(JSON.stringify([]), { status: 200 })
    }
    if (url.includes('/rest/v1/deleted_accounts') && init.method === 'POST') {
      tombstoneInserted = true
      return new Response(JSON.stringify({}), { status: 201 })
    }
    if (url.includes('/rest/v1/team_members?user_id=eq.u-clean') && init.method === 'DELETE') {
      deletedMembers = true
      return new Response(JSON.stringify({}), { status: 200 })
    }
    if (url.includes('/rest/v1/player_links?user_id=eq.u-clean') && init.method === 'DELETE') {
      deletedLinks = true
      return new Response(JSON.stringify({}), { status: 200 })
    }
    if (url.includes('/auth/v1/admin/users/u-clean') && init.method === 'PUT') {
      banned = true
      return new Response(JSON.stringify({}), { status: 200 })
    }
    return new Response('[]', { status: 200 })
  })

  const delReq = new Request('https://app.test/api/account/delete', {
    method: 'POST',
    headers: { Authorization: 'Bearer token-123', 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmationEmail: 'clean@test.com' }),
  })
  const res4 = await handleAccountDeleteRequest(config, delReq)
  check('delete returns 200', res4.status === 200)
  check('tombstone inserted', tombstoneInserted)
  check('memberships deleted', deletedMembers)
  check('player links deleted', deletedLinks)
  check('user banned in auth admin', banned)

} finally {
  globalThis.fetch = realFetch
}

if (failed > 0) {
  process.exit(1)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/tsx/dist/cli.mjs gateway/account/deleteAccount.test.mjs`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `gateway/account/deleteAccount.ts`**

Create `gateway/account/deleteAccount.ts`:
- Authenticate incoming request via `GET ${config.supabaseUrl}/auth/v1/user` using the caller's Bearer token.
- Helper `getBlockers(config, userId)`:
  - Check `platform_admins` where `user_id = eq.${userId}`.
  - Query teams where user is captain: check if other captains exist for each team. If no other captain exists, team is a blocker.
- In `GET /api/account/delete/blockers`: return `{ deletable: !isPlatformAdmin && soleCaptainTeams.length === 0, isPlatformAdmin, soleCaptainTeams }`.
- In `POST /api/account/delete`:
  - Re-verify blockers. If blocked, return 409 with details.
  - Check confirmation email matches user email (case-insensitive).
  - Check if any captained team had `trial_started_at is not null` on `organizations` to populate `trial_used` and `stripe_customer_id`.
  - Insert into `deleted_accounts` with `resolution: 'ignore'` on conflict.
  - Delete `team_members` for `user_id`.
  - Delete `player_links` for `user_id`.
  - Call GoTrue admin `PUT ${config.supabaseUrl}/auth/v1/admin/users/${userId}` with `ban_duration: '876000h'` (100 years).
  - Return `{ success: true }`.

- [ ] **Step 4: Run test to verify it passes and wire to `package.json`**

Run: `node node_modules/tsx/dist/cli.mjs gateway/account/deleteAccount.test.mjs`
Expected: PASS

Update `package.json`: append ` && node node_modules/tsx/dist/cli.mjs gateway/account/deleteAccount.test.mjs` to `test:gateway:offline`.
Run: `npm run test:gateway:offline`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add gateway/account/deleteAccount.ts gateway/account/deleteAccount.test.mjs package.json
git commit -m "feat(account): implement account deletion service handler"
```

---

### Task 4: Mount Account Handlers in Worker and Node Server

**Files:**
- Modify: `worker.ts:100-110`
- Modify: `server/index.ts:88-95`

**Interfaces:**
- Consumes: `handleAccountDeleteRequest` from `gateway/account/deleteAccount.ts`
- Routes: `/api/account/delete` and `/api/account/delete/blockers`

- [ ] **Step 1: Mount in `worker.ts`**

In `worker.ts`, import `handleAccountDeleteRequest`:
```typescript
import { handleAccountDeleteRequest } from "./gateway/account/deleteAccount";
```
In `fetch(request, env, ctx)` handler (after flags/admin responses):
```typescript
const accountResponse = await handleAccountDeleteRequest(
  {
    supabaseUrl: env.SUPABASE_URL,
    supabaseSecretKey: env.SUPABASE_SECRET_KEY,
  },
  request
);
if (accountResponse) return accountResponse;
```

- [ ] **Step 2: Mount in `server/index.ts`**

In `server/index.ts`, import `handleAccountDeleteRequest`:
```typescript
import { handleAccountDeleteRequest } from "../gateway/account/deleteAccount";
```
Add route middleware using `createNodeAdapter` before `app.use(express.json())`:
```typescript
app.use(
  createNodeAdapter(
    (request) => handleAccountDeleteRequest(
      {
        supabaseUrl: gatewayConfig.supabaseUrl,
        supabaseSecretKey: process.env.SUPABASE_SECRET_KEY || "",
      },
      request
    ),
    (path) => path.startsWith("/api/account/delete")
  )
);
```

- [ ] **Step 3: Verify build and offline tests**

Run: `npm run build && npm run test:gateway:offline`
Expected: Build passes, all offline tests pass.

- [ ] **Step 4: Commit**

```bash
git add worker.ts server/index.ts
git commit -m "feat(server): mount account delete handlers in worker and express server"
```

---

### Task 5: Frontend Delete Account Dialog and UserMenu Integration

**Files:**
- Create: `frontend/components/DeleteAccountDialog.tsx`
- Modify: `frontend/components/nav/UserMenu.tsx:50-165`
- Test: `frontend/components/DeleteAccountDialog.test.tsx`

**Interfaces:**
- Consumes: `/api/account/delete/blockers`, `/api/account/delete`
- Consumes: Phosphor icons (`Trash`, `WarningCircle`)
- Props for `DeleteAccountDialog`: `{ open: boolean, onOpenChange: (open: boolean) => void, email: string | null }`

- [ ] **Step 1: Write failing frontend test for `DeleteAccountDialog`**

Create `frontend/components/DeleteAccountDialog.test.tsx`:
```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DeleteAccountDialog } from './DeleteAccountDialog'

describe('DeleteAccountDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders blockers when user is platform admin or sole captain', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        deletable: false,
        isPlatformAdmin: true,
        soleCaptainTeams: [{ team_id: 1, name: 'Team Alpha' }],
      }),
    }) as any

    render(<DeleteAccountDialog open={true} onOpenChange={() => {}} email="test@test.com" />)

    await waitFor(() => {
      expect(screen.getByText(/cannot be deleted/i)).toBeInTheDocument()
      expect(screen.getByText(/Team Alpha/i)).toBeInTheDocument()
      expect(screen.getByText(/platform administrator/i)).toBeInTheDocument()
    })
  })

  it('requires typing email to confirm when deletable', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        deletable: true,
        isPlatformAdmin: false,
        soleCaptainTeams: [],
      }),
    }) as any

    render(<DeleteAccountDialog open={true} onOpenChange={() => {}} email="test@test.com" />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /delete account/i })).toBeDisabled()
    })

    const input = screen.getByPlaceholderText('test@test.com')
    fireEvent.change(input, { target: { value: 'test@test.com' } })

    expect(screen.getByRole('button', { name: /delete account/i })).not.toBeDisabled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test frontend/components/DeleteAccountDialog.test.tsx`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `DeleteAccountDialog.tsx`**

Create `frontend/components/DeleteAccountDialog.tsx`:
- Fetch `/api/account/delete/blockers` when opened.
- If loading: show spinner or skeleton.
- If blockers exist: show informative warning list with team names and contact support notice. Submit button hidden or disabled.
- If deletable: show warning that deletion is permanent, data cannot be recovered, and email cannot be reused. Input requiring user to type their email exact match.
- On submit: `POST /api/account/delete`, on success trigger `window.location.href = '/'` or call auth logout.

- [ ] **Step 4: Add "Delete account…" action to `UserMenu.tsx`**

In `frontend/components/nav/UserMenu.tsx`:
- Import `Trash` from `@phosphor-icons/react`.
- Add local state `deleteDialogOpen`.
- Add action before Sign out:
```tsx
{ icon: Trash, label: "Delete account…", onSelect: () => setDeleteDialogOpen(true) }
```
- Render `<DeleteAccountDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen} email={email} />`.

- [ ] **Step 5: Run tests to verify pass**

Run: `cd frontend && npm test`
Expected: All frontend tests pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/components/DeleteAccountDialog.tsx frontend/components/DeleteAccountDialog.test.tsx frontend/components/nav/UserMenu.tsx
git commit -m "feat(ui): add DeleteAccountDialog and wire to UserMenu"
```

---

### Task 6: End-to-End Verification and Lint Check

**Files:**
- Test all components across frontend and backend.

- [ ] **Step 1: Run gateway offline test suite**

Run: `npm run test:gateway:offline`
Expected: PASS

- [ ] **Step 2: Run frontend test suite**

Run: `cd frontend && npm test`
Expected: PASS

- [ ] **Step 3: Run TypeScript checks and linting**

Run: `npm run typecheck` (or `npx tsc --noEmit`) and `cd frontend && npm run build`
Expected: PASS with 0 errors.

- [ ] **Step 4: Check git status**

Run: `git status`
Expected: Clean working tree.
