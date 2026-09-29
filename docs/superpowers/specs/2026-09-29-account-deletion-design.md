# Account deletion (soft): design

## Summary

Users today have no way to delete their own account. There is also no
defense against a deleted user re-signing up to farm a fresh free trial:
trials are scoped to `organizations` only (`can_start_trial` checks
`trial_started_at is null` on the org), so account + org + trial + delete
+ re-signup is currently a free repeat.

This design adds self-service account deletion that is deliberately *not*
true deletion: the `auth.users` row and its email are retained so the
account can never be recreated or logged into, while the user's
app-level traces (memberships, player links) are removed.

Retaining the auth row is what makes the whole feature safe. The FK graph
around `auth.users` blocks a hard delete from ever succeeding casually:
`admin_audit_log.admin_id` is `ON DELETE RESTRICT`, `team_invites.invited_by`
is `NO ACTION`, and deleting a sole captain's row raises
`team % must have at least one captain` from `enforce_last_captain()`.
A soft delete never touches that graph, so none of those fire — including
the ex-admin case CLAUDE.md flags as needing "an explicit decision about
their audit history": the audit rows keep pointing at the retained
`auth.users` row and no decision is forced.

## Goals

- A user can delete their own account from the app, self-service.
- The email can never sign up again (password or Google OAuth) — clear
  error message, not GoTrue's generic "User already registered".
- The email can never log in again, on any provider.
- Retain enough metadata (email, whether a trial was consumed, Stripe
  customer id) that support can answer "did this person already have a
  trial?" for a deleted account.
- No new capability for a banned user to get a session (existing
  refresh tokens die; see Ban mechanics).

## Non-goals

- True/hard deletion of `auth.users`. Explicitly rejected (see below and
  CLAUDE.md gotchas: audit RESTRICT, last-captain trigger, invite NO
  ACTION all fire on it).
- Reactivation or "undelete" as a product surface. Support can restore
  manually (delete tombstone row, clear `banned_until`) — that is the
  escape hatch, not a feature.
- Same-person-different-email abuse detection (device fingerprinting,
  IP heuristics). Out of scope; the tombstone's `stripe_customer_id` is
  stored so a future cross-email Stripe-customer check has data to work
  with.
- GDPR erasure of operational data the user generated (feedback
  reports, admin audit rows). The auth row and its email are retained by
  design, so this is not an erasure path; anything more belongs to a
  separate compliance decision.
- Blocking deletion of the user's organizations. Orgs survive; only the
  user's *membership* in them is removed (org deletion is already a
  separate flow, `delete_org` admin op / org settings dialog).

## Decisions taken (with rationale)

| Decision | Choice | Why |
|---|---|---|
| Mechanism | Tombstone table + GoTrue ban, `auth.users` row retained | A hard delete must survive `admin_audit_log` RESTRICT, `enforce_last_captain()`, and `team_invites` NO ACTION — three special cases, each fragile, plus a blocklist that has to catch every FK path. Retaining the row means none of that graph is ever touched, and GoTrue itself refuses a duplicate-email signup for free. |
| Block re-signup | Gateway check via `is_email_deleted()` (security definer, returns one bit) on password signup and Google callback | The gateway has only the anon key; a definer function leaks nothing but a boolean and avoids moving signup handling outside `createGateway` or giving the gateway the service key. |
| Block re-login | GoTrue `banned_until` set far-future via admin API | GoTrue enforces the ban at token issuance/refresh for *every* provider — covers Google OAuth login too, which a deleted auth row alone does not. |
| Where the endpoint lives | `gateway/account/` mounted outside `createGateway`, twice (worker.ts, server/index.ts via createNodeAdapter) | Exact pattern the admin console uses: handlers needing the service-role key stay out of the gateway. |
| Caller identity | Forward the caller's Bearer token to GoTrue `/auth/v1/user` | GoTrue verifies the token and returns the id/email; no new JWKS verification code in the handler. |
| Sole-captain teams | Precondition, not auto-transfer | Silently promoting a teammate to captain is a team-capture vector; refusing with a list of blocking teams ("transfer captainship or delete the team first") matches how the trigger already protects the invariant. |
| Platform admins | Blocked from self-delete | Mirrors the manual-grant philosophy: gaining admin is a manual step, losing it should not be self-service. Error says to contact support (who removes the `platform_admins` row first). |
| Trial metadata in tombstone | `trial_used boolean` + `stripe_customer_id`, stored but no `can_start_trial` hook | Re-signup is already impossible for the same email, so a trial gate keyed on the tombstone would be dead code. The columns exist so support can answer abuse questions and a future cross-email check has its data. |
| Scrub scope | Delete `team_members` + `player_links` rows; keep feedback/audit/invites | Memberships and player links are the user's own PII traces and are cheap to remove without touching any FK back to `auth.users`. `feedback_reports.reporter_user_id` and audit rows are operational records that keep pointing at the retained auth row harmlessly; `team_invites.invited_by` is NO ACTION and is not affected because the auth row is never deleted. |
| Frontend entry point | "Delete account…" inside `UserMenu` popover → `DeleteAccountDialog` | Matches the existing rule that the sidebar footer holds only the account card and everything else lives in the popover; no sixth footer row. |

## Tombstone table

**`deleted_accounts`** — service-role only:

| column | type | notes |
|---|---|---|
| `email` | `text` PK | stored lowercased |
| `user_id` | `uuid not null references auth.users(id) on delete restrict` | provenance; RESTRICT documents that even a future hard-delete path must go through the tombstone first |
| `deleted_at` | `timestamptz not null default now()` | |
| `trial_used` | `boolean not null default false` | true if any org the user captained had `trial_started_at` |
| `stripe_customer_id` | `text null` | the Stripe customer of those orgs, if any; future cross-email abuse check |

RLS enabled, **zero policies**, privileges revoked from `anon` and
`authenticated` — same treatment as `platform_admins` / `admin_audit_log`.
Must be added to the zero-policy allowlist in
`supabase/tests/00_meta.test.sql` or `npm run db:test` fails (repo rule).

**`is_email_deleted(p_email text) returns boolean`** — `SECURITY DEFINER`,
`stable`, granted to `anon`/`authenticated`. Body:
`select exists (select 1 from public.deleted_accounts where email = lower(p_email))`.
Leaks nothing but one bit. (GoTrue lowercases stored emails, and the
delete handler lowercases before insert.)

## Deletion flow

1. **`GET /api/account/delete/blockers`** — caller identity from Bearer
   token (GoTrue `/auth/v1/user`). Returns, via service-role queries:
   - teams where the user is the sole captain (`team_members.role =
     'captain'` for the user and no other captain row for that team):
     `team_id`, team name
   - `is_platform_admin: boolean`
   Response is `{ blockers: [...], deletable: boolean }`.
2. **`POST /api/account/delete`** (same handler file):
   - Re-check blockers → `409` with the list if any (never rely on the
     GET having been honest).
   - Insert tombstone row (idempotent on PK conflict: proceed, do not
     fail — re-apply the ban and return success).
   - Delete the user's `team_members` rows (safe: blockers guarantee no
     sole-captain team, so `enforce_last_captain` never raises) and
     `player_links` rows.
   - GoTrue admin API: set `banned_until` far-future on the user
     (e.g. `9999-12-31T00:00:00Z`).
   - Order is tombstone-first on purpose: the tombstone is the source of
     truth for "this email is dead". If the GoTrue call fails after the
     tombstone write, return `500` and tell the user to retry / contact
     support — the state is safe (signup blocked, clear message) and
     retryable; the reverse order would risk "banned but no tombstone",
     which is indistinguishable from a corrupted row.
3. **Frontend:** `DeleteAccountDialog` fetches blockers on open; if any,
   show them and disable submit. Otherwise type-email-to-confirm
   (matching the repo's destructive-confirm pattern), `POST`, on 200
   call `logout()`. On non-200 show the error and stay logged in.

### Ban mechanics

GoTrue checks `banned_until` when issuing *and refreshing* tokens, for
every provider. After deletion:

- Password login → rejected.
- Google OAuth → rejected at callback.
- Existing refresh token → fails at next refresh. A live access token
  remains valid until its natural expiry (default ~1h) — acceptable for
  this product; the dialog also calls `logout()` which clears local
  session state.

### Signup gate

- `gateway/auth-handlers.ts` `POST /auth/signup`: after the existing
  password check, call `is_email_deleted(email)`; if true, `403` with
  "This account was deleted and cannot be recreated. Contact support."
- Google callback: same check once the email is known, before user
  creation. (If GoTrue already has a matching retained row, the ban
  blocks the session anyway — the gate exists for the clear message.)
- Guest auth (`/auth/guest`): no email, untouched.

## Why not soft-delete columns on existing tables

The repo already rejected `deleted_at` soft deletes once
(`2026-09-10-delete-recovery-design.md`): every RLS policy needs a
`deleted_at is null` clause and `unique` constraints break when a
soft-deleted row coexists with a live row on the same key. A single
tombstone table for the *account* (one row per deleted person, no unique
conflicts, no policy churn) is the same conclusion applied here: contain
the soft state in one new table instead of threading it through the
schema.

## Files touched

| area | change |
|---|---|
| `supabase/migrations/` | new migration: `deleted_accounts` table, `is_email_deleted()`, grants/revokes |
| `supabase/tests/00_meta.test.sql` | add `deleted_accounts` to zero-policy allowlist |
| `supabase/tests/` | pgTAP: `is_email_deleted` true/false; anon/authenticated cannot read `deleted_accounts` |
| `gateway/account/deleteAccount.ts` | new: blockers + delete handlers (service-role) |
| `gateway/auth-handlers.ts` | signup + Google callback call `is_email_deleted` |
| `worker.ts`, `server/index.ts` | mount account handlers (same seam as admin handlers) |
| `frontend/components/nav/UserMenu.tsx` | add "Delete account…" menu item |
| `frontend/components/DeleteAccountDialog.tsx` | new dialog (same directory as `OrganizationSettingsDialog.tsx`) |
| offline gateway tests | blockers/409/idempotency unit tests (`test:gateway:offline`) |
| frontend vitest | dialog states, submit gating |

## Testing

- **pgTAP (`npm run db:test`, local stack):** `is_email_deleted` returns
  false for a fresh email and true for an inserted tombstone email;
  `anon`/`authenticated` get zero rows from `deleted_accounts`; meta test
  passes with the new allowlist entry.
- **Offline gateway tests (`npm run test:gateway:offline`):** blockers
  endpoint shapes; delete returns 409 with blockers; tombstone insert +
  member/link deletes + ban call sequence; idempotent second delete.
- **Frontend vitest:** dialog renders blockers and disables submit;
  type-email-to-confirm only enables on exact match; 2xx triggers
  `logout`, non-2xx keeps session.
- Never `npm test` — reads production (repo rule).

## Rollout

Additive migration (new table + function only). **Prod migration history
has diverged from the repo — never `supabase db push`.** Apply the SQL
surgically via psql in a single transaction (verify policies/grants
after), *before* merging: Workers Builds and Vercel auto-deploy `main`
to production, so the DB change must land first. Then merge code. Local
`db:reset` picks the migration up from `supabase/migrations/` as usual.
