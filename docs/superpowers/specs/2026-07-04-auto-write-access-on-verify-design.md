# Design: automatic write access on email verification

Date: 2026-07-04
Status: approved

## Problem

New signups can read every table but cannot write. Migration
`002_public_read_team_write.sql` gives any authenticated user read access,
while insert, update, and delete require the user's email to be present in
`public.allowed_users` (checked by `public.is_allowed()`). Nothing adds a new
signup to that table, so every new account is permanently read-only until
someone inserts its email by hand in the Supabase dashboard.

## Goal

A user who verifies their email address automatically and permanently gains
write access. Until they verify, they remain read-only. Manual revocation of
any single account must remain possible.

## Decision

Grant write access with a Postgres trigger on `auth.users`: when
`email_confirmed_at` becomes non-null, insert the user's email into
`public.allowed_users`. The allowlist remains the single source of truth for
write access, `is_allowed()` and every RLS policy stay untouched, and deleting
a row from `allowed_users` still revokes one account.

Alternatives considered and rejected:

- Checking `email_confirmed_at` directly inside `is_allowed()`: no revocation
  path (every verified account can always write) and the allowlist stops being
  the source of truth.
- Stamping a verified claim into the JWT via a custom access token hook: more
  configuration, and write access would only appear after the next token
  refresh instead of immediately at verification.

## Behavior

- Email/password signup: account starts read-only. Clicking the confirmation
  link sets `email_confirmed_at`, the trigger inserts the email into
  `allowed_users`, and writes work from the next request onward.
- Google OAuth signup: the email arrives already verified, so write access is
  granted immediately at first sign-in.
- The grant is permanent: the allowlist row persists independently of any
  later state of the auth user.
- Revocation: delete the row from `allowed_users`. The account drops back to
  read-only on its next request. Revocation is per-email, not per-person: a
  revoked user who changes their account email and confirms the new address
  is re-granted by the trigger. This is within the accepted exposure model
  described in the security notes.
- Existing verified accounts are backfilled so nobody who already confirmed
  their email is left read-only.
- No gateway or frontend changes. The `allowed` flag returned by the session
  bootstrap (`gateway/auth-handlers.ts`) queries `is_allowed()` live, so it
  reflects the new state automatically.

## Implementation

One new migration, `supabase-migrations/003_auto_grant_write_on_verify.sql`,
run manually in the Supabase SQL editor like its predecessors. It must be
re-runnable, matching the convention of 001 and 002: `create or replace` for
the function and `drop trigger if exists` before `create trigger`. Contents:

1. Function `public.grant_write_on_verify()`, `security definer` with
   `set search_path = ''`, returning trigger:

   ```sql
   insert into public.allowed_users (email)
   values (lower(new.email))
   on conflict do nothing;
   return new;
   ```

2. Trigger on `auth.users`:

   ```sql
   create trigger on_email_verified
     after insert or update of email_confirmed_at, email
     on auth.users
     for each row
     when (new.email_confirmed_at is not null)
     execute function public.grant_write_on_verify();
   ```

   `insert` covers accounts created already-confirmed (OAuth). Including
   `email` in the update column list covers a verified user changing their
   address later: the new email is allowlisted on confirmation. The old
   address's row is left behind, which is harmless (it no longer matches any
   account) and keeps the migration simple. The insert is idempotent, so
   redundant trigger firings are no-ops.

3. Backfill:

   ```sql
   insert into public.allowed_users (email)
   select lower(email) from auth.users
   where email_confirmed_at is not null and email is not null
   on conflict do nothing;
   ```

## Manual dashboard step

"Confirm email" (Authentication, Sign In / Up, Email) was verified already
enabled on 2026-07-04 via the management API, so no action is needed. If it
is ever disabled, Supabase auto-confirms every signup and the trigger grants
write access at signup, which defeats the read-only-until-verified rule.

The Confirm Signup email template keeps the default `{{ .ConfirmationURL }}`
link: template editing is not available on the free tier with the default
email provider (confirmed by a 400 from the management API). The default
link is sufficient for this feature, because GoTrue sets `email_confirmed_at`
when it is clicked, which fires the trigger. The only loss is that the user
is not signed in automatically afterwards and logs in manually. If a custom
SMTP provider or a paid plan is ever added, point the template at
`{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=signup` (the
gateway already handles this route) and strip the trailing slash from
`site_url` first, or the rendered link contains a double slash the gateway
rejects.

## Security notes

- The trigger function is `security definer` so it can write to
  `allowed_users`, which remains non-readable and non-writable for clients
  (RLS enabled with zero policies plus explicit revokes from migration 001).
- Execute permission on the trigger function is revoked from `public`,
  `anon`, and `authenticated`, mirroring the treatment of `is_allowed()`.
  Only the trigger itself invokes it.
- The email inserted comes from `auth.users.email`, a server-controlled
  column, not from any user-editable metadata.
- The exposure change is deliberate and accepted: anyone who can receive
  email at an address they sign up with can gain write access. The allowlist
  changes meaning from "invite list" to "verified users minus revoked ones".

## Testing

Migrations run manually, so verification is behavioral, on a deployed or
local environment pointed at the live database:

1. Before the migration: note a fresh signup cannot write.
2. Run the migration. Confirm existing verified users now appear in
   `allowed_users` (backfill check).
3. Sign up with a fresh email address. Confirm reads succeed and a write is
   rejected while unverified.
4. Click the confirmation link. Confirm the email now appears in
   `allowed_users` and a write succeeds without re-login.
5. Delete that row. Confirm the account is read-only again (revocation).

## Documentation updates

- CLAUDE.md: update the RLS invariant bullet and add the new migration to the
  layout notes, describing the verified-email grant and the allowlist's role
  as the revocation mechanism.
- Auth-system project memory: same update.
