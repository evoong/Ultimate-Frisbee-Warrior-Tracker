# Team permissions, personal stats, and guest access: design

## Summary

Replace the soft-launch open-access model (`017_open_access_for_now.sql`,
under which every signed-in user can read and write every organization's
data) with a real role-based permission model enforced in Postgres RLS:

- **Teams** are the existing `organizations` tenant, renamed. A team has
  **captains**, **editors**, and **members**.
- **Members** read everything on their team and record game data. **Editors**
  additionally change team settings (name, photo, public/private) and invite
  members. **Captains** additionally grant roles and delete the team.
- **Guests** sign in anonymously and get read-only access to teams that have
  opted in to being public — schedule, league, games, roster and stats, but
  never strategy, chat, or player contact details.
- **Personal stats**: a user account links to a `players` row, so every
  existing stat query can be filtered to "me", across every team the user
  belongs to.

The design goal that drives every decision below: **a user must have no code
path by which to increase their own permissions.** Not a check that says no —
no path at all.

Development and verification happen against a local Supabase instance seeded
with a user in every role, before any of it reaches production.

## Goals

- One enforcement boundary: Postgres RLS. The gateway gains no authorization
  logic it can disagree with.
- Membership can only ever originate from someone who already has the power
  to grant it.
- Guests are structurally incapable of writing, not merely denied.
- Player contact details are unreadable by guests by policy, not by the
  frontend declining to ask for them.
- No model-visible text can widen a request's authority: the AI chat holds a
  service-role key, and prompt injection must not be able to steer it at
  another team's data.
- Every stat surface that exists today keeps working, filtered by permission.
- A future migration that adds a table without policies fails the test suite.

## Non-goals (deliberately out of scope)

- **Per-permission capability flags.** Three fixed roles cover the stated
  need; per-member toggles multiply the RLS surface for no current use case.
- **Multiple teams inside one club.** A team is the tenant. If a club later
  needs several teams with different captains, that is a new layer added
  above this one, not a change to it.
- **Join codes / shareable invite links.** Email invites only. A code is a
  bearer secret that survives forwarding, and needs expiry, revocation and
  rate limiting to be safe. Can be added later on top of `team_invites`.
- **Approval workflow for guests requesting access.** Guests sign up or stay
  guests.
- **Migrating historical data between teams.** Out of scope entirely.

## Current state

Facts established by reading the repo, which the design depends on:

- `organizations` (migration 016) is already the tenant boundary, with
  `owner`/`member` roles. Every domain table carries `organization_id`.
- `teams` already means something else: a squad *name* for a season or league
  ("Disc-iples", "Jogging Dead"), not a group of people.
- **`017_open_access_for_now.sql` relaxed every domain table** to
  `for select/insert/update/delete to authenticated using (true)`. The
  frontend mirrors this with `allowed = user != null` in `AuthContext.tsx`.
- Membership checks key on `auth.jwt() ->> 'email'` — a mutable claim.
- `AuthContext.joinOrganization()` lets any signed-in user insert themselves
  into any organization, permitted by 016's `or email = auth.jwt()->>'email'`
  insert policy. This is the escalation path the feature closes.
- **No index exists on `organization_id` on any of the ~20 domain tables.**
  Irrelevant under `using (true)`; load-bearing under strict RLS.
- The browser holds no Supabase key. All PostgREST traffic goes through the
  gateway `/db/*` proxy, which injects the user's JWT from httpOnly cookies
  and strips client-supplied `apikey`/`authorization` headers. **RLS is
  therefore already the only boundary** between a user and the data.
- **Except**: `/api/chat`, `/api/chat/history`, chat function-calling game
  actions, `/api/schedule/sync-jam`, and both MCP servers run with
  `SUPABASE_SECRET_KEY`, which bypasses RLS. They take `organization_id`
  from the request and check it with stubs that `return true`.
- `players` rows have no link to any auth user. Stats derive from
  `game_events.player_id`.
- Migration 016 notes that `game_attendance` and `chat_logs` "have no tracked
  `create table` anywhere in this repo (created ad hoc in the live DB)" —
  so replaying `supabase-migrations/` does not reproduce production.

## Terminology and the rename

| Today | After | Meaning |
|---|---|---|
| `organizations` | `teams` | The group of people. Owns all data. |
| `organization_members` | `team_members` | Who is on the team, and their role. |
| `organization_id` | `team_id` | Tenant column on ~20 domain tables. |
| `teams` | `squads` | A season's squad name. |

"organization" appears 426 times across 26 source files. Performing the
rename in the same commits as the policy work would bury a security review
under mechanical churn, so **the security model ships first under the
existing names, and the rename lands afterward as its own purely mechanical
PR** (phase 6). This document uses the final names when describing new
objects and the current names when describing existing ones.

## Local Supabase instance

`supabase init` creates `supabase/config.toml`. The instance requires Docker
(present and running) and Supabase CLI 2.67.1 (installed).

**The baseline comes from production, not from `supabase-migrations/`:**

```
supabase db dump --db-url "$DATABASE_URL" -f supabase/migrations/00000000000000_baseline.sql
supabase start
```

Replaying the 27 tracked migration files would produce a database missing
`game_attendance` and `chat_logs` (see Current state). A local database that
differs from production is a local database that lies about what will happen
on deploy.

`supabase-migrations/001..027` is frozen as the historical record with a
README pointer. From phase 1 onward, migrations are authored as Supabase CLI
migrations under `supabase/migrations/`. The repo's `supabase-migration`
skill documents the superseded flow and is updated in the same PR.

**`config.toml`**: `enable_anonymous_sign_ins = true`, email confirmation
disabled locally, `site_url = http://localhost:5199`.

**Seed data is synthetic, never a production dump.** Production `players`
rows carry real phone numbers, which do not belong in a dev container.
`supabase/seed.sql` builds two teams — one public, one private — each with a
roster, a season, games, and enough `game_events` for the stats pages to
render. `scripts/seed-local-users.ts` creates six identities through the
local auth admin API:

| Identity | Role |
|---|---|
| `captain@local.test` | captain of team A |
| `editor@local.test` | editor of team A |
| `member@local.test` | member of team A, linked to a player |
| `unlinked@local.test` | member of team A, no player link |
| `outsider@local.test` | captain of team B |
| (anonymous) | guest, no membership |

New npm scripts: `db:start`, `db:reset` (reset + seed), `db:test`.
Local env points the gateway at `http://127.0.0.1:54321` with keys read from
`supabase status -o json`.

## Data model

### New and changed tables

**`team_members`** (replaces `organization_members`)

```sql
create table public.team_members (
  id          bigint generated by default as identity primary key,
  team_id     bigint not null references public.teams(id) on delete cascade,
  user_id     uuid   not null references auth.users(id) on delete cascade,
  role        text   not null default 'member'
                     check (role in ('captain', 'editor', 'member')),
  created_at  timestamptz not null default now(),
  invited_by  uuid references auth.users(id),
  unique (team_id, user_id)
);
```

Keyed on `user_id`, not email. Email is a mutable claim; a user id is not.
Email remains as display data fetched from the session, and as the addressing
mechanism for invites only.

**`team_invites`**

```sql
create table public.team_invites (
  id           bigint generated by default as identity primary key,
  team_id      bigint not null references public.teams(id) on delete cascade,
  email        text   not null check (email = lower(email)),
  role         text   not null default 'member'
                      check (role in ('editor', 'member')),
  invited_by   uuid   references auth.users(id),   -- null: created by migration
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '30 days',
  accepted_at  timestamptz,
  accepted_by  uuid references auth.users(id)
);

create unique index team_invites_pending_unique
  on public.team_invites (team_id, email) where accepted_at is null;
```

The `role` check excludes `'captain'` at the schema level: captaincy is
granted only by promoting an existing member, never by invitation.

**`player_links`** — what makes personal stats work.

```sql
create table public.player_links (
  id          bigint generated by default as identity primary key,
  team_id     bigint not null references public.teams(id) on delete cascade,
  player_id   integer not null references public.players(id) on delete cascade,
  user_id     uuid   not null references auth.users(id) on delete cascade,
  status      text   not null default 'pending'
                     check (status in ('pending', 'approved')),
  created_at  timestamptz not null default now(),
  unique (player_id),
  unique (team_id, user_id)
);
```

`unique (player_id)` — one account per roster spot. `unique (team_id,
user_id)` — one roster spot per account per team. A user may be linked in
several teams; "My Stats" spans all of them.

**Links never grant permission.** No policy anywhere reads `player_links`.
It answers "whose stats are these", never "what may this person do". This is
why a self-claim is low-risk even before approval.

**`player_private`** — PII split out of `players`.

```sql
create table public.player_private (
  player_id        integer primary key references public.players(id) on delete cascade,
  team_id          bigint  not null references public.teams(id) on delete cascade,
  phone            text,
  first_name_edit  text,
  last_name_edit   text
);
```

Columns are moved off `players` and dropped there. Rationale: Supabase
anonymous users are the same Postgres role (`authenticated`) as real users,
distinguished only by the `is_anonymous` JWT claim — so column-level `GRANT`
cannot hide a column from guests. Sensitive data in a separate row with its
own policy is enforceable; a hidden column is not.

**`teams` (`organizations`)** gains `photo_url text`.

### Integrity

A trigger keeps every team at **at least one captain**; demoting or removing
the last captain raises. A captain-less team is an escalation vector, because
"this team has no captain" invites a recovery path an attacker can aim at.

### Indexes

`team_members(user_id)`, `team_members(team_id, role)`,
`player_links(user_id)`, `team_invites(team_id, email) where accepted_at is
null`, and `organization_id` on all ~20 domain tables.

## Permission model

### Role matrix

| | captain | editor | member | guest |
|---|:---:|:---:|:---:|:---:|
| Read team data | yes | yes | yes | public teams only |
| Read strategy, chat, player phones | yes | yes | yes | no |
| Record games, events, lineups, strategy | yes | yes | yes | no |
| Team name, photo, public/private | yes | yes | no | no |
| Invite / remove members | yes | yes (member only) | no | no |
| Grant editor or captain | yes | no | no | no |
| Delete team | yes | no | no | no |

An editor can invite members but cannot mint another editor. Only a captain
grants power at or above their own level; otherwise one editor becomes an
editor factory and the captain's grant means less than they intended.

### RLS mechanics

Four `security definer`, `set search_path = ''` functions return the caller's
team ids as arrays:

```sql
create or replace function public.my_member_team_ids()
returns bigint[]
language sql stable security definer set search_path = ''
as $$
  select case
    when coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then '{}'::bigint[]
    else coalesce((
      select array_agg(team_id) from public.team_members
      where user_id = (select auth.uid())
    ), '{}'::bigint[])
  end;
$$;

revoke all on function public.my_member_team_ids() from public, anon;
grant execute on function public.my_member_team_ids() to authenticated;
```

Alongside it: `my_manage_team_ids()` (captain or editor),
`my_captain_team_ids()` (captain), and `public_team_ids()`
(`teams.is_public`).

Policies use them as:

```sql
using (organization_id = any ((select public.my_member_team_ids())))
```

The `(select ...)` wrapper matters for performance: Postgres evaluates it
once per query as an InitPlan rather than once per row. Combined with the new
`organization_id` indexes, strict RLS costs approximately nothing.

Every membership function returns an **empty array for anonymous callers**,
so a guest cannot match any row — before any explicit guest check runs.

### Read tiers

**Tier A** — readable by members, *or* by anyone when the team is public:
`squads`, `seasons`, `games`, `game_events`, `players`, `season_players`,
`game_lineups`, `game_lineup_groups`, `game_attendance`, `league_teams`,
`league_games`.

```sql
using (
  organization_id = any ((select public.my_member_team_ids()))
  or organization_id = any ((select public.public_team_ids()))
)
```

**Tier B** — members only, **with no public branch at all**: every
`strategy_*` table, `chat_logs`, `calendar_sources`, `jam_sync_conflicts`,
`player_private`, `player_links`, `team_members`, `team_invites`.

```sql
using (organization_id = any ((select public.my_member_team_ids())))
```

Not a public branch that evaluates to false — no branch. A policy that cannot
express a leak cannot be misconfigured into one.

### Writes

Every domain table takes member-tier for insert, update and delete, with
`with check` on **both** insert and update:

```sql
create policy "member insert" on public.<t>
  for insert to authenticated
  with check (organization_id = any ((select public.my_member_team_ids())));

create policy "member update" on public.<t>
  for update to authenticated
  using       (organization_id = any ((select public.my_member_team_ids())))
  with check  (organization_id = any ((select public.my_member_team_ids())));
```

The update `with check` is what stops "move this row into my team" and "move
my row into yours". A `using`-only update policy silently permits both.

`teams` itself is read by members of that team, or by anyone when
`is_public` — the latter is what lets a guest browse the public-teams list
at all. Update requires manage-tier, delete requires captain-tier, and
insert is denied to `authenticated` outright (teams are created by RPC):

```sql
create policy "member or public read" on public.teams
  for select to authenticated
  using (id = any ((select public.my_member_team_ids()))
         or id = any ((select public.public_team_ids())));
```

Note this is strictly narrower than 017's `using (true)`: a private team's
existence and name stop being visible to non-members.

`event_types` is global shared reference data with no `organization_id`;
writes require any non-guest membership, as today, with guests denied.

### The membership tables have no DML grants

```sql
revoke insert, update, delete on public.team_members from authenticated;
revoke insert, update, delete on public.team_invites from authenticated;
revoke insert, update, delete on public.player_links  from authenticated;
```

There is no policy to get wrong because there is no code path. Membership
changes happen only through RPCs. Migration 016 needed its permissive
`or email = auth.jwt()->>'email'` insert policy purely because the client
created a team in two steps — and that clause is exactly how today's open
self-join escalation works. An atomic `create_team` removes the need for it.

### Membership RPCs

All are `security definer`, `set search_path = ''`, revoked from
`public`/`anon`, granted to `authenticated`.

| Function | Caller must be | Notes |
|---|---|---|
| `create_team(name)` | any non-guest | Creates team + caller's captain row atomically |
| `invite_member(team_id, email, role)` | manage-tier | Editors may pass `'member'` only; captains may also pass `'editor'` |
| `revoke_invite(invite_id)` | manage-tier on that invite's team | |
| `accept_invite()` | any non-guest with **confirmed email** | No arguments; matches pending invites to the caller's own verified email |
| `set_member_role(team_id, target_user_id, role)` | captain-tier | Whitelist-checked role; captain trigger enforces >= 1 captain |
| `remove_member(team_id, target_user_id)` | captain-tier; manage-tier only when the target's role is `'member'`; or self (leave) | An editor can never remove a captain or another editor |
| `set_player_link(team_id, player_id, user_id)` | manage-tier | Creates an `approved` link |
| `claim_player(team_id, player_id)` | member-tier | Creates a `pending` link for the caller only |
| `approve_claim(link_id)` | manage-tier | Flips `pending` to `approved` |

Invariants every one of them upholds:

- The caller is derived from `auth.uid()`. **No function accepts a caller
  identity as a parameter.**
- The first statement rejects anonymous JWTs.
- Role values are whitelist-checked, never interpolated.
- Team scope is checked against the specific `team_id` being acted on.

`accept_invite()` requiring a confirmed email is the sharpest of these.
Supabase issues a session for an unverified signup, and an invite keyed on an
email string is a bearer token addressed to whoever claims that string first.
Without the check, an attacker signs up as a captain's email, never confirms
it, and consumes their invite. The function reads
`auth.users.email_confirmed_at` directly, which it can do because it is
`security definer`.

### Escalation vectors and what closes each

| Vector | Closed by |
|---|---|
| Promote self to captain | No UPDATE grant on `team_members`; `set_member_role` is captain-only |
| Insert own membership row | No INSERT grant; membership only via invite acceptance or `create_team` |
| Editor mints editors | Role whitelist per caller tier, plus schema-level check excluding `'captain'` from invites |
| Sign up as someone's email unverified and consume their invite | `accept_invite` requires `email_confirmed_at is not null` |
| Write into another team | `with check` on insert **and** update |
| Move a row between teams | Update policy checks both old row (`using`) and new row (`with check`) |
| Guest writes anything | Empty team arrays **and** explicit anonymous rejection — two independent mechanisms |
| Guest reads a private team | Public read branch requires `teams.is_public` |
| Guest reads strategy, chat, or phone numbers | Tier B has no public branch; PII lives in `player_private` |
| Orphaned captain-less team | At-least-one-captain trigger |
| Photo bucket cross-team writes | Path convention `{team_id}/{player_id}` plus membership check |
| Player links used to gain access | Links are display-only; no policy reads them |
| Service-role paths bypassing all of the above | See next section |

### Storage

`player-photos` is currently writable by any member of any organization.
It moves to a path convention of `{team_id}/{player_id}.<ext>` with policies
checking member-tier on the `team_id` path segment. Team photos live at
`team-photos/{team_id}.<ext>` and require manage-tier.

## Service-key paths

`/api/chat`, `/api/chat/history`, the chat's function-calling game actions,
`/api/schedule/sync-jam`, and both MCP servers run with
`SUPABASE_SECRET_KEY`, which ignores RLS entirely. Airtight policies do
nothing for a request that never passes through them. Today these accept
`organization_id` from the request body or query string and check it with:

```ts
function createIsOrgMember(_env: Env) {
  return async (_email: string, _organizationId: number): Promise<boolean> => true
}
```

So a signed-in user can currently POST `organization_id: 7` and read another
team's roster and stats through the AI chat, and write game events into it
through chat actions. Locking down RLS without fixing this leaves a hole
behind the new wall.

**This phase is not optional and is not descopable.** The chat endpoint is
the one place in the system where untrusted natural-language text meets a
service-role database key. An attacker does not need to find a bug in the
gateway: they can ask the model, in the message body, to fetch or write data
for a different team, and the handler will comply because nothing downstream
checks. That is prompt injection with a credential that ignores every policy
in this document. The fix is that the team is resolved from the session and
the role is verified in the handler, so that no instruction appearing in
model-visible text can widen the request's authority. Model output is treated
as data, never as authorization.

Changes:

- `createIsOrgMember` / `createIsEmailAllowed` in `worker.ts` (and their
  twins in `server/index.ts`) become real `team_members` lookups returning
  the caller's role.
- Every service-key handler resolves the team from the **session**, verifies
  role for the operation, and rejects anonymous JWTs. Chat is Tier B: guests
  receive 403, not a filtered answer.
- Chat write actions (`gateway/gameActions.ts`) require member-tier on the
  specific team.
- `runJamSync` on the cron path has no caller. It stays service-role but is
  scoped to the teams owning the `calendar_sources` rows it processes: a
  background job's authority comes from the row it acts on, not from a user.
- MCP (`gateway/mcpAgent.ts`, `mcp-server/index.ts`): `MCP_ORGANIZATION_ID`
  selects one org per deployment while `this.props.email` "isn't consulted
  for access control yet". It gets consulted — the OAuth-authenticated email
  must map to a `team_members` row for that team, or the tools do not
  register.

## Frontend

**The UI hides what you cannot do; the database decides what you can.** Every
capability check in React is UX only. No policy depends on one.

`AuthContext`'s `allowed = user != null` is replaced by a capability object
derived from per-team role: `isGuest`, `canRecord`, `canManageTeam`,
`canManageRoles`. `/auth/session` returns:

```json
{ "user": {...}, "is_anonymous": false,
  "teams": [{ "id": 1, "name": "...", "role": "captain", "is_public": false }] }
```

| Surface | Change |
|---|---|
| `pages/Login.tsx` | "Continue as guest" posts to a new `/auth/guest`, which calls `signInAnonymously()` and sets the same httpOnly cookies |
| `pages/CreateOrganization.tsx` | Create-team calls the `create_team` RPC. **The "join an existing organization" list is deleted** — that list plus open self-join is the current escalation path. Replaced by pending invites, consumed automatically on login. |
| `components/OrganizationSettingsDialog.tsx` | Team name, photo upload, public toggle (manage-tier). Members tab with roles, invite by email, pending invites, remove. Role dropdown captain-only. |
| `pages/Stats.tsx` | "My Stats" view: `useGetPlayerStats` filtered to the caller's approved link, career and per-season, across every team. Unlinked users are prompted "Which player are you?" -> `claim_player` -> pending until approved. |
| `components/AppSidebar.tsx`, `lib/nav.ts` | Guests: Plays and AI hidden entirely (Tier B); Schedule, Roster, Stats read-only; persistent "browsing as a guest" bar with a sign-up path |
| `hooks/backend/organizations.ts` | Rewritten off direct table writes onto the RPCs |

Guests have no team, so they land on a new lightweight public-teams browser
rather than the team-scoped Schedule page.

## Testing

RLS fails silently — a wrong policy does not throw, it returns rows. The
suite is therefore load-bearing, in three layers.

**1. Policy matrix (pgTAP, `supabase test db`).** The six seeded identities
crossed with every table and all four verbs, asserting both the allow and the
deny. Generated programmatically from a table-to-tier map, so roughly 500
assertions cost about thirty lines. A suite that only proves people can do
things proves nothing about security.

**2. Named escalation tests.** Every row of the vector table above becomes a
test that must fail loudly:

```
member cannot UPDATE own role to captain
member cannot INSERT into team_members
editor cannot invite at role 'editor'
unverified email cannot accept_invite
member cannot UPDATE a row's organization_id to another team
guest cannot INSERT anywhere
guest cannot SELECT strategy_plays, chat_logs, player_private
guest cannot SELECT a private team
last captain cannot be demoted or removed
```

**3. Meta-tests.** One walks `pg_tables` and fails if any table in `public`
lacks RLS or has zero policies. The other walks `pg_proc` and fails if any
`security definer` function is executable by `anon`/`public` or is missing
`search_path`. Migration 016's own comments show tables have been created ad
hoc in the live database before; a new table added without policies should
break the build rather than quietly shipping wide open.

A smaller HTTP suite extending `server.test.mjs` covers what SQL cannot see:
the guest endpoint, service-key handlers rejecting a cross-team
`organization_id`, and the invite -> accept -> membership round trip.

## Rollout

| # | Phase | Contents |
|---|---|---|
| 0 | Local instance | `supabase/` config, production-schema baseline, synthetic seed, test harness. No behavior change. |
| 1 | Schema | `team_members`, `team_invites`, `player_links`, `player_private` split, `photo_url`, indexes, captain trigger, backfill |
| 2 | RPCs | The nine functions, plus `revoke` of all DML on membership tables |
| 3 | Strict RLS | Policies replacing 017 across every table; storage policies |
| 4 | Gateway | Real membership lookups, service-key handlers, `/auth/guest`, MCP membership check |
| 5 | Frontend | Capability model, guest UX, team management, My Stats |
| 6 | Rename | `organizations` -> `teams`, `teams` -> `squads`. Mechanical only. |

### Backfill

`organization_members` rows are matched to `auth.users` by email and written
to `team_members` with `user_id`; `owner` becomes `captain`, `member` stays
`member`. **A row whose email has no account becomes a pending invite, never
a deletion** — otherwise cutover silently revokes access from people who were
merely slow to sign up. Applied to the audited production state below, that
means 9 real memberships, 1 pre-created captain, and 3 pending invites (one
member with no account, plus two accounts with no membership).

### Production cutover

- Enable anonymous sign-ins in the production Supabase project.
- A `pg_cron` job deletes anonymous users older than 30 days so guest
  sessions do not accumulate in `auth.users` indefinitely.
- Ships as a branch and pull request, never a direct push to main.
- The `auth-system` memory and the `supabase-migration` skill both describe
  the model being replaced, and are updated in the same PR.

### Production state at time of writing (audited 2026-09-03)

| | |
|---|---|
| Organizations | **exactly one**: `id 1`, "My Team", private |
| Memberships | 11, all on org 1 (1 `owner`, 10 `member`) |
| Auth users | 11 |
| Members with **no** auth account | `eric@venn.ca`, `errriccccccccc@gmail.com` |
| Auth accounts with **no** membership | `scruffy.selling@gmail.com`, `riceboxrandompurchases@gmail.com` (unconfirmed) |

Because only one organization exists, the captain-less team case does not
arise at cutover. The rule still stands for the future: **a team with no
captain has no self-service adoption path.** "Claim this ownerless team" is
precisely the recovery flow an attacker would aim at; assigning a captain to
an orphaned team is a service-role operation performed deliberately, never a
button.

### Cutover decisions (resolved)

1. **Team 1 is renamed "My Team" -> "Disc-iples"**, and `eric@venn.ca`
   becomes its captain. Note "Disc-iples" is also the name of squad `id 1`;
   the two are different objects in different tables and the collision is
   cosmetic.
2. **`eric@venn.ca` has no auth account**, so the migration creates one
   (admin API, no email sent) and writes the captain row against that uid.
   He claims the account through a password reset at first login. This is
   also the stronger security posture: an existing account means the address
   cannot later be signed up by someone else to claim the captaincy.
3. **`errriccccccccc@gmail.com`** has no account and becomes a pending
   invite at role `member`, preserving the access they have today.
4. **`scruffy.selling@gmail.com` and `riceboxrandompurchases@gmail.com`**
   hold accounts but no membership. Rather than losing access outright, each
   receives a **pending invite at role `member`**, which `accept_invite()`
   consumes at their next login. This preserves what they can do today under
   017 without granting anything new. Two consequences worth stating:

   - `riceboxrandompurchases@gmail.com` has an **unconfirmed** email, so it
     cannot accept until the address is confirmed. That is the invite rule
     working as designed, not a bug to route around.
   - Backfill-created invites get a **90-day expiry** rather than the 30-day
     default, because the recipient is not expecting an email and may not
     log in soon. After expiry a captain re-invites through the normal flow.

   Net effect at cutover: 10 members (including the captain) and 3 pending
   invites.
