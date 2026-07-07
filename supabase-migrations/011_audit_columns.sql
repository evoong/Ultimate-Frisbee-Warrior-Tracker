-- ============================================================
-- 011_audit_columns.sql
-- Audit columns on every user-editable domain table:
--   created_at timestamptz  when the row was inserted
--   updated_at timestamptz  when the row was last written
--   created_by text         email of the inserting user (JWT claim)
--   updated_by text         email of the last editor
--
-- One shared trigger (set_audit_fields) maintains all four:
-- - created_at/created_by are immutable: the update branch restores
--   them from OLD, so no client can rewrite history.
-- - updated_at equals created_at until the first edit, so
--   "never edited" is detectable.
-- - The actor is auth.jwt() ->> 'email'. Service-role writes (Jam
--   calendar sync, chat endpoints, SQL editor) have no JWT email, so
--   created_by/updated_by stay null there: null means "system".
-- - Emails, not auth uuids: the app's identity model is email-based
--   (allowed_users), emails are directly displayable, and viewers are
--   already signed in. Note this makes editor emails visible to any
--   authenticated viewer through the public-read policies.
--
-- Rows that existed before this migration get created_at/updated_at
-- backfilled to the migration time (their true creation time is
-- unknown) and null created_by/updated_by.
--
-- Not covered: standings (deprecated), chat_logs (append-only log,
-- already has created_at). allowed_users gets created_at only: it is
-- security infrastructure managed from the dashboard/SQL editor.
--
-- Run this entire file in the Supabase SQL Editor AFTER 010.
-- Re-runnable (add column if not exists, drop trigger if exists).
-- ============================================================

create or replace function public.set_audit_fields()
returns trigger
language plpgsql
as $$
declare
  v_actor text := nullif(coalesce(auth.jwt() ->> 'email', ''), '');
begin
  if tg_op = 'INSERT' then
    if new.created_at is null then new.created_at := now(); end if;
    if new.created_by is null then new.created_by := v_actor; end if;
    new.updated_at := new.created_at;
    if new.updated_by is null then new.updated_by := v_actor; end if;
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.updated_at := now();
    new.updated_by := v_actor;
  end if;
  return new;
end
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'games', 'players', 'seasons', 'teams', 'season_players',
    'game_events', 'game_lineups', 'game_attendance',
    'league_teams', 'league_games',
    'strategy_plays', 'strategy_steps', 'strategy_positions',
    'strategy_opponent_markers', 'strategy_arrows',
    'event_types', 'calendar_sources', 'jam_sync_conflicts'
  ] loop
    execute format(
      'alter table public.%I
         add column if not exists created_at timestamptz not null default now(),
         add column if not exists updated_at timestamptz not null default now(),
         add column if not exists created_by text,
         add column if not exists updated_by text',
      t
    );
    execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
    execute format(
      'create trigger %I before insert or update on public.%I
         for each row execute function public.set_audit_fields()',
      t || '_audit', t
    );
  end loop;
end
$$;

-- allowed_users: creation time only, no trigger (rows are managed from
-- the dashboard/SQL editor, and the table is not client-readable).
alter table public.allowed_users
  add column if not exists created_at timestamptz not null default now();
