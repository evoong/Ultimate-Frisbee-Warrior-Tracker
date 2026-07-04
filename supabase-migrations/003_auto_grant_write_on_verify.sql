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
-- DASHBOARD STATE (verified via the management API, 2026-07-04):
--   "Confirm email" (Authentication -> Sign In / Up -> Email) is
--   already enabled, so signups require verification before the
--   trigger grants write access. If it is ever disabled, Supabase
--   auto-confirms every signup and write access is granted at signup
--   instead of at verification.
--   The Confirm Signup template still uses the default
--   {{ .ConfirmationURL }} link and CANNOT be edited on the free tier
--   with the default email provider (the dashboard hides the option
--   and the management API returns 400). That is fine for this
--   feature: clicking the default link sets email_confirmed_at, which
--   fires the trigger and grants write access. The user just is not
--   signed in afterwards and logs in manually. If a custom SMTP
--   provider or a paid plan is ever added, point the template at
--     {{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=signup
--   so confirmation also signs the user in through the gateway, and
--   strip the trailing slash from site_url first or the rendered link
--   contains a double slash the gateway rejects.
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
--    is nothing to allowlist. There is deliberately no exception
--    handler: if the insert ever fails, the error aborts the
--    auth.users write and surfaces loudly in Supabase Auth logs,
--    which is preferable to silently stranding a verified user
--    without write access.
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
