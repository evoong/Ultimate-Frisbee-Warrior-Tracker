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
