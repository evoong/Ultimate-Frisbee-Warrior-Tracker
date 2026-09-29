-- ============================================================
-- 20260929120000_chat_actions.sql
--
-- Chat action recovery: give every AI-chat database write a receipt,
-- so the frontend can offer a reliable Undo.
--
-- chat_actions is written exclusively by the chat agent (service
-- role): one row per applied action, with the affected rows
-- snapshotted into before_rows/after_rows so an undo can restore or
-- reverse exactly what the agent did. status is the undo state
-- machine ('applied' -> 'undoing' -> 'undone'); undone_at records
-- when the undo completed.
--
-- chat_logs.request_id links a chat message to the receipt for the
-- action that message produced (the same request id the gateway
-- logs), so the UI can attach the undo affordance to the exact
-- message.
--
-- RLS mirrors chat_logs' owner-scoped pattern (20260925000000): a
-- user may SELECT only their own receipts inside their org
-- memberships (my_member_team_ids()); no client role can write --
-- undo itself goes through the service-role gateway, like the writes
-- it reverses. Supabase's default privileges grant anon and
-- authenticated ALL on new public tables, and TRUNCATE is not subject
-- to RLS, so (as with platform_admins and feature_flags) everything
-- is revoked and only SELECT re-granted to authenticated.
--
-- Deletes archive to deleted_rows_archive through the same generic
-- archive_deleted_row() trigger every domain table carries
-- (20260910120000), keeping service-role cleanups recoverable.
-- ============================================================

-- 1. Add request_id to chat_logs to link messages to action receipts
alter table public.chat_logs add column if not exists request_id uuid;
create index if not exists idx_chat_logs_request_id on public.chat_logs(request_id) where request_id is not null;

-- 2. Create chat_actions table
create table if not exists public.chat_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id bigint not null references public.organizations(id) on delete cascade,
  session_id text not null,
  user_id text not null,
  request_id uuid,
  action_type text not null,
  description text not null,
  status text not null default 'applied',
  before_rows jsonb not null default '{}'::jsonb,
  after_rows jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  constraint chat_actions_status_check check (status in ('applied', 'undoing', 'undone')),
  constraint chat_actions_action_type_check check (action_type in (
    'create_game_event',
    'undo_last_event',
    'add_to_lineup',
    'remove_from_lineup',
    'create_lineup_group',
    'create_lineup',
    'save_lineup_template',
    'apply_lineup_template'
  ))
);

create index if not exists idx_chat_actions_session
  on public.chat_actions (organization_id, session_id, created_at desc);

create index if not exists idx_chat_actions_user
  on public.chat_actions (organization_id, user_id, created_at desc);

create index if not exists idx_chat_actions_request
  on public.chat_actions (request_id) where request_id is not null;

-- 3. RLS: Owner read-only. No client insert, update, or delete.
alter table public.chat_actions enable row level security;

create policy "owner read" on public.chat_actions
  for select to authenticated
  using (
    organization_id = any ((select public.my_member_team_ids())::bigint[])
    and user_id = (auth.uid())::text
  );

revoke all on public.chat_actions from anon, authenticated;
grant select on public.chat_actions to authenticated;
grant all on public.chat_actions to service_role;

-- 4. Attach deleted_rows_archive trigger
drop trigger if exists archive_deleted_chat_actions on public.chat_actions;
create trigger archive_deleted_chat_actions
  before delete on public.chat_actions
  for each row execute function public.archive_deleted_row();
