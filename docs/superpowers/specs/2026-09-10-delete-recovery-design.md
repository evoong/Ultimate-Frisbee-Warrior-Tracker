# Delete recovery: design

## Summary

On 2026-09-04, a test/verification run reached the production database using
the service-role key from the root `.env` (the same misconfiguration
`server.test.mjs`'s own file-level comment already warns about: root `.env`
points at production, not the local stack) and hard-deleted a real player row
(`players.id = 3`, "Brandon Ca"). Nothing in the schema recorded what was
deleted. Recovery only worked because this particular delete happened to
leave two lucky side traces: `game_events.related_player_id` uses
`ON DELETE SET NULL` (so one of his assists survived, scorer-less), and his
`player-photos` storage upload was never cleaned up (storage isn't covered by
the FK cascade at all). A delete of almost any other row, or this same row
via a path that didn't touch those two tables, would have left nothing to
reconstruct from.

This design makes every table's deletes recoverable by default, and closes
the specific hole that let a test run reach production in the first place.

## Goals

- Deleting any row, from any table, through any path (app RLS-scoped writes,
  service-role scripts, cascade side-effects) leaves a full recoverable copy
  behind.
- A cascade delete (e.g. deleting a player cascades to their
  `season_players`/`game_attendance`/`game_lineups`/etc. rows) archives every
  cascaded-away row too, not just the row that was directly targeted.
- A destructive test/verification script cannot silently run against
  production again.
- No changes to any existing query, RLS policy, hook, or MCP tool.

## Non-goals

- Soft deletes (a `deleted_at` column + filtering it out everywhere). Ruled
  out below.
- A self-serve "trash" / undo feature in the app UI. This is a
  recover-from-an-accident mechanism operated via SQL/service role, not a
  user-facing feature.
- Retroactively recovering anything lost before this migration ships (Brandon
  Ca was already manually recovered in a separate session).
- Auditing/archiving *updates* — this design covers deletes only.

## Decisions taken (with rationale)

| Decision | Choice | Why |
|---|---|---|
| Mechanism | Archive-on-delete trigger, not soft delete | Soft delete needs `deleted_at is null` added to every RLS policy in the schema and breaks several `unique` constraints (`calendar_sources.organizer`, `organization_members(organization_id, email)`) the moment a soft-deleted row coexists with a live one on the same key. Archive-on-delete needs zero changes to existing queries/policies. |
| Scope | Every table in `public` (except `deleted_rows_archive` itself) | User request: "every table," not just `players`. |
| Cascade coverage | Automatic, via per-row triggers | Postgres fires `BEFORE DELETE` row triggers on cascade-deleted rows too, so attaching the trigger to every table covers cascades for free — no special-casing needed. |
| Archive access | Service-role only, RLS enabled with zero policies | Archived jsonb can contain data from tables like `player_private`; this must not be reachable by `anon`/`authenticated`. |
| Restore mechanism | `restore_deleted_row(archive_id)`, service-role only | Recovery is a deliberate admin action taken after an incident, not an app-facing "undo" — see Non-goals. |
| Root-cause guard | `server.test.mjs` refuses to run unless `SUPABASE_URL` looks like the local stack | Cheapest possible fix for the actual mechanism that caused this incident; independent of the archive but shipped in the same pass since it directly prevents a repeat. |

## Archive mechanism

**`deleted_rows_archive`** — one shared table for every archived row:

| column | type | notes |
|---|---|---|
| `id` | `bigint identity` | PK |
| `table_name` | `text` | e.g. `'players'` |
| `row_pk` | `text` | the deleted row's `id`, stringified |
| `row_data` | `jsonb` | `to_jsonb(OLD)` — the full row |
| `deleted_at` | `timestamptz` | default `now()` |
| `deleted_by` | `text` | `auth.jwt() ->> 'email'`, null when there's no JWT (e.g. a service-role script) |

RLS enabled, **no policies** — unreachable from `anon`/`authenticated`
entirely; only the service role (which bypasses RLS) or a direct SQL-editor
session can read it.

**`archive_deleted_row()`** — one generic `SECURITY DEFINER` trigger
function, table-agnostic via `TG_TABLE_NAME` and `to_jsonb(OLD)` (the same
technique `set_audit_fields()` already uses generically for
`created_at`/`updated_at` across every table). Inserts one archive row, then
`return old` so the delete proceeds normally.

**Attachment** — a migration `do $$ ... $$` loop (the same pattern
`016_organizations.sql` uses for org-scoping) attaches
`before delete ... execute function archive_deleted_row()` to every domain
table: `teams`, `seasons`, `players`, `games`, `event_types`, `game_events`,
`season_players`, `game_lineups`, `game_lineup_groups`, `game_attendance`,
`league_teams`, `league_games`, `strategy_plays`, `strategy_steps`,
`strategy_positions`, `strategy_opponent_markers`, `strategy_arrows`,
`strategy_text_boxes`, `strategy_highlights`, `strategy_lines`,
`calendar_sources`, `jam_sync_conflicts`, `chat_logs`, `organizations`,
`organization_members`, `team_members`, `team_invites`, `player_links`,
`player_private`, `lineup_templates`, `lineup_template_groups`,
`lineup_template_players`, `feedback_clusters`, `feedback_reports`.
`standings` is excluded (already dead/unused per `016`'s own comment). The
loop skips any table that doesn't exist (`to_regclass(...) is null`) so it's
safe to run against environments at different migration states.

**`restore_deleted_row(p_archive_id bigint) returns jsonb`** —
`SECURITY DEFINER`, looks up the archive row, and does:

```sql
insert into public.<table> select * from jsonb_populate_record(null::public.<table>, <row_data>)
```

Granted to `service_role` only; revoked from `public`/`anon`/`authenticated`.
Restoring re-creates the row with its original `id` and all original column
values (including original `created_at`/`created_by`) — this is a literal
undo, not a fresh insert that happens to look similar.

**Known limitation:** if a restored row's original `id` has since been
reused by a new row (e.g. the identity sequence advanced and a later insert
happened to land on the same value — extremely unlikely for a `bigint
identity` column but not impossible if the sequence was ever manually reset),
`restore_deleted_row` will fail on the primary key conflict rather than
silently overwriting anything. That failure is the correct behavior; resolving
it is a manual, look-at-the-data judgment call, not something to automate.

## Root-cause guard

`server.test.mjs` currently builds its Supabase client from
`process.env.SUPABASE_URL` / `SUPABASE_SECRET_KEY` with no check on what
those point at. Add a guard immediately after `dotenv/config` runs:

```js
const url = process.env.SUPABASE_URL ?? "";
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(url)) {
  console.error(
    `✗ SUPABASE_URL (${url}) is not a local Supabase instance.\n` +
    `  server.test.mjs performs destructive CRUD cycles and must never run ` +
    `against production.\n` +
    `  Use the local stack: npm run db:start, then point SUPABASE_URL at ` +
    `its local URL (see \`supabase status\`).`
  );
  process.exit(1);
}
```

This is a fail-closed check at the top of the file, before any client is
constructed or any test runs. It doesn't fix the root `.env`-points-at-prod
setup (that's an existing, separately-documented gotcha in `CLAUDE.md`) — it
stops this specific script from acting on it destructively.

## Testing

- `supabase/tests/` (pgTAP, run via `npm run db:test` against the local
  stack): delete a row from a representative table, assert exactly one new
  `deleted_rows_archive` row exists with matching `table_name`/`row_pk` and
  the expected `row_data`. Delete a `players` row with existing
  `season_players`/`game_attendance` children, assert archive rows exist for
  the player *and* every cascaded child. Call `restore_deleted_row` on an
  archived row, assert the original row reappears with identical columns.
  Assert `anon`/`authenticated` cannot select from `deleted_rows_archive` or
  execute `restore_deleted_row`.
- `server.test.mjs`: a smoke check that running it with a non-local
  `SUPABASE_URL` exits non-zero before any network call — this is the one
  regression test that would have caught the actual incident.

## Rollout

This is additive-only (new table, new function, new triggers) — no existing
column, policy, or query changes. Safe to apply directly to production, then
mirrored into `supabase/migrations/` for local `db:reset` parity (already
true of every other migration in this repo).
