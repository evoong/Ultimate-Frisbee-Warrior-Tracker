# Team Permissions — Plan 1: Database Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a local Supabase instance and build the complete
role-based permission model — schema, RPCs, and strict RLS — replacing
`017_open_access_for_now.sql`, verified by a pgTAP suite that proves both
what each role can do and what it cannot.

**Architecture:** Postgres RLS is the single enforcement boundary. Membership
tables carry no DML grants for `authenticated`; every membership change goes
through a `security definer` RPC that derives the caller from `auth.uid()`.
Four array-returning helper functions supply team ids to every policy, so a
policy is a single indexed `= any (...)` test.

**Tech Stack:** Supabase CLI 2.67.1, PostgreSQL 15, pgTAP, Docker.

**Spec:** `docs/superpowers/specs/2026-09-03-team-permissions-design.md`

## Global Constraints

- Roles are exactly `'captain'`, `'editor'`, `'member'`. Guests hold no row.
- Every `security definer` function: `set search_path = ''`, then
  `revoke all ... from public, anon` and `grant execute ... to authenticated`.
- No function accepts a caller identity as a parameter. The caller is always
  `(select auth.uid())`.
- Every write RPC rejects anonymous JWTs on its first statement.
- Policies reference helpers as `(select public.fn())` — the wrapper makes
  Postgres evaluate them once per query as an InitPlan, not once per row.
- Existing table/column names are used throughout: the tenant table is
  `organizations` and the tenant column is `organization_id`. The rename to
  `teams` / `team_id` is Plan 4 and must not be started here.
- New objects use final names (`team_members`, `team_invites`,
  `player_links`, `player_private`) and reference `organizations(id)`.
- Migrations are Supabase CLI migrations in `supabase/migrations/`.
  `supabase-migrations/001..027` is frozen history — do not add files there.
- Never commit `.env*`, database dumps, or production data.
- Commit after every task. Never push to `main`; this work is a branch + PR.

## Critical gotcha, read before Task 3

**A table's owner bypasses its own RLS.** pgTAP runs as `postgres`, which
both owns the tables and has `BYPASSRLS`. A policy test that forgets
`set local role authenticated` passes no matter how broken the policy is.
Every test in this plan calls `tests.login_as(...)` or
`tests.login_as_guest()`, both of which set the role. Task 3 adds a
canary test that fails loudly if RLS is being bypassed.

---

### Task 1: Local Supabase instance with a production-derived baseline

**Files:**
- Create: `supabase/config.toml` (generated, then edited)
- Create: `supabase/migrations/00000000000000_baseline.sql` (generated)
- Modify: `package.json` (scripts)
- Create: `.env.local.example`

**Interfaces:**
- Produces: a running local stack; `npm run db:reset` rebuilds it from the
  baseline plus every later migration.

- [ ] **Step 1: Initialize the Supabase project**

```bash
supabase init
```

Answer "n" if it offers to generate VS Code settings.

- [ ] **Step 2: Dump the production schema as the baseline**

`DATABASE_URL` is in `.env`. If the pooler host rejects the connection
(`tenant/user ... not found`), use the direct connection string from the
Supabase dashboard → Project Settings → Database instead.

```bash
set -a; . ./.env; set +a
supabase db dump --db-url "$DATABASE_URL" -f supabase/migrations/00000000000000_baseline.sql
```

Schema only — no `--data-only`, ever. Production `players` rows contain real
phone numbers and must never land in a dev container.

- [ ] **Step 3: Verify the baseline contains the ad-hoc tables**

```bash
grep -cE 'CREATE TABLE.*(game_attendance|chat_logs)' supabase/migrations/00000000000000_baseline.sql
```

Expected: `2`. These two tables have no tracked `create table` in
`supabase-migrations/`, which is the entire reason the baseline is a dump
rather than a replay. If this prints `0`, the dump targeted the wrong
database — stop and fix it.

- [ ] **Step 4: Configure auth for local development**

Edit `supabase/config.toml`:

```toml
[auth]
site_url = "http://localhost:5199"
additional_redirect_urls = ["http://localhost:5199"]
enable_anonymous_sign_ins = true

[auth.email]
enable_confirmations = false
```

`enable_anonymous_sign_ins` is what makes guest login testable at all.

- [ ] **Step 5: Start the stack and confirm it is healthy**

```bash
supabase start
supabase status
```

Expected: `API URL: http://127.0.0.1:54321` plus anon and service_role keys.
Docker must be running.

- [ ] **Step 6: Add npm scripts**

In root `package.json`, inside `"scripts"`:

```json
"db:start": "supabase start",
"db:stop": "supabase stop",
"db:reset": "supabase db reset",
"db:test": "supabase test db"
```

- [ ] **Step 7: Document local env wiring**

Create `.env.local.example`:

```bash
# Local Supabase (values from `supabase status`). Copy to .env.local.
# .env* is gitignored — never commit the real file.
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_PUBLISHABLE_KEY=<anon key from supabase status>
SUPABASE_SECRET_KEY=<service_role key from supabase status>
SUPABASE_JWKS_URL=http://127.0.0.1:54321/auth/v1/.well-known/jwks.json
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

- [ ] **Step 8: Verify a reset works end to end**

```bash
npm run db:reset
```

Expected: applies `00000000000000_baseline.sql` with no errors.

- [ ] **Step 9: Commit**

```bash
git add supabase/config.toml supabase/migrations/00000000000000_baseline.sql package.json .env.local.example
git commit -m "Add local Supabase instance with production-derived baseline"
```

---

### Task 2: Synthetic seed data and test identities

**Files:**
- Create: `supabase/seed.sql`
- Create: `scripts/seed-local-users.mjs`
- Modify: `package.json` (`db:reset` chains the user seed)

**Interfaces:**
- Produces: organizations 1 (private, "Team A") and 2 (public, "Team B");
  players 101-104; season 1; game 1 with goal events. Six identities:
  `captain@local.test`, `editor@local.test`, `member@local.test`,
  `unlinked@local.test`, `outsider@local.test` (org 2), plus one anonymous
  user. All passwords `localdev123`. **No player_links are seeded** — every
  link test creates its own, and Plan 3 verifies the unlinked-user flow
  against these accounts.
- Consumes: nothing.

- [ ] **Step 1: Write the SQL seed**

Create `supabase/seed.sql`. Ids are fixed so tests can hardcode them.

```sql
-- Synthetic only. Never seeded from production: real player rows carry
-- phone numbers that must not exist in a dev container.

insert into public.organizations (id, name, is_public) overriding system value
values (1, 'Team A (private)', false),
       (2, 'Team B (public)',  true)
on conflict (id) do nothing;

insert into public.teams (id, name) overriding system value
values (1, 'Disc-iples'), (2, 'Rival Squad')
on conflict (id) do nothing;
update public.teams set organization_id = id where id in (1, 2);

insert into public.seasons (id, team_id, name, year, organization_id) overriding system value
values (1, 1, 'Fall', '2026', 1), (2, 2, 'Fall', '2026', 2)
on conflict (id) do nothing;

insert into public.players (id, first_name, last_name, display_name, phone, organization_id)
overriding system value
values (101, 'Cap',  'Tain',  'Cap',  '555-0101', 1),
       (102, 'Ed',   'Itor',  'Ed',   '555-0102', 1),
       (103, 'Mem',  'Ber',   'Mem',  '555-0103', 1),
       (104, 'Out',  'Sider', 'Out',  '555-0104', 2)
on conflict (id) do nothing;

insert into public.games (id, season_id, opponent, game_date, our_score, their_score, organization_id)
overriding system value
values (1, 1, 'Rivals', '2026-09-01', 15, 12, 1),
       (2, 2, 'Others', '2026-09-01', 10, 15, 2)
on conflict (id) do nothing;

insert into public.game_events (game_id, player_id, related_player_id, event_type, point_number, organization_id)
values (1, 101, 102, 'Goal', 1, 1),
       (1, 103, 101, 'Goal', 2, 1),
       (1, 102, null,  'Goal', 3, 1),
       (2, 104, null,  'Goal', 1, 2);

insert into public.strategy_plays (name, organization_id)
values ('Vertical stack', 1), ('Horizontal stack', 2);

select setval(pg_get_serial_sequence('public.players', 'id'), 200, true);
select setval(pg_get_serial_sequence('public.games',   'id'), 200, true);
```

If a column referenced above does not exist in the baseline, read the
baseline's `create table` for that table and adjust — the baseline is the
source of truth, not this snippet.

- [ ] **Step 2: Write the user seeding script**

Create `scripts/seed-local-users.mjs`:

```js
// Creates the six test identities against the LOCAL Supabase only.
// Refuses to run against anything else.
const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const KEY = process.env.SUPABASE_SECRET_KEY

if (!/127\.0\.0\.1|localhost/.test(URL)) {
  console.error(`refusing to seed users against non-local URL: ${URL}`)
  process.exit(1)
}
if (!KEY) {
  console.error('SUPABASE_SECRET_KEY is required (see `supabase status`)')
  process.exit(1)
}

const USERS = [
  'captain@local.test',
  'editor@local.test',
  'member@local.test',
  'unlinked@local.test',
  'outsider@local.test',
]

async function api(path, init) {
  const res = await fetch(`${URL}${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

for (const email of USERS) {
  const { status, body } = await api('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'localdev123', email_confirm: true }),
  })
  console.log(status < 300 ? `created ${email} ${body.id}` : `skip ${email}: ${JSON.stringify(body)}`)
}

// A real anonymous user, so guest behavior is exercised against the same
// shape production produces rather than a hand-faked JWT claim.
const anon = await fetch(`${URL}/auth/v1/signup`, {
  method: 'POST',
  headers: { apikey: KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
})
console.log('anonymous user:', anon.status)
```

- [ ] **Step 3: Chain it into the reset**

In root `package.json`:

```json
"db:seed:users": "node --env-file=.env.local scripts/seed-local-users.mjs",
"db:reset": "supabase db reset && npm run db:seed:users"
```

- [ ] **Step 4: Run and verify**

```bash
cp .env.local.example .env.local   # then fill in the keys from `supabase status`
npm run db:reset
```

Expected: five `created ...` lines with uuids, then `anonymous user: 200`.

- [ ] **Step 5: Verify the seed landed**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "select count(*) from public.game_events;" \
  -c "select email, is_anonymous from auth.users order by created_at;"
```

Expected: 4 events; five confirmed users plus one anonymous.
(If `psql` is unavailable, run the same SQL from the Supabase Studio SQL
editor at http://127.0.0.1:54323.)

- [ ] **Step 6: Commit**

```bash
git add supabase/seed.sql scripts/seed-local-users.mjs package.json
git commit -m "Add synthetic local seed data and test identities"
```

---

### Task 3: pgTAP harness, login helpers, and structural meta-tests

**Files:**
- Create: `supabase/migrations/20260903000100_test_helpers.sql`
- Create: `supabase/tests/00_meta.test.sql`

**Interfaces:**
- Produces: `tests.login_as(email text)`, `tests.login_as_guest()`,
  `tests.logout()` — used by every later test file.

- [ ] **Step 1: Write the helper migration**

Create `supabase/migrations/20260903000100_test_helpers.sql`:

```sql
-- Test-only helpers. Safe in production (the tests schema is never granted
-- to any application role), but only ever called from supabase/tests.
create extension if not exists pgtap with schema extensions;

create schema if not exists tests;

create or replace function tests.login_as(p_email text)
returns uuid
language plpgsql
as $$
declare
  v_uid uuid;
begin
  select id into v_uid from auth.users where email = p_email;
  if v_uid is null then
    raise exception 'tests.login_as: no such user %', p_email;
  end if;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object(
    'sub', v_uid,
    'email', p_email,
    'role', 'authenticated',
    'is_anonymous', false
  )::text, true);
  return v_uid;
end;
$$;

create or replace function tests.login_as_guest()
returns uuid
language plpgsql
as $$
declare
  v_uid uuid;
begin
  select id into v_uid from auth.users where is_anonymous limit 1;
  if v_uid is null then
    raise exception 'tests.login_as_guest: seed has no anonymous user';
  end if;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object(
    'sub', v_uid,
    'role', 'authenticated',
    'is_anonymous', true
  )::text, true);
  return v_uid;
end;
$$;

create or replace function tests.logout()
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', null, true);
  reset role;
end;
$$;
```

- [ ] **Step 2: Write the meta-tests**

Create `supabase/tests/00_meta.test.sql`:

```sql
begin;
select plan(5);

-- Canary: proves RLS is actually applied under tests.login_as. If the test
-- session were running as a table owner or BYPASSRLS role, this returns
-- rows and every other policy test in this suite is meaningless.
select tests.login_as('outsider@local.test');
select is_empty(
  $$ select id from public.game_events where organization_id = 1 $$,
  'RLS canary: an outsider sees no rows from another org'
);
select tests.logout();

select is_empty(
  $$ select c.relname::text
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and not c.relrowsecurity $$,
  'every table in public has RLS enabled'
);

-- standings is deprecated and intentionally has zero policies (016 dropped
-- them); nothing reads or writes it, so no access is the correct state.
select is_empty(
  $$ select c.relname::text
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and c.relname <> 'standings'
        and not exists (select 1 from pg_policy p where p.polrelid = c.oid) $$,
  'every table in public has at least one policy'
);

select is_empty(
  $$ select p.proname::text
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prosecdef
        and (p.proconfig is null
             or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')) $$,
  'every security definer function in public pins search_path'
);

select is_empty(
  $$ select p.proname::text
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prosecdef
        and has_function_privilege('anon', p.oid, 'EXECUTE') $$,
  'no security definer function in public is executable by anon'
);

select * from finish();
rollback;
```

- [ ] **Step 3: Run the suite — expect the canary to FAIL**

```bash
npm run db:reset && npm run db:test
```

Expected: the RLS canary test **fails**. Under `017_open_access_for_now.sql`
every domain table is `using (true)`, so an outsider can read org 1's events.
That failure is the accurate description of today's security posture and is
the thing Task 14 fixes. The other four assertions should pass.

- [ ] **Step 4: Record the expected failure**

Add this comment directly above the canary test so nobody "fixes" it by
deleting it:

```sql
-- EXPECTED TO FAIL until Task 14 replaces 017's `using (true)` policies.
-- Do not weaken or skip this test; it is the suite's proof of validity.
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260903000100_test_helpers.sql supabase/tests/00_meta.test.sql
git commit -m "Add pgTAP harness, login helpers, and structural meta-tests"
```

---

### Task 4: team_members table and the at-least-one-captain trigger

**Files:**
- Create: `supabase/migrations/20260903000200_team_members.sql`
- Create: `supabase/tests/01_team_members.test.sql`
- Modify: `supabase/seed.sql`

**Interfaces:**
- Produces: `public.team_members(id, team_id, user_id, role, created_at, invited_by)`
  where `team_id` references `organizations(id)`; trigger
  `team_members_require_captain`.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/01_team_members.test.sql`:

```sql
begin;
select plan(4);

select has_table('public', 'team_members', 'team_members exists');

select throws_ok(
  $$ insert into public.team_members (team_id, user_id, role)
     values (1, (select id from auth.users where email = 'member@local.test'), 'owner') $$,
  '23514',
  null,
  'role is constrained to captain/editor/member'
);

-- Seeded state: org 1 has exactly one captain.
select throws_ok(
  $$ delete from public.team_members
      where team_id = 1
        and user_id = (select id from auth.users where email = 'captain@local.test') $$,
  'P0001',
  'team 1 must have at least one captain',
  'removing the last captain raises'
);

select throws_ok(
  $$ update public.team_members set role = 'member'
      where team_id = 1
        and user_id = (select id from auth.users where email = 'captain@local.test') $$,
  'P0001',
  'team 1 must have at least one captain',
  'demoting the last captain raises'
);

select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run db:test
```

Expected: FAIL — `relation "public.team_members" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260903000200_team_members.sql`:

```sql
-- Membership keyed on user_id, not email: email is a mutable JWT claim,
-- a user id is not. Email survives only as invite addressing (Task 5).
create table if not exists public.team_members (
  id          bigint generated by default as identity primary key,
  team_id     bigint not null references public.organizations(id) on delete cascade,
  user_id     uuid   not null references auth.users(id) on delete cascade,
  role        text   not null default 'member'
                     check (role in ('captain', 'editor', 'member')),
  created_at  timestamptz not null default now(),
  invited_by  uuid references auth.users(id),
  unique (team_id, user_id)
);

create index if not exists team_members_user_id_idx on public.team_members (user_id);
create index if not exists team_members_team_role_idx on public.team_members (team_id, role);

alter table public.team_members enable row level security;

-- A captain-less team is an escalation vector: "this team has no captain"
-- invites a recovery path an attacker can aim at. There is no such path;
-- the last captain simply cannot be removed or demoted.
create or replace function public.enforce_last_captain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team_id bigint := coalesce(old.team_id, new.team_id);
  v_remaining int;
begin
  if tg_op = 'UPDATE' and old.role = 'captain' and new.role = 'captain' then
    return new;
  end if;
  if old.role is distinct from 'captain' then
    return coalesce(new, old);
  end if;

  select count(*) into v_remaining
    from public.team_members
   where team_id = v_team_id and role = 'captain' and id <> old.id;

  if v_remaining = 0 then
    raise exception 'team % must have at least one captain', v_team_id;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger team_members_require_captain
  before update or delete on public.team_members
  for each row execute function public.enforce_last_captain();
```

- [ ] **Step 4: Seed memberships**

Append to `supabase/seed.sql`:

```sql
insert into public.team_members (team_id, user_id, role)
select 1, id, 'captain' from auth.users where email = 'captain@local.test'
union all select 1, id, 'editor'  from auth.users where email = 'editor@local.test'
union all select 1, id, 'member'  from auth.users where email = 'member@local.test'
union all select 1, id, 'member'  from auth.users where email = 'unlinked@local.test'
union all select 2, id, 'captain' from auth.users where email = 'outsider@local.test'
on conflict (team_id, user_id) do nothing;
```

The user seed runs **after** `supabase db reset` applies `seed.sql`, so this
block must run after users exist. Move it into a new
`scripts/seed-local-memberships.sql` executed by `db:seed:users` instead:

```json
"db:seed:users": "node --env-file=.env.local scripts/seed-local-users.mjs && psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -f scripts/seed-local-memberships.sql"
```

Create `scripts/seed-local-memberships.sql` containing the insert above.

- [ ] **Step 5: Run the tests**

```bash
npm run db:reset && npm run db:test
```

Expected: all four `01_team_members` assertions PASS. The Task 3 canary
still fails (expected until Task 14).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260903000200_team_members.sql supabase/tests/01_team_members.test.sql scripts/seed-local-memberships.sql package.json
git commit -m "Add team_members with at-least-one-captain trigger"
```

---

### Task 5: team_invites and player_links

**Files:**
- Create: `supabase/migrations/20260903000300_invites_and_links.sql`
- Create: `supabase/tests/02_invites_links.test.sql`

**Interfaces:**
- Produces: `public.team_invites(id, team_id, email, role, invited_by,
  created_at, expires_at, accepted_at, accepted_by)`;
  `public.player_links(id, team_id, player_id, user_id, status, created_at)`.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/02_invites_links.test.sql`:

```sql
begin;
select plan(5);

select has_table('public', 'team_invites', 'team_invites exists');
select has_table('public', 'player_links', 'player_links exists');

-- Captaincy is granted by promotion, never by invitation. Enforced in the
-- schema so no RPC bug can widen it.
select throws_ok(
  $$ insert into public.team_invites (team_id, email, role)
     values (1, 'x@local.test', 'captain') $$,
  '23514',
  null,
  'an invite can never carry role captain'
);

select throws_ok(
  $$ insert into public.team_invites (team_id, email, role)
     values (1, 'MixedCase@local.test', 'member') $$,
  '23514',
  null,
  'invite emails must be lowercase'
);

select lives_ok(
  $$ insert into public.team_invites (team_id, email, role)
     values (1, 'first@local.test', 'member'),
            (1, 'first@local.test', 'member') $$,
  'duplicate pending invites for one email are rejected'
);

select * from finish();
rollback;
```

Note the last assertion is deliberately written as `lives_ok` first; Step 3
makes it a unique-violation and Step 5 flips it to `throws_ok`.

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run db:test
```

Expected: FAIL — `relation "public.team_invites" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260903000300_invites_and_links.sql`:

```sql
create table if not exists public.team_invites (
  id           bigint generated by default as identity primary key,
  team_id      bigint not null references public.organizations(id) on delete cascade,
  email        text   not null check (email = lower(email)),
  role         text   not null default 'member'
                      check (role in ('editor', 'member')),
  invited_by   uuid references auth.users(id),  -- null: created by migration
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '30 days',
  accepted_at  timestamptz,
  accepted_by  uuid references auth.users(id)
);

create unique index if not exists team_invites_pending_unique
  on public.team_invites (team_id, email) where accepted_at is null;

create index if not exists team_invites_email_idx
  on public.team_invites (email) where accepted_at is null;

alter table public.team_invites enable row level security;

-- Links answer "whose stats are these", never "what may this person do".
-- No policy anywhere reads this table. Keep it that way.
create table if not exists public.player_links (
  id          bigint generated by default as identity primary key,
  team_id     bigint  not null references public.organizations(id) on delete cascade,
  player_id   integer not null references public.players(id) on delete cascade,
  user_id     uuid    not null references auth.users(id) on delete cascade,
  status      text    not null default 'pending'
                      check (status in ('pending', 'approved')),
  created_at  timestamptz not null default now(),
  unique (player_id),
  unique (team_id, user_id)
);

create index if not exists player_links_user_id_idx on public.player_links (user_id);

alter table public.player_links enable row level security;
```

- [ ] **Step 4: Flip the duplicate-invite assertion**

In `supabase/tests/02_invites_links.test.sql`, replace the `lives_ok` block
with:

```sql
select throws_ok(
  $$ insert into public.team_invites (team_id, email, role)
     values (1, 'first@local.test', 'member'),
            (1, 'first@local.test', 'member') $$,
  '23505',
  null,
  'duplicate pending invites for one email are rejected'
);
```

- [ ] **Step 5: Run the tests**

```bash
npm run db:reset && npm run db:test
```

Expected: all five `02_invites_links` assertions PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260903000300_invites_and_links.sql supabase/tests/02_invites_links.test.sql
git commit -m "Add team_invites and player_links tables"
```

---

### Task 6: Split player PII into player_private

**Files:**
- Create: `supabase/migrations/20260903000400_player_private.sql`
- Create: `supabase/tests/03_player_private.test.sql`
- Modify: `supabase/seed.sql`

**Interfaces:**
- Produces: `public.player_private(player_id, team_id, phone,
  first_name_edit, last_name_edit)`. Those three columns are **dropped**
  from `public.players`.

Rationale (from the spec): Supabase anonymous users hold the same Postgres
role as real users, so column-level `GRANT` cannot hide a column from a
guest. Sensitive data in a separate row with its own policy is enforceable;
a hidden column is not.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/03_player_private.test.sql`:

```sql
begin;
select plan(4);

select has_table('public', 'player_private', 'player_private exists');
select hasnt_column('public', 'players', 'phone', 'phone no longer lives on players');
select hasnt_column('public', 'players', 'first_name_edit', 'first_name_edit moved off players');

select is(
  (select phone from public.player_private where player_id = 101),
  '555-0101',
  'existing phone data was migrated, not dropped'
);

select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run db:test
```

Expected: FAIL — `relation "public.player_private" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260903000400_player_private.sql`:

```sql
create table if not exists public.player_private (
  player_id        integer primary key references public.players(id) on delete cascade,
  team_id          bigint  not null references public.organizations(id) on delete cascade,
  phone            text,
  first_name_edit  text,
  last_name_edit   text
);

create index if not exists player_private_team_id_idx on public.player_private (team_id);

alter table public.player_private enable row level security;

-- Move the data before dropping the columns, in one transaction, so no
-- phone number is ever lost between the two statements.
insert into public.player_private (player_id, team_id, phone, first_name_edit, last_name_edit)
select id, organization_id, phone, first_name_edit, last_name_edit
  from public.players
 where phone is not null or first_name_edit is not null or last_name_edit is not null
on conflict (player_id) do nothing;

alter table public.players drop column if exists phone;
alter table public.players drop column if exists first_name_edit;
alter table public.players drop column if exists last_name_edit;
```

- [ ] **Step 4: Run the tests**

```bash
npm run db:reset && npm run db:test
```

Expected: all four `03_player_private` assertions PASS.

- [ ] **Step 5: Find every reader of the moved columns**

```bash
grep -rn "first_name_edit\|last_name_edit\|\.phone\b" frontend gateway server mcp-server --include=*.ts --include=*.tsx | grep -v node_modules
```

Record the hits in the commit message. **Do not fix them here** — the
frontend and gateway are Plans 2 and 3, and this plan must not leave a
half-edited application layer behind.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260903000400_player_private.sql supabase/tests/03_player_private.test.sql
git commit -m "Split player PII into player_private table"
```

---

### Task 7: Tenant indexes and team photo column

**Files:**
- Create: `supabase/migrations/20260903000500_tenant_indexes.sql`
- Create: `supabase/tests/04_indexes.test.sql`

**Interfaces:**
- Produces: an index on `organization_id` for every org-scoped table;
  `organizations.photo_url`.

Migration 016 added `organization_id` to ~20 tables and never indexed it.
Irrelevant under 017's `using (true)`; load-bearing the moment every query
filters on it.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/04_indexes.test.sql`:

```sql
begin;
select plan(2);

select has_column('public', 'organizations', 'photo_url', 'organizations has photo_url');

select is_empty(
  $$ select c.relname::text
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id'
      where n.nspname = 'public'
        and c.relkind = 'r'
        and not exists (
          select 1 from pg_index i
           where i.indrelid = c.oid
             and a.attnum = any (i.indkey)
        ) $$,
  'every table with organization_id has an index that includes it'
);

select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run db:test
```

Expected: FAIL — the `is_empty` assertion lists ~20 unindexed tables.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260903000500_tenant_indexes.sql`:

```sql
alter table public.organizations add column if not exists photo_url text;

do $$
declare
  t record;
begin
  for t in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id'
     where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format(
      'create index if not exists %I on public.%I (organization_id)',
      t.relname || '_organization_id_idx', t.relname
    );
  end loop;
end
$$;
```

- [ ] **Step 4: Run the tests**

```bash
npm run db:reset && npm run db:test
```

Expected: both `04_indexes` assertions PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260903000500_tenant_indexes.sql supabase/tests/04_indexes.test.sql
git commit -m "Index organization_id on every tenant table, add team photo_url"
```

---

### Task 8: Permission helper functions

**Files:**
- Create: `supabase/migrations/20260903000600_permission_helpers.sql`
- Create: `supabase/tests/05_helpers.test.sql`

**Interfaces:**
- Produces, all returning `bigint[]`:
  `public.my_member_team_ids()`, `public.my_manage_team_ids()`,
  `public.my_captain_team_ids()`, `public.public_team_ids()`.
  Also `public.is_guest() returns boolean`.
- Consumed by: every policy in Tasks 13-15 and every RPC in Tasks 9-12.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/05_helpers.test.sql`:

```sql
begin;
select plan(6);

select tests.login_as('captain@local.test');
select is(public.my_member_team_ids(),  array[1]::bigint[], 'captain is a member of team 1');
select is(public.my_captain_team_ids(), array[1]::bigint[], 'captain holds captaincy of team 1');

select tests.login_as('editor@local.test');
select is(public.my_manage_team_ids(),  array[1]::bigint[], 'editor holds manage rights on team 1');
select is(public.my_captain_team_ids(), '{}'::bigint[],     'editor holds no captaincy');

select tests.login_as('member@local.test');
select is(public.my_manage_team_ids(),  '{}'::bigint[],     'member holds no manage rights');

select tests.login_as_guest();
select is(public.my_member_team_ids(),  '{}'::bigint[],     'a guest belongs to no team');

select tests.logout();
select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run db:test
```

Expected: FAIL — `function public.my_member_team_ids() does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260903000600_permission_helpers.sql`:

```sql
create or replace function public.is_guest()
returns boolean
language sql
stable
as $$
  select coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false);
$$;

-- Every membership helper returns an empty array for an anonymous caller,
-- so a guest cannot match any row before any explicit guest check runs.
create or replace function public.my_member_team_ids()
returns bigint[]
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.is_guest() then '{}'::bigint[]
         else coalesce((
           select array_agg(team_id order by team_id)
             from public.team_members
            where user_id = (select auth.uid())
         ), '{}'::bigint[]) end;
$$;

create or replace function public.my_manage_team_ids()
returns bigint[]
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.is_guest() then '{}'::bigint[]
         else coalesce((
           select array_agg(team_id order by team_id)
             from public.team_members
            where user_id = (select auth.uid())
              and role in ('captain', 'editor')
         ), '{}'::bigint[]) end;
$$;

create or replace function public.my_captain_team_ids()
returns bigint[]
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.is_guest() then '{}'::bigint[]
         else coalesce((
           select array_agg(team_id order by team_id)
             from public.team_members
            where user_id = (select auth.uid())
              and role = 'captain'
         ), '{}'::bigint[]) end;
$$;

create or replace function public.public_team_ids()
returns bigint[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select array_agg(id order by id) from public.organizations where is_public
  ), '{}'::bigint[]);
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.my_member_team_ids()', 'public.my_manage_team_ids()',
    'public.my_captain_team_ids()', 'public.public_team_ids()'
  ]
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$$;
```

- [ ] **Step 4: Run the tests**

```bash
npm run db:reset && npm run db:test
```

Expected: all six `05_helpers` assertions PASS, and the Task 3 meta-tests
still pass (the new functions pin `search_path` and are revoked from `anon`).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260903000600_permission_helpers.sql supabase/tests/05_helpers.test.sql
git commit -m "Add permission helper functions for RLS policies"
```

---

### Task 9: create_team, invite_member, revoke_invite

**Files:**
- Create: `supabase/migrations/20260903000700_membership_rpcs.sql`
- Create: `supabase/tests/06_invite_rpcs.test.sql`

**Interfaces:**
- Produces:
  - `public.create_team(p_name text) returns bigint`
  - `public.invite_member(p_team_id bigint, p_email text, p_role text) returns bigint`
  - `public.revoke_invite(p_invite_id bigint) returns void`

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/06_invite_rpcs.test.sql`:

```sql
begin;
select plan(7);

-- create_team is the only way a team comes into existence, and it creates
-- the caller's captain row in the same statement. That atomicity is what
-- lets team_members carry no self-insert policy at all.
select tests.login_as('member@local.test');
select lives_ok(
  $$ select public.create_team('Brand New Team') $$,
  'any signed-in user can create a team'
);
select is(
  (select role from public.team_members
    where team_id = (select max(id) from public.organizations)
      and user_id = (select auth.uid())),
  'captain',
  'the creator is the new team''s captain'
);

select tests.login_as_guest();
select throws_ok(
  $$ select public.create_team('Guest Team') $$,
  'P0001', 'guests cannot perform this action',
  'a guest cannot create a team'
);

select tests.login_as('editor@local.test');
select lives_ok(
  $$ select public.invite_member(1, 'NewPerson@Local.test', 'member') $$,
  'an editor can invite a member (email is normalized)'
);
select throws_ok(
  $$ select public.invite_member(1, 'another@local.test', 'editor') $$,
  'P0001', 'only a captain can grant the editor role',
  'an editor cannot mint another editor'
);

select tests.login_as('member@local.test');
select throws_ok(
  $$ select public.invite_member(1, 'nope@local.test', 'member') $$,
  'P0001', 'insufficient permissions on this team',
  'a plain member cannot invite'
);

select tests.login_as('outsider@local.test');
select throws_ok(
  $$ select public.invite_member(1, 'nope2@local.test', 'member') $$,
  'P0001', 'insufficient permissions on this team',
  'a captain of another team cannot invite into team 1'
);

select tests.logout();
select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run db:test
```

Expected: FAIL — `function public.create_team(unknown) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260903000700_membership_rpcs.sql`:

```sql
-- Shared guard. Every write RPC calls this first.
create or replace function public.assert_not_guest()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if public.is_guest() or (select auth.uid()) is null then
    raise exception 'guests cannot perform this action';
  end if;
end;
$$;

create or replace function public.create_team(p_name text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team_id bigint;
begin
  perform public.assert_not_guest();

  if coalesce(btrim(p_name), '') = '' then
    raise exception 'team name is required';
  end if;

  insert into public.organizations (name, is_public)
  values (btrim(p_name), false)
  returning id into v_team_id;

  insert into public.team_members (team_id, user_id, role)
  values (v_team_id, (select auth.uid()), 'captain');

  return v_team_id;
end;
$$;

create or replace function public.invite_member(
  p_team_id bigint,
  p_email   text,
  p_role    text default 'member'
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email     text := lower(btrim(p_email));
  v_caller    uuid;
  v_is_captain boolean;
  v_invite_id bigint;
begin
  perform public.assert_not_guest();
  v_caller := (select auth.uid());

  if p_role not in ('member', 'editor') then
    raise exception 'invalid invite role: %', p_role;
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid email address';
  end if;

  if not (p_team_id = any (public.my_manage_team_ids())) then
    raise exception 'insufficient permissions on this team';
  end if;

  v_is_captain := p_team_id = any (public.my_captain_team_ids());
  if p_role = 'editor' and not v_is_captain then
    raise exception 'only a captain can grant the editor role';
  end if;

  if exists (
    select 1 from public.team_members m
     where m.team_id = p_team_id
       and m.user_id = (select u.id from auth.users u where lower(u.email) = v_email)
  ) then
    raise exception 'that person is already on this team';
  end if;

  insert into public.team_invites (team_id, email, role, invited_by)
  values (p_team_id, v_email, p_role, v_caller)
  on conflict (team_id, email) where accepted_at is null
  do update set role = excluded.role, invited_by = excluded.invited_by,
                expires_at = now() + interval '30 days'
  returning id into v_invite_id;

  return v_invite_id;
end;
$$;

create or replace function public.revoke_invite(p_invite_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team_id bigint;
begin
  perform public.assert_not_guest();

  select team_id into v_team_id
    from public.team_invites
   where id = p_invite_id and accepted_at is null;

  if v_team_id is null then
    raise exception 'no such pending invite';
  end if;
  if not (v_team_id = any (public.my_manage_team_ids())) then
    raise exception 'insufficient permissions on this team';
  end if;

  delete from public.team_invites where id = p_invite_id;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.assert_not_guest()',
    'public.create_team(text)',
    'public.invite_member(bigint, text, text)',
    'public.revoke_invite(bigint)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$$;
```

- [ ] **Step 4: Run the tests**

```bash
npm run db:reset && npm run db:test
```

Expected: all seven `06_invite_rpcs` assertions PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260903000700_membership_rpcs.sql supabase/tests/06_invite_rpcs.test.sql
git commit -m "Add create_team, invite_member, and revoke_invite RPCs"
```

---

### Task 10: accept_invite with the confirmed-email gate

**Files:**
- Create: `supabase/migrations/20260903000800_accept_invite.sql`
- Create: `supabase/tests/07_accept_invite.test.sql`
- Modify: `scripts/seed-local-users.mjs`

**Interfaces:**
- Produces: `public.accept_invite() returns table (team_id bigint, role text)`.
  **No arguments** — the caller is `auth.uid()` and the matching email comes
  from `auth.users`, never from a parameter.

An invite keyed on an email string is a bearer token addressed to whoever
claims that string first. Requiring `email_confirmed_at is not null` is what
makes it safe: an attacker who signs up as a captain's address without
controlling the mailbox cannot consume their invite.

- [ ] **Step 1: Add an unconfirmed test identity**

In `scripts/seed-local-users.mjs`, after the `USERS` loop:

```js
// Deliberately unconfirmed: proves accept_invite refuses an unverified
// address, which is the invite model's load-bearing assumption.
const { status, body } = await api('/auth/v1/admin/users', {
  method: 'POST',
  body: JSON.stringify({ email: 'unconfirmed@local.test', password: 'localdev123', email_confirm: false }),
})
console.log(status < 300 ? `created unconfirmed@local.test ${body.id}` : `skip: ${JSON.stringify(body)}`)
```

- [ ] **Step 2: Write the failing test**

Create `supabase/tests/07_accept_invite.test.sql`:

```sql
begin;
select plan(5);

insert into public.team_invites (team_id, email, role)
values (1, 'unconfirmed@local.test', 'member'),
       (1, 'outsider@local.test',    'member');

select tests.login_as('unconfirmed@local.test');
select throws_ok(
  $$ select * from public.accept_invite() $$,
  'P0001', 'confirm your email address before joining a team',
  'an unconfirmed email cannot accept an invite'
);
select is_empty(
  $$ select id from public.team_members
      where team_id = 1 and user_id = (select auth.uid()) $$,
  'no membership was created for the unconfirmed user'
);

select tests.login_as('outsider@local.test');
select is(
  (select count(*)::int from public.accept_invite()),
  1,
  'a confirmed user consumes their pending invite'
);
select is(
  (select role from public.team_members
    where team_id = 1 and user_id = (select auth.uid())),
  'member',
  'the invite role is what gets granted'
);
select is(
  (select count(*)::int from public.accept_invite()),
  0,
  'accepting twice is a no-op'
);

select tests.logout();
select * from finish();
rollback;
```

- [ ] **Step 3: Run it and watch it fail**

```bash
npm run db:reset && npm run db:test
```

Expected: FAIL — `function public.accept_invite() does not exist`.

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/20260903000800_accept_invite.sql`:

```sql
create or replace function public.accept_invite()
returns table (team_id bigint, role text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid;
  v_email     text;
  v_confirmed timestamptz;
begin
  perform public.assert_not_guest();
  v_uid := (select auth.uid());

  select lower(u.email), u.email_confirmed_at
    into v_email, v_confirmed
    from auth.users u
   where u.id = v_uid;

  if v_confirmed is null then
    raise exception 'confirm your email address before joining a team';
  end if;

  return query
  with claimed as (
    update public.team_invites i
       set accepted_at = now(), accepted_by = v_uid
     where i.email = v_email
       and i.accepted_at is null
       and i.expires_at > now()
       and not exists (
         select 1 from public.team_members m
          where m.team_id = i.team_id and m.user_id = v_uid
       )
    returning i.team_id, i.role, i.invited_by
  ), inserted as (
    insert into public.team_members (team_id, user_id, role, invited_by)
    select c.team_id, v_uid, c.role, c.invited_by from claimed c
    on conflict (team_id, user_id) do nothing
    returning team_members.team_id, team_members.role
  )
  select i.team_id, i.role from inserted i;
end;
$$;

revoke all on function public.accept_invite() from public, anon;
grant execute on function public.accept_invite() to authenticated;
```

- [ ] **Step 5: Run the tests**

```bash
npm run db:reset && npm run db:test
```

Expected: all five `07_accept_invite` assertions PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260903000800_accept_invite.sql supabase/tests/07_accept_invite.test.sql scripts/seed-local-users.mjs
git commit -m "Add accept_invite RPC gated on confirmed email"
```

---

### Task 11: set_member_role and remove_member

**Files:**
- Create: `supabase/migrations/20260903000900_role_management.sql`
- Create: `supabase/tests/08_role_management.test.sql`

**Interfaces:**
- Produces:
  - `public.set_member_role(p_team_id bigint, p_user_id uuid, p_role text) returns void`
  - `public.remove_member(p_team_id bigint, p_user_id uuid) returns void`

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/08_role_management.test.sql`:

```sql
begin;
select plan(6);

select tests.login_as('member@local.test');
select throws_ok(
  format(
    $$ select public.set_member_role(1, %L::uuid, 'captain') $$,
    (select id from auth.users where email = 'member@local.test')
  ),
  'P0001', 'only a captain can change roles',
  'a member cannot promote themselves to captain'
);

select tests.login_as('editor@local.test');
select throws_ok(
  format(
    $$ select public.set_member_role(1, %L::uuid, 'editor') $$,
    (select id from auth.users where email = 'member@local.test')
  ),
  'P0001', 'only a captain can change roles',
  'an editor cannot change roles'
);
select throws_ok(
  format(
    $$ select public.remove_member(1, %L::uuid) $$,
    (select id from auth.users where email = 'captain@local.test')
  ),
  'P0001', 'only a captain can remove a captain or an editor',
  'an editor cannot remove a captain'
);
select lives_ok(
  format(
    $$ select public.remove_member(1, %L::uuid) $$,
    (select id from auth.users where email = 'unlinked@local.test')
  ),
  'an editor can remove a plain member'
);

select tests.login_as('captain@local.test');
select throws_ok(
  format(
    $$ select public.set_member_role(1, %L::uuid, 'member') $$,
    (select id from auth.users where email = 'captain@local.test')
  ),
  'P0001', 'team 1 must have at least one captain',
  'the last captain cannot demote themselves'
);
select lives_ok(
  format(
    $$ select public.set_member_role(1, %L::uuid, 'editor') $$,
    (select id from auth.users where email = 'member@local.test')
  ),
  'a captain can grant the editor role'
);

select tests.logout();
select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run db:test
```

Expected: FAIL — `function public.set_member_role(...) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260903000900_role_management.sql`:

```sql
create or replace function public.set_member_role(
  p_team_id bigint,
  p_user_id uuid,
  p_role    text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_not_guest();

  if p_role not in ('captain', 'editor', 'member') then
    raise exception 'invalid role: %', p_role;
  end if;
  if not (p_team_id = any (public.my_captain_team_ids())) then
    raise exception 'only a captain can change roles';
  end if;

  update public.team_members
     set role = p_role
   where team_id = p_team_id and user_id = p_user_id;

  if not found then
    raise exception 'that person is not on this team';
  end if;
end;
$$;

-- An editor may remove a plain member, never a captain or another editor.
-- Anyone may remove themselves (leave). The last-captain trigger still
-- applies underneath all of it.
create or replace function public.remove_member(
  p_team_id bigint,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target_role text;
  v_is_self     boolean;
  v_is_captain  boolean;
  v_is_manager  boolean;
begin
  perform public.assert_not_guest();

  v_is_self    := p_user_id = (select auth.uid());
  v_is_captain := p_team_id = any (public.my_captain_team_ids());
  v_is_manager := p_team_id = any (public.my_manage_team_ids());

  select role into v_target_role
    from public.team_members
   where team_id = p_team_id and user_id = p_user_id;

  if v_target_role is null then
    raise exception 'that person is not on this team';
  end if;

  if not v_is_self then
    if not v_is_manager then
      raise exception 'insufficient permissions on this team';
    end if;
    if v_target_role <> 'member' and not v_is_captain then
      raise exception 'only a captain can remove a captain or an editor';
    end if;
  end if;

  delete from public.team_members
   where team_id = p_team_id and user_id = p_user_id;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.set_member_role(bigint, uuid, text)',
    'public.remove_member(bigint, uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$$;
```

- [ ] **Step 4: Run the tests**

```bash
npm run db:reset && npm run db:test
```

Expected: all six `08_role_management` assertions PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260903000900_role_management.sql supabase/tests/08_role_management.test.sql
git commit -m "Add set_member_role and remove_member RPCs"
```

---

### Task 12: Player link RPCs

**Files:**
- Create: `supabase/migrations/20260903001000_player_link_rpcs.sql`
- Create: `supabase/tests/09_player_links.test.sql`

**Interfaces:**
- Produces:
  - `public.claim_player(p_player_id integer) returns bigint` — pending
  - `public.set_player_link(p_player_id integer, p_user_id uuid) returns bigint` — approved
  - `public.approve_claim(p_link_id bigint) returns void`

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/09_player_links.test.sql`:

```sql
begin;
select plan(5);

select tests.login_as('member@local.test');
select is(
  (select status from public.player_links where id = public.claim_player(103)),
  'pending',
  'a member self-claim starts pending'
);
select throws_ok(
  $$ select public.claim_player(104) $$,
  'P0001', 'that player belongs to another team',
  'a member cannot claim a player on a team they do not belong to'
);
select throws_ok(
  format(
    $$ select public.set_player_link(101, %L::uuid) $$,
    (select id from auth.users where email = 'member@local.test')
  ),
  'P0001', 'insufficient permissions on this team',
  'a member cannot assign links'
);

select tests.login_as('captain@local.test');
select is(
  (select status from public.player_links where id = public.set_player_link(
     101, (select id from auth.users where email = 'captain@local.test'))),
  'approved',
  'a captain-assigned link is approved immediately'
);

select tests.login_as_guest();
select throws_ok(
  $$ select public.claim_player(103) $$,
  'P0001', 'guests cannot perform this action',
  'a guest cannot claim a player'
);

select tests.logout();
select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run db:test
```

Expected: FAIL — `function public.claim_player(integer) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260903001000_player_link_rpcs.sql`:

```sql
create or replace function public.claim_player(p_player_id integer)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team_id bigint;
  v_link_id bigint;
begin
  perform public.assert_not_guest();

  select organization_id into v_team_id from public.players where id = p_player_id;
  if v_team_id is null then
    raise exception 'no such player';
  end if;
  if not (v_team_id = any (public.my_member_team_ids())) then
    raise exception 'that player belongs to another team';
  end if;

  insert into public.player_links (team_id, player_id, user_id, status)
  values (v_team_id, p_player_id, (select auth.uid()), 'pending')
  returning id into v_link_id;

  return v_link_id;
end;
$$;

create or replace function public.set_player_link(p_player_id integer, p_user_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team_id bigint;
  v_link_id bigint;
begin
  perform public.assert_not_guest();

  select organization_id into v_team_id from public.players where id = p_player_id;
  if v_team_id is null then
    raise exception 'no such player';
  end if;
  if not (v_team_id = any (public.my_manage_team_ids())) then
    raise exception 'insufficient permissions on this team';
  end if;
  if not exists (
    select 1 from public.team_members where team_id = v_team_id and user_id = p_user_id
  ) then
    raise exception 'that person is not on this team';
  end if;

  insert into public.player_links (team_id, player_id, user_id, status)
  values (v_team_id, p_player_id, p_user_id, 'approved')
  on conflict (player_id) do update
    set user_id = excluded.user_id, status = 'approved'
  returning id into v_link_id;

  return v_link_id;
end;
$$;

create or replace function public.approve_claim(p_link_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team_id bigint;
begin
  perform public.assert_not_guest();

  select team_id into v_team_id from public.player_links where id = p_link_id;
  if v_team_id is null then
    raise exception 'no such claim';
  end if;
  if not (v_team_id = any (public.my_manage_team_ids())) then
    raise exception 'insufficient permissions on this team';
  end if;

  update public.player_links set status = 'approved' where id = p_link_id;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.claim_player(integer)',
    'public.set_player_link(integer, uuid)',
    'public.approve_claim(bigint)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$$;
```

- [ ] **Step 4: Run the tests**

```bash
npm run db:reset && npm run db:test
```

Expected: all five `09_player_links` assertions PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260903001000_player_link_rpcs.sql supabase/tests/09_player_links.test.sql
git commit -m "Add player link RPCs for personal stats"
```

---

### Task 13: Revoke DML on membership tables and add their read policies

**Files:**
- Create: `supabase/migrations/20260903001100_membership_lockdown.sql`
- Create: `supabase/tests/10_membership_lockdown.test.sql`

**Interfaces:**
- Produces: read-only policies on `team_members`, `team_invites`,
  `player_links`; no INSERT/UPDATE/DELETE grant for `authenticated` on any
  of the three.

This is the centre of the design. There is no policy to get wrong because
there is no code path: `authenticated` holds no write privilege at all, so
every membership change must travel through the RPCs from Tasks 9-12.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/10_membership_lockdown.test.sql`:

```sql
begin;
select plan(6);

select tests.login_as('member@local.test');

select throws_ok(
  $$ insert into public.team_members (team_id, user_id, role)
     values (2, (select auth.uid()), 'captain') $$,
  '42501',
  null,
  'no INSERT privilege on team_members, at any role'
);
select throws_ok(
  $$ update public.team_members set role = 'captain' where user_id = (select auth.uid()) $$,
  '42501',
  null,
  'no UPDATE privilege on team_members'
);
select throws_ok(
  $$ insert into public.team_invites (team_id, email, role)
     values (2, 'sneaky@local.test', 'editor') $$,
  '42501',
  null,
  'no INSERT privilege on team_invites'
);
select throws_ok(
  $$ update public.player_links set status = 'approved' where team_id = 1 $$,
  '42501',
  null,
  'no UPDATE privilege on player_links'
);

select is(
  (select count(*)::int from public.team_members where team_id = 1),
  4,
  'a member can read their own team roster'
);
select is_empty(
  $$ select id from public.team_members where team_id = 2 $$,
  'a member cannot read another team roster'
);

select tests.logout();
select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run db:test
```

Expected: FAIL — the inserts succeed, because nothing has revoked the
default grants yet.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260903001100_membership_lockdown.sql`:

```sql
-- Membership is read-only to clients. Every change goes through a
-- security definer RPC that derives the caller from auth.uid(). Revoking
-- the privilege outright is stronger than a policy: a policy can be
-- misread, an absent grant cannot be satisfied.
do $$
declare t text;
begin
  foreach t in array array['team_members', 'team_invites', 'player_links']
  loop
    execute format('revoke insert, update, delete on public.%I from authenticated', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end
$$;

drop policy if exists "member read roster" on public.team_members;
create policy "member read roster" on public.team_members
  for select to authenticated
  using (team_id = any ((select public.my_member_team_ids())));

drop policy if exists "manager read invites" on public.team_invites;
create policy "manager read invites" on public.team_invites
  for select to authenticated
  using (team_id = any ((select public.my_manage_team_ids())));

drop policy if exists "member read links" on public.player_links;
create policy "member read links" on public.player_links
  for select to authenticated
  using (team_id = any ((select public.my_member_team_ids())));
```

- [ ] **Step 4: Run the tests**

```bash
npm run db:reset && npm run db:test
```

Expected: all six `10_membership_lockdown` assertions PASS, and every RPC
test from Tasks 9-12 still passes — the RPCs are `security definer`, so
revoking the caller's table privileges does not affect them. If an RPC test
now fails with `42501`, that RPC is missing `security definer`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260903001100_membership_lockdown.sql supabase/tests/10_membership_lockdown.test.sql
git commit -m "Revoke client DML on membership tables, add read policies"
```

---

### Task 14: Strict RLS on domain tables, replacing 017

**Files:**
- Create: `supabase/migrations/20260903001200_strict_rls.sql`
- Create: `supabase/tests/11_domain_rls.test.sql`
- Modify: `supabase/tests/00_meta.test.sql` (remove the expected-failure note)

**Interfaces:**
- Produces: Tier A and Tier B policies on every org-scoped table, plus
  policies on `organizations` itself.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/11_domain_rls.test.sql`:

```sql
begin;
select plan(10);

-- Tier A: public teams are readable by anyone, including guests.
select tests.login_as_guest();
select isnt_empty(
  $$ select id from public.games where organization_id = 2 $$,
  'a guest can read a public team''s games'
);
select is_empty(
  $$ select id from public.games where organization_id = 1 $$,
  'a guest cannot read a private team''s games'
);

-- Tier B has no public branch at all, not even for a public team.
select is_empty(
  $$ select id from public.strategy_plays where organization_id = 2 $$,
  'a guest cannot read strategy on a public team'
);
select is_empty(
  $$ select player_id from public.player_private $$,
  'a guest cannot read player phone numbers anywhere'
);
select throws_ok(
  $$ insert into public.game_events (game_id, player_id, event_type, organization_id)
     values (2, 104, 'Goal', 2) $$,
  '42501',
  null,
  'a guest cannot write, even to a public team'
);

-- Members write their own team and nothing else.
select tests.login_as('member@local.test');
select lives_ok(
  $$ insert into public.game_events (game_id, player_id, event_type, organization_id)
     values (1, 103, 'Goal', 1) $$,
  'a member can record events on their own team'
);
select throws_ok(
  $$ insert into public.game_events (game_id, player_id, event_type, organization_id)
     values (2, 104, 'Goal', 2) $$,
  '42501',
  null,
  'a member cannot write into another team'
);
select throws_ok(
  $$ update public.games set organization_id = 2 where id = 1 $$,
  '42501',
  null,
  'a member cannot move a row into another team'
);

-- Team settings are manage-tier.
select throws_ok(
  $$ update public.organizations set name = 'Hijacked' where id = 1 $$,
  '42501',
  null,
  'a member cannot rename the team'
);
select tests.login_as('editor@local.test');
select lives_ok(
  $$ update public.organizations set name = 'Renamed By Editor' where id = 1 $$,
  'an editor can rename the team'
);

select tests.logout();
select * from finish();
rollback;
```

Note: an RLS denial on `insert`/`update` surfaces as SQLSTATE `42501`
(`new row violates row-level security policy`). A denial on `select`
returns zero rows rather than raising, which is why those assertions use
`is_empty` instead.

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run db:test
```

Expected: FAIL on nearly every assertion — 017's `using (true)` policies let
everyone do everything.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260903001200_strict_rls.sql`:

```sql
-- Supersedes 017_open_access_for_now.sql. Tier A is readable by members or
-- by anyone when the owning team is public; Tier B is members-only with no
-- public branch at all -- a policy that cannot express a leak cannot be
-- misconfigured into one. Writes are member-tier everywhere, with a
-- with check on update as well as insert, which is what stops a row being
-- moved between teams in either direction.

do $$
declare
  t text;
  tier_a text[] := array[
    'teams', 'seasons', 'players', 'games', 'game_events',
    'season_players', 'game_lineups', 'game_lineup_groups',
    'game_attendance', 'league_teams', 'league_games'
  ];
  tier_b text[] := array[
    'strategy_plays', 'strategy_steps', 'strategy_positions',
    'strategy_opponent_markers', 'strategy_arrows', 'strategy_text_boxes',
    'chat_logs', 'calendar_sources', 'jam_sync_conflicts', 'player_private'
  ];
  read_clause text;
begin
  foreach t in array (tier_a || tier_b)
  loop
    if to_regclass('public.' || t) is null then
      raise notice 'skipping missing table: %', t;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', t);

    -- Drop 017's permissive set and 016's membership set alike.
    execute format('drop policy if exists "authenticated read" on public.%I', t);
    execute format('drop policy if exists "authenticated insert" on public.%I', t);
    execute format('drop policy if exists "authenticated update" on public.%I', t);
    execute format('drop policy if exists "authenticated delete" on public.%I', t);
    execute format('drop policy if exists "org member or public read" on public.%I', t);
    execute format('drop policy if exists "org member insert" on public.%I', t);
    execute format('drop policy if exists "org member update" on public.%I', t);
    execute format('drop policy if exists "org member delete" on public.%I', t);
    execute format('drop policy if exists "member read" on public.%I', t);
    execute format('drop policy if exists "member insert" on public.%I', t);
    execute format('drop policy if exists "member update" on public.%I', t);
    execute format('drop policy if exists "member delete" on public.%I', t);

    if t = any (tier_a) then
      read_clause := 'organization_id = any ((select public.my_member_team_ids()))
                      or organization_id = any ((select public.public_team_ids()))';
    else
      read_clause := 'organization_id = any ((select public.my_member_team_ids()))';
    end if;

    execute format(
      'create policy "member read" on public.%I for select to authenticated using (%s)',
      t, read_clause
    );
    execute format(
      'create policy "member insert" on public.%I for insert to authenticated
         with check (organization_id = any ((select public.my_member_team_ids())))',
      t
    );
    execute format(
      'create policy "member update" on public.%I for update to authenticated
         using      (organization_id = any ((select public.my_member_team_ids())))
         with check (organization_id = any ((select public.my_member_team_ids())))',
      t
    );
    execute format(
      'create policy "member delete" on public.%I for delete to authenticated
         using (organization_id = any ((select public.my_member_team_ids())))',
      t
    );

    execute format('revoke all on public.%I from anon', t);
  end loop;
end
$$;

-- The tenant table itself. Narrower than 017's `using (true)`: a private
-- team's existence and name stop being visible to non-members. Insert is
-- denied outright -- teams come from create_team(), which is what lets
-- team_members carry no self-insert policy.
drop policy if exists "authenticated read" on public.organizations;
drop policy if exists "member or public read" on public.organizations;
drop policy if exists "any signed-in insert" on public.organizations;
drop policy if exists "owner update" on public.organizations;
drop policy if exists "owner delete" on public.organizations;

create policy "member or public read" on public.organizations
  for select to authenticated
  using (id = any ((select public.my_member_team_ids()))
         or id = any ((select public.public_team_ids())));

create policy "manager update" on public.organizations
  for update to authenticated
  using      (id = any ((select public.my_manage_team_ids())))
  with check (id = any ((select public.my_manage_team_ids())));

create policy "captain delete" on public.organizations
  for delete to authenticated
  using (id = any ((select public.my_captain_team_ids())));

revoke insert on public.organizations from authenticated;
revoke all on public.organizations from anon;

-- event_types is global reference data with no organization_id. Writable by
-- any non-guest who belongs to a team; guests denied.
do $$
declare p text;
begin
  foreach p in array array['org member insert', 'org member update', 'org member delete']
  loop
    execute format('drop policy if exists %L on public.event_types', p);
  end loop;
end
$$;

create policy "team member insert" on public.event_types
  for insert to authenticated
  with check (array_length(public.my_member_team_ids(), 1) > 0);

create policy "team member update" on public.event_types
  for update to authenticated
  using      (array_length(public.my_member_team_ids(), 1) > 0)
  with check (array_length(public.my_member_team_ids(), 1) > 0);
```

- [ ] **Step 4: Run the tests**

```bash
npm run db:reset && npm run db:test
```

Expected: all ten `11_domain_rls` assertions PASS, **and the Task 3 RLS
canary now passes** — an outsider finally sees no rows from another org.

- [ ] **Step 5: Remove the expected-failure note**

In `supabase/tests/00_meta.test.sql`, delete the two-line
`-- EXPECTED TO FAIL until Task 14 ...` comment. The canary is now a
permanent regression guard.

- [ ] **Step 6: Confirm policy performance**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" <<'SQL'
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from auth.users where email='member@local.test'),
                    'email','member@local.test','role','authenticated',
                    'is_anonymous',false)::text, false);
explain (analyze, buffers) select * from public.game_events where organization_id = 1;
SQL
```

Expected: the helper call appears as an **InitPlan** evaluated once, not a
per-row `SubPlan`, and the scan uses `game_events_organization_id_idx`.
If you see a SubPlan, a policy is missing its `(select ...)` wrapper.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260903001200_strict_rls.sql supabase/tests/11_domain_rls.test.sql supabase/tests/00_meta.test.sql
git commit -m "Replace open-access RLS with strict role-based policies"
```

---

### Task 15: Storage policies for player and team photos

**Files:**
- Create: `supabase/migrations/20260903001300_storage_policies.sql`
- Create: `supabase/tests/12_storage.test.sql`

**Interfaces:**
- Produces: policies on `storage.objects` for buckets `player-photos` and
  `team-photos`, keyed on a `{team_id}/...` first path segment.

016 left `player-photos` writable by a member of *any* organization, because
the bucket had no path convention tying an object to a team. Adding the
convention is what makes a team-scoped policy expressible.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/12_storage.test.sql`:

```sql
begin;
select plan(3);

select tests.login_as('member@local.test');
select lives_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     values ('player-photos', '1/103.jpg', (select auth.uid())) $$,
  'a member can upload a photo under their own team prefix'
);
select throws_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     values ('player-photos', '2/104.jpg', (select auth.uid())) $$,
  '42501',
  null,
  'a member cannot upload under another team prefix'
);

select tests.login_as_guest();
select throws_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     values ('player-photos', '2/104.jpg', (select auth.uid())) $$,
  '42501',
  null,
  'a guest cannot upload at all'
);

select tests.logout();
select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run db:test
```

Expected: FAIL — the cross-team upload succeeds under 016's any-member
policy.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260903001300_storage_policies.sql`:

```sql
insert into storage.buckets (id, name, public)
values ('player-photos', 'player-photos', true),
       ('team-photos',   'team-photos',   true)
on conflict (id) do nothing;

-- Path convention: the first segment is the owning team id, which is what
-- makes a team-scoped policy expressible at all.
create or replace function public.storage_path_team_id(p_name text)
returns bigint
language sql
immutable
as $$
  select case
    when split_part(p_name, '/', 1) ~ '^[0-9]+$'
      then split_part(p_name, '/', 1)::bigint
    else null
  end;
$$;

do $$
declare p text;
begin
  foreach p in array array[
    'allowlisted insert player photos', 'allowlisted update player photos',
    'allowlisted delete player photos', 'org member insert player photos',
    'org member update player photos',  'org member delete player photos'
  ]
  loop
    execute format('drop policy if exists %L on storage.objects', p);
  end loop;
end
$$;

create policy "team member write player photos" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'player-photos'
    and public.storage_path_team_id(name) = any ((select public.my_member_team_ids()))
  );

create policy "team member update player photos" on storage.objects
  for update to authenticated
  using      (bucket_id = 'player-photos'
              and public.storage_path_team_id(name) = any ((select public.my_member_team_ids())))
  with check (bucket_id = 'player-photos'
              and public.storage_path_team_id(name) = any ((select public.my_member_team_ids())));

create policy "team member delete player photos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'player-photos'
         and public.storage_path_team_id(name) = any ((select public.my_member_team_ids())));

-- Team photos are team identity, so manage-tier rather than member-tier.
create policy "manager write team photos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'team-photos'
              and public.storage_path_team_id(name) = any ((select public.my_manage_team_ids())));

create policy "manager update team photos" on storage.objects
  for update to authenticated
  using      (bucket_id = 'team-photos'
              and public.storage_path_team_id(name) = any ((select public.my_manage_team_ids())))
  with check (bucket_id = 'team-photos'
              and public.storage_path_team_id(name) = any ((select public.my_manage_team_ids())));

create policy "manager delete team photos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'team-photos'
         and public.storage_path_team_id(name) = any ((select public.my_manage_team_ids())));
```

- [ ] **Step 4: Run the tests**

```bash
npm run db:reset && npm run db:test
```

Expected: all three `12_storage` assertions PASS.

- [ ] **Step 5: Note the upload-path change for Plan 3**

```bash
grep -rn "player-photos" frontend gateway server --include=*.ts --include=*.tsx | grep -v node_modules
```

Existing uploads use a flat object name. Plan 3 changes the client to write
`{team_id}/{player_id}.<ext>`. Record the hits in the commit message; do not
edit the frontend here.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260903001300_storage_policies.sql supabase/tests/12_storage.test.sql
git commit -m "Scope photo storage policies to the owning team"
```

---

### Task 16: The named escalation suite

**Files:**
- Create: `supabase/tests/13_escalation.test.sql`

**Interfaces:**
- Consumes: everything built in Tasks 4-15. Adds no schema.

Every row of the spec's escalation-vector table becomes a test that must
fail loudly. A suite that only proves people can do things proves nothing
about security.

- [ ] **Step 1: Write the suite**

Create `supabase/tests/13_escalation.test.sql`:

```sql
begin;
select plan(9);

-- 1. Self-promotion through the table.
select tests.login_as('member@local.test');
select throws_ok(
  $$ update public.team_members set role = 'captain' where user_id = (select auth.uid()) $$,
  '42501', null,
  'ESCALATION: member cannot UPDATE their own role to captain'
);

-- 2. Self-insertion of a membership row.
select throws_ok(
  $$ insert into public.team_members (team_id, user_id, role)
     values (2, (select auth.uid()), 'member') $$,
  '42501', null,
  'ESCALATION: member cannot INSERT themselves into another team'
);

-- 3. Self-promotion through the RPC.
select throws_ok(
  format($$ select public.set_member_role(1, %L::uuid, 'captain') $$, (select auth.uid())),
  'P0001', 'only a captain can change roles',
  'ESCALATION: member cannot promote themselves via RPC'
);

-- 4. Editors cannot widen their own grant.
select tests.login_as('editor@local.test');
select throws_ok(
  $$ select public.invite_member(1, 'newedit@local.test', 'editor') $$,
  'P0001', 'only a captain can grant the editor role',
  'ESCALATION: editor cannot mint another editor'
);

-- 5. Cross-tenant row movement, both directions.
select tests.login_as('member@local.test');
select throws_ok(
  $$ update public.game_events set organization_id = 2 where organization_id = 1 $$,
  '42501', null,
  'ESCALATION: member cannot move their team''s rows into another team'
);
select is_empty(
  $$ select id from public.game_events where organization_id = 2 $$,
  'ESCALATION: member cannot even see another team''s rows to move them'
);

-- 6. Guests write nothing, anywhere.
select tests.login_as_guest();
select throws_ok(
  $$ insert into public.players (first_name, organization_id) values ('Ghost', 2) $$,
  '42501', null,
  'ESCALATION: guest cannot insert into a public team'
);

-- 7. Guests cannot enumerate rosters.
select is_empty(
  $$ select id from public.team_members $$,
  'ESCALATION: guest cannot enumerate any team roster'
);

-- 8. The last captain is immovable.
select tests.login_as('captain@local.test');
select throws_ok(
  format($$ select public.remove_member(1, %L::uuid) $$, (select auth.uid())),
  'P0001', 'team 1 must have at least one captain',
  'ESCALATION: the last captain cannot leave and orphan the team'
);

select tests.logout();
select * from finish();
rollback;
```

- [ ] **Step 2: Run the suite**

```bash
npm run db:reset && npm run db:test
```

Expected: all nine PASS. **If any assertion fails, stop.** A failure here is
a live escalation path, not a test bug — fix the policy or RPC it names
before continuing.

- [ ] **Step 3: Commit**

```bash
git add supabase/tests/13_escalation.test.sql
git commit -m "Add named escalation-vector test suite"
```

---

### Task 17: Production backfill migration

**Files:**
- Create: `supabase/migrations/20260903001400_backfill_memberships.sql`
- Create: `supabase/tests/14_backfill.test.sql`

**Interfaces:**
- Produces: `public.backfill_team_memberships() returns void`, invoked once
  by the migration itself and re-runnable (idempotent).

Audited production state, 2026-09-03: one organization (`id 1`, "My Team",
private), 11 memberships, 11 auth users. `eric@venn.ca` and
`errriccccccccc@gmail.com` are members with no account;
`scruffy.selling@gmail.com` and `riceboxrandompurchases@gmail.com` hold
accounts with no membership. Target end state: 10 members (captain
included) and 3 pending invites.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/14_backfill.test.sql`. It builds a fixture matching
the audited production shape, runs the backfill, and asserts the outcome.

```sql
begin;
select plan(6);

-- Fixture: an org in the pre-migration shape, mirroring production.
insert into public.organizations (id, name, is_public) overriding system value
values (900, 'My Team', false);

insert into public.organization_members (organization_id, email, role)
values (900, 'captain@local.test',  'owner'),     -- has an account
       (900, 'member@local.test',   'member'),    -- has an account
       (900, 'ghost@local.test',    'member');    -- no account anywhere

select public.backfill_team_memberships();

select is(
  (select role from public.team_members
    where team_id = 900
      and user_id = (select id from auth.users where email = 'captain@local.test')),
  'captain',
  'owner is carried over as captain'
);
select is(
  (select role from public.team_members
    where team_id = 900
      and user_id = (select id from auth.users where email = 'member@local.test')),
  'member',
  'member role is preserved'
);
select is(
  (select count(*)::int from public.team_invites
    where team_id = 900 and email = 'ghost@local.test' and accepted_at is null),
  1,
  'a member with no account becomes a pending invite, never a deletion'
);
select is(
  (select (expires_at - created_at) > interval '60 days' from public.team_invites
    where team_id = 900 and email = 'ghost@local.test'),
  true,
  'backfill invites get the longer 90-day expiry'
);
select is(
  (select count(*)::int from public.team_members where team_id = 900),
  2,
  'no membership row was invented for an accountless email'
);

-- Idempotence: re-running must not duplicate anything.
select public.backfill_team_memberships();
select is(
  (select count(*)::int from public.team_members where team_id = 900),
  2,
  'the backfill is safely re-runnable'
);

select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run db:test
```

Expected: FAIL — `function public.backfill_team_memberships() does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260903001400_backfill_memberships.sql`:

```sql
-- Converts the email-keyed organization_members model to uid-keyed
-- team_members. A member whose email has no account becomes a pending
-- invite rather than a deletion: cutover must not silently revoke access
-- from someone who was merely slow to sign up.
create or replace function public.backfill_team_memberships()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.team_members (team_id, user_id, role)
  select om.organization_id,
         u.id,
         case om.role when 'owner' then 'captain' else 'member' end
    from public.organization_members om
    join auth.users u on lower(u.email) = om.email
  on conflict (team_id, user_id) do nothing;

  insert into public.team_invites (team_id, email, role, invited_by, expires_at)
  select om.organization_id,
         om.email,
         case om.role when 'owner' then 'editor' else 'member' end,
         null,
         now() + interval '90 days'
    from public.organization_members om
   where not exists (select 1 from auth.users u where lower(u.email) = om.email)
  on conflict (team_id, email) where accepted_at is null do nothing;
end;
$$;

revoke all on function public.backfill_team_memberships() from public, anon, authenticated;

select public.backfill_team_memberships();
```

An accountless `owner` becomes an `editor` invite rather than a `captain`
one because the schema forbids captain invites outright. Production's one
such row (`eric@venn.ca`) is handled explicitly in Step 4 instead.

- [ ] **Step 4: Write the production cutover script**

Create `scripts/cutover-production.mjs`. This runs **once**, against
production, at deploy time — not from a migration, because it needs the auth
admin API to create an account.

```js
// One-shot production cutover. Run AFTER migrations are applied.
//   node --env-file=.env scripts/cutover-production.mjs
// Idempotent: safe to re-run.
import { createClient } from '@supabase/supabase-js'

const CAPTAIN_EMAIL = 'eric@venn.ca'
const TEAM_ID = 1
const TEAM_NAME = 'Disc-iples'
const INVITE_EMAILS = ['scruffy.selling@gmail.com', 'riceboxrandompurchases@gmail.com']

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY)

// 1. eric@venn.ca was hardcoded as owner in migration 016 but has no
//    account, so uid-keyed membership has nothing to point at. Creating
//    the account is also the stronger posture: an address that already
//    exists cannot be signed up by someone else to claim the captaincy.
const { data: existing } = await db.auth.admin.listUsers({ perPage: 1000 })
let captain = existing.users.find(u => u.email?.toLowerCase() === CAPTAIN_EMAIL)
if (!captain) {
  const { data, error } = await db.auth.admin.createUser({
    email: CAPTAIN_EMAIL,
    email_confirm: true,
  })
  if (error) throw new Error(`createUser: ${error.message}`)
  captain = data.user
  console.log(`created captain account ${CAPTAIN_EMAIL} -> ${captain.id}`)
} else {
  console.log(`captain account already exists -> ${captain.id}`)
}

// 2. Captain row, and the rename.
const { error: memberErr } = await db.from('team_members')
  .upsert({ team_id: TEAM_ID, user_id: captain.id, role: 'captain' },
          { onConflict: 'team_id,user_id' })
if (memberErr) throw new Error(`team_members: ${memberErr.message}`)

const { error: nameErr } = await db.from('organizations')
  .update({ name: TEAM_NAME }).eq('id', TEAM_ID)
if (nameErr) throw new Error(`rename: ${nameErr.message}`)
console.log(`team ${TEAM_ID} renamed to ${TEAM_NAME}, captain assigned`)

// 3. Accounts that hold no membership keep the access they have under 017,
//    as a pending invite rather than an abrupt cut.
for (const email of INVITE_EMAILS) {
  const { error } = await db.from('team_invites').upsert({
    team_id: TEAM_ID,
    email,
    role: 'member',
    invited_by: null,
    expires_at: new Date(Date.now() + 90 * 864e5).toISOString(),
  }, { onConflict: 'team_id,email' })
  if (error) throw new Error(`invite ${email}: ${error.message}`)
  console.log(`pending invite created for ${email}`)
}

// 4. Report, so the operator can eyeball the end state.
const { data: members } = await db.from('team_members').select('role').eq('team_id', TEAM_ID)
const { data: invites } = await db.from('team_invites')
  .select('email').eq('team_id', TEAM_ID).is('accepted_at', null)
console.log(`\nfinal state: ${members.length} members, ${invites.length} pending invites`)
console.log('expected:    10 members, 3 pending invites')
```

- [ ] **Step 5: Run the tests**

```bash
npm run db:reset && npm run db:test
```

Expected: all six `14_backfill` assertions PASS, and every earlier suite
still passes.

- [ ] **Step 6: Rehearse the cutover locally**

```bash
node --env-file=.env.local scripts/cutover-production.mjs
```

Expected: it creates the account, assigns the captain, renames the team, and
prints a final-state line. Run it a second time and confirm it reports the
same numbers — idempotence is what makes it safe to re-run after a partial
failure. **Do not run this against production during this plan.** It runs at
deploy time, after Plans 2 and 3 have landed.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260903001400_backfill_memberships.sql supabase/tests/14_backfill.test.sql scripts/cutover-production.mjs
git commit -m "Add membership backfill migration and production cutover script"
```

---

### Task 18: Freeze the legacy migration directory and document the flow

**Files:**
- Create: `supabase-migrations/README.md`
- Modify: `.claude/skills/supabase-migration/SKILL.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Freeze the legacy directory**

Create `supabase-migrations/README.md`:

```markdown
# Frozen migration history (001-027)

These files are the historical record of schema changes applied by hand
through the Supabase SQL editor. **Do not add files here.**

They are not replayable: `game_attendance` and `chat_logs` were created
ad hoc in the live database and have no `create table` in this directory,
so replaying these files produces a database that differs from production.

New migrations live in `supabase/migrations/` and are applied with the
Supabase CLI. The baseline there (`00000000000000_baseline.sql`) is a
schema dump of production taken 2026-09-03, which is the only accurate
starting point.

See `docs/superpowers/specs/2026-09-03-team-permissions-design.md`.
```

- [ ] **Step 2: Update the migration skill**

In `.claude/skills/supabase-migration/SKILL.md`, replace the instruction to
add numbered files under `supabase-migrations/` with the CLI flow:

```markdown
Create the migration:      supabase migration new <name>
Apply locally and test:    npm run db:reset && npm run db:test
Apply to production:       supabase db push --db-url "$DATABASE_URL"
```

Keep every other section. Add a line stating that `supabase-migrations/` is
frozen history and that `supabase-schema.sql` is superseded by the baseline.

- [ ] **Step 3: Update CLAUDE.md**

Add to the "New-environment setup" section:

```markdown
5. Local database: `npm run db:start` (needs Docker), then `npm run db:reset`
   to load the baseline plus seed data and test identities. `npm run db:test`
   runs the pgTAP permission suite. Copy `.env.local.example` to `.env.local`
   and fill in the keys printed by `supabase status`.
```

- [ ] **Step 4: Verify the whole suite one final time**

```bash
npm run db:reset && npm run db:test
```

Expected: every assertion in all 14 test files passes. Record the total
count in the commit message.

- [ ] **Step 5: Commit**

```bash
git add supabase-migrations/README.md .claude/skills/supabase-migration/SKILL.md CLAUDE.md
git commit -m "Freeze legacy migration directory, document local database flow"
```

---

## Done when

- `npm run db:reset && npm run db:test` passes every assertion, including
  the RLS canary and all nine escalation tests.
- No table in `public` lacks RLS or policies (except `standings`, which is
  deliberately inaccessible).
- No `security definer` function in `public` is executable by `anon`, and
  every one pins `search_path`.
- `authenticated` holds no INSERT, UPDATE, or DELETE privilege on
  `team_members`, `team_invites`, or `player_links`.
- The application still points at production and is unchanged. **The app
  will not work against the strict local database until Plans 2 and 3
  land** — that is expected, and is why the cutover script is not run here.

## Next

`docs/superpowers/plans/2026-09-03-team-permissions-2-gateway.md`
