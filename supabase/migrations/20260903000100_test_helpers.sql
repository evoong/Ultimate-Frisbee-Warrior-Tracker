-- Test-only helpers, only ever called from supabase/tests. If applied to
-- production, `authenticated` does gain USAGE on this new schema (see the
-- grant below); that is a real change there, not a hypothetical one. What
-- keeps this safe: the helpers are SECURITY INVOKER, so calling them as
-- `authenticated` cannot elevate privileges (tests.login_as would fail with
-- "permission denied for table users", since authenticated has no access to
-- auth.users); and PostgREST's exposed-schema allowlist does not include
-- `tests`, so no HTTP request can reach these functions at all.
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

-- tests.login_as/login_as_guest switch the session's effective role to
-- `authenticated` via `set_config('role', ...)` (equivalent to SET ROLE).
-- Once that happens, the rest of the transaction runs with `authenticated`'s
-- own privileges, not postgres's superuser access, so tests.logout() (or a
-- second tests.login_as call before logging out) needs USAGE on this schema
-- to even be callable. Function EXECUTE already defaults to PUBLIC, so this
-- is the only grant required. This is DB-level only: PostgREST's exposed
-- schemas do not include `tests`, so no HTTP path can reach these functions.
grant usage on schema tests to authenticated;

-- Align local function ACLs with production's.
--
-- Supabase's local image ships default privileges that grant `anon` EXECUTE on
-- every function created in `public`, so replaying the baseline here produces
-- five legacy SECURITY DEFINER functions that `anon` can call. Production does
-- not grant them: the dump's own ACLs (baseline.sql:2627-2652) list only
-- service_role and authenticated. Without this, the meta-test asserting that no
-- SECURITY DEFINER function is executable by anon fails locally for a reason
-- that does not exist in production, and the suite learns to be ignored.
--
-- Against production this is a no-op, because anon never held these grants.
revoke all on function public.get_secret(text) from anon;
revoke all on function public.is_org_member(bigint) from anon;
revoke all on function public.is_org_owner(bigint) from anon;
revoke all on function public.my_organizations() from anon;
revoke all on function public.org_is_public(bigint) from anon;
