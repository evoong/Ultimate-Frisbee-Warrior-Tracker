-- ============================================================
-- 017_open_access_for_now.sql
-- Soft-launch access model: every signed-in user may READ and WRITE every
-- organization's data, for now. The organization structure introduced in
-- 016_organizations.sql stays fully in place (organization_id columns,
-- organizations/organization_members tables, helper functions, onboarding),
-- but the per-table RLS enforcement of membership is relaxed to
-- any-authenticated until the app is ready for strict isolation. To go
-- strict later, re-run section 6 of 016_organizations.sql.
--
-- Also opens the organizations list to any signed-in user (not just
-- members or public orgs) so the onboarding screen can offer "join an
-- existing team" alongside "create your own". Self-joining was already
-- permitted by 016's "owner invite or self join" insert policy (a user may
-- always insert a membership row for their own email).
--
-- Run this entire file in the Supabase SQL Editor AFTER 016.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Relax every org-scoped domain table to any-authenticated
--    read + write.
-- ------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'teams', 'seasons', 'players', 'games', 'game_events',
    'season_players', 'game_lineups', 'game_lineup_groups',
    'game_attendance', 'league_teams', 'league_games',
    'strategy_plays', 'strategy_steps', 'strategy_positions',
    'strategy_opponent_markers', 'strategy_arrows', 'strategy_text_boxes',
    'calendar_sources', 'jam_sync_conflicts', 'chat_logs'
  ]
  loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;

    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists "org member or public read" on public.%I', t);
    execute format('drop policy if exists "org member insert" on public.%I', t);
    execute format('drop policy if exists "org member update" on public.%I', t);
    execute format('drop policy if exists "org member delete" on public.%I', t);

    execute format(
      'create policy "authenticated read" on public.%I
         for select to authenticated
         using (true)',
      t
    );
    execute format(
      'create policy "authenticated insert" on public.%I
         for insert to authenticated
         with check (true)',
      t
    );
    execute format(
      'create policy "authenticated update" on public.%I
         for update to authenticated
         using (true)
         with check (true)',
      t
    );
    execute format(
      'create policy "authenticated delete" on public.%I
         for delete to authenticated
         using (true)',
      t
    );
  end loop;
end
$$;

-- ------------------------------------------------------------
-- 2. Any signed-in user may browse the organizations list, so the
--    onboarding screen can offer joining an existing team. Ownership
--    still gates update/delete (unchanged from 016).
-- ------------------------------------------------------------
drop policy if exists "member or public read" on public.organizations;
create policy "authenticated read" on public.organizations
  for select to authenticated
  using (true);
