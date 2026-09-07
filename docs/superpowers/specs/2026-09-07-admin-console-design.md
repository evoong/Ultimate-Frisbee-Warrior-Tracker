# Admin Console — Sub-project A: Foundation + User & Org Operations

**Status:** design approved 2026-09-07
**Scope:** sub-project A of three (see Future Work for B and C)

## Goal

Give the app owner a first-party admin console at `/admin` that can inspect any
user or organization and perform a fixed catalog of audited, invariant-safe
manual corrections — without weakening any existing RLS policy.

## Why this exists

Every read and write an admin console needs is precisely what this project's
RLS was built to forbid. `strict_rls`, `membership_lockdown`,
`lockdown_standings`, and the revoked default grants are deliberate. The
console therefore cannot be "the app with more permissions"; it needs its own
trust boundary, its own credential path, and its own audit trail.

There is also no platform-level admin concept anywhere in the codebase today —
no `is_admin`, no `app_metadata` role, no superuser row. This spec introduces
the first one.

## Schema facts this design depends on

These were verified against the migrations, not assumed. They are recorded here
because several of them overturned an earlier draft of this design.

1. **The tenant is `organizations`.** `team_members.team_id` is a foreign key to
   `organizations(id)`, not to `teams(id)`. So do `team_invites.team_id`,
   `player_links.team_id`, and `player_private.team_id`. `my_teams()` joins
   `team_members.team_id` to `organizations.id`. "Team" and "organization" name
   the same tenant entity; the newer tables call the column `team_id` and the
   ~26 older tables call it `organization_id`.
2. **`teams` is a secondary grouping**, referenced only by `games.team_id`,
   `seasons.team_id`, and `league_games.team_id`. It is not the tenant.
3. **`organization_members` is legacy.** Its only reader, `my_organizations()`,
   was dropped by `20260903001500_my_teams.sql` in favour of `team_members`.
   Rows may still exist and are stale.
4. **`enforce_last_captain()` is a trigger**, not just RPC logic:
   `team_members_require_captain BEFORE UPDATE OR DELETE ON team_members FOR
   EACH ROW`. It fires on *every* write path, including a service-role write
   that bypasses RLS. It is the only trigger in the schema.
5. **The membership RPCs cannot be called by an admin.** `set_member_role`,
   `remove_member`, `invite_member`, `revoke_invite`, `set_player_link`, and
   `approve_claim` are `security definer` but gate on `auth.uid()` via
   `assert_not_guest()` and `my_captain_team_ids()`. Under the service role
   `auth.uid()` is NULL, so `my_captain_team_ids()` is empty and
   `set_member_role` raises `only a captain can change roles`.
6. **`organizations` cascades widely.** ~26 tables carry a denormalized
   `organization_id` with `ON DELETE CASCADE`, so deleting an organization row
   removes all of its data in one statement.
7. **Ten columns reference `players(id)`** — `game_attendance.player_id`,
   `game_events.player_id`, `game_events.related_player_id`,
   `game_lineups.player_id`, `lineup_template_players.player_id`,
   `season_players.player_id`, `strategy_arrows.start_player_id`,
   `strategy_positions.player_id`, `player_links.player_id`, and
   `player_private.player_id`. Four of those tables carry a unique constraint
   that a naive merge would violate.

### Consequence: no team transfer

An earlier draft included `admin_transfer_team(team_id, org_id)`. It is cut.
Facts 1 and 2 make it incoherent: `players`, `game_events`, `strategy_*`, and
`lineup_templates` are scoped only by `organization_id`, so there is no way to
determine which of them belong to a moved team. Any partial implementation
would leave games referencing players in the old tenant — silent cross-tenant
corruption. If team transfer is ever genuinely needed it requires a schema
change first, and that is its own project.

### Consequence: admin writes go direct, not through the RPCs

Because of fact 5, admin operations write to tables directly with the service
role. Because of fact 4, the invariant that actually matters still holds. What
the RPCs contribute beyond the trigger is *caller authorization*, which the
admin boundary replaces with its own role check, and *input validation*, which
each operation re-implements. This mirrors the pattern `gateway/membership.ts`
already documents: "a deliberate re-implementation of what a policy would have
done automatically."

## Architecture

### Placement

Admin handlers live in `gateway/admin/`, **outside** `createGateway`. The
comment above the chat handler in `worker.ts` states the gateway "only ever
proxies as the caller's own token", and chat lives outside it because it needs
the service role. Admin handlers need the service role too, so placing them
inside `createGateway` would break a documented invariant.

`handleAdminRequest(config, request): Promise<Response | null>` is
framework-agnostic exactly as the gateway is, and is mounted twice:

- `worker.ts`, immediately after the `gateway(request)` call and before
  `ASSETS.fetch`, alongside the chat handler.
- `server/index.ts`, via a node adapter mounted before `express.json()` so the
  handler reads its own request body.

### Path split

- **API: `/api/admin/*`.** Already covered by `worker.ts`'s `isGatewayPath`.
- **SPA route: `/admin/*`.**

These must differ. `worker.ts` serves the SPA fallback only for paths that fail
`isGatewayPath`; if `/admin` were the API prefix, navigating to `/admin/users`
would 404 instead of loading the app.

### Authorization chain

Every request to `/api/admin/*`:

```
csrfViolation(request, url)                  reuse gateway/csrf.ts verbatim
verifyAccessToken(token, jwksUrl, url)       existing, unchanged
  -> SessionClaims { sub, email, isAnonymous }
  -> reject when isAnonymous (a guest is never an admin)
adminLookup.roleFor(claims.sub)              new; mirrors createMembershipLookup
  service-role query against platform_admins
  fail closed: any error or non-2xx yields null, therefore denied
  30s TTL; error results deliberately not cached
  onLookupError -> Sentry, never allowed to affect the deny
hasAtLeastAdmin(role, operation.minRole)     readonly < support < superadmin
```

`/auth/session` gains one field, `admin: 'superadmin' | 'support' | 'readonly'
| null`, used **only** to decide whether the nav link renders. Every
`/api/admin/*` request re-checks server-side; forging the field client-side
yields a menu item and a 403.

Revocation takes effect within the 30s TTL, matching team-role revocation. No
custom JWT claims, no Supabase auth hook, and no edits to existing RLS
policies.

## Data model

Both tables are RLS-enabled with **zero policies** — the `feedback_clusters`
pattern, which is default-deny for every role except the service role.

```sql
create table public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null check (role in ('superadmin','support','readonly')),
  created_at timestamptz not null default now(),
  granted_by uuid references auth.users(id) on delete set null,
  note       text not null default ''
);

create table public.admin_audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  admin_id   uuid not null references auth.users(id) on delete restrict,
  admin_role text not null,
  operation  text not null,
  target     jsonb not null,
  before     jsonb,
  after      jsonb,
  result     text not null check (result in ('ok','denied','error')),
  error      text,
  request_id text
);
```

Four deliberate decisions:

- **`admin_id` is `on delete restrict`.** An audit row must not vanish because
  the admin's account was deleted. `platform_admins` cascades; the log refuses.
- **`admin_role` is denormalized** — the role held *at the time of the action*.
  Demoting an admin later must not rewrite history.
- **`result` includes `'denied'` and `'error'`**, so the log records attempts.
  A denied attempt is the most interesting row in a security log; a
  success-only log is an activity feed.
- **Append-only is enforced by a trigger** that raises on `UPDATE` and
  `DELETE`. Table ownership would otherwise let the service role rewrite
  history.

### Bootstrapping

`scripts/grant-platform-admin.mjs <email> <role>`, run by hand with the service
role. Not a migration: migrations are committed to git and an operator's email
does not belong there.

**The console cannot create or promote admins.** Grants happen only through
that script. A compromised admin session therefore cannot mint more admins.

## The operation catalog

There is no generic row editor. Admin mutations are a fixed catalog of named
operations:

```ts
type AdminRole = 'readonly' | 'support' | 'superadmin'

interface AdminOperation<I> {
  name:    string
  minRole: AdminRole
  input:   ZodType<I>
  target:  (input: I) => Json
  preview: (ctx: AdminCtx, input: I) => Promise<Json>
  apply:   (ctx: AdminCtx, input: I) => Promise<{ before: Json; after: Json }>
}
```

Dispatched as `POST /api/admin/op/:name` with `{ input, mode: 'preview' | 'apply' }`.

Rationale over a table editor:

- A raw `UPDATE team_members SET role=...` from a generic editor cannot be
  constrained; a catalog can only do what a named operation permits, and each
  operation re-implements the validation its RPC counterpart had.
- Auditing a generic editor records SQL. Auditing a catalog records
  `set_member_role`, which is what an operator actually searches for later.
- `minRole` per operation makes the `readonly` role fall out for free.

**The dispatcher writes the audit row, not the operations.** A new operation
therefore cannot forget to log, and `denied` and `error` outcomes are logged by
the same wrapper that logs successes. `preview` never writes data and never
writes an audit row.

### v1 operations

| Operation | minRole | Implementation |
|---|---|---|
| `set_member_role` | support | validate role in (captain, editor, member); `UPDATE team_members` by (team_id, user_id); last-captain trigger enforces |
| `remove_member` | support | `DELETE team_members` by (team_id, user_id); last-captain trigger enforces |
| `invite_member` | support | validate role in (editor, member) — `team_invites.role` forbids `captain`; `INSERT team_invites`; respects `team_invites_pending_unique` |
| `revoke_invite` | support | `DELETE team_invites` where id and `accepted_at is null` |
| `set_player_link` | support | `INSERT ... ON CONFLICT (player_id) DO UPDATE SET user_id`, status `approved`; a violation of `unique (team_id, user_id)` is returned as a 409 naming the player already linked to that user, never silently resolved |
| `approve_player_link` | support | `UPDATE player_links SET status='approved'` |
| `merge_players` | superadmin | `admin_merge_players` RPC |
| `delete_org` | superadmin | `admin_preview_delete_org` then `DELETE organizations`; requires typed-name confirmation |

### v1 read endpoints (`readonly` and above)

- `GET /api/admin/search?q=` — organizations by name, users by email, players by display name
- `GET /api/admin/user/:id` — email, created_at, last_sign_in_at, is_anonymous, memberships with org name and role, player links, pending invites matching the email, feedback report count
- `GET /api/admin/org/:id` — name, is_public, members with emails and roles, `teams` rows, counts of seasons/games/players, pending invites, and any legacy `organization_members` rows flagged as stale
- `GET /api/admin/audit?limit=&cursor=` — audit log page, newest first

### New SQL

Only two operations genuinely need SQL. Both are `security definer` with all
grants revoked from `public`, `anon`, and `authenticated`.

**`admin_preview_delete_org(p_org_id bigint) returns jsonb`** — row counts per
dependent table, so the console can show the blast radius before committing.

**`admin_merge_players(p_keep_id integer, p_merge_id integer) returns jsonb`** —
must be one transaction, which PostgREST cannot express as separate calls.
Refuses when the two players are in different organizations. For each of the
ten referencing columns it repoints `p_merge_id` to `p_keep_id`; where a unique
constraint would be violated (`game_attendance(game_id, player_id)`,
`game_lineups(game_id, player_id, lineup_name)`, `season_players(season_id,
player_id)`, `strategy_positions(step_id, player_id)`, `player_links(player_id)`,
`player_private(player_id)`) the keeper's row wins and the merged player's row
is deleted. Returns a per-table count of rows repointed and rows dropped.

## Frontend

```
frontend/pages/admin/
  AdminLayout.tsx   Search.tsx   UserDetail.tsx   OrgDetail.tsx   AuditLog.tsx
```

- `React.lazy` on the admin route so admin code stays out of the main bundle.
  This is a bundle-size and blast-radius measure, **not** a security boundary —
  enforcement is server-side, always.
- The nav link in `AppSidebar.tsx` renders only when `session.admin` is
  non-null.
- **Every mutation is two-step:** form, then a preview panel showing
  before/after and any cascade counts, then confirm. `delete_org` and
  `merge_players` additionally require typing the organization or player name.
- Reuses `frontend/lib/shadcn`; `OrganizationSettingsDialog.tsx` is the closest
  existing model.
- A persistent banner on every admin page shows the operator's role and
  "actions here are logged".
- `AuditLog.tsx` ships in v1: a log nobody can read is not yet doing its job.

## Error handling

- `onLookupError` reports to Sentry, exactly as `createMembershipLookup` does,
  and never affects the fail-closed deny.
- Operation failures return a generic message to the client and log the detail
  against the `request_id` that also lands in the audit row, so a console error
  can be correlated with Sentry and the Worker log.
- A lookup failure is never cached, so a transient Supabase outage does not
  lock an admin out for the remainder of the TTL.

## Testing

**pgTAP** (`npm run db:test`):

- `platform_admins` and `admin_audit_log` are default-deny for `anon` and `authenticated`
- the append-only trigger rejects `UPDATE` and `DELETE` on `admin_audit_log`
- `admin_preview_delete_org` counts match what `DELETE` actually removes
- `admin_merge_players` refuses a cross-organization merge
- `admin_merge_players` preserves each of the four unique constraints, keeping the keeper's row
- `admin_merge_players` leaves no row still referencing the merged player
- `invite_member` rejects role `captain` (the `team_invites.role` check would
  otherwise raise a bare constraint error)
- `set_player_link` returns 409 rather than corrupting `unique (team_id, user_id)`

**Node tests** in the existing `gateway/*.test.mjs` style:

- `gateway/admin/adminAuth.test.mjs` — fail-closed on lookup error; 30s TTL; error results not cached; `isAnonymous` is never an admin; role ranking; per-operation `minRole`
- `gateway/admin/adminOps.test.mjs` — the dispatcher writes an audit row for `ok`, `denied`, and `error`; `preview` writes neither data nor an audit row; unknown operation name yields 404; input failing the Zod schema yields 400 and a `denied` audit row

Wired into `npm run test:gateway` and `npm run test:gateway:offline`.

**`npm test` is not touched.** `CLAUDE.md` records that it reads and asserts
against the production database.

## Non-goals

Deliberately excluded from this sub-project:

- **Impersonation / view-as-user** — sub-project C. Requires a read-only token
  scope that every write path in both the gateway and the Express server
  refuses; that is a cross-cutting change and its own security review.
- **Feedback triage inbox** — sub-project B. `feedback_clusters` already has
  `awaiting_approval` and `decision_needed` statuses that no UI can act on.
- **Ops health and data-integrity checks** — sub-project B.
- **Team transfer between organizations** — infeasible without a schema change,
  see above.
- **Any change to existing RLS policies.**
- **Any generic table editor.**
- **Admin management from within the console.**

## Future work

- **Sub-project B:** feedback triage inbox plus ops health and integrity
  checks. Additive pages on this foundation; the only writes are
  `feedback_clusters` status transitions. Reuses the operation catalog and
  audit dispatcher unchanged.
- **Sub-project C:** impersonation. Depends on this foundation and should land
  after it, so the audit log is exercised before the riskiest capability writes
  to it.

Both are named here so this sub-project's seams are shaped to accept them: the
operation catalog is a registry rather than a switch statement, and
`AdminCtx` carries the request id and admin identity that C will need to mark
impersonated sessions.
