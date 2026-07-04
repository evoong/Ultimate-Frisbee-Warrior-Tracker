# Automatic Write Access on Email Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users who verify their email automatically and permanently gain write access; unverified accounts stay read-only.

**Architecture:** A single new SQL migration adds a security-definer trigger function and a trigger on `auth.users` that inserts the verified email into `public.allowed_users`, plus a backfill for already-verified accounts. No gateway, frontend, or policy changes: `is_allowed()` keeps reading the live allowlist, so the grant takes effect on the user's next request.

**Tech Stack:** PostgreSQL (Supabase), plain SQL migration run manually in the Supabase SQL editor.

**Spec:** `docs/superpowers/specs/2026-07-04-auto-write-access-on-verify-design.md`

## Global Constraints

- No em dashes or emojis in any generated document, comment, or prose (CLAUDE.md rule).
- Never push to `main`; all work stays on branch `feat/auto-write-on-verify` and lands via PR.
- No Co-Authored-By lines or AI attribution in commits or PR bodies.
- Migrations must be re-runnable: `create or replace` for functions, `drop trigger if exists` before `create trigger` (convention from migrations 001 and 002).
- Migrations CANNOT be executed from this environment. They run manually in the Supabase SQL editor. Never claim the migration was applied; the deliverable is the file plus verification instructions.
- CLAUDE.md must be updated in the same change as the logic change (CLAUDE.md rule).

---

### Task 1: Migration 003, trigger and backfill

**Files:**
- Create: `supabase-migrations/003_auto_grant_write_on_verify.sql`

**Interfaces:**
- Consumes: `public.allowed_users` (email text primary key, check email = lower(email)) and `public.is_allowed()` from migration 001; `auth.users` (columns `email`, `email_confirmed_at`).
- Produces: trigger `on_email_verified` on `auth.users` and function `public.grant_write_on_verify()`. Nothing else in the codebase references these by name.

There is no automated test harness for SQL in this repo and the migration cannot run locally, so the test cycle is: write the file, self-check it against the checklist in Step 2, and embed the verification queries that whoever runs it in the SQL editor will execute (Step 3 puts them in the file header so they travel with the migration).

- [ ] **Step 1: Write the migration file**

Create `supabase-migrations/003_auto_grant_write_on_verify.sql` with exactly this content:

```sql
-- ============================================================
-- 003_auto_grant_write_on_verify.sql
-- Automatic write access on email verification.
--
-- A trigger on auth.users inserts the user's email into
-- public.allowed_users the moment email_confirmed_at is set, so a user
-- who verifies their email permanently gains write access. Unverified
-- accounts keep the read-only access from migration 002. Deleting a row
-- from allowed_users still revokes that one account.
--
-- Run this entire file in the Supabase SQL Editor AFTER 002.
-- Re-runnable (create or replace, drop trigger if exists).
--
-- MANUAL DASHBOARD STEP (required alongside this migration):
--   Enable "Confirm email" under Authentication -> Sign In / Up ->
--   Email. If it stays disabled, Supabase auto-confirms every signup
--   and write access is granted at signup instead of at verification.
--   The Confirm Signup email template must point at
--     {{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=signup
--   (the gateway already handles this route).
--
-- VERIFICATION (run in the SQL editor after applying):
--   1. Trigger exists and is enabled ('O' = enabled):
--        select tgname, tgenabled from pg_trigger
--        where tgrelid = 'auth.users'::regclass
--          and tgname = 'on_email_verified';
--   2. Function exists and is security definer (prosecdef = true):
--        select proname, prosecdef from pg_proc
--        where proname = 'grant_write_on_verify';
--   3. Backfill complete, expect 0:
--        select count(*) from auth.users u
--        where u.email_confirmed_at is not null
--          and u.email is not null
--          and not exists (
--            select 1 from public.allowed_users a
--            where a.email = lower(u.email));
-- ============================================================

-- ------------------------------------------------------------
-- 1. Trigger function. SECURITY DEFINER so it can write to
--    public.allowed_users, which clients can neither read nor write
--    (RLS with zero policies plus explicit revokes, migration 001).
--    The email comes from auth.users.email, a server-controlled
--    column, never from user-editable metadata. The null guard covers
--    accounts without an email (for example phone-only), where there
--    is nothing to allowlist.
-- ------------------------------------------------------------
create or replace function public.grant_write_on_verify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is null then
    return new;
  end if;
  insert into public.allowed_users (email)
  values (lower(new.email))
  on conflict do nothing;
  return new;
end;
$$;

revoke all on function public.grant_write_on_verify()
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2. Trigger. Fires on insert because OAuth accounts (Google) arrive
--    with email_confirmed_at already set, and on updates of
--    email_confirmed_at (the email confirmation link) or email (a
--    verified user changing their address gets the new address
--    allowlisted when it confirms; the old address's row is left
--    behind, harmless because it no longer matches any account). The
--    insert is idempotent, so redundant firings are no-ops.
-- ------------------------------------------------------------
drop trigger if exists on_email_verified on auth.users;
create trigger on_email_verified
  after insert or update of email_confirmed_at, email
  on auth.users
  for each row
  when (new.email_confirmed_at is not null)
  execute function public.grant_write_on_verify();

-- ------------------------------------------------------------
-- 3. Backfill: every already-confirmed account gets write access now,
--    not on its next auth.users update.
-- ------------------------------------------------------------
insert into public.allowed_users (email)
select lower(email)
from auth.users
where email_confirmed_at is not null
  and email is not null
on conflict do nothing;
```

- [ ] **Step 2: Self-check the file against this checklist**

Read the file back and confirm every item:

- Function uses `create or replace`, `security definer`, `set search_path = ''`, and guards `new.email is null`.
- `revoke all on function` covers `public, anon, authenticated`.
- Trigger is dropped with `drop trigger if exists` before creation (re-runnable).
- Trigger fires `after insert or update of email_confirmed_at, email` with the `when (new.email_confirmed_at is not null)` clause.
- Backfill filters both `email_confirmed_at is not null` and `email is not null` and ends with `on conflict do nothing`.
- All emails pass through `lower()` (the table has a `check (email = lower(email))` constraint).
- Header contains the dashboard step and the three verification queries.
- No em dashes or emojis anywhere in the file.

- [ ] **Step 3: Run the backend test suite to confirm nothing regressed**

Run from the repo root: `npm test`
Expected: same results as on `main` (this change adds one SQL file; nothing executable changed). Note: project memory records a pre-existing failure caused by the live database missing `game_events.point_number`; that failure is not caused by this change.

- [ ] **Step 4: Commit**

```bash
git add supabase-migrations/003_auto_grant_write_on_verify.sql
git commit -m "Add migration granting write access on email verification"
```

---

### Task 2: Update CLAUDE.md to match the new security model

**Files:**
- Modify: `CLAUDE.md:85-87` (migrations bullet in Layout)
- Modify: `CLAUDE.md:113-115` (RLS invariant bullet in the security model)

**Interfaces:**
- Consumes: nothing from Task 1 (documentation only, but describes the trigger it added).
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Update the Layout migrations bullet**

In `CLAUDE.md`, replace exactly this text:

```markdown
- `supabase-migrations/`: SQL migrations, run manually in the Supabase SQL
  editor. `001_auth_allowlist_rls.sql` sets up the allowlist and RLS and
  documents the required Supabase dashboard steps in its header.
```

with:

```markdown
- `supabase-migrations/`: SQL migrations, run manually in the Supabase SQL
  editor. `001_auth_allowlist_rls.sql` sets up the allowlist and RLS and
  documents the required Supabase dashboard steps in its header.
  `002_public_read_team_write.sql` opens reads to any authenticated user
  while keeping writes allowlist-only. `003_auto_grant_write_on_verify.sql`
  adds a trigger that allowlists users when they verify their email; its
  header documents the required "Confirm email" dashboard toggle and
  post-apply verification queries.
```

- [ ] **Step 2: Update the RLS invariant bullet**

In `CLAUDE.md`, replace exactly this text:

```markdown
- RLS everywhere: access is gated by an `allowed_users` email allowlist via a
  security-definer `is_allowed()` function that checks the JWT email claim. The
  allowlist table itself is not client-readable.
```

with:

```markdown
- RLS everywhere: any authenticated user may read; writes require the user's
  email to be in the `allowed_users` allowlist, checked by the
  security-definer `is_allowed()` function against the JWT email claim.
  Verifying an email adds it to the allowlist automatically (trigger from
  migration 003), so the allowlist's role is "verified users minus revoked
  ones": deleting a row revokes that account's write access. The allowlist
  table itself is not client-readable.
```

- [ ] **Step 3: Confirm the document rules held**

Check the two edited sections contain no em dashes and no emojis, and that no other CLAUDE.md statement now contradicts them (search CLAUDE.md for "allowlist" and read each hit).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "Document automatic write access on email verification"
```

---

### Task 3: Push branch and open the pull request

**Files:**
- None created or modified (git and GitHub operations only).

**Interfaces:**
- Consumes: commits from Tasks 1 and 2 on branch `feat/auto-write-on-verify`.
- Produces: an open PR against `main`.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/auto-write-on-verify
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "Grant write access automatically on email verification" --body "$(cat <<'EOF'
## Summary
- New users are read-only until they verify their email; verification permanently grants write access.
- Migration 003 adds a security-definer trigger on auth.users that inserts the verified email into public.allowed_users, plus a backfill for already-verified accounts.
- The allowlist remains the revoke mechanism: deleting a row returns that account to read-only.
- No gateway, frontend, or RLS policy changes.

Design doc: docs/superpowers/specs/2026-07-04-auto-write-access-on-verify-design.md

## Manual steps after merge (dashboard access required)
1. Run supabase-migrations/003_auto_grant_write_on_verify.sql in the Supabase SQL editor, then run the three verification queries in its header.
2. Enable "Confirm email" under Authentication, Sign In / Up, Email, and confirm the Confirm Signup template points at {{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=signup.

## Behavioral test checklist (after the manual steps)
1. Fresh signup: reads work, writes rejected while unverified.
2. Click the confirmation link: email appears in allowed_users and writes succeed without re-login.
3. Delete that allowlist row: account is read-only again.
EOF
)"
```

Expected: PR URL printed. Do not merge; the repo rule is PR-based review.

---

## Self-review notes

- Spec coverage: migration contents (Task 1), re-runnability (Task 1 Step 2), backfill (Task 1), dashboard step surfaced in the migration header and PR body (Tasks 1 and 3), CLAUDE.md updates (Task 2), behavioral test checklist (PR body, Task 3). The auth-system project memory update is intentionally not a task: it lives outside the repo and the session owner updates it after merge.
- The spec's illustrative trigger SQL omitted a null-email guard; the plan's SQL adds one because `allowed_users.email` is a primary key and phone-only accounts would otherwise abort the auth.users write.
