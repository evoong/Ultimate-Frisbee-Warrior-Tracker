-- ============================================================
-- 20260910120000_deleted_row_recovery.sql
--
-- Incident: on 2026-09-04, a test/verification run using the production
-- service-role key (server.test.mjs reads SUPABASE_SECRET_KEY from the
-- root .env, which points at production -- see CLAUDE.md's existing
-- warning about this) hard-deleted a real player row (players.id = 3,
-- "Brandon Ca"). Nothing in the schema recorded what was deleted, so
-- recovery was reconstructed by hand from a surviving foreign key
-- (game_events.related_player_id, ON DELETE SET NULL) and an orphaned
-- storage object -- and that only worked because this particular delete
-- happened to leave those two side traces. A delete of almost any other
-- row would have left nothing to reconstruct from.
--
-- This migration makes every domain-table delete recoverable by default:
-- a single generic trigger function copies the full row (as jsonb) to
-- deleted_rows_archive immediately before it is removed, and a
-- restore_deleted_row() helper re-inserts it. This covers direct deletes
-- AND deletes performed as part of an ON DELETE CASCADE, since Postgres
-- fires row-level triggers on cascaded deletes too -- e.g. deleting a
-- player also archives their season_players/game_attendance/game_lineups/
-- player_links/player_private/lineup_template_players/strategy_positions
-- rows before those cascade away.
--
-- deleted_rows_archive is intentionally not exposed to any client role
-- (RLS enabled, zero policies): the archived jsonb can contain data from
-- tables like player_private, so recovery is a deliberate, service-role-
-- only action (via the Supabase SQL editor or an MCP session), not a
-- self-serve "trash" feature in the app.
-- ============================================================

create table if not exists public.deleted_rows_archive (
  id bigint generated always as identity primary key,
  table_name text not null,
  row_pk text not null,
  row_data jsonb not null,
  deleted_at timestamptz not null default now(),
  deleted_by text
);

create index if not exists deleted_rows_archive_lookup_idx
  on public.deleted_rows_archive (table_name, row_pk, deleted_at desc);

alter table public.deleted_rows_archive enable row level security;
-- No policies: unreachable from anon/authenticated. Only service_role
-- (which bypasses RLS) or the Supabase SQL editor can read/restore it.

revoke all on public.deleted_rows_archive from anon, authenticated;

-- ------------------------------------------------------------
-- 1. Generic archive-on-delete trigger. Table-agnostic: OLD.id is
--    resolved at trigger-invocation time, same technique the existing
--    set_audit_fields() trigger already uses for created_at/updated_at.
-- ------------------------------------------------------------
create or replace function public.archive_deleted_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.deleted_rows_archive (table_name, row_pk, row_data, deleted_by)
  values (
    TG_TABLE_NAME,
    old.id::text,
    to_jsonb(old),
    nullif(coalesce(auth.jwt() ->> 'email', ''), '')
  );
  return old;
end;
$$;

alter function public.archive_deleted_row() owner to postgres;
revoke all on function public.archive_deleted_row() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2. Attach the trigger to every domain table. Same list-driven pattern
--    016_organizations.sql already uses for org-scoping. Excludes
--    `standings` (deprecated/unused, see 016) and deleted_rows_archive
--    itself.
-- ------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'teams', 'seasons', 'players', 'games', 'event_types', 'game_events',
    'season_players', 'game_lineups', 'game_lineup_groups',
    'game_attendance', 'league_teams', 'league_games',
    'strategy_plays', 'strategy_steps', 'strategy_positions',
    'strategy_opponent_markers', 'strategy_arrows', 'strategy_text_boxes',
    'strategy_highlights', 'strategy_lines',
    'calendar_sources', 'jam_sync_conflicts', 'chat_logs',
    'organizations', 'organization_members',
    'team_members', 'team_invites', 'player_links', 'player_private',
    'lineup_templates', 'lineup_template_groups', 'lineup_template_players',
    'feedback_clusters', 'feedback_reports'
  ]
  loop
    if to_regclass('public.' || t) is null then
      raise notice 'skipping missing table: %', t;
      continue;
    end if;
    execute format('drop trigger if exists %I on public.%I', t || '_archive_before_delete', t);
    execute format(
      'create trigger %I before delete on public.%I for each row execute function public.archive_deleted_row()',
      t || '_archive_before_delete', t
    );
  end loop;
end
$$;

-- ------------------------------------------------------------
-- 3. Restore helper: re-inserts an archived row from its jsonb snapshot.
--    Deliberately not granted to anon/authenticated -- restoring a row
--    (e.g. re-adding a player) should go through the app's normal write
--    paths for anything routine; this is for exactly the kind of
--    "something got hard-deleted, put it back" situation this migration
--    exists for.
-- ------------------------------------------------------------
create or replace function public.restore_deleted_row(p_archive_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text;
  v_data jsonb;
  v_result jsonb;
begin
  select table_name, row_data into v_table, v_data
  from public.deleted_rows_archive
  where id = p_archive_id;

  if v_table is null then
    raise exception 'no archived row with id %', p_archive_id;
  end if;

  execute format(
    'insert into public.%I select * from jsonb_populate_record(null::public.%I, %L) returning to_jsonb(%I.*)',
    v_table, v_table, v_data, v_table
  ) into v_result;

  return v_result;
end;
$$;

alter function public.restore_deleted_row(bigint) owner to postgres;
revoke all on function public.restore_deleted_row(bigint) from public, anon, authenticated;
grant execute on function public.restore_deleted_row(bigint) to service_role;
