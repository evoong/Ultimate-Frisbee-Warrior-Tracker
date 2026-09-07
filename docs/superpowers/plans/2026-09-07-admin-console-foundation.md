# Admin Console Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an audited, invariant-safe admin console at `/admin` that can inspect any user or organization and perform a fixed catalog of named manual corrections, without weakening any existing RLS policy.

**Architecture:** A `platform_admins` table plus an append-only `admin_audit_log`, both RLS-enabled with zero policies (service-role only). Admin request handling lives in `gateway/admin/`, deliberately **outside** `createGateway` (which never holds the service role), and is mounted in both `worker.ts` and `server/index.ts`. Authorization is a per-request, fail-closed lookup mirroring `createMembershipLookup`. Mutations are a fixed catalog of named operations dispatched through a wrapper that writes the audit row, so no operation can forget to log.

**Tech Stack:** TypeScript, Cloudflare Workers + Express (dual mount), Supabase Postgres via raw REST (`gateway/supabaseRest.ts`), `jose` for JWT verification, `zod` for input schemas, React + Vite + shadcn on the frontend, pgTAP for database tests, plain `node` scripts for gateway tests.

**Spec:** `docs/superpowers/specs/2026-09-07-admin-console-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- Admin handlers live in `gateway/admin/`, **outside** `createGateway`. The gateway "only ever proxies as the caller's own token" (comment in `worker.ts`); admin handlers hold the service role, so they must not go inside it.
- API prefix is **`/api/admin/*`**. SPA route is **`/admin/*`**. These must differ: `worker.ts` serves the SPA fallback only for paths failing `isGatewayPath`, so an `/admin` API prefix would make `/admin/users` 404.
- Both new tables are RLS-enabled with **zero policies**, plus explicit `revoke all ... from anon, authenticated`. Follow `20260907201815_lockdown_feedback_triage_grants.sql`.
- `admin_audit_log.admin_id` is `on delete restrict`. `admin_role` is denormalized (the role held at the time of the action). `result` is one of `'ok' | 'denied' | 'error'`. `UPDATE` and `DELETE` are rejected by trigger.
- Admin role order is `readonly` < `support` < `superadmin`.
- `createAdminLookup` **fails closed**: any error or non-2xx yields `null`, therefore denied. TTL is 30s. Error results are **never cached**. `onLookupError` reports to Sentry and must never affect the deny.
- A guest is never an admin: reject when `SessionClaims.isAnonymous` is true.
- The **dispatcher** writes audit rows, not the operations. `preview` writes neither data nor an audit row.
- Admin writes go **direct via the service role**, never through `set_member_role` / `remove_member` / `invite_member` / `revoke_invite` / `set_player_link` / `approve_claim`. Those gate on `auth.uid()` via `my_captain_team_ids()`, which is empty under the service role, so they raise `only a captain can change roles`. The `team_members_require_captain` trigger still enforces the last-captain invariant on direct writes; each operation re-implements the RPC's input validation.
- New `security definer` functions must `set search_path = ''` and `revoke all ... from public, anon, authenticated`. `00_meta.test.sql` asserts both.
- **No changes to any existing RLS policy.**
- The console cannot create or promote admins. Grants happen only via `scripts/grant-platform-admin.mjs`.
- **Never run `npm test`.** `CLAUDE.md` records that it reads and asserts against the production database. Use `npm run db:test` and `npm run test:gateway:offline`.
- `team_members.team_id`, `team_invites.team_id`, `player_links.team_id`, and `player_private.team_id` are all foreign keys to **`organizations(id)`**. The tenant is the organization. Do not treat these as references to `teams(id)`.
- **Admin pages belong to the GLOBAL visual system**, not the schedule's. The app ships two: stock shadcn tokens in `frontend/index.css` (global), and a scoped `--sch-*` / `.sch-*` system under `.schedule-scope` in `frontend/components/schedule/schedule-theme.css`. The scoped one is namespaced precisely so it cannot leak — do **not** use `--sch-*` tokens, `.sch-*` classes, Space Mono, or the chartreuse accent on any admin page.
- **`frontend/orgTheme.css` is a dead file** that nothing imports. Do not wire it up; it would restyle every page and effectively drop the light theme.
- **Light and dark are both live**, toggled by a `dark` class on `<html>` (set in `App.tsx`, persisted to localStorage). Every admin page must be legible in both. Use shadcn tokens (`bg-background`, `text-foreground`, `text-muted-foreground`, `border`) rather than fixed palette colours, so both themes follow automatically.
- shadcn primitives live in **`frontend/lib/shadcn/`**, not `components/ui/`. There is no `components.json`, so `npx shadcn add` does not work — add any missing primitive by hand.

## File Structure

**Create**
- `supabase/migrations/20260907210000_platform_admins.sql` — the two tables, the append-only trigger, grant revocations.
- `supabase/migrations/20260907210100_admin_rpcs.sql` — `admin_preview_delete_org`, `admin_merge_players`.
- `supabase/tests/18_platform_admins.test.sql` — lockdown and append-only assertions.
- `supabase/tests/19_admin_rpcs.test.sql` — RPC behaviour, including every unique-constraint conflict path.
- `scripts/grant-platform-admin.mjs` — the only way to mint an admin.
- `gateway/admin/adminAuth.ts` — `AdminRole`, `hasAtLeastAdmin`, `createAdminLookup`.
- `gateway/admin/adminAuth.test.mjs` — offline, `fetch`-stubbed.
- `gateway/admin/operations.ts` — `AdminOperation`, `AdminCtx`, the registry, the auditing dispatcher.
- `gateway/admin/adminOps.test.mjs` — offline, stubbed.
- `gateway/admin/ops.ts` — the eight v1 operation definitions.
- `gateway/admin/reads.ts` — the four read endpoints.
- `gateway/admin/index.ts` — `handleAdminRequest`, the only export the app mounts.
- `frontend/pages/admin/AdminLayout.tsx`, `Search.tsx`, `UserDetail.tsx`, `OrgDetail.tsx`, `AuditLog.tsx`
- `frontend/lib/adminClient.ts` — typed fetch wrapper for `/api/admin/*`.

**Modify**
- `supabase/tests/00_meta.test.sql:45` — extend the zero-policy allowlist.
- `gateway/node-adapter.ts` — generalize so a second handler can be mounted.
- `gateway/auth-handlers.ts` — add `admin` to the `GET /auth/session` payload.
- `worker.ts` — mount `handleAdminRequest` after the gateway call.
- `server/index.ts` — mount `handleAdminRequest` before `express.json()`.
- `frontend/App.tsx` — lazy `/admin/*` route.
- `frontend/components/AppSidebar.tsx` — conditional nav link.
- `frontend/contexts/AuthContext.tsx` — surface `admin` from the session.
- `package.json` — add the new test files to `test:gateway` and `test:gateway:offline`.
- `CLAUDE.md` — document the bootstrap script and the admin trust boundary.

---

### Task 1: Admin tables, append-only trigger, and bootstrap script

**Files:**
- Create: `supabase/migrations/20260907210000_platform_admins.sql`
- Create: `supabase/tests/18_platform_admins.test.sql`
- Create: `scripts/grant-platform-admin.mjs`
- Modify: `supabase/tests/00_meta.test.sql:45`

**Interfaces:**
- Consumes: nothing.
- Produces: tables `public.platform_admins (user_id uuid pk, role text, created_at timestamptz, granted_by uuid, note text)` and `public.admin_audit_log (id bigint pk, at timestamptz, admin_id uuid, admin_role text, operation text, target jsonb, before jsonb, after jsonb, result text, error text, request_id text)`. Every later task reads or writes these.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/18_platform_admins.test.sql`:

```sql
begin;
select plan(9);

select has_table('public', 'platform_admins', 'platform_admins exists');
select has_table('public', 'admin_audit_log', 'admin_audit_log exists');

-- Both tables are service-role-only: RLS on, zero policies, no grants.
select is_empty(
  $$ select p.polname::text from pg_policy p
       join pg_class c on c.oid = p.polrelid
      where c.relname in ('platform_admins', 'admin_audit_log') $$,
  'neither admin table has any policy'
);

select is_empty(
  $$ select c.relname::text from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in ('platform_admins', 'admin_audit_log')
        and not c.relrowsecurity $$,
  'both admin tables have RLS enabled'
);

select is_empty(
  $$ select c.relname::text from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where n.nspname = 'public'
        and c.relname in ('platform_admins', 'admin_audit_log')
        and a.grantee in ('anon'::regrole, 'authenticated'::regrole) $$,
  'neither anon nor authenticated holds any privilege on the admin tables'
);

-- An audit row must survive the deletion of the admin who wrote it.
select col_has_check('public', 'admin_audit_log', 'result',
  'result is constrained');

-- Append-only: the log accepts inserts and refuses everything else.
insert into public.admin_audit_log (admin_id, admin_role, operation, target, result)
select id, 'superadmin', 'test_op', '{"k":1}'::jsonb, 'ok'
  from auth.users limit 1;

select throws_ok(
  $$ update public.admin_audit_log set operation = 'tampered' $$,
  'admin_audit_log is append-only',
  'UPDATE on admin_audit_log is rejected'
);

select throws_ok(
  $$ delete from public.admin_audit_log $$,
  'admin_audit_log is append-only',
  'DELETE on admin_audit_log is rejected'
);

select throws_ok(
  $$ insert into public.platform_admins (user_id, role)
     select id, 'wizard' from auth.users limit 1 $$,
  '23514',
  'an unknown admin role is rejected by the check constraint'
);

select * from finish();
rollback;
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run db:test`
Expected: FAIL — `18_platform_admins.test.sql` errors because `public.platform_admins` does not exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260907210000_platform_admins.sql`:

```sql
-- Platform-level admin identities and the audit trail of everything they do.
--
-- Both tables are service-role-only. The admin console reaches them through
-- /api/admin/* handlers that hold the service-role key; the browser never
-- reads or writes them directly. RLS is therefore enabled with NO policies --
-- default-deny for every role that is not the service role -- exactly as
-- feedback_clusters/feedback_reports are. This is the intent, not an oversight
-- to be "fixed" later by adding a permissive policy.

create table public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null check (role in ('superadmin', 'support', 'readonly')),
  created_at timestamptz not null default now(),
  granted_by uuid references auth.users(id) on delete set null,
  note       text not null default ''
);

-- admin_id is ON DELETE RESTRICT, deliberately unlike platform_admins above:
-- an audit row must not disappear because the admin's account was deleted.
-- That is the entire point of an audit log. Deleting a former admin's
-- auth.users row therefore requires deciding what to do with their history
-- rather than silently discarding it.
--
-- admin_role is denormalized rather than joined: it records the authority the
-- admin held AT THE TIME OF THE ACTION, so demoting someone later cannot
-- rewrite what they were allowed to do.
--
-- result carries 'denied' and 'error' alongside 'ok' because the log records
-- ATTEMPTS. A denied attempt is the most interesting row in a security log; a
-- success-only log is an activity feed.
create table public.admin_audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  admin_id   uuid not null references auth.users(id) on delete restrict,
  admin_role text not null,
  operation  text not null,
  target     jsonb not null,
  before     jsonb,
  after      jsonb,
  result     text not null check (result in ('ok', 'denied', 'error')),
  error      text,
  request_id text
);

create index admin_audit_log_at_idx        on public.admin_audit_log (at desc);
create index admin_audit_log_operation_idx on public.admin_audit_log (operation, at desc);
create index admin_audit_log_admin_idx     on public.admin_audit_log (admin_id, at desc);

-- Append-only is enforced, not assumed. The service role owns these tables and
-- could otherwise rewrite history; a trigger is the only thing that stops a
-- buggy or malicious handler from editing its own audit trail.
create or replace function public.admin_audit_log_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'admin_audit_log is append-only';
end;
$$;

create trigger admin_audit_log_no_mutate
  before update or delete on public.admin_audit_log
  for each row execute function public.admin_audit_log_append_only();

alter table public.platform_admins  enable row level security;
alter table public.admin_audit_log  enable row level security;

-- Supabase grants anon/authenticated broad table privileges by default in the
-- public schema, so enabling RLS alone is not the whole lockdown -- see
-- 20260907201815_lockdown_feedback_triage_grants.sql for the same reasoning
-- and 00_meta.test.sql's "anon holds no privilege on any table in public".
revoke all on public.platform_admins from anon, authenticated;
revoke all on public.admin_audit_log from anon, authenticated;
revoke all on function public.admin_audit_log_append_only() from public, anon, authenticated;
```

- [ ] **Step 4: Extend the meta-test allowlist**

In `supabase/tests/00_meta.test.sql`, the "every table in public has at least one policy" assertion carries a hardcoded allowlist. Change line 45 from:

```sql
        and c.relname not in ('standings', 'feedback_clusters', 'feedback_reports')
```

to:

```sql
        and c.relname not in ('standings', 'feedback_clusters', 'feedback_reports',
                              'platform_admins', 'admin_audit_log')
```

And extend the comment block above it (currently ending "...and none is.") by appending:

```sql
-- platform_admins and admin_audit_log (20260907210000_platform_admins.sql) are
-- zero-policy for the same reason: the admin console reaches them only through
-- /api/admin/* handlers holding the service-role key, so no client role is
-- meant to reach these rows.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS — `18_platform_admins.test.sql` reports 9/9, and `00_meta.test.sql` still passes with the extended allowlist.

- [ ] **Step 6: Write the bootstrap script**

Create `scripts/grant-platform-admin.mjs`:

```js
// The ONLY way to mint a platform admin. Deliberately not a migration:
// migrations are committed to git and an operator's email does not belong
// there. Deliberately not an admin-console operation either -- a compromised
// admin session must not be able to create more admins.
//
// Usage: node --env-file=.env.local scripts/grant-platform-admin.mjs <email> <role>
//        node --env-file=.env       scripts/grant-platform-admin.mjs <email> <role>

const ROLES = ['superadmin', 'support', 'readonly']

const [email, role] = process.argv.slice(2)
if (!email || !ROLES.includes(role)) {
  console.error(`usage: grant-platform-admin.mjs <email> <${ROLES.join('|')}>`)
  process.exit(1)
}

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SECRET_KEY
if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SECRET_KEY must be set')
  process.exit(1)
}

const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }

// GoTrue's admin list endpoint is the only way to resolve an email to a user
// id with the service role; auth.users is not exposed over REST.
const lookup = await fetch(
  `${url}/auth/v1/admin/users?page=1&per_page=200`, { headers }
)
if (!lookup.ok) {
  console.error(`user lookup failed (${lookup.status}): ${await lookup.text()}`)
  process.exit(1)
}
const { users } = await lookup.json()
const target = users.find(u => (u.email ?? '').toLowerCase() === email.toLowerCase())
if (!target) {
  console.error(`no user found with email ${email}`)
  process.exit(1)
}

const res = await fetch(`${url}/rest/v1/platform_admins?on_conflict=user_id`, {
  method: 'POST',
  headers: { ...headers, Prefer: 'return=representation,resolution=merge-duplicates' },
  body: JSON.stringify({ user_id: target.id, role, note: `granted via script for ${email}` }),
})
if (!res.ok) {
  console.error(`grant failed (${res.status}): ${await res.text()}`)
  process.exit(1)
}
console.log(`granted ${role} to ${email} (${target.id})`)
```

- [ ] **Step 7: Verify the script against the local stack**

Run: `node --env-file=.env.local scripts/grant-platform-admin.mjs captain@local.test superadmin`
Expected: prints `granted superadmin to captain@local.test (<uuid>)`. Re-running prints the same line (upsert, not a duplicate-key error).

Then confirm the row landed:
Run: `docker exec -i $(docker ps -qf name=supabase_db) psql -U postgres -d postgres -c "select role from public.platform_admins"`
Expected: one row, `superadmin`.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260907210000_platform_admins.sql \
        supabase/tests/18_platform_admins.test.sql \
        supabase/tests/00_meta.test.sql \
        scripts/grant-platform-admin.mjs
git commit -m "feat: platform_admins and append-only admin_audit_log"
```

---

### Task 2: The admin authorization lookup

**Files:**
- Create: `gateway/admin/adminAuth.ts`
- Create: `gateway/admin/adminAuth.test.mjs`
- Modify: `package.json` (add to `test:gateway` and `test:gateway:offline`)

**Interfaces:**
- Consumes: `public.platform_admins` from Task 1.
- Produces:
  - `type AdminRole = 'readonly' | 'support' | 'superadmin'`
  - `function hasAtLeastAdmin(role: AdminRole | null, required: AdminRole): boolean`
  - `interface AdminLookupConfig { supabaseUrl: string; supabaseSecretKey: string; onLookupError?: (err: unknown) => void }`
  - `interface AdminLookup { roleFor(userId: string): Promise<AdminRole | null> }`
  - `function createAdminLookup(config: AdminLookupConfig): AdminLookup`

- [ ] **Step 1: Write the failing test**

Create `gateway/admin/adminAuth.test.mjs`. This runs offline by stubbing `globalThis.fetch`, so it belongs in `test:gateway:offline`.

```js
import { createAdminLookup, hasAtLeastAdmin } from './adminAuth.ts'

let failed = 0
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'}  ${name}`)
  if (!cond) failed++
}

// --- hasAtLeastAdmin: pure rank comparison ---

check('superadmin satisfies readonly',   hasAtLeastAdmin('superadmin', 'readonly') === true)
check('superadmin satisfies support',    hasAtLeastAdmin('superadmin', 'support') === true)
check('support satisfies readonly',      hasAtLeastAdmin('support', 'readonly') === true)
check('support does not satisfy superadmin', hasAtLeastAdmin('support', 'superadmin') === false)
check('readonly does not satisfy support',   hasAtLeastAdmin('readonly', 'support') === false)
check('null satisfies nothing',          hasAtLeastAdmin(null, 'readonly') === false)
// Same-rank boundary: a role satisfies its own requirement exactly.
check('readonly satisfies readonly',     hasAtLeastAdmin('readonly', 'readonly') === true)
check('superadmin satisfies superadmin', hasAtLeastAdmin('superadmin', 'superadmin') === true)

// --- createAdminLookup: fetch stubbed, no stack required ---

const CONFIG = { supabaseUrl: 'https://example.test', supabaseSecretKey: 'secret' }
const realFetch = globalThis.fetch

function stub(impl) {
  const calls = []
  globalThis.fetch = async (url, init) => { calls.push(String(url)); return impl(calls.length) }
  return calls
}
const ok = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

// A matching row yields the role.
stub(() => ok([{ role: 'support' }]))
check('returns the row role', await createAdminLookup(CONFIG).roleFor('u1') === 'support')

// No row means not an admin.
stub(() => ok([]))
check('no row yields null', await createAdminLookup(CONFIG).roleFor('u1') === null)

// An unrecognized role string must not be trusted through.
stub(() => ok([{ role: 'wizard' }]))
check('unknown role yields null', await createAdminLookup(CONFIG).roleFor('u1') === null)

// Fail closed on a non-2xx response.
stub(() => new Response('nope', { status: 500 }))
check('non-2xx yields null', await createAdminLookup(CONFIG).roleFor('u1') === null)

// Fail closed when fetch itself throws.
stub(() => { throw new Error('refused') })
check('thrown fetch yields null', await createAdminLookup(CONFIG).roleFor('u1') === null)

// onLookupError fires, and does not turn a failure into an allow.
{
  let seen = null
  stub(() => { throw new Error('boom') })
  const lookup = createAdminLookup({ ...CONFIG, onLookupError: e => { seen = e } })
  const role = await lookup.roleFor('u1')
  check('onLookupError receives the error', seen instanceof Error)
  check('a reported error still denies', role === null)
}

// A successful result is cached: one fetch for two calls on the same instance.
{
  const calls = stub(() => ok([{ role: 'readonly' }]))
  const lookup = createAdminLookup(CONFIG)
  await lookup.roleFor('u1')
  await lookup.roleFor('u1')
  check('success is cached within the TTL', calls.length === 1)
}

// An error result is NOT cached: a transient outage must not lock an admin
// out for the remainder of the TTL once the backend recovers.
{
  const calls = stub(n => (n === 1 ? new Response('down', { status: 503 }) : ok([{ role: 'support' }])))
  const lookup = createAdminLookup(CONFIG)
  const first = await lookup.roleFor('u1')
  const second = await lookup.roleFor('u1')
  check('first call denied', first === null)
  check('error result was not cached', calls.length === 2)
  check('recovery is visible immediately', second === 'support')
}

// Distinct users do not share a cache entry.
{
  const calls = stub(n => ok([{ role: n === 1 ? 'support' : 'readonly' }]))
  const lookup = createAdminLookup(CONFIG)
  check('user 1 role', await lookup.roleFor('u1') === 'support')
  check('user 2 role', await lookup.roleFor('u2') === 'readonly')
  check('two users cost two fetches', calls.length === 2)
}

// The user id must be encoded into the query, not interpolated raw.
{
  const calls = stub(() => ok([]))
  await createAdminLookup(CONFIG).roleFor('a b&c')
  check('user id is URL-encoded', calls[0].includes('a%20b%26c'))
}

globalThis.fetch = realFetch
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node node_modules/tsx/dist/cli.mjs gateway/admin/adminAuth.test.mjs`
Expected: FAIL — cannot resolve `./adminAuth.ts`.

- [ ] **Step 3: Write the implementation**

Create `gateway/admin/adminAuth.ts`:

```ts
// Platform-admin authorization for /api/admin/* handlers, which hold the
// service-role key and therefore bypass RLS. Everything here is a deliberate
// re-implementation of what a policy would have done automatically -- the same
// reasoning as gateway/membership.ts, which this module mirrors closely on
// purpose.

export type AdminRole = 'readonly' | 'support' | 'superadmin'

const RANK: Record<AdminRole, number> = { readonly: 1, support: 2, superadmin: 3 }

function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && value in RANK
}

export function hasAtLeastAdmin(role: AdminRole | null, required: AdminRole): boolean {
  if (!role) return false
  return RANK[role] >= RANK[required]
}

export interface AdminLookupConfig {
  supabaseUrl: string
  supabaseSecretKey: string
  // Called (never awaited, never allowed to affect the fail-closed deny below)
  // whenever a lookup fails. This module stays framework-agnostic, so callers
  // wire this to their own Sentry.captureException -- otherwise a Supabase
  // outage or a bad SUPABASE_SECRET_KEY reads as "denied" with no signal
  // anywhere.
  onLookupError?: (err: unknown) => void
}

export interface AdminLookup {
  roleFor(userId: string): Promise<AdminRole | null>
}

// Short TTL: a revoked admin must stop working promptly, but a burst of
// requests from one console page should not re-query per request. Matches
// membership.ts.
const TTL_MS = 30_000

// Construct one per request in the Worker, exactly as with
// createMembershipLookup: the cache is scoped to the returned instance so a
// long-lived isolate does not accumulate entries across distinct users.
// server/index.ts is the same documented exception -- Express has no
// per-request isolate boundary, and a module-scoped lookup bounds the cache by
// distinct users rather than by request volume, with staleness capped by the
// TTL above.
export function createAdminLookup(config: AdminLookupConfig): AdminLookup {
  const cache = new Map<string, { at: number; role: AdminRole | null }>()

  return {
    async roleFor(userId: string): Promise<AdminRole | null> {
      const hit = cache.get(userId)
      if (hit && Date.now() - hit.at < TTL_MS) return hit.role

      const url =
        `${config.supabaseUrl}/rest/v1/platform_admins` +
        `?select=role&user_id=eq.${encodeURIComponent(userId)}`

      // Fail closed. An unavailable lookup must never read as "allowed",
      // whether the request reached Supabase and was rejected or never
      // arrived at all. Neither mode is cached: a transient outage must not
      // lock an admin out for the remainder of the TTL after recovery.
      try {
        const res = await fetch(url, {
          headers: {
            apikey: config.supabaseSecretKey,
            Authorization: `Bearer ${config.supabaseSecretKey}`,
          },
        })
        if (!res.ok) {
          config.onLookupError?.(new Error(`platform_admins lookup failed (${res.status})`))
          return null
        }
        const rows = await res.json()
        const role = Array.isArray(rows) && rows.length > 0 ? rows[0]?.role : null
        // An unrecognized role string is not trusted through: a row added by
        // hand with a typo must deny, not crash a rank comparison later.
        const resolved = isAdminRole(role) ? role : null
        cache.set(userId, { at: Date.now(), role: resolved })
        return resolved
      } catch (err) {
        config.onLookupError?.(err)
        return null
      }
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node node_modules/tsx/dist/cli.mjs gateway/admin/adminAuth.test.mjs`
Expected: PASS — `all passed`, exit 0.

- [ ] **Step 5: Wire it into the npm scripts**

In `package.json`, append to both `test:gateway` and `test:gateway:offline`:

```
 && node node_modules/tsx/dist/cli.mjs gateway/admin/adminAuth.test.mjs
```

Run: `npm run test:gateway:offline`
Expected: PASS — every file in the offline suite, including the new one.

- [ ] **Step 6: Commit**

```bash
git add gateway/admin/adminAuth.ts gateway/admin/adminAuth.test.mjs package.json
git commit -m "feat: fail-closed platform-admin role lookup"
```

---

### Task 3: The two admin RPCs

**Files:**
- Create: `supabase/migrations/20260907210100_admin_rpcs.sql`
- Create: `supabase/tests/19_admin_rpcs.test.sql`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure SQL).
- Produces:
  - `public.admin_preview_delete_org(p_org_id bigint) returns jsonb` — shape `{"organization_id": 1, "name": "...", "dependents": {"players.organization_id": 12, ...}}`
  - `public.admin_merge_players(p_keep_id integer, p_merge_id integer) returns jsonb` — shape `{"keep_id": 3, "merge_id": 9, "repointed": {"game_events.player_id": 4, ...}, "dropped": {"season_players": 1, ...}}`

Task 5 calls both by name through `sbWrite(config, 'POST', '/rpc/<name>', {...})`.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/19_admin_rpcs.test.sql`. The seed data provides organization 1; this test builds its own players and dependents so it does not depend on seed specifics.

```sql
begin;
select plan(12);

select has_function('public', 'admin_preview_delete_org', array['bigint'],
  'admin_preview_delete_org exists');
select has_function('public', 'admin_merge_players', array['integer', 'integer'],
  'admin_merge_players exists');

-- Neither function may be reachable by a client role.
select ok(
  not has_function_privilege('anon', 'public.admin_merge_players(integer,integer)', 'EXECUTE'),
  'anon cannot execute admin_merge_players'
);
select ok(
  not has_function_privilege('authenticated', 'public.admin_preview_delete_org(bigint)', 'EXECUTE'),
  'authenticated cannot execute admin_preview_delete_org'
);

-- --- admin_preview_delete_org ---

select throws_ok(
  $$ select public.admin_preview_delete_org(999999) $$,
  'organization 999999 does not exist',
  'preview rejects an unknown organization'
);

-- games.team_id references teams(id), NOT organizations(id). The preview must
-- not count it as a tenant dependent -- that was a real bug risk when the
-- dependent list was derived from column names instead of foreign keys.
select ok(
  (public.admin_preview_delete_org(1) -> 'dependents') ? 'team_members.team_id',
  'preview counts team_members.team_id (a real FK to organizations)'
);
select ok(
  not ((public.admin_preview_delete_org(1) -> 'dependents') ? 'games.team_id'),
  'preview does not count games.team_id (FK to teams, not organizations)'
);

-- --- admin_merge_players ---

insert into public.players (id, display_name, organization_id)
values (9001, 'Dup Keeper', 1), (9002, 'Dup Merged', 1);
insert into public.seasons (id, name, organization_id, team_id)
values (9001, 'Merge Test Season', 1, (select id from public.teams where organization_id = 1 limit 1));

-- Both players on the same season: unique (season_id, player_id) means a naive
-- repoint would raise. The keeper's row must win and the merged row must go.
insert into public.season_players (season_id, player_id, organization_id)
values (9001, 9001, 1), (9001, 9002, 1);

select lives_ok(
  $$ select public.admin_merge_players(9001, 9002) $$,
  'merge succeeds despite a season_players unique conflict'
);

select is(
  (select count(*)::int from public.season_players where season_id = 9001),
  1,
  'the conflicting season_players row was dropped, not duplicated'
);
select is(
  (select player_id from public.season_players where season_id = 9001),
  9001,
  'the surviving season_players row belongs to the keeper'
);
select is(
  (select count(*)::int from public.players where id = 9002),
  0,
  'the merged player row is gone'
);

-- A cross-organization merge is refused outright: repointing rows across
-- tenants is data corruption, not a correction.
insert into public.organizations (id, name) values (9002, 'Other Org');
insert into public.players (id, display_name, organization_id)
values (9003, 'Keeper A', 1), (9004, 'Other Org Player', 9002);

select throws_ok(
  $$ select public.admin_merge_players(9003, 9004) $$,
  'players 9003 and 9004 are in different organizations',
  'a cross-organization merge is refused'
);

select * from finish();
rollback;
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run db:test`
Expected: FAIL — `19_admin_rpcs.test.sql` reports the functions do not exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260907210100_admin_rpcs.sql`:

```sql
-- The only two admin-console operations that genuinely need SQL. Everything
-- else the console does is a single-statement service-role write issued over
-- REST -- see docs/superpowers/specs/2026-09-07-admin-console-design.md.
--
-- Both are service-role-only: EXECUTE is revoked from every client role, and
-- the console reaches them through /api/admin/* handlers that already checked
-- platform_admins.

-- Blast radius of deleting an organization, so the console can show it before
-- committing. organizations cascades to roughly 26 tables, so the honest
-- answer is a per-table count.
--
-- The dependent list is derived from pg_constraint rather than by matching
-- column names. Name matching would wrongly include games.team_id,
-- seasons.team_id, and league_games.team_id, which reference teams(id), not
-- organizations(id) -- counting those would overstate the blast radius and
-- misreport which rows actually cascade. Deriving from real foreign keys also
-- means a table added later is counted without editing this function.
create or replace function public.admin_preview_delete_org(p_org_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row   record;
  v_count bigint;
  v_deps  jsonb := '{}'::jsonb;
begin
  if not exists (select 1 from public.organizations where id = p_org_id) then
    raise exception 'organization % does not exist', p_org_id;
  end if;

  for v_row in
    select c.relname::text as tbl, a.attname::text as col
      from pg_constraint k
      join pg_class c     on c.oid = k.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
     where k.contype = 'f'
       and k.confrelid = 'public.organizations'::regclass
       and array_length(k.conkey, 1) = 1
       and n.nspname = 'public'
       and c.relkind = 'r'
     order by c.relname, a.attname
  loop
    execute format('select count(*) from public.%I where %I = $1', v_row.tbl, v_row.col)
       into v_count using p_org_id;
    if v_count > 0 then
      v_deps := v_deps || jsonb_build_object(v_row.tbl || '.' || v_row.col, v_count);
    end if;
  end loop;

  return jsonb_build_object(
    'organization_id', p_org_id,
    'name',            (select name from public.organizations where id = p_org_id),
    'dependents',      v_deps
  );
end;
$$;

-- Fold one duplicate player into another. Must be one transaction, which
-- PostgREST cannot express as a sequence of separate calls -- that is the only
-- reason this is SQL rather than handler code.
--
-- Ten columns reference players(id). Four of their tables carry a unique
-- constraint that a naive repoint would violate:
--   game_attendance   (game_id, player_id)
--   game_lineups      (game_id, player_id, lineup_name)
--   season_players    (season_id, player_id)
--   strategy_positions(step_id, player_id)
-- plus player_links (unique player_id) and player_private (player_id primary
-- key), which allow at most one row per player outright.
--
-- Conflict rule, applied uniformly: THE KEEPER'S ROW WINS. Where repointing
-- the merged player would collide with an existing keeper row, the merged
-- player's row is deleted instead. This is deliberately wholesale rather than
-- field-level coalescing -- a merge that silently blended two players'
-- attributes would be impossible to review after the fact, and the audit log
-- records the per-table counts either way.
create or replace function public.admin_merge_players(
  p_keep_id  integer,
  p_merge_id integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_keep_org  bigint;
  v_merge_org bigint;
  v_repointed jsonb := '{}'::jsonb;
  v_dropped   jsonb := '{}'::jsonb;
  v_n         bigint;
begin
  if p_keep_id = p_merge_id then
    raise exception 'cannot merge player % into itself', p_keep_id;
  end if;

  select organization_id into v_keep_org  from public.players where id = p_keep_id;
  select organization_id into v_merge_org from public.players where id = p_merge_id;

  if v_keep_org is null then
    raise exception 'player % does not exist', p_keep_id;
  end if;
  if v_merge_org is null then
    raise exception 'player % does not exist', p_merge_id;
  end if;
  if v_keep_org <> v_merge_org then
    raise exception 'players % and % are in different organizations', p_keep_id, p_merge_id;
  end if;

  -- Conflict-bearing tables: drop the merged player's colliding rows first,
  -- then repoint whatever is left.

  delete from public.game_attendance m
   where m.player_id = p_merge_id
     and exists (select 1 from public.game_attendance k
                  where k.player_id = p_keep_id and k.game_id = m.game_id);
  get diagnostics v_n = row_count;
  v_dropped := v_dropped || jsonb_build_object('game_attendance', v_n);

  delete from public.game_lineups m
   where m.player_id = p_merge_id
     and exists (select 1 from public.game_lineups k
                  where k.player_id = p_keep_id
                    and k.game_id = m.game_id
                    and k.lineup_name = m.lineup_name);
  get diagnostics v_n = row_count;
  v_dropped := v_dropped || jsonb_build_object('game_lineups', v_n);

  delete from public.season_players m
   where m.player_id = p_merge_id
     and exists (select 1 from public.season_players k
                  where k.player_id = p_keep_id and k.season_id = m.season_id);
  get diagnostics v_n = row_count;
  v_dropped := v_dropped || jsonb_build_object('season_players', v_n);

  delete from public.strategy_positions m
   where m.player_id = p_merge_id
     and exists (select 1 from public.strategy_positions k
                  where k.player_id = p_keep_id and k.step_id = m.step_id);
  get diagnostics v_n = row_count;
  v_dropped := v_dropped || jsonb_build_object('strategy_positions', v_n);

  -- At most one row per player: the keeper's wins outright.
  delete from public.player_links m
   where m.player_id = p_merge_id
     and exists (select 1 from public.player_links k where k.player_id = p_keep_id);
  get diagnostics v_n = row_count;
  v_dropped := v_dropped || jsonb_build_object('player_links', v_n);

  delete from public.player_private m
   where m.player_id = p_merge_id
     and exists (select 1 from public.player_private k where k.player_id = p_keep_id);
  get diagnostics v_n = row_count;
  v_dropped := v_dropped || jsonb_build_object('player_private', v_n);

  -- Repoint every surviving reference.

  update public.game_attendance set player_id = p_keep_id where player_id = p_merge_id;
  get diagnostics v_n = row_count;
  v_repointed := v_repointed || jsonb_build_object('game_attendance.player_id', v_n);

  update public.game_events set player_id = p_keep_id where player_id = p_merge_id;
  get diagnostics v_n = row_count;
  v_repointed := v_repointed || jsonb_build_object('game_events.player_id', v_n);

  update public.game_events set related_player_id = p_keep_id where related_player_id = p_merge_id;
  get diagnostics v_n = row_count;
  v_repointed := v_repointed || jsonb_build_object('game_events.related_player_id', v_n);

  update public.game_lineups set player_id = p_keep_id where player_id = p_merge_id;
  get diagnostics v_n = row_count;
  v_repointed := v_repointed || jsonb_build_object('game_lineups.player_id', v_n);

  update public.lineup_template_players set player_id = p_keep_id where player_id = p_merge_id;
  get diagnostics v_n = row_count;
  v_repointed := v_repointed || jsonb_build_object('lineup_template_players.player_id', v_n);

  update public.season_players set player_id = p_keep_id where player_id = p_merge_id;
  get diagnostics v_n = row_count;
  v_repointed := v_repointed || jsonb_build_object('season_players.player_id', v_n);

  update public.strategy_arrows set start_player_id = p_keep_id where start_player_id = p_merge_id;
  get diagnostics v_n = row_count;
  v_repointed := v_repointed || jsonb_build_object('strategy_arrows.start_player_id', v_n);

  update public.strategy_positions set player_id = p_keep_id where player_id = p_merge_id;
  get diagnostics v_n = row_count;
  v_repointed := v_repointed || jsonb_build_object('strategy_positions.player_id', v_n);

  update public.player_links set player_id = p_keep_id where player_id = p_merge_id;
  get diagnostics v_n = row_count;
  v_repointed := v_repointed || jsonb_build_object('player_links.player_id', v_n);

  update public.player_private set player_id = p_keep_id where player_id = p_merge_id;
  get diagnostics v_n = row_count;
  v_repointed := v_repointed || jsonb_build_object('player_private.player_id', v_n);

  delete from public.players where id = p_merge_id;

  return jsonb_build_object(
    'keep_id',   p_keep_id,
    'merge_id',  p_merge_id,
    'repointed', v_repointed,
    'dropped',   v_dropped
  );
end;
$$;

revoke all on function public.admin_preview_delete_org(bigint) from public, anon, authenticated;
revoke all on function public.admin_merge_players(integer, integer) from public, anon, authenticated;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS — `19_admin_rpcs.test.sql` reports 12/12, and `00_meta.test.sql` still passes (both new functions pin `search_path` and are not executable by `anon`).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260907210100_admin_rpcs.sql supabase/tests/19_admin_rpcs.test.sql
git commit -m "feat: admin_preview_delete_org and admin_merge_players"
```

---

### Task 4: The auditing operation dispatcher

**Files:**
- Create: `gateway/admin/operations.ts`
- Create: `gateway/admin/adminOps.test.mjs`
- Modify: `package.json` (add to `test:gateway` and `test:gateway:offline`)

**Interfaces:**
- Consumes: `AdminRole`, `hasAtLeastAdmin` from `./adminAuth.ts` (Task 2); `admin_audit_log` from Task 1.
- Produces:
  - `interface AdminCtx { config: ActionsConfig; adminId: string; adminRole: AdminRole; requestId: string }`
  - `interface AdminOperation<I> { name: string; minRole: AdminRole; input: ZodType<I>; target: (input: I) => unknown; preview: (ctx: AdminCtx, input: I) => Promise<unknown>; apply: (ctx: AdminCtx, input: I) => Promise<{ before: unknown; after: unknown }> }`
  - `function defineOperation<I>(op: AdminOperation<I>): AdminOperation<I>`
  - `function createRegistry(ops: AdminOperation<any>[]): Map<string, AdminOperation<any>>`
  - `async function dispatchOperation(registry, ctx, name: string, mode: 'preview' | 'apply', rawInput: unknown): Promise<{ status: number; body: unknown }>`
  - `class AdminOpError extends Error { constructor(message: string, status: number, clientMessage?: string) }` — an operation throws this to choose its own HTTP status and a client-safe message. Task 5's `set_player_link` uses it for 409.

Task 5 supplies the operations; Task 7 calls `dispatchOperation`.

- [ ] **Step 1: Write the failing test**

Create `gateway/admin/adminOps.test.mjs`:

```js
import { z } from 'zod'
import { createRegistry, defineOperation, dispatchOperation } from './operations.ts'

let failed = 0
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'}  ${name}`)
  if (!cond) failed++
}

// Every audit write goes through sbWrite to /admin_audit_log, so capturing
// fetch is enough to assert exactly what the dispatcher logged.
const realFetch = globalThis.fetch
function capture() {
  const audits = []
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/admin_audit_log')) audits.push(JSON.parse(init.body))
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return audits
}

const CTX = {
  config: { supabaseUrl: 'https://example.test', supabaseSecretKey: 'secret' },
  adminId: '11111111-1111-1111-1111-111111111111',
  adminRole: 'support',
  requestId: 'req-1',
}

let applied = 0
const bump = defineOperation({
  name: 'bump',
  minRole: 'support',
  input: z.object({ id: z.number().int() }),
  target: i => ({ id: i.id }),
  preview: async () => ({ would: 'bump' }),
  apply: async (_ctx, i) => { applied++; return { before: { n: 1 }, after: { n: 2, id: i.id } } },
})

const nuke = defineOperation({
  name: 'nuke',
  minRole: 'superadmin',
  input: z.object({}),
  target: () => ({}),
  preview: async () => ({}),
  apply: async () => { throw new Error('kaboom') },
})

const registry = createRegistry([bump, nuke])

// --- happy path ---
{
  const audits = capture()
  const res = await dispatchOperation(registry, CTX, 'bump', 'apply', { id: 7 })
  check('apply returns 200', res.status === 200)
  check('apply ran the operation', applied === 1)
  check('apply wrote exactly one audit row', audits.length === 1)
  check('audit result is ok', audits[0].result === 'ok')
  check('audit records the operation name', audits[0].operation === 'bump')
  check('audit records the admin id', audits[0].admin_id === CTX.adminId)
  check('audit denormalizes the role', audits[0].admin_role === 'support')
  check('audit carries the request id', audits[0].request_id === 'req-1')
  check('audit records before', audits[0].before.n === 1)
  check('audit records after', audits[0].after.n === 2)
  check('audit records the target', audits[0].target.id === 7)
}

// --- preview writes nothing at all ---
{
  applied = 0
  const audits = capture()
  const res = await dispatchOperation(registry, CTX, 'bump', 'preview', { id: 7 })
  check('preview returns 200', res.status === 200)
  check('preview does not apply', applied === 0)
  check('preview writes no audit row', audits.length === 0)
}

// --- insufficient role is denied AND logged ---
{
  const audits = capture()
  const res = await dispatchOperation(registry, CTX, 'nuke', 'apply', {})
  check('insufficient role returns 403', res.status === 403)
  check('a denial is audited', audits.length === 1 && audits[0].result === 'denied')
}

// --- a readonly admin cannot even preview a mutation ---
{
  const audits = capture()
  const ro = { ...CTX, adminRole: 'readonly' }
  const res = await dispatchOperation(registry, ro, 'bump', 'preview', { id: 1 })
  check('readonly cannot preview a support operation', res.status === 403)
  check('a denied preview is audited', audits.length === 1 && audits[0].result === 'denied')
}

// --- bad input is rejected and logged ---
{
  const audits = capture()
  const res = await dispatchOperation(registry, CTX, 'bump', 'apply', { id: 'seven' })
  check('invalid input returns 400', res.status === 400)
  check('invalid input is audited as denied', audits.length === 1 && audits[0].result === 'denied')
}

// --- unknown operation ---
{
  const audits = capture()
  const res = await dispatchOperation(registry, CTX, 'no_such_op', 'apply', {})
  check('unknown operation returns 404', res.status === 404)
  check('an unknown operation writes no audit row', audits.length === 0)
}

// --- a throwing operation is logged as error, and the detail is not leaked ---
{
  const audits = capture()
  const su = { ...CTX, adminRole: 'superadmin' }
  const res = await dispatchOperation(registry, su, 'nuke', 'apply', {})
  check('a thrown operation returns 500', res.status === 500)
  check('the failure is audited as error', audits.length === 1 && audits[0].result === 'error')
  check('the audit row keeps the detail', audits[0].error.includes('kaboom'))
  check('the client response does not leak the detail',
        !JSON.stringify(res.body).includes('kaboom'))
  check('the client response carries the request id',
        JSON.stringify(res.body).includes('req-1'))
}

// --- AdminOpError chooses its own status and is safe to show the client ---
{
  const conflict = defineOperation({
    name: 'conflict',
    minRole: 'support',
    input: z.object({}),
    target: () => ({}),
    preview: async () => ({}),
    apply: async () => {
      throw new AdminOpError(
        'player 5 is already linked to user abc',
        409,
        'that player is already linked to another account'
      )
    },
  })
  const reg2 = createRegistry([conflict])
  const audits = capture()
  const res = await dispatchOperation(reg2, CTX, 'conflict', 'apply', {})
  check('AdminOpError sets the status', res.status === 409)
  check('a sub-500 AdminOpError audits as denied',
        audits.length === 1 && audits[0].result === 'denied')
  check('the audit row keeps the internal message',
        audits[0].error.includes('already linked to user abc'))
  check('the client sees only the clientMessage',
        JSON.stringify(res.body).includes('already linked to another account')
        && !JSON.stringify(res.body).includes('user abc'))
}

globalThis.fetch = realFetch
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
```

Also extend the import at the top of the file to:

```js
import { AdminOpError, createRegistry, defineOperation, dispatchOperation } from './operations.ts'
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node node_modules/tsx/dist/cli.mjs gateway/admin/adminOps.test.mjs`
Expected: FAIL — cannot resolve `./operations.ts`.

- [ ] **Step 3: Write the implementation**

Create `gateway/admin/operations.ts`:

```ts
import type { ZodType } from 'zod'
import type { ActionsConfig } from '../supabaseRest.js'
import { sbWrite } from '../supabaseRest.js'
import { hasAtLeastAdmin, type AdminRole } from './adminAuth.js'

// The admin console has no generic row editor, deliberately. A raw
// "UPDATE any table" surface cannot be constrained and audits as SQL; a fixed
// catalog of named operations can only do what each operation permits and
// audits as an operation name, which is what someone actually searches for
// months later.
//
// THE DISPATCHER WRITES THE AUDIT ROW, NOT THE OPERATIONS. That is the whole
// reason this indirection exists: a new operation cannot forget to log, and
// denied and errored attempts are logged by the same wrapper that logs
// successes. Do not move audit writes into individual operations.

// Thrown by an operation that wants a specific HTTP status and a message the
// client may safely see. Everything else that throws becomes a 500 whose
// detail stays in the audit row -- Postgres error text can carry column names
// and row values belonging to other tenants.
export class AdminOpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly clientMessage: string = message
  ) {
    super(message)
    this.name = 'AdminOpError'
  }
}

export interface AdminCtx {
  config: ActionsConfig
  adminId: string
  adminRole: AdminRole
  // Correlates the client's error response, the audit row, and Sentry.
  requestId: string
}

export interface AdminOperation<I> {
  name: string
  minRole: AdminRole
  input: ZodType<I>
  /** What the audit row records as the thing acted upon. */
  target: (input: I) => unknown
  /** Dry run. Must never write data. */
  preview: (ctx: AdminCtx, input: I) => Promise<unknown>
  apply: (ctx: AdminCtx, input: I) => Promise<{ before: unknown; after: unknown }>
}

// Identity helper that pins the generic so each operation's input type is
// inferred from its schema instead of widening to any at the registry.
export function defineOperation<I>(op: AdminOperation<I>): AdminOperation<I> {
  return op
}

export function createRegistry(ops: AdminOperation<any>[]): Map<string, AdminOperation<any>> {
  const map = new Map<string, AdminOperation<any>>()
  for (const op of ops) {
    if (map.has(op.name)) throw new Error(`duplicate admin operation: ${op.name}`)
    map.set(op.name, op)
  }
  return map
}

async function audit(
  ctx: AdminCtx,
  row: {
    operation: string
    target: unknown
    result: 'ok' | 'denied' | 'error'
    before?: unknown
    after?: unknown
    error?: string
  }
): Promise<void> {
  // An audit write must never mask the outcome it is recording: if logging
  // fails, the operation's own result still reaches the caller. The throw is
  // swallowed here and surfaced by the caller's onError hook instead.
  try {
    await sbWrite(ctx.config, 'POST', '/admin_audit_log', {
      admin_id: ctx.adminId,
      admin_role: ctx.adminRole,
      operation: row.operation,
      target: row.target ?? {},
      before: row.before ?? null,
      after: row.after ?? null,
      result: row.result,
      error: row.error ?? null,
      request_id: ctx.requestId,
    })
  } catch {
    // Intentionally empty -- see above.
  }
}

export async function dispatchOperation(
  registry: Map<string, AdminOperation<any>>,
  ctx: AdminCtx,
  name: string,
  mode: 'preview' | 'apply',
  rawInput: unknown
): Promise<{ status: number; body: unknown }> {
  const op = registry.get(name)
  // An unknown name is not an attempt at anything auditable -- there is no
  // operation and no target to record.
  if (!op) return { status: 404, body: { error: `unknown operation: ${name}` } }

  // The role gate covers preview as well as apply. A readonly admin must not
  // be able to enumerate what a mutation WOULD do to a given row.
  if (!hasAtLeastAdmin(ctx.adminRole, op.minRole)) {
    await audit(ctx, {
      operation: op.name,
      target: { raw: rawInput },
      result: 'denied',
      error: `role ${ctx.adminRole} is below required ${op.minRole}`,
    })
    return { status: 403, body: { error: 'insufficient admin role' } }
  }

  const parsed = op.input.safeParse(rawInput)
  if (!parsed.success) {
    await audit(ctx, {
      operation: op.name,
      target: { raw: rawInput },
      result: 'denied',
      error: `invalid input: ${parsed.error.message}`,
    })
    return { status: 400, body: { error: 'invalid input', detail: parsed.error.format() } }
  }
  const input = parsed.data

  try {
    if (mode === 'preview') {
      // No audit row: a preview changes nothing, and logging every keystroke
      // of a form would bury the rows that record real changes.
      return { status: 200, body: { mode: 'preview', preview: await op.preview(ctx, input) } }
    }
    const { before, after } = await op.apply(ctx, input)
    await audit(ctx, { operation: op.name, target: op.target(input), result: 'ok', before, after })
    return { status: 200, body: { mode: 'apply', before, after } }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)

    if (err instanceof AdminOpError) {
      // A sub-500 AdminOpError is a refusal, not a malfunction: the operation
      // decided this input may not proceed, which is the same category as a
      // role or schema rejection above.
      await audit(ctx, {
        operation: op.name,
        target: op.target(input),
        result: err.status < 500 ? 'denied' : 'error',
        error: detail,
      })
      return {
        status: err.status,
        body: { error: err.clientMessage, request_id: ctx.requestId },
      }
    }

    await audit(ctx, {
      operation: op.name,
      target: op.target(input),
      result: 'error',
      error: detail,
    })
    // The detail stays in the audit row and Sentry; the client gets the
    // request id to quote instead. Postgres error text can carry column names
    // and row values from other tenants.
    return {
      status: 500,
      body: { error: 'operation failed', request_id: ctx.requestId },
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node node_modules/tsx/dist/cli.mjs gateway/admin/adminOps.test.mjs`
Expected: PASS — `all passed`, exit 0.

- [ ] **Step 5: Wire it into the npm scripts**

In `package.json`, append to both `test:gateway` and `test:gateway:offline`:

```
 && node node_modules/tsx/dist/cli.mjs gateway/admin/adminOps.test.mjs
```

Run: `npm run test:gateway:offline`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add gateway/admin/operations.ts gateway/admin/adminOps.test.mjs package.json
git commit -m "feat: auditing admin operation dispatcher"
```

---

### Task 5: The eight v1 operations

**Files:**
- Create: `gateway/admin/ops.ts`
- Modify: `gateway/admin/adminOps.test.mjs` (append the operation-specific cases)

**Interfaces:**
- Consumes: `defineOperation`, `AdminOpError`, `AdminCtx` from `./operations.ts` (Task 4); `sbGet`, `sbWrite` from `../supabaseRest.js`; `admin_merge_players`, `admin_preview_delete_org` from Task 3.
- Produces: `export const ADMIN_OPERATIONS: AdminOperation<any>[]` — the array Task 7 hands to `createRegistry`.

**Reminder from Global Constraints:** these write directly with the service role. Do **not** call `set_member_role`, `remove_member`, `invite_member`, `revoke_invite`, `set_player_link`, or `approve_claim` — they gate on `auth.uid()`, which is NULL here, and will raise `only a captain can change roles`. The `team_members_require_captain` trigger still protects the last-captain invariant on these direct writes.

- [ ] **Step 1: Write the failing tests**

Append to `gateway/admin/adminOps.test.mjs`, before the `globalThis.fetch = realFetch` line:

```js
// --- operation definitions: schema and role wiring ---
{
  const { ADMIN_OPERATIONS } = await import('./ops.ts')
  const byName = new Map(ADMIN_OPERATIONS.map(o => [o.name, o]))

  check('all eight operations are registered', ADMIN_OPERATIONS.length === 8)
  for (const n of ['set_member_role', 'remove_member', 'invite_member', 'revoke_invite',
                   'set_player_link', 'approve_player_link', 'merge_players', 'delete_org']) {
    check(`${n} is registered`, byName.has(n))
  }

  // Destructive operations are superadmin-only; routine support work is not.
  check('merge_players is superadmin', byName.get('merge_players').minRole === 'superadmin')
  check('delete_org is superadmin',    byName.get('delete_org').minRole === 'superadmin')
  check('set_member_role is support',  byName.get('set_member_role').minRole === 'support')

  // team_invites.role forbids 'captain'; the schema must reject it up front
  // rather than letting a bare check-constraint error reach the operator.
  const inv = byName.get('invite_member').input
  check('invite_member accepts editor', inv.safeParse({ team_id: 1, email: 'a@b.co', role: 'editor' }).success)
  check('invite_member rejects captain', !inv.safeParse({ team_id: 1, email: 'a@b.co', role: 'captain' }).success)
  check('invite_member rejects a non-email', !inv.safeParse({ team_id: 1, email: 'nope', role: 'member' }).success)

  const smr = byName.get('set_member_role').input
  check('set_member_role accepts captain', smr.safeParse(
    { team_id: 1, user_id: '11111111-1111-1111-1111-111111111111', role: 'captain' }).success)
  check('set_member_role rejects an unknown role', !smr.safeParse(
    { team_id: 1, user_id: '11111111-1111-1111-1111-111111111111', role: 'wizard' }).success)
  check('set_member_role rejects a non-uuid user', !smr.safeParse(
    { team_id: 1, user_id: 'me', role: 'member' }).success)

  // delete_org demands the typed name, so a mis-click cannot destroy a tenant.
  const del = byName.get('delete_org').input
  check('delete_org requires confirm_name', !del.safeParse({ organization_id: 1 }).success)
  check('delete_org accepts a confirm_name', del.safeParse(
    { organization_id: 1, confirm_name: 'Warriors' }).success)

  // merge_players must refuse a self-merge before any SQL runs.
  const mp = byName.get('merge_players').input
  check('merge_players rejects a self-merge', !mp.safeParse({ keep_id: 5, merge_id: 5 }).success)
  check('merge_players accepts two distinct ids', mp.safeParse({ keep_id: 5, merge_id: 6 }).success)
}

// --- the last-captain trigger is translated, not leaked as a 500 ---
{
  const { ADMIN_OPERATIONS } = await import('./ops.ts')
  const setRole = ADMIN_OPERATIONS.find(o => o.name === 'set_member_role')
  const audits = []
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.includes('/admin_audit_log')) { audits.push(JSON.parse(init.body)); return new Response('[]', { status: 200 }) }
    // The pre-read finds the member...
    if (u.includes('/team_members') && (init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify([{ team_id: 1, user_id: 'u', role: 'captain' }]),
                          { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    // ...and the PATCH trips the trigger.
    return new Response('team 1 must have at least one captain', { status: 400 })
  }
  const reg = createRegistry([setRole])
  const su = { ...CTX, adminRole: 'superadmin' }
  const res = await dispatchOperation(reg, su, 'set_member_role', 'apply',
    { team_id: 1, user_id: '11111111-1111-1111-1111-111111111111', role: 'member' })
  check('a last-captain violation is a 409, not a 500', res.status === 409)
  check('the operator is told how to fix it',
        JSON.stringify(res.body).includes('at least one captain'))
  check('a last-captain violation audits as denied',
        audits.length === 1 && audits[0].result === 'denied')
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node node_modules/tsx/dist/cli.mjs gateway/admin/adminOps.test.mjs`
Expected: FAIL — cannot resolve `./ops.ts`.

- [ ] **Step 3: Write the implementation**

Create `gateway/admin/ops.ts`:

```ts
import { z } from 'zod'
import { sbGet, sbWrite } from '../supabaseRest.js'
import { AdminOpError, defineOperation, type AdminCtx, type AdminOperation } from './operations.js'

// The v1 operation catalog.
//
// These write to tables DIRECTLY with the service role rather than calling the
// membership RPCs. That is not a shortcut. set_member_role, remove_member,
// invite_member, revoke_invite, set_player_link and approve_claim are all
// security definer but gate on auth.uid() via assert_not_guest() and
// my_captain_team_ids(); under the service role auth.uid() is NULL, so
// my_captain_team_ids() is empty and set_member_role raises "only a captain
// can change roles". What those RPCs add over a direct write is CALLER
// AUTHORIZATION, which the admin boundary supplies differently, and INPUT
// VALIDATION, which each operation below re-implements.
//
// The invariant that actually matters is unaffected: enforce_last_captain() is
// a trigger (team_members_require_captain BEFORE UPDATE OR DELETE), so it
// fires on these direct writes exactly as it does on an RPC's writes.
//
// Note on identifiers: team_members.team_id, team_invites.team_id and
// player_links.team_id are all foreign keys to organizations(id). The tenant
// is the organization.

const TEAM_ROLES = ['captain', 'editor', 'member'] as const
// team_invites.role has check (role in ('editor', 'member')) -- an invite
// cannot grant captain. Reject it in the schema so the operator gets a clear
// message instead of a bare constraint violation.
const INVITE_ROLES = ['editor', 'member'] as const

// The last-captain trigger's message is the single most confusing error in
// this schema (see the gotcha in CLAUDE.md), so it is translated into a 409
// with actionable wording rather than becoming an opaque 500. The trigger's
// own text names only the team id, never row data, so it is safe to show.
function translate(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('must have at least one captain')) {
    throw new AdminOpError(
      message,
      409,
      'That team must have at least one captain. Promote another member first, then retry.'
    )
  }
  throw err
}

async function memberRow(ctx: AdminCtx, teamId: number, userId: string) {
  const rows = await sbGet(
    ctx.config,
    `/team_members?select=id,team_id,user_id,role,created_at` +
      `&team_id=eq.${teamId}&user_id=eq.${encodeURIComponent(userId)}`
  )
  return rows[0] ?? null
}

async function inviteRow(ctx: AdminCtx, inviteId: number) {
  const rows = await sbGet(
    ctx.config,
    `/team_invites?select=id,team_id,email,role,created_at,expires_at,accepted_at&id=eq.${inviteId}`
  )
  return rows[0] ?? null
}

async function linkRow(ctx: AdminCtx, playerId: number) {
  const rows = await sbGet(
    ctx.config,
    `/player_links?select=id,team_id,player_id,user_id,status,created_at&player_id=eq.${playerId}`
  )
  return rows[0] ?? null
}

const setMemberRole = defineOperation({
  name: 'set_member_role',
  minRole: 'support',
  input: z.object({
    team_id: z.number().int().positive(),
    user_id: z.string().uuid(),
    role: z.enum(TEAM_ROLES),
  }),
  target: i => ({ team_id: i.team_id, user_id: i.user_id, role: i.role }),
  preview: async (ctx, i) => ({
    current: await memberRow(ctx, i.team_id, i.user_id),
    next: { role: i.role },
  }),
  apply: async (ctx, i) => {
    const before = await memberRow(ctx, i.team_id, i.user_id)
    if (!before) {
      throw new AdminOpError(
        `user ${i.user_id} is not a member of organization ${i.team_id}`,
        404,
        'That person is not a member of this organization.'
      )
    }
    try {
      const rows = await sbWrite(
        ctx.config,
        'PATCH',
        `/team_members?team_id=eq.${i.team_id}&user_id=eq.${encodeURIComponent(i.user_id)}`,
        { role: i.role }
      )
      return { before, after: rows[0] ?? null }
    } catch (err) {
      translate(err)
    }
  },
})

const removeMember = defineOperation({
  name: 'remove_member',
  minRole: 'support',
  input: z.object({
    team_id: z.number().int().positive(),
    user_id: z.string().uuid(),
  }),
  target: i => ({ team_id: i.team_id, user_id: i.user_id }),
  preview: async (ctx, i) => ({ current: await memberRow(ctx, i.team_id, i.user_id) }),
  apply: async (ctx, i) => {
    const before = await memberRow(ctx, i.team_id, i.user_id)
    if (!before) {
      throw new AdminOpError(
        `user ${i.user_id} is not a member of organization ${i.team_id}`,
        404,
        'That person is not a member of this organization.'
      )
    }
    try {
      await sbWrite(
        ctx.config,
        'DELETE',
        `/team_members?team_id=eq.${i.team_id}&user_id=eq.${encodeURIComponent(i.user_id)}`
      )
      return { before, after: null }
    } catch (err) {
      translate(err)
    }
  },
})

const inviteMember = defineOperation({
  name: 'invite_member',
  minRole: 'support',
  input: z.object({
    team_id: z.number().int().positive(),
    // team_invites has check (email = lower(email)), so normalize here rather
    // than letting the constraint reject a perfectly reasonable input.
    email: z.string().email().transform(v => v.trim().toLowerCase()),
    role: z.enum(INVITE_ROLES),
  }),
  target: i => ({ team_id: i.team_id, email: i.email, role: i.role }),
  preview: async (ctx, i) => {
    const existing = await sbGet(
      ctx.config,
      `/team_invites?select=id,role,created_at,expires_at&team_id=eq.${i.team_id}` +
        `&email=eq.${encodeURIComponent(i.email)}&accepted_at=is.null`
    )
    return { pending: existing[0] ?? null, next: { role: i.role } }
  },
  apply: async (ctx, i) => {
    // team_invites_pending_unique is a partial unique index on
    // (team_id, email) where accepted_at is null, so a second pending invite
    // is a conflict rather than a duplicate row.
    const existing = await sbGet(
      ctx.config,
      `/team_invites?select=id&team_id=eq.${i.team_id}` +
        `&email=eq.${encodeURIComponent(i.email)}&accepted_at=is.null`
    )
    if (existing[0]) {
      throw new AdminOpError(
        `a pending invite already exists for ${i.email} on organization ${i.team_id}`,
        409,
        'That address already has a pending invite for this organization. Revoke it first.'
      )
    }
    const rows = await sbWrite(ctx.config, 'POST', '/team_invites', {
      team_id: i.team_id,
      email: i.email,
      role: i.role,
    })
    return { before: null, after: rows[0] ?? null }
  },
})

const revokeInvite = defineOperation({
  name: 'revoke_invite',
  minRole: 'support',
  input: z.object({ invite_id: z.number().int().positive() }),
  target: i => ({ invite_id: i.invite_id }),
  preview: async (ctx, i) => ({ current: await inviteRow(ctx, i.invite_id) }),
  apply: async (ctx, i) => {
    const before = await inviteRow(ctx, i.invite_id)
    if (!before) {
      throw new AdminOpError(`invite ${i.invite_id} does not exist`, 404, 'That invite no longer exists.')
    }
    if (before.accepted_at) {
      // Revoking an accepted invite would be theatre: the membership it
      // created already exists and is removed with remove_member instead.
      throw new AdminOpError(
        `invite ${i.invite_id} was already accepted at ${before.accepted_at}`,
        409,
        'That invite was already accepted. Remove the membership instead.'
      )
    }
    await sbWrite(ctx.config, 'DELETE', `/team_invites?id=eq.${i.invite_id}&accepted_at=is.null`)
    return { before, after: null }
  },
})

const setPlayerLink = defineOperation({
  name: 'set_player_link',
  minRole: 'support',
  input: z.object({
    player_id: z.number().int().positive(),
    user_id: z.string().uuid(),
  }),
  target: i => ({ player_id: i.player_id, user_id: i.user_id }),
  preview: async (ctx, i) => ({ current: await linkRow(ctx, i.player_id) }),
  apply: async (ctx, i) => {
    const players = await sbGet(
      ctx.config,
      `/players?select=id,display_name,organization_id&id=eq.${i.player_id}`
    )
    const player = players[0]
    if (!player) {
      throw new AdminOpError(`player ${i.player_id} does not exist`, 404, 'That player does not exist.')
    }

    // player_links carries unique (player_id) AND unique (team_id, user_id).
    // The second one is the trap: this user may already be linked to a
    // DIFFERENT player in the same organization, and repointing would violate
    // it. Report that explicitly rather than letting Postgres raise 23505.
    const clash = await sbGet(
      ctx.config,
      `/player_links?select=id,player_id&team_id=eq.${player.organization_id}` +
        `&user_id=eq.${encodeURIComponent(i.user_id)}&player_id=neq.${i.player_id}`
    )
    if (clash[0]) {
      throw new AdminOpError(
        `user ${i.user_id} is already linked to player ${clash[0].player_id} in organization ${player.organization_id}`,
        409,
        `That account is already linked to a different player in this organization (player ${clash[0].player_id}). Unlink that one first.`
      )
    }

    const before = await linkRow(ctx, i.player_id)
    const after = before
      ? (await sbWrite(ctx.config, 'PATCH', `/player_links?player_id=eq.${i.player_id}`, {
          user_id: i.user_id,
          status: 'approved',
        }))[0]
      : (await sbWrite(ctx.config, 'POST', '/player_links', {
          team_id: player.organization_id,
          player_id: i.player_id,
          user_id: i.user_id,
          status: 'approved',
        }))[0]
    return { before, after: after ?? null }
  },
})

const approvePlayerLink = defineOperation({
  name: 'approve_player_link',
  minRole: 'support',
  input: z.object({ link_id: z.number().int().positive() }),
  target: i => ({ link_id: i.link_id }),
  preview: async (ctx, i) => {
    const rows = await sbGet(
      ctx.config,
      `/player_links?select=id,team_id,player_id,user_id,status&id=eq.${i.link_id}`
    )
    return { current: rows[0] ?? null, next: { status: 'approved' } }
  },
  apply: async (ctx, i) => {
    const rows = await sbGet(
      ctx.config,
      `/player_links?select=id,team_id,player_id,user_id,status&id=eq.${i.link_id}`
    )
    const before = rows[0]
    if (!before) {
      throw new AdminOpError(`player link ${i.link_id} does not exist`, 404, 'That link no longer exists.')
    }
    const after = await sbWrite(ctx.config, 'PATCH', `/player_links?id=eq.${i.link_id}`, {
      status: 'approved',
    })
    return { before, after: after[0] ?? null }
  },
})

const mergePlayers = defineOperation({
  name: 'merge_players',
  minRole: 'superadmin',
  input: z
    .object({
      keep_id: z.number().int().positive(),
      merge_id: z.number().int().positive(),
    })
    // Caught here so the operator sees a schema error rather than the RPC's
    // "cannot merge player N into itself" after a round trip.
    .refine(i => i.keep_id !== i.merge_id, {
      message: 'keep_id and merge_id must differ',
    }),
  target: i => ({ keep_id: i.keep_id, merge_id: i.merge_id }),
  preview: async (ctx, i) => {
    const both = await sbGet(
      ctx.config,
      `/players?select=id,display_name,number,organization_id&id=in.(${i.keep_id},${i.merge_id})`
    )
    return {
      keep: both.find((p: any) => p.id === i.keep_id) ?? null,
      merge: both.find((p: any) => p.id === i.merge_id) ?? null,
      // The merge itself reports exact per-table counts; a preview cannot
      // compute them without doing the work, so it states the rule instead.
      rule: 'Where a unique constraint would collide, the keeper’s row wins and the merged player’s row is deleted.',
    }
  },
  apply: async (ctx, i) => {
    const before = await sbGet(
      ctx.config,
      `/players?select=id,display_name,number,organization_id&id=in.(${i.keep_id},${i.merge_id})`
    )
    const result = await sbWrite(ctx.config, 'POST', '/rpc/admin_merge_players', {
      p_keep_id: i.keep_id,
      p_merge_id: i.merge_id,
    })
    return { before, after: result }
  },
})

const deleteOrg = defineOperation({
  name: 'delete_org',
  minRole: 'superadmin',
  input: z.object({
    organization_id: z.number().int().positive(),
    // Typed-name confirmation. Verified against the real name in apply, so a
    // mis-click on the wrong row cannot destroy a tenant.
    confirm_name: z.string().min(1),
  }),
  target: i => ({ organization_id: i.organization_id }),
  preview: async (ctx, i) =>
    sbWrite(ctx.config, 'POST', '/rpc/admin_preview_delete_org', {
      p_org_id: i.organization_id,
    }),
  apply: async (ctx, i) => {
    const orgs = await sbGet(
      ctx.config,
      `/organizations?select=id,name,is_public,created_at&id=eq.${i.organization_id}`
    )
    const org = orgs[0]
    if (!org) {
      throw new AdminOpError(
        `organization ${i.organization_id} does not exist`,
        404,
        'That organization does not exist.'
      )
    }
    if (org.name !== i.confirm_name) {
      throw new AdminOpError(
        `confirm_name ${JSON.stringify(i.confirm_name)} does not match ${JSON.stringify(org.name)}`,
        409,
        'The typed name does not match this organization’s name.'
      )
    }
    // Captured before the delete: once the cascade runs there is nothing left
    // to count, and the audit row is the only remaining record of the size of
    // what was removed.
    const dependents = await sbWrite(ctx.config, 'POST', '/rpc/admin_preview_delete_org', {
      p_org_id: i.organization_id,
    })
    await sbWrite(ctx.config, 'DELETE', `/organizations?id=eq.${i.organization_id}`)
    return { before: { organization: org, dependents }, after: null }
  },
})

export const ADMIN_OPERATIONS: AdminOperation<any>[] = [
  setMemberRole,
  removeMember,
  inviteMember,
  revokeInvite,
  setPlayerLink,
  approvePlayerLink,
  mergePlayers,
  deleteOrg,
]
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node node_modules/tsx/dist/cli.mjs gateway/admin/adminOps.test.mjs`
Expected: PASS — `all passed`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add gateway/admin/ops.ts gateway/admin/adminOps.test.mjs
git commit -m "feat: v1 admin operation catalog"
```

---

### Task 6: Read endpoints and their SQL

**Files:**
- Create: `supabase/migrations/20260907210200_admin_read_fns.sql`
- Create: `supabase/tests/20_admin_read_fns.test.sql`
- Create: `gateway/admin/reads.ts`

**Interfaces:**
- Consumes: `AdminCtx` from `./operations.ts` (Task 4); `sbGet`, `sbWrite` from `../supabaseRest.js`.
- Produces:
  - SQL: `admin_search(p_q text) returns jsonb`, `admin_user_detail(p_user_id uuid) returns jsonb`, `admin_org_detail(p_org_id bigint) returns jsonb`
  - TS: `async function handleAdminRead(ctx: AdminCtx, segments: string[], url: URL): Promise<{ status: number; body: unknown } | null>` — returns `null` when the path is not a read route, so Task 7 can fall through to the operation dispatcher.

`auth.users` is not exposed over Supabase REST, which is why these are SQL functions rather than REST queries. Paginating GoTrue's admin API would cap search at one page and vary by GoTrue version.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/20_admin_read_fns.test.sql`:

```sql
begin;
select plan(8);

select has_function('public', 'admin_search', array['text'], 'admin_search exists');
select has_function('public', 'admin_user_detail', array['uuid'], 'admin_user_detail exists');
select has_function('public', 'admin_org_detail', array['bigint'], 'admin_org_detail exists');

select ok(
  not has_function_privilege('authenticated', 'public.admin_search(text)', 'EXECUTE'),
  'authenticated cannot execute admin_search'
);

-- Search reaches organizations by name.
select ok(
  jsonb_array_length(public.admin_search('a') -> 'organizations') >= 0,
  'admin_search returns an organizations array'
);

-- Search reaches auth.users by email, which plain REST cannot do at all.
select ok(
  (select jsonb_array_length(public.admin_search(
     split_part((select email from auth.users limit 1), '@', 1)) -> 'users')) >= 1,
  'admin_search finds a real user by an email fragment'
);

-- Org detail surfaces legacy organization_members rows so stale data is
-- visible rather than silently ignored (my_organizations() was dropped by
-- 20260903001500_my_teams.sql; team_members is the live source).
select ok(
  (public.admin_org_detail(1)) ? 'legacy_organization_members',
  'admin_org_detail flags legacy organization_members rows'
);

select throws_ok(
  $$ select public.admin_org_detail(999999) $$,
  'organization 999999 does not exist',
  'admin_org_detail rejects an unknown organization'
);

select * from finish();
rollback;
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run db:test`
Expected: FAIL — `20_admin_read_fns.test.sql` reports the functions do not exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260907210200_admin_read_fns.sql`:

```sql
-- Read-side support for the admin console.
--
-- These are SQL functions rather than REST queries for one reason: auth.users
-- is not exposed over Supabase REST, so "find the user with this email" and
-- "when did this account last sign in" are unanswerable from the handler
-- layer. Paginating GoTrue's /admin/users endpoint instead would cap search at
-- a single page and vary across GoTrue versions.
--
-- Service-role-only, like every other admin function here.

create or replace function public.admin_search(p_q text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'query', p_q,
    'organizations', coalesce((
      select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'is_public', o.is_public)
                       order by o.name)
        from public.organizations o
       where o.name ilike '%' || p_q || '%'
       limit 25
    ), '[]'::jsonb),
    'users', coalesce((
      select jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email,
                                          'last_sign_in_at', u.last_sign_in_at)
                       order by u.email)
        from auth.users u
       where u.email ilike '%' || p_q || '%'
       limit 25
    ), '[]'::jsonb),
    'players', coalesce((
      select jsonb_agg(jsonb_build_object('id', pl.id, 'display_name', pl.display_name,
                                          'organization_id', pl.organization_id)
                       order by pl.display_name)
        from public.players pl
       where pl.display_name ilike '%' || p_q || '%'
       limit 25
    ), '[]'::jsonb)
  );
$$;

create or replace function public.admin_user_detail(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  select email into v_email from auth.users where id = p_user_id;
  if not found then
    raise exception 'user % does not exist', p_user_id;
  end if;

  return jsonb_build_object(
    'user', (
      select jsonb_build_object('id', u.id, 'email', u.email,
                                'created_at', u.created_at,
                                'last_sign_in_at', u.last_sign_in_at,
                                'is_anonymous', u.is_anonymous)
        from auth.users u where u.id = p_user_id
    ),
    -- team_members.team_id is a foreign key to organizations(id).
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object('organization_id', o.id, 'name', o.name,
                                          'role', m.role, 'since', m.created_at)
                       order by o.name)
        from public.team_members m
        join public.organizations o on o.id = m.team_id
       where m.user_id = p_user_id
    ), '[]'::jsonb),
    'player_links', coalesce((
      select jsonb_agg(jsonb_build_object('link_id', l.id, 'player_id', l.player_id,
                                          'display_name', pl.display_name,
                                          'organization_id', l.team_id, 'status', l.status)
                       order by l.id)
        from public.player_links l
        join public.players pl on pl.id = l.player_id
       where l.user_id = p_user_id
    ), '[]'::jsonb),
    -- Invites are addressed by email, so they are found by email, not user id.
    'pending_invites', coalesce((
      select jsonb_agg(jsonb_build_object('invite_id', i.id, 'organization_id', i.team_id,
                                          'role', i.role, 'expires_at', i.expires_at)
                       order by i.id)
        from public.team_invites i
       where i.email = lower(v_email) and i.accepted_at is null
    ), '[]'::jsonb),
    'feedback_report_count', (
      select count(*) from public.feedback_reports r where r.reporter_user_id = p_user_id
    )
  );
end;
$$;

create or replace function public.admin_org_detail(p_org_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.organizations where id = p_org_id) then
    raise exception 'organization % does not exist', p_org_id;
  end if;

  return jsonb_build_object(
    'organization', (
      select jsonb_build_object('id', o.id, 'name', o.name, 'is_public', o.is_public,
                                'created_at', o.created_at)
        from public.organizations o where o.id = p_org_id
    ),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', u.email,
                                          'role', m.role, 'since', m.created_at)
                       order by m.role, u.email)
        from public.team_members m
        join auth.users u on u.id = m.user_id
       where m.team_id = p_org_id
    ), '[]'::jsonb),
    'pending_invites', coalesce((
      select jsonb_agg(jsonb_build_object('invite_id', i.id, 'email', i.email,
                                          'role', i.role, 'expires_at', i.expires_at)
                       order by i.email)
        from public.team_invites i
       where i.team_id = p_org_id and i.accepted_at is null
    ), '[]'::jsonb),
    -- teams is a secondary grouping (games/seasons/league_games reference it),
    -- NOT the tenant. Listed for orientation only.
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by t.name)
        from public.teams t where t.organization_id = p_org_id
    ), '[]'::jsonb),
    'counts', jsonb_build_object(
      'players', (select count(*) from public.players  where organization_id = p_org_id),
      'seasons', (select count(*) from public.seasons  where organization_id = p_org_id),
      'games',   (select count(*) from public.games    where organization_id = p_org_id)
    ),
    -- organization_members predates team_members and its only reader,
    -- my_organizations(), was dropped by 20260903001500_my_teams.sql. Any rows
    -- here are stale. Surfaced rather than hidden so the operator can see
    -- legacy data instead of wondering why a member list disagrees.
    'legacy_organization_members', coalesce((
      select jsonb_agg(jsonb_build_object('email', om.email, 'role', om.role)
                       order by om.email)
        from public.organization_members om where om.organization_id = p_org_id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.admin_search(text)            from public, anon, authenticated;
revoke all on function public.admin_user_detail(uuid)       from public, anon, authenticated;
revoke all on function public.admin_org_detail(bigint)      from public, anon, authenticated;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS — `20_admin_read_fns.test.sql` reports 8/8; `00_meta.test.sql` still passes.

- [ ] **Step 5: Write the read router**

Create `gateway/admin/reads.ts`:

```ts
import { sbGet, sbWrite } from '../supabaseRest.js'
import type { AdminCtx } from './operations.js'

// The read half of /api/admin/*. Every route here requires only the readonly
// role, which the caller has already checked -- these routes are why the
// readonly role exists at all.
//
// Returns null when `segments` names no read route, so the caller can fall
// through to the operation dispatcher.

const AUDIT_PAGE_MAX = 200

export async function handleAdminRead(
  ctx: AdminCtx,
  segments: string[],
  url: URL
): Promise<{ status: number; body: unknown } | null> {
  const [head, param] = segments

  if (head === 'search') {
    const q = (url.searchParams.get('q') ?? '').trim()
    // An empty query would ILIKE '%%' and return the first 25 of everything,
    // which reads as a result set rather than as "you typed nothing".
    if (q.length < 2) {
      return { status: 400, body: { error: 'q must be at least 2 characters' } }
    }
    return {
      status: 200,
      body: await sbWrite(ctx.config, 'POST', '/rpc/admin_search', { p_q: q }),
    }
  }

  if (head === 'user' && param) {
    return {
      status: 200,
      body: await sbWrite(ctx.config, 'POST', '/rpc/admin_user_detail', { p_user_id: param }),
    }
  }

  if (head === 'org' && param) {
    const orgId = Number(param)
    if (!Number.isInteger(orgId) || orgId <= 0) {
      return { status: 400, body: { error: 'org id must be a positive integer' } }
    }
    return {
      status: 200,
      body: await sbWrite(ctx.config, 'POST', '/rpc/admin_org_detail', { p_org_id: orgId }),
    }
  }

  if (head === 'audit') {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, AUDIT_PAGE_MAX)
    // Keyset pagination on the identity primary key: the log is append-only,
    // so an id cursor is stable in a way an offset is not.
    const cursor = url.searchParams.get('cursor')
    const operation = url.searchParams.get('operation')
    const filters = [
      cursor ? `&id=lt.${encodeURIComponent(cursor)}` : '',
      operation ? `&operation=eq.${encodeURIComponent(operation)}` : '',
    ].join('')
    const rows = await sbGet(
      ctx.config,
      `/admin_audit_log?select=*&order=id.desc&limit=${limit}${filters}`
    )
    const next = rows.length === limit ? String(rows[rows.length - 1].id) : null
    return { status: 200, body: { rows, next_cursor: next } }
  }

  return null
}
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260907210200_admin_read_fns.sql \
        supabase/tests/20_admin_read_fns.test.sql \
        gateway/admin/reads.ts
git commit -m "feat: admin read endpoints over auth.users and tenant data"
```

---

### Task 7: The admin request handler and its two mounts

**Files:**
- Create: `gateway/admin/index.ts`
- Modify: `gateway/node-adapter.ts`
- Modify: `worker.ts` (after the `gateway(request)` call, ~line 65)
- Modify: `server/index.ts` (after the `nodeAdapter` mount, ~line 44)

**Interfaces:**
- Consumes: `createAdminLookup`, `AdminRole` (Task 2); `createRegistry`, `dispatchOperation`, `AdminCtx` (Task 4); `ADMIN_OPERATIONS` (Task 5); `handleAdminRead` (Task 6); `verifyAccessToken` from `../jwt.js`; `csrfViolation` from `../csrf.js`; `cookieNames`, `parseCookies` from `../cookies.js`.
- Produces:
  - `interface AdminConfig { supabaseUrl: string; supabaseSecretKey: string; jwksUrl: string }`
  - `async function handleAdminRequest(config: AdminConfig, request: Request, lookup: AdminLookup): Promise<Response | null>` — `null` for any path outside `/api/admin`.
  - `export function createNodeAdapter(handler: (req: Request) => Promise<Response | null>, isOwned: (path: string) => boolean)` in `node-adapter.ts`.

**Note:** the spec originally routed the frontend's nav gate through a new `admin` field on `GET /auth/session`. That is not buildable: `GatewayConfig` deliberately carries no `supabaseSecretKey`, and reading `platform_admins` requires it. Adding the service-role key to the gateway would break the invariant this whole design rests on. `GET /api/admin/whoami` replaces it, so `gateway/auth-handlers.ts` is not modified at all and the nav gate shares the same enforcement path as every other admin route.

- [ ] **Step 1: Write the handler**

Create `gateway/admin/index.ts`:

```ts
import { cookieNames, parseCookies } from '../cookies.js'
import { csrfViolation } from '../csrf.js'
import { verifyAccessToken } from '../jwt.js'
import type { AdminLookup } from './adminAuth.js'
import { ADMIN_OPERATIONS } from './ops.js'
import { createRegistry, dispatchOperation, type AdminCtx } from './operations.js'
import { handleAdminRead } from './reads.js'

// The admin console's request handler. Lives OUTSIDE createGateway on purpose:
// the gateway "only ever proxies as the caller's own token" (see worker.ts),
// and these handlers hold the service-role key. Chat sits outside the gateway
// for exactly the same reason.
//
// Mounted twice -- worker.ts and server/index.ts -- and framework-agnostic
// like the gateway itself, returning null for any path it does not own.
//
// The API prefix is /api/admin, NOT /admin. worker.ts serves the SPA fallback
// only for paths that fail its isGatewayPath check, so an /admin API prefix
// would make a browser navigation to /admin/users return 404 instead of
// loading the app. /api is already in that list.

export interface AdminConfig {
  supabaseUrl: string
  supabaseSecretKey: string
  jwksUrl: string
}

const PREFIX = '/api/admin'

// Pure and stateless, so module scope is safe in a long-lived Worker isolate.
// createRegistry throws on a duplicate name, making a collision a startup
// failure rather than a silently shadowed operation.
const REGISTRY = createRegistry(ADMIN_OPERATIONS)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function isAdminPath(path: string): boolean {
  return path === PREFIX || path.startsWith(`${PREFIX}/`)
}

export async function handleAdminRequest(
  config: AdminConfig,
  request: Request,
  lookup: AdminLookup
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!isAdminPath(url.pathname)) return null

  // Same CSRF posture as /auth and /db. Reused verbatim rather than
  // reimplemented so the admin surface cannot drift from the app's.
  const csrf = csrfViolation(request, url)
  if (csrf) return csrf

  const token = parseCookies(request)[cookieNames(url).accessToken]
  const claims = token ? await verifyAccessToken(token, config.jwksUrl, config.supabaseUrl) : null
  if (!claims) return json({ error: 'not authenticated' }, 401)

  // A guest is never an admin. The lookup below would return null anyway
  // (an anonymous user holds no platform_admins row), but stating it here
  // means a future bug that grants a row to an anonymous id still denies.
  if (claims.isAnonymous) return json({ error: 'not an admin' }, 403)

  const adminRole = await lookup.roleFor(claims.sub)
  // Fail-closed: a lookup outage resolves to null and therefore to a denial.
  // Deliberately indistinguishable from "not an admin" in the response --
  // whether a given account is an admin is not something to confirm to a
  // non-admin caller.
  if (!adminRole) return json({ error: 'not an admin' }, 403)

  const ctx: AdminCtx = {
    config: { supabaseUrl: config.supabaseUrl, supabaseSecretKey: config.supabaseSecretKey },
    adminId: claims.sub,
    adminRole,
    requestId: crypto.randomUUID(),
  }

  const segments = url.pathname.slice(PREFIX.length).split('/').filter(Boolean)

  // Confirms admin status to the frontend so it can render the nav link. This
  // replaces the /auth/session field the spec first proposed: the gateway has
  // no service-role key and so cannot read platform_admins.
  if (segments[0] === 'whoami' && request.method === 'GET') {
    return json({ role: adminRole, admin_id: claims.sub })
  }

  if (request.method === 'GET') {
    const read = await handleAdminRead(ctx, segments, url)
    if (read) return json(read.body, read.status)
    return json({ error: 'unknown admin route' }, 404)
  }

  if (request.method === 'POST' && segments[0] === 'op' && segments[1]) {
    let payload: any
    try {
      payload = await request.json()
    } catch {
      return json({ error: 'body must be JSON' }, 400)
    }
    const mode = payload?.mode === 'apply' ? 'apply' : 'preview'
    const result = await dispatchOperation(REGISTRY, ctx, segments[1], mode, payload?.input ?? {})
    return json(result.body, result.status)
  }

  return json({ error: 'unknown admin route' }, 404)
}
```

- [ ] **Step 2: Generalize the node adapter**

In `gateway/node-adapter.ts`, replace the `nodeAdapter` export with a generalized version plus a compatibility wrapper. The body-draining behaviour and its comment must be preserved exactly — draining for a non-owned path breaks Express's body parser downstream.

Change:

```ts
export function nodeAdapter(gateway: Gateway) {
  return async (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      if (!isGatewayOwnedPath(path)) return next()
```

to:

```ts
// Generalized so a second web-standard handler (the admin console, which
// holds the service-role key and therefore cannot live inside the gateway)
// can be mounted the same way. The isOwned predicate is a parameter for the
// same reason the drain below is conditional: draining the body for a path
// this handler does not own leaves nothing for Express's body parser and
// throws "stream is not readable".
export function createNodeAdapter(
  handler: (request: Request) => Promise<Response | null>,
  isOwned: (path: string) => boolean
) {
  return async (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      if (!isOwned(path)) return next()

      const request = await toWebRequest(req)
      const response = await handler(request)
      if (!response) return next()
      await writeWebResponse(response, res)
    } catch (err) {
      next(err)
    }
  }
}

// Express/Node middleware wrapper around the web-standard gateway.
// Mount BEFORE body parsers so /db request bodies pass through untouched.
export function nodeAdapter(gateway: Gateway) {
  return createNodeAdapter(gateway, isGatewayOwnedPath)
}
```

Delete the now-duplicated body of the old `nodeAdapter` (the `toWebRequest` / `handler` / `writeWebResponse` block that followed the `isGatewayOwnedPath` check).

- [ ] **Step 3: Mount in the Worker**

In `worker.ts`, immediately after:

```ts
      const gatewayResponse = await gateway(request);
      if (gatewayResponse) return gatewayResponse;
```

insert:

```ts
      // Admin console. Outside the gateway because it holds the service-role
      // key, and before ASSETS.fetch so /api/admin/* is never treated as a
      // static asset. The lookup is constructed per request, never hoisted to
      // module scope: its cache is instance-scoped so a long-lived isolate
      // does not accumulate entries across distinct users.
      const adminResponse = await handleAdminRequest(
        {
          supabaseUrl: env.SUPABASE_URL,
          supabaseSecretKey: env.SUPABASE_SECRET_KEY,
          jwksUrl: env.SUPABASE_JWKS_URL,
        },
        request,
        createAdminLookup({
          supabaseUrl: env.SUPABASE_URL,
          supabaseSecretKey: env.SUPABASE_SECRET_KEY,
          onLookupError: (err) => Sentry.captureException(err),
        })
      );
      if (adminResponse) return adminResponse;
```

And add to the imports at the top of `worker.ts`:

```ts
import { createAdminLookup } from './gateway/admin/adminAuth.js'
import { handleAdminRequest } from './gateway/admin/index.js'
```

- [ ] **Step 4: Mount in Express**

In `server/index.ts`, add to the imports:

```ts
import { createAdminLookup } from "../gateway/admin/adminAuth.js";
import { handleAdminRequest, isAdminPath } from "../gateway/admin/index.js";
import { createNodeAdapter } from "../gateway/node-adapter.js";
```

Then immediately after the existing `app.use(nodeAdapter(createGateway(gatewayConfig)));` (~line 44) and **before** `app.use(express.json());`, insert:

```ts
// Admin console, mounted before express.json() so the handler reads its own
// request body from the web Request it is handed. Module-scoped lookup for the
// same documented reason as `membership` below: Express has no per-request
// isolate boundary, so a module-scoped cache is bounded by distinct users
// rather than by request volume, with staleness capped by the 30s TTL.
const adminLookup = createAdminLookup({
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseSecretKey: process.env.SUPABASE_SECRET_KEY,
  onLookupError: (err) => Sentry.captureException(err),
});
app.use(
  createNodeAdapter(
    (request) =>
      handleAdminRequest(
        {
          supabaseUrl: process.env.SUPABASE_URL,
          supabaseSecretKey: process.env.SUPABASE_SECRET_KEY,
          jwksUrl: process.env.SUPABASE_JWKS_URL,
        },
        request,
        adminLookup
      ),
    isAdminPath
  )
);
```

- [ ] **Step 5: Verify end to end against the local stack**

Start the Express server (via the "Express API Server" config in `.claude/launch.json`, which uses the Windows-safe `tsx` invocation), then:

Run: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3001/api/admin/whoami`
Expected: `401` — no session cookie.

Run: `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Origin: http://evil.test' http://localhost:3001/api/admin/op/delete_org`
Expected: `403` — CSRF origin mismatch, before any auth work.

Run: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3001/api/admin/nope`
Expected: `401` — unauthenticated callers never learn which routes exist.

- [ ] **Step 6: Confirm the gateway still owns its own paths**

Run: `npm run test:gateway:offline`
Expected: PASS — the `node-adapter.ts` refactor changed no gateway behaviour.

- [ ] **Step 7: Commit**

```bash
git add gateway/admin/index.ts gateway/node-adapter.ts worker.ts server/index.ts
git commit -m "feat: mount the admin handler on both Worker and Express"
```

---

### Task 8: Frontend admin shell and nav gate

**Files:**
- Create: `frontend/lib/adminClient.ts`
- Create: `frontend/pages/admin/AdminLayout.tsx`
- Modify: `frontend/App.tsx`
- Modify: `frontend/components/AppSidebar.tsx`

**Interfaces:**
- Consumes: `GET /api/admin/whoami`, `GET /api/admin/*`, `POST /api/admin/op/:name` from Task 7.
- Produces:
  - `type AdminRole = 'readonly' | 'support' | 'superadmin'`
  - `function useAdminRole(): { role: AdminRole | null; loading: boolean }`
  - `async function adminGet<T>(path: string): Promise<T>`
  - `async function adminOp<T>(name: string, input: unknown, mode: 'preview' | 'apply'): Promise<T>`
  - `class AdminRequestError extends Error { status: number; requestId?: string }`
  - `AdminLayout` — the routed shell rendering the banner and `<Outlet />`.

- [ ] **Step 1: Write the client**

Create `frontend/lib/adminClient.ts`:

```ts
import { useEffect, useState } from 'react'

export type AdminRole = 'readonly' | 'support' | 'superadmin'

const RANK: Record<AdminRole, number> = { readonly: 1, support: 2, superadmin: 3 }

export function adminRoleAtLeast(role: AdminRole | null, required: AdminRole): boolean {
  return role ? RANK[role] >= RANK[required] : false
}

export class AdminRequestError extends Error {
  constructor(message: string, readonly status: number, readonly requestId?: string) {
    super(message)
    this.name = 'AdminRequestError'
  }
}

async function parse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new AdminRequestError(
      (body as any)?.error ?? `admin request failed (${res.status})`,
      res.status,
      (body as any)?.request_id
    )
  }
  return body as T
}

export async function adminGet<T>(path: string): Promise<T> {
  return parse<T>(await fetch(`/api/admin${path}`, { credentials: 'same-origin' }))
}

export async function adminOp<T>(
  name: string,
  input: unknown,
  mode: 'preview' | 'apply'
): Promise<T> {
  return parse<T>(
    await fetch(`/api/admin/op/${name}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, mode }),
    })
  )
}

// Single-flight: the sidebar and the admin shell both need this, and they are
// in different component trees, so without sharing the promise one page load
// would issue two identical /whoami requests. Module scope is safe because the
// answer is per-session and the page reloads on sign-out.
let whoamiInFlight: Promise<AdminRole | null> | null = null

function fetchAdminRole(): Promise<AdminRole | null> {
  whoamiInFlight ??= adminGet<{ role: AdminRole }>('/whoami')
    .then(r => r.role)
    // A 403 is the normal case for the overwhelming majority of users and is
    // not an error worth surfacing -- it simply means no admin link.
    .catch(() => null)
  return whoamiInFlight
}

// The nav gate.
//
// This is a RENDERING hint only. It is never the authorization decision:
// every /api/admin/* request re-checks server-side, so forging this state in
// devtools buys a menu item and a 403.
export function useAdminRole(): { role: AdminRole | null; loading: boolean } {
  const [role, setRole] = useState<AdminRole | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetchAdminRole()
      .then(r => { if (!cancelled) setRole(r) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  return { role, loading }
}
```

- [ ] **Step 2: Write the shell**

Create `frontend/pages/admin/AdminLayout.tsx`:

```tsx
import { NavLink, Outlet } from 'react-router-dom'
import { useAdminRole } from '../../lib/adminClient'

const TABS = [
  { to: '/admin', label: 'Search', end: true },
  { to: '/admin/audit', label: 'Audit log', end: false },
]

export default function AdminLayout() {
  const { role, loading } = useAdminRole()

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Checking access…</div>

  // Server-side enforcement already rejects non-admins on every request; this
  // is the friendly version of the same answer, not a second gate.
  if (!role) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">Not available</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This area is limited to platform administrators.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      {/* Persistent, deliberately hard to miss: every action here is logged
          with the operator's identity, and the operator should know it. */}
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm">
        <strong>Admin console</strong> — signed in as <code>{role}</code>. Every action you take
        here is recorded in the audit log with your account.
      </div>

      <nav className="flex gap-4 border-b pb-2 text-sm">
        {TABS.map(t => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              isActive ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground'
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>

      {/* Pages read the role via useAdminRole(), which shares one in-flight
          /whoami across the whole page -- no context plumbing needed. */}
      <Outlet />
    </div>
  )
}
```

- [ ] **Step 3: Add the lazy route**

In `frontend/App.tsx`, add near the other imports:

```tsx
import { Suspense, lazy } from 'react'

// Lazy so the admin bundle is not shipped to the overwhelming majority of
// users who will never open it. This is a bundle-size and blast-radius
// measure, NOT a security boundary -- enforcement is server-side on every
// /api/admin/* request.
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'))
const AdminSearch = lazy(() => import('./pages/admin/Search'))
const AdminUserDetail = lazy(() => import('./pages/admin/UserDetail'))
const AdminOrgDetail = lazy(() => import('./pages/admin/OrgDetail'))
const AdminAuditLog = lazy(() => import('./pages/admin/AuditLog'))
```

and add this route block alongside the existing routes, matching whatever
`<Routes>`/`<Route>` structure `App.tsx` already uses:

```tsx
<Route
  path="/admin"
  element={
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <AdminLayout />
    </Suspense>
  }
>
  <Route index element={<AdminSearch />} />
  <Route path="user/:userId" element={<AdminUserDetail />} />
  <Route path="org/:orgId" element={<AdminOrgDetail />} />
  <Route path="audit" element={<AdminAuditLog />} />
</Route>
```

- [ ] **Step 4: Gate the nav link**

In `frontend/components/AppSidebar.tsx`, add the hook call alongside the component's existing hooks:

```tsx
const { role: adminRole } = useAdminRole()
```

with the import:

```tsx
import { useAdminRole } from '../lib/adminClient'
```

and render the link only when a role came back, placed after the existing
navigation items and following whatever markup the sidebar's other items use:

```tsx
{adminRole && (
  <NavLink to="/admin" className="...same classes as the sidebar's other links...">
    Admin
  </NavLink>
)}
```

- [ ] **Step 5: Verify in the browser, in both themes**

Start both dev servers from `.claude/launch.json` ("Express API Server" and "Vite Frontend"), sign in as the account granted `superadmin` in Task 1, and confirm:

- the sidebar shows an **Admin** link
- `/admin` renders the banner reading `signed in as superadmin`
- signed in as an account with no `platform_admins` row, the sidebar shows **no** Admin link, and navigating directly to `/admin` renders "Not available" rather than a blank page or a crash
- the browser devtools Network tab shows exactly **one** `GET /api/admin/whoami` per page load, even though both the sidebar and the admin shell ask for it — that is the single-flight cache in `adminClient.ts` working

Then check the banner and nav in **both themes and at 390px width**, per the
"Verifying a visual change" note in `CLAUDE.md`. The banner is the one place
these pages use a colour outside the shadcn token set — shadcn has no `warning`
token and a logged-action notice should not read as `destructive`. Confirm the
amber tint keeps its text legible against both `bg-background` values; if it
does not in one theme, switch the banner to `border-border bg-muted` with a
`font-semibold` label rather than hand-tuning two amber values.

- [ ] **Step 6: Commit**

```bash
git add frontend/lib/adminClient.ts frontend/pages/admin/AdminLayout.tsx \
        frontend/App.tsx frontend/components/AppSidebar.tsx
git commit -m "feat: admin shell, lazy route, and role-gated nav link"
```

---

### Task 9: Search, user detail, and org detail pages

**Files:**
- Create: `frontend/pages/admin/OperationDialog.tsx`
- Create: `frontend/pages/admin/Search.tsx`
- Create: `frontend/pages/admin/UserDetail.tsx`
- Create: `frontend/pages/admin/OrgDetail.tsx`

**Interfaces:**
- Consumes: `adminGet`, `adminOp`, `adminRoleAtLeast`, `AdminRequestError`, `AdminRole` from `../../lib/adminClient` (Task 8); `GET /api/admin/search|user/:id|org/:id` (Task 6); `POST /api/admin/op/:name` (Task 7).
- Produces: `OperationDialog` — the shared two-step preview/confirm surface every mutation goes through. Task 10 does not use it (the audit log is read-only).

- [ ] **Step 1: Write the shared preview/confirm dialog**

Every mutation goes through this one component, so the two-step flow cannot be
skipped by a page author in a hurry.

Create `frontend/pages/admin/OperationDialog.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react'
import { AdminRequestError, adminOp } from '../../lib/adminClient'

interface Props {
  /** Operation name as registered in gateway/admin/ops.ts. */
  name: string
  title: string
  input: Record<string, unknown>
  /**
   * When set, the operator must type this exact string before Apply enables.
   * Used for delete_org (the organization's name) and merge_players.
   */
  confirmPhrase?: string
  onDone: () => void
  onCancel: () => void
}

type Stage = 'previewing' | 'ready' | 'applying' | 'failed'

export default function OperationDialog({
  name, title, input, confirmPhrase, onDone, onCancel,
}: Props) {
  const [stage, setStage] = useState<Stage>('previewing')
  const [preview, setPreview] = useState<unknown>(null)
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null)
  const [typed, setTyped] = useState('')

  // Preview first, always. The operator sees what the server says WOULD happen
  // before anything is written -- a preview writes no data and no audit row.
  const runPreview = useCallback(async () => {
    setStage('previewing')
    setError(null)
    try {
      const res = await adminOp<{ preview: unknown }>(name, input, 'preview')
      setPreview(res.preview)
      setStage('ready')
    } catch (err) {
      const e = err as AdminRequestError
      setError({ message: e.message, requestId: e.requestId })
      setStage('failed')
    }
    // input is a fresh object literal on every parent render, so it is
    // serialized for the dependency rather than compared by identity --
    // otherwise this effect would re-fire forever.
  }, [name, JSON.stringify(input)])

  // MUST be an effect, not a call during render: runPreview sets state, and
  // setting state while rendering re-renders immediately, which loops.
  useEffect(() => { void runPreview() }, [runPreview])

  async function runApply() {
    setStage('applying')
    setError(null)
    try {
      await adminOp(name, input, 'apply')
      onDone()
    } catch (err) {
      const e = err as AdminRequestError
      setError({ message: e.message, requestId: e.requestId })
      setStage('failed')
    }
  }

  const phraseSatisfied = !confirmPhrase || typed === confirmPhrase

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4">
      <div className="w-full max-w-lg rounded-md border bg-background p-5 shadow-none">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Operation <code>{name}</code>
        </p>

        <div className="mt-4 max-h-72 overflow-auto rounded border bg-muted/40 p-3">
          {stage === 'previewing' && <p className="text-sm text-muted-foreground">Checking…</p>}
          {preview !== null && (
            <pre className="whitespace-pre-wrap break-words text-xs">
              {JSON.stringify(preview, null, 2)}
            </pre>
          )}
        </div>

        {error && (
          <div className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <p>{error.message}</p>
            {/* The server keeps operation detail out of client responses; the
                request id is how an operator ties this to Sentry and to the
                audit row. */}
            {error.requestId && (
              <p className="mt-1 text-xs text-muted-foreground">
                Request <code>{error.requestId}</code>
              </p>
            )}
          </div>
        )}

        {confirmPhrase && stage === 'ready' && (
          <label className="mt-4 block text-sm">
            Type <code className="font-semibold">{confirmPhrase}</code> to confirm
            <input
              className="mt-1 w-full rounded border bg-background px-2 py-1 text-sm"
              value={typed}
              onChange={e => setTyped(e.target.value)}
              autoComplete="off"
            />
          </label>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button className="rounded border px-3 py-1.5 text-sm" onClick={onCancel}>
            Cancel
          </button>
          {stage === 'failed' && (
            <button className="rounded border px-3 py-1.5 text-sm" onClick={runPreview}>
              Retry preview
            </button>
          )}
          <button
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
            disabled={stage !== 'ready' || !phraseSatisfied}
            onClick={runApply}
          >
            {stage === 'applying' ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Write the search page**

Create `frontend/pages/admin/Search.tsx`:

```tsx
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AdminRequestError, adminGet } from '../../lib/adminClient'

interface SearchResults {
  query: string
  organizations: { id: number; name: string; is_public: boolean }[]
  users: { id: string; email: string; last_sign_in_at: string | null }[]
  players: { id: number; display_name: string; organization_id: number }[]
}

export default function AdminSearch() {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchResults | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      setResults(await adminGet<SearchResults>(`/search?q=${encodeURIComponent(q)}`))
    } catch (err) {
      setError((err as AdminRequestError).message)
      setResults(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={run} className="flex gap-2">
        <input
          className="w-full max-w-md rounded border bg-background px-3 py-1.5 text-sm"
          placeholder="Email, organization name, or player name"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
        <button
          className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
          disabled={busy || q.trim().length < 2}
        >
          Search
        </button>
      </form>

      {/* The server requires two characters; say so rather than firing a
          request that will 400. */}
      {q.trim().length === 1 && (
        <p className="text-xs text-muted-foreground">Type at least two characters.</p>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {results && (
        <div className="flex flex-col gap-6 text-sm">
          <section>
            <h2 className="mb-2 font-semibold">Users ({results.users.length})</h2>
            {results.users.length === 0 && <p className="text-muted-foreground">None.</p>}
            <ul className="flex flex-col gap-1">
              {results.users.map(u => (
                <li key={u.id}>
                  <Link className="underline" to={`/admin/user/${u.id}`}>{u.email}</Link>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {u.last_sign_in_at ? `last seen ${new Date(u.last_sign_in_at).toLocaleDateString()}` : 'never signed in'}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="mb-2 font-semibold">Organizations ({results.organizations.length})</h2>
            {results.organizations.length === 0 && <p className="text-muted-foreground">None.</p>}
            <ul className="flex flex-col gap-1">
              {results.organizations.map(o => (
                <li key={o.id}>
                  <Link className="underline" to={`/admin/org/${o.id}`}>{o.name}</Link>
                  <span className="ml-2 text-xs text-muted-foreground">
                    #{o.id}{o.is_public ? ' · public' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="mb-2 font-semibold">Players ({results.players.length})</h2>
            {results.players.length === 0 && <p className="text-muted-foreground">None.</p>}
            <ul className="flex flex-col gap-1">
              {results.players.map(p => (
                <li key={p.id}>
                  {p.display_name}
                  <span className="ml-2 text-xs text-muted-foreground">
                    player #{p.id} ·{' '}
                    <Link className="underline" to={`/admin/org/${p.organization_id}`}>
                      org #{p.organization_id}
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Write the user detail page**

Create `frontend/pages/admin/UserDetail.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AdminRequestError, adminGet } from '../../lib/adminClient'
import OperationDialog from './OperationDialog'

interface UserDetail {
  user: { id: string; email: string; created_at: string; last_sign_in_at: string | null; is_anonymous: boolean }
  memberships: { organization_id: number; name: string; role: string; since: string }[]
  player_links: { link_id: number; player_id: number; display_name: string; organization_id: number; status: string }[]
  pending_invites: { invite_id: number; organization_id: number; role: string; expires_at: string }[]
  feedback_report_count: number
}

type Pending =
  | { name: 'set_member_role'; title: string; input: Record<string, unknown> }
  | { name: 'remove_member'; title: string; input: Record<string, unknown> }
  | { name: 'revoke_invite'; title: string; input: Record<string, unknown> }
  | { name: 'approve_player_link'; title: string; input: Record<string, unknown> }

export default function AdminUserDetail() {
  const { userId } = useParams<{ userId: string }>()
  const [data, setData] = useState<UserDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setData(await adminGet<UserDetail>(`/user/${userId}`))
    } catch (err) {
      setError((err as AdminRequestError).message)
    }
  }, [userId])

  useEffect(() => { void load() }, [load])

  if (error) return <p className="text-sm text-destructive">{error}</p>
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>

  return (
    <div className="flex flex-col gap-6 text-sm">
      <section>
        <h1 className="text-base font-semibold">{data.user.email}</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          <code>{data.user.id}</code> · joined {new Date(data.user.created_at).toLocaleDateString()} ·{' '}
          {data.user.last_sign_in_at
            ? `last seen ${new Date(data.user.last_sign_in_at).toLocaleString()}`
            : 'never signed in'}
          {data.user.is_anonymous && ' · guest account'}
          {' · '}{data.feedback_report_count} feedback report(s)
        </p>
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Memberships ({data.memberships.length})</h2>
        {data.memberships.length === 0 && <p className="text-muted-foreground">On no organizations.</p>}
        <ul className="flex flex-col gap-2">
          {data.memberships.map(m => (
            <li key={m.organization_id} className="flex flex-wrap items-center gap-2">
              <Link className="underline" to={`/admin/org/${m.organization_id}`}>{m.name}</Link>
              <span className="rounded border px-1.5 py-0.5 text-xs">{m.role}</span>
              {/* Roles offered exclude the current one -- a no-op write would
                  still produce an audit row saying nothing happened. */}
              {['captain', 'editor', 'member'].filter(r => r !== m.role).map(r => (
                <button
                  key={r}
                  className="rounded border px-2 py-0.5 text-xs"
                  onClick={() => setPending({
                    name: 'set_member_role',
                    title: `Make ${data.user.email} ${r} of ${m.name}`,
                    input: { team_id: m.organization_id, user_id: data.user.id, role: r },
                  })}
                >
                  → {r}
                </button>
              ))}
              <button
                className="rounded border border-destructive/40 px-2 py-0.5 text-xs text-destructive"
                onClick={() => setPending({
                  name: 'remove_member',
                  title: `Remove ${data.user.email} from ${m.name}`,
                  input: { team_id: m.organization_id, user_id: data.user.id },
                })}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Player links ({data.player_links.length})</h2>
        {data.player_links.length === 0 && <p className="text-muted-foreground">No linked players.</p>}
        <ul className="flex flex-col gap-2">
          {data.player_links.map(l => (
            <li key={l.link_id} className="flex flex-wrap items-center gap-2">
              <span>{l.display_name}</span>
              <span className="text-xs text-muted-foreground">
                player #{l.player_id} · org #{l.organization_id}
              </span>
              <span className="rounded border px-1.5 py-0.5 text-xs">{l.status}</span>
              {l.status !== 'approved' && (
                <button
                  className="rounded border px-2 py-0.5 text-xs"
                  onClick={() => setPending({
                    name: 'approve_player_link',
                    title: `Approve ${data.user.email} as ${l.display_name}`,
                    input: { link_id: l.link_id },
                  })}
                >
                  Approve
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Pending invites ({data.pending_invites.length})</h2>
        {data.pending_invites.length === 0 && <p className="text-muted-foreground">None.</p>}
        <ul className="flex flex-col gap-2">
          {data.pending_invites.map(i => (
            <li key={i.invite_id} className="flex flex-wrap items-center gap-2">
              <Link className="underline" to={`/admin/org/${i.organization_id}`}>
                org #{i.organization_id}
              </Link>
              <span className="rounded border px-1.5 py-0.5 text-xs">{i.role}</span>
              <span className="text-xs text-muted-foreground">
                expires {new Date(i.expires_at).toLocaleDateString()}
              </span>
              <button
                className="rounded border px-2 py-0.5 text-xs"
                onClick={() => setPending({
                  name: 'revoke_invite',
                  title: `Revoke invite #${i.invite_id}`,
                  input: { invite_id: i.invite_id },
                })}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      </section>

      {pending && (
        <OperationDialog
          name={pending.name}
          title={pending.title}
          input={pending.input}
          onDone={() => { setPending(null); void load() }}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 4: Write the org detail page**

Create `frontend/pages/admin/OrgDetail.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AdminRequestError, adminGet, adminRoleAtLeast, useAdminRole } from '../../lib/adminClient'
import OperationDialog from './OperationDialog'

interface OrgDetail {
  organization: { id: number; name: string; is_public: boolean; created_at: string }
  members: { user_id: string; email: string; role: string; since: string }[]
  pending_invites: { invite_id: number; email: string; role: string; expires_at: string }[]
  teams: { id: number; name: string }[]
  counts: { players: number; seasons: number; games: number }
  legacy_organization_members: { email: string; role: string }[]
}

export default function AdminOrgDetail() {
  const { orgId } = useParams<{ orgId: string }>()
  const { role } = useAdminRole()
  const [data, setData] = useState<OrgDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<{ name: string; title: string; input: Record<string, unknown>; confirmPhrase?: string } | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'editor' | 'member'>('member')

  const load = useCallback(async () => {
    setError(null)
    try {
      setData(await adminGet<OrgDetail>(`/org/${orgId}`))
    } catch (err) {
      setError((err as AdminRequestError).message)
    }
  }, [orgId])

  useEffect(() => { void load() }, [load])

  if (error) return <p className="text-sm text-destructive">{error}</p>
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>

  const org = data.organization

  return (
    <div className="flex flex-col gap-6 text-sm">
      <section>
        <h1 className="text-base font-semibold">{org.name}</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          org #{org.id}{org.is_public ? ' · public' : ' · private'} · created{' '}
          {new Date(org.created_at).toLocaleDateString()} · {data.counts.players} players ·{' '}
          {data.counts.seasons} seasons · {data.counts.games} games
        </p>
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Members ({data.members.length})</h2>
        <ul className="flex flex-col gap-1">
          {data.members.map(m => (
            <li key={m.user_id} className="flex flex-wrap items-center gap-2">
              <Link className="underline" to={`/admin/user/${m.user_id}`}>{m.email}</Link>
              <span className="rounded border px-1.5 py-0.5 text-xs">{m.role}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          Change roles and remove members from a user’s own page.
        </p>
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Invite someone</h2>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="w-64 rounded border bg-background px-2 py-1 text-sm"
            placeholder="email@example.com"
            value={inviteEmail}
            onChange={e => setInviteEmail(e.target.value)}
          />
          {/* team_invites.role has check (role in ('editor','member')) -- an
              invite cannot grant captain, so captain is not offered. */}
          <select
            className="rounded border bg-background px-2 py-1 text-sm"
            value={inviteRole}
            onChange={e => setInviteRole(e.target.value as 'editor' | 'member')}
          >
            <option value="member">member</option>
            <option value="editor">editor</option>
          </select>
          <button
            className="rounded border px-2 py-1 text-sm disabled:opacity-40"
            disabled={!inviteEmail.includes('@')}
            onClick={() => setPending({
              name: 'invite_member',
              title: `Invite ${inviteEmail} to ${org.name} as ${inviteRole}`,
              input: { team_id: org.id, email: inviteEmail, role: inviteRole },
            })}
          >
            Invite
          </button>
        </div>
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Pending invites ({data.pending_invites.length})</h2>
        {data.pending_invites.length === 0 && <p className="text-muted-foreground">None.</p>}
        <ul className="flex flex-col gap-2">
          {data.pending_invites.map(i => (
            <li key={i.invite_id} className="flex flex-wrap items-center gap-2">
              <span>{i.email}</span>
              <span className="rounded border px-1.5 py-0.5 text-xs">{i.role}</span>
              <button
                className="rounded border px-2 py-0.5 text-xs"
                onClick={() => setPending({
                  name: 'revoke_invite',
                  title: `Revoke the invite for ${i.email}`,
                  input: { invite_id: i.invite_id },
                })}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Teams ({data.teams.length})</h2>
        {/* teams is a secondary grouping referenced by games/seasons/
            league_games, not the tenant. Listed for orientation; there is no
            transfer operation because the schema cannot express one. */}
        <p className="text-xs text-muted-foreground">
          Secondary grouping used by games and seasons. Not the tenant boundary.
        </p>
        <ul className="mt-1 flex flex-col gap-1">
          {data.teams.map(t => <li key={t.id}>{t.name} <span className="text-xs text-muted-foreground">#{t.id}</span></li>)}
        </ul>
      </section>

      {data.legacy_organization_members.length > 0 && (
        <section>
          <h2 className="mb-2 font-semibold">Legacy organization_members rows</h2>
          <p className="text-xs text-muted-foreground">
            These predate <code>team_members</code> and are read by nothing. Shown so a
            disagreement with the member list above has a visible cause.
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {data.legacy_organization_members.map(m => (
              <li key={m.email} className="text-muted-foreground">{m.email} · {m.role}</li>
            ))}
          </ul>
        </section>
      )}

      {adminRoleAtLeast(role, 'superadmin') && (
        <section className="rounded border border-destructive/40 p-4">
          <h2 className="font-semibold text-destructive">Delete this organization</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Cascades to every player, game, season, and strategy in this tenant. The preview
            shows exact per-table counts first, and you must type the organization’s name.
          </p>
          <button
            className="mt-3 rounded border border-destructive/40 px-3 py-1.5 text-sm text-destructive"
            onClick={() => setPending({
              name: 'delete_org',
              title: `Delete ${org.name}`,
              input: { organization_id: org.id, confirm_name: org.name },
              confirmPhrase: org.name,
            })}
          >
            Delete organization…
          </button>
        </section>
      )}

      {pending && (
        <OperationDialog
          name={pending.name}
          title={pending.title}
          input={pending.input}
          confirmPhrase={pending.confirmPhrase}
          onDone={() => { setPending(null); void load() }}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 5: Verify the flows against the local stack**

With both dev servers running and signed in as the `superadmin` account:

1. Search `local` — confirm the seeded users appear.
2. Open a user, change a membership role — confirm the dialog previews first, that Apply then succeeds, and that the page reloads showing the new role.
3. On a team where the target is the **only captain**, demote them — confirm the dialog shows the 409 message *"That team must have at least one captain. Promote another member first, then retry."* rather than a generic failure. This exercises the trigger through the whole stack.
4. Invite an address that already has a pending invite — confirm the 409 conflict message.
5. Open the delete-organization panel and confirm **Apply stays disabled** until the typed name matches exactly, and that the preview lists per-table counts.
6. Cancel out without applying, then check the audit log table directly:
   `docker exec -i $(docker ps -qf name=supabase_db) psql -U postgres -d postgres -c "select operation, result from public.admin_audit_log order by id desc limit 10"`
   Expected: rows for the applied and denied operations, and **no rows** for any preview.
7. Check every page in both themes and at 390px, per `CLAUDE.md`'s "Verifying a visual change".

- [ ] **Step 6: Commit**

```bash
git add frontend/pages/admin/OperationDialog.tsx frontend/pages/admin/Search.tsx \
        frontend/pages/admin/UserDetail.tsx frontend/pages/admin/OrgDetail.tsx
git commit -m "feat: admin search, user detail, and org detail with preview-confirm"
```

---

### Task 10: Audit log page

**Files:**
- Create: `frontend/pages/admin/AuditLog.tsx`

**Interfaces:**
- Consumes: `adminGet` from `../../lib/adminClient` (Task 8); `GET /api/admin/audit?limit=&cursor=&operation=` (Task 6).
- Produces: nothing other tasks consume.

- [ ] **Step 1: Write the page**

Create `frontend/pages/admin/AuditLog.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react'
import { AdminRequestError, adminGet } from '../../lib/adminClient'

interface AuditRow {
  id: number
  at: string
  admin_id: string
  admin_role: string
  operation: string
  target: unknown
  before: unknown
  after: unknown
  result: 'ok' | 'denied' | 'error'
  error: string | null
  request_id: string | null
}

const RESULT_CLASS: Record<AuditRow['result'], string> = {
  ok: 'border-border',
  denied: 'border-amber-500/50',
  error: 'border-destructive/50',
}

export default function AdminAuditLog() {
  const [rows, setRows] = useState<AuditRow[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)

  // `reset` distinguishes "new query" from "next page": the cursor is keyset,
  // so appending is correct for paging and wrong when the filter changes.
  const load = useCallback(async (reset: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const params = new URLSearchParams({ limit: '50' })
      if (filter) params.set('operation', filter)
      if (!reset && cursor) params.set('cursor', cursor)
      const res = await adminGet<{ rows: AuditRow[]; next_cursor: string | null }>(
        `/audit?${params.toString()}`
      )
      setRows(prev => (reset ? res.rows : [...prev, ...res.rows]))
      setCursor(res.next_cursor)
    } catch (err) {
      setError((err as AdminRequestError).message)
    } finally {
      setBusy(false)
    }
  }, [cursor, filter])

  useEffect(() => { void load(true) }, [filter]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-muted-foreground">Filter by operation</label>
        <select
          className="rounded border bg-background px-2 py-1 text-sm"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        >
          <option value="">all</option>
          {['set_member_role', 'remove_member', 'invite_member', 'revoke_invite',
            'set_player_link', 'approve_player_link', 'merge_players', 'delete_org']
            .map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <ul className="flex flex-col gap-2">
        {rows.map(r => (
          <li key={r.id} className={`rounded border ${RESULT_CLASS[r.result]} p-3`}>
            <div className="flex flex-wrap items-center gap-2">
              <code className="font-semibold">{r.operation}</code>
              <span className="rounded border px-1.5 py-0.5 text-xs">{r.result}</span>
              <span className="text-xs text-muted-foreground">
                {new Date(r.at).toLocaleString()} · {r.admin_role} ·{' '}
                <code>{r.admin_id.slice(0, 8)}</code>
              </span>
              <button
                className="ml-auto rounded border px-2 py-0.5 text-xs"
                onClick={() => setExpanded(expanded === r.id ? null : r.id)}
              >
                {expanded === r.id ? 'Hide' : 'Details'}
              </button>
            </div>

            {r.error && <p className="mt-2 text-xs text-destructive">{r.error}</p>}

            {expanded === r.id && (
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-xs">
                {JSON.stringify({ target: r.target, before: r.before, after: r.after, request_id: r.request_id }, null, 2)}
              </pre>
            )}
          </li>
        ))}
      </ul>

      {rows.length === 0 && !busy && (
        <p className="text-muted-foreground">No entries yet.</p>
      )}

      {cursor && (
        <button
          className="self-start rounded border px-3 py-1.5 text-sm disabled:opacity-40"
          disabled={busy}
          onClick={() => void load(false)}
        >
          {busy ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify against the local stack**

With the operations from Task 9's verification already applied, open `/admin/audit` and confirm:

- the applied and denied operations both appear, newest first
- a `denied` row is visually distinguishable from an `ok` row
- **Details** reveals `target`, `before`, `after`, and the `request_id`
- filtering by `set_member_role` narrows the list, and switching back to `all` restores it (this checks that a filter change resets rather than appends)
- **Load more** appends rather than replacing, when there are more than 50 rows

Check both themes and 390px per `CLAUDE.md`.

- [ ] **Step 3: Commit**

```bash
git add frontend/pages/admin/AuditLog.tsx
git commit -m "feat: admin audit log viewer"
```

---

### Task 11: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-09-07-admin-console-design.md`

**Interfaces:**
- Consumes: everything built in Tasks 1-10.
- Produces: nothing consumed by code.

**Merge note:** `origin/feat/schedule-ledger-redesign` also appends a `## Design system` section to `CLAUDE.md`, between `## MCP server (AI tool access)` and `## References`. Add the admin section **after** `## Design system`'s position (i.e. immediately before `## References`) so the two additions do not overlap. If that branch has not merged yet, the addition still applies cleanly — it lands in the same place either way.

- [ ] **Step 1: Add the admin console section to CLAUDE.md**

Insert immediately before the `## References` section:

```markdown
## Admin console

- The console lives at `/admin` (SPA route); its API is `/api/admin/*`. These
  prefixes must stay different: `worker.ts` serves the SPA fallback only for
  paths failing its `isGatewayPath` check, so an `/admin` API prefix makes a
  browser navigation to `/admin/users` return 404.
- Handlers are in `gateway/admin/` and live **outside** `createGateway`,
  because they hold the service-role key and the gateway never does. They are
  mounted twice: in `worker.ts` right after the gateway call, and in
  `server/index.ts` via `createNodeAdapter` before `express.json()`.
- **Granting admin is a manual step, on purpose.** Run
  `node --env-file=.env.local scripts/grant-platform-admin.mjs <email> <role>`
  (roles: `superadmin`, `support`, `readonly`). The console deliberately has no
  operation for this, so a compromised admin session cannot mint more admins.
  Without a `platform_admins` row you get a 403 from every `/api/admin/*`
  route and no Admin link in the sidebar — that is correct behaviour, not a bug.
- `platform_admins` and `admin_audit_log` are RLS-enabled with **zero
  policies** and no grants to `anon`/`authenticated`. If you add a table like
  this, also add it to the allowlist in `supabase/tests/00_meta.test.sql`,
  which otherwise fails with "every table in public has at least one policy".
- `admin_audit_log` is append-only via the `admin_audit_log_no_mutate` trigger.
  `UPDATE` and `DELETE` raise even for the service role. Deleting a former
  admin's `auth.users` row is blocked by `admin_id`'s `ON DELETE RESTRICT` —
  that is deliberate, and it means a GDPR deletion for an ex-admin needs an
  explicit decision about their audit history.
- **Admin operations write tables directly with the service role; they do not
  call the membership RPCs.** `set_member_role` and friends gate on
  `auth.uid()` via `my_captain_team_ids()`, which is empty under the service
  role, so they raise `only a captain can change roles`. This is safe because
  `enforce_last_captain()` is a *trigger* (`team_members_require_captain`) and
  fires on direct writes too. Each operation re-implements the RPC's input
  validation; see `gateway/admin/ops.ts`.
- Adding an operation means adding one entry to `ADMIN_OPERATIONS` in
  `gateway/admin/ops.ts`. Do **not** write an audit row from inside an
  operation — `dispatchOperation` does it, which is what guarantees no
  operation can forget. `preview` must never write.
- There is **no team-transfer operation** and cannot be one without a schema
  change: `players`, `game_events`, `strategy_*`, and `lineup_templates` are
  scoped only by `organization_id`, so there is no way to tell which of them
  belong to a moved team. See the spec for the full reasoning.
- Tests: `npm run db:test` (pgTAP suites 18-20) and
  `npm run test:gateway:offline` (`adminAuth`, `adminOps`). As everywhere else
  in this repo, do not run `npm test` — it reads production.
```

- [ ] **Step 2: Record the two spec deviations**

Append to the spec at `docs/superpowers/specs/2026-09-07-admin-console-design.md`:

```markdown
## Deviations found during implementation

Two things in the design above were not buildable as written. Both were
corrected in the plan; this section records why so the spec is not read as the
final word on them.

1. **`/auth/session` does not gain an `admin` field.** `GatewayConfig`
   deliberately carries no `supabaseSecretKey`, and reading `platform_admins`
   requires it — adding the service-role key to the gateway would break the
   invariant the whole design rests on. `GET /api/admin/whoami` serves the nav
   gate instead, which also means the gate shares the same enforcement path as
   every other admin route rather than being a second trust surface.
2. **No admin operation wraps an existing membership RPC.** The RPCs gate on
   `auth.uid()`, which is NULL under the service role, so a wrapper would
   raise rather than work. Operations write directly; `enforce_last_captain()`
   is a trigger and still applies. See schema fact 5 above, which anticipated
   this but stopped short of stating the consequence for the operation table.
```

- [ ] **Step 3: Verify the whole suite one last time**

Run: `npm run db:reset && npm run db:test`
Expected: PASS — all suites including 18, 19, and 20.

Run: `npm run test:gateway:offline`
Expected: PASS — including `adminAuth.test.mjs` and `adminOps.test.mjs`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-07-admin-console-design.md
git commit -m "docs: admin console trust boundary and bootstrap"
```
