-- Supersedes 017_open_access_for_now.sql. Tier A is readable by members or
-- by anyone when the owning team is public; Tier B is members-only with no
-- public branch at all -- a policy that cannot express a leak cannot be
-- misconfigured into one. Writes are member-tier everywhere, with a
-- with check on update as well as insert, which is what stops a row being
-- moved between teams in either direction.
--
-- Every membership-helper call is wrapped as `(select public.fn())::bigint[]`
-- -- the house form established in Task 13. `any (subquery)` treats the
-- subquery as a set of rows, not an array, and fails to compile against a
-- bigint[]-returning function; a bare `any (public.fn())` with no inner
-- select compiles but loses the InitPlan (once-per-query) semantics the
-- Global Constraint requires, evaluating instead as a per-row SubPlan.
--
-- tier_b also carries lineup_templates, lineup_template_groups,
-- lineup_template_players, strategy_highlights and strategy_lines -- five
-- organization_id-bearing tables the brief's original inventory omitted
-- from both tiers, which left them on 017's permissive policies. All five
-- go to tier B: strategy_highlights/strategy_lines are siblings of the
-- other strategy_* tables already there; a lineup template is a reusable
-- formation a coach prefers -- tactical planning material, not the public
-- record of a played game that puts game_lineups/game_lineup_groups in
-- tier A. organization_members also carries organization_id and is
-- deliberately in neither tier: its policies are already membership-scoped
-- via is_org_member()/is_org_owner() from migration 016, and Plan 4 owns
-- its retirement.

do $$
declare
  t text;
  tier_a text[] := array[
    'teams', 'seasons', 'players', 'games', 'game_events',
    'season_players', 'game_lineups', 'game_lineup_groups',
    'game_attendance', 'league_teams', 'league_games'
  ];
  -- player_private is excluded here: it has no organization_id (Task 6 gave
  -- it team_id), so it gets its own explicit tier-B block below rather than
  -- making this loop tenant-column-aware for one exception.
  tier_b text[] := array[
    'strategy_plays', 'strategy_steps', 'strategy_positions',
    'strategy_opponent_markers', 'strategy_arrows', 'strategy_text_boxes',
    'strategy_highlights', 'strategy_lines',
    'chat_logs', 'calendar_sources', 'jam_sync_conflicts',
    'lineup_templates', 'lineup_template_groups', 'lineup_template_players'
  ];
  read_clause text;
begin
  foreach t in array (tier_a || tier_b)
  loop
    if to_regclass('public.' || t) is null then
      raise notice 'skipping missing table: %', t;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', t);

    -- Drop 017's permissive set and 016's membership set alike.
    execute format('drop policy if exists "authenticated read" on public.%I', t);
    execute format('drop policy if exists "authenticated insert" on public.%I', t);
    execute format('drop policy if exists "authenticated update" on public.%I', t);
    execute format('drop policy if exists "authenticated delete" on public.%I', t);
    execute format('drop policy if exists "org member or public read" on public.%I', t);
    execute format('drop policy if exists "org member insert" on public.%I', t);
    execute format('drop policy if exists "org member update" on public.%I', t);
    execute format('drop policy if exists "org member delete" on public.%I', t);
    execute format('drop policy if exists "member read" on public.%I', t);
    execute format('drop policy if exists "member insert" on public.%I', t);
    execute format('drop policy if exists "member update" on public.%I', t);
    execute format('drop policy if exists "member delete" on public.%I', t);

    if t = any (tier_a) then
      read_clause := 'organization_id = any ((select public.my_member_team_ids())::bigint[])
                      or organization_id = any ((select public.public_team_ids())::bigint[])';
    else
      read_clause := 'organization_id = any ((select public.my_member_team_ids())::bigint[])';
    end if;

    execute format(
      'create policy "member read" on public.%I for select to authenticated using (%s)',
      t, read_clause
    );
    execute format(
      'create policy "member insert" on public.%I for insert to authenticated
         with check (organization_id = any ((select public.my_member_team_ids())::bigint[]))',
      t
    );
    execute format(
      'create policy "member update" on public.%I for update to authenticated
         using      (organization_id = any ((select public.my_member_team_ids())::bigint[]))
         with check (organization_id = any ((select public.my_member_team_ids())::bigint[]))',
      t
    );
    execute format(
      'create policy "member delete" on public.%I for delete to authenticated
         using (organization_id = any ((select public.my_member_team_ids())::bigint[]))',
      t
    );

    execute format('revoke all on public.%I from anon', t);
    -- authenticated keeps insert/update/delete -- that is exactly what the
    -- policies above govern -- but TRUNCATE is not subject to RLS at all,
    -- so it must be revoked explicitly or it bypasses every policy here.
    execute format('revoke truncate, references, trigger on public.%I from authenticated', t);
  end loop;
end
$$;

-- player_private has no organization_id (Task 6 gave it team_id), so it
-- cannot go through the tenant-column loop above. Same four policies, same
-- members-only read rule -- no public branch, even for a public team's
-- roster, phone numbers stay members-only -- and the same TRUNCATE revoke.
alter table public.player_private enable row level security;

drop policy if exists "authenticated read" on public.player_private;
drop policy if exists "authenticated insert" on public.player_private;
drop policy if exists "authenticated update" on public.player_private;
drop policy if exists "authenticated delete" on public.player_private;
drop policy if exists "org member or public read" on public.player_private;
drop policy if exists "org member insert" on public.player_private;
drop policy if exists "org member update" on public.player_private;
drop policy if exists "org member delete" on public.player_private;
drop policy if exists "member read" on public.player_private;
drop policy if exists "member insert" on public.player_private;
drop policy if exists "member update" on public.player_private;
drop policy if exists "member delete" on public.player_private;

create policy "member read" on public.player_private
  for select to authenticated
  using (team_id = any ((select public.my_member_team_ids())::bigint[]));

create policy "member insert" on public.player_private
  for insert to authenticated
  with check (team_id = any ((select public.my_member_team_ids())::bigint[]));

create policy "member update" on public.player_private
  for update to authenticated
  using      (team_id = any ((select public.my_member_team_ids())::bigint[]))
  with check (team_id = any ((select public.my_member_team_ids())::bigint[]));

create policy "member delete" on public.player_private
  for delete to authenticated
  using (team_id = any ((select public.my_member_team_ids())::bigint[]));

revoke all on public.player_private from anon;
revoke truncate, references, trigger on public.player_private from authenticated;

-- The tenant table itself. Narrower than 017's `using (true)`: a private
-- team's existence and name stop being visible to non-members. Insert is
-- denied outright -- teams come from create_team(), which is what lets
-- team_members carry no self-insert policy.
drop policy if exists "authenticated read" on public.organizations;
drop policy if exists "member or public read" on public.organizations;
drop policy if exists "any signed-in insert" on public.organizations;
drop policy if exists "owner update" on public.organizations;
drop policy if exists "owner delete" on public.organizations;

create policy "member or public read" on public.organizations
  for select to authenticated
  using (id = any ((select public.my_member_team_ids())::bigint[])
         or id = any ((select public.public_team_ids())::bigint[]));

create policy "manager update" on public.organizations
  for update to authenticated
  using      (id = any ((select public.my_manage_team_ids())::bigint[]))
  with check (id = any ((select public.my_manage_team_ids())::bigint[]));

create policy "captain delete" on public.organizations
  for delete to authenticated
  using (id = any ((select public.my_captain_team_ids())::bigint[]));

revoke insert on public.organizations from authenticated;
revoke all on public.organizations from anon;
revoke truncate, references, trigger on public.organizations from authenticated;

-- event_types is global reference data with no organization_id. Writable by
-- any non-guest who belongs to a team; guests denied. The array_length
-- check is wrapped in `(select ...)` per the Global Constraint, forcing an
-- InitPlan; do not add a coalesce around it -- for a guest the helper
-- returns an empty array, array_length gives NULL, and `NULL > 0` is NULL,
-- which RLS treats as deny. That is the correct guest-denial path already.
do $$
declare p text;
begin
  foreach p in array array['org member insert', 'org member update', 'org member delete']
  loop
    execute format('drop policy if exists %I on public.event_types', p);
  end loop;
end
$$;

create policy "team member insert" on public.event_types
  for insert to authenticated
  with check ((select array_length(public.my_member_team_ids(), 1)) > 0);

create policy "team member update" on public.event_types
  for update to authenticated
  using      ((select array_length(public.my_member_team_ids(), 1)) > 0)
  with check ((select array_length(public.my_member_team_ids(), 1)) > 0);

revoke truncate, references, trigger on public.event_types from authenticated;
