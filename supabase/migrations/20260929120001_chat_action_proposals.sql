-- Pending chat action proposals (spec: 2026-09-29-chat-interactive-features).
-- When the chat agent's write tools fire, they store a validated proposal
-- here instead of writing; POST /api/chat/confirm claims a row (atomic
-- DELETE with return=representation) and executes it. Service-role only:
-- every read and write goes through the Express/Worker handlers holding the
-- service key, so RLS is enabled with zero policies and no client grants,
-- exactly the platform_admins precedent (see 00_meta.test.sql's allowlist).
--
-- Mirrors chat_logs' column style (session_id text, user_id text,
-- organization_id bigint, no FKs) per the baseline's dump-restoration form.

create table public.chat_action_proposals (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  organization_id bigint not null,
  user_id text not null,
  tool_name text not null,
  args jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.chat_action_proposals enable row level security;

revoke all on public.chat_action_proposals from anon, authenticated;
