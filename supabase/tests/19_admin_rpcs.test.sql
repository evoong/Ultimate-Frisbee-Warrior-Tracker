begin;
select plan(37);

select has_function('public', 'admin_preview_delete_org', array['bigint'],
  'admin_preview_delete_org exists');
select has_function('public', 'admin_merge_players', array['integer', 'integer'],
  'admin_merge_players exists');

-- Neither function may be reachable by a client role.
select ok(
  not has_function_privilege('anon', 'public.admin_merge_players(integer,integer)', 'EXECUTE'),
  'anon cannot execute admin_merge_players'
);
select ok(
  not has_function_privilege('authenticated', 'public.admin_preview_delete_org(bigint)', 'EXECUTE'),
  'authenticated cannot execute admin_preview_delete_org'
);

-- --- admin_preview_delete_org ---

select throws_ok(
  $$ select public.admin_preview_delete_org(999999) $$,
  'organization 999999 does not exist',
  'preview rejects an unknown organization'
);

-- team_members.team_id references organizations(id), so it must show up.
select ok(
  (public.admin_preview_delete_org(1) -> 'dependents') ? 'team_members.team_id',
  'preview counts team_members.team_id (a real FK to organizations)'
);

-- seasons.team_id is the column the design doc calls out by name: it FKs to
-- teams(id), not organizations(id), despite the misleading column name. This
-- is the actual risk the FK-derivation exists to avoid (unlike games.team_id,
-- which is not even a real column -- asserting its absence proves nothing).
select ok(
  not ((public.admin_preview_delete_org(1) -> 'dependents') ? 'seasons.team_id'),
  'preview does not count seasons.team_id (FK to teams, not organizations)'
);

-- The preview must report an exact row count, not merely key presence/
-- absence. Seed an isolated organization with a known number of dependent
-- rows and check the reported count against it.
insert into public.organizations (id, name) values (9010, 'Preview Count Org');
insert into public.players (id, display_name, organization_id) values
  (9011, 'Count One',   9010),
  (9012, 'Count Two',   9010),
  (9013, 'Count Three', 9010);

select is(
  ((public.admin_preview_delete_org(9010) -> 'dependents') ->> 'players.organization_id')::int,
  3,
  'preview reports the exact seeded row count for players.organization_id'
);

-- --- admin_merge_players: conflict fixtures across every conflict-bearing table ---
--
-- Players 9001 (keeper) and 9002 (merged) each get a colliding row in all six
-- conflict-bearing tables, so this one merge call exercises every collision
-- key and delete clause the migration defines. A regression that dropped a
-- column from any delete's match (e.g. game_lineups down to two columns) or
-- swapped which row survives would surface here.

insert into public.players (id, display_name, organization_id)
values (9001, 'Dup Keeper', 1), (9002, 'Dup Merged', 1);

insert into public.seasons (id, name, organization_id, team_id)
values (9001, 'Merge Test Season', 1, (select id from public.teams where organization_id = 1 limit 1));

-- season_players (season_id, player_id)
insert into public.season_players (season_id, player_id, organization_id)
values (9001, 9001, 1), (9001, 9002, 1);

-- game_attendance (game_id, player_id)
insert into public.games (id, organization_id) values (9101, 1), (9102, 1);
insert into public.game_attendance (game_id, player_id, organization_id)
values (9101, 9001, 1), (9101, 9002, 1);

-- game_lineups (game_id, player_id, lineup_name)
insert into public.game_lineups (game_id, player_id, lineup_name, organization_id)
values (9101, 9001, 'O', 1), (9101, 9002, 'O', 1);

-- strategy_positions (step_id, player_id)
insert into public.strategy_plays (id, name, organization_id) values (9201, 'Admin RPC Test Play', 1);
insert into public.strategy_steps (id, play_id, step_number, organization_id)
values (9301, 9201, 1, 1), (9302, 9201, 2, 1);
insert into public.strategy_positions (step_id, player_id, x, y, organization_id)
values (9301, 9001, 0.3, 0.3, 1), (9301, 9002, 0.4, 0.4, 1);

-- player_links (unique player_id) -- both players already linked to a real user.
insert into public.player_links (team_id, player_id, user_id, status) values
  (1, 9001, (select id from auth.users where email = 'captain@local.test'), 'approved'),
  (1, 9002, (select id from auth.users where email = 'editor@local.test'),  'approved');

-- player_private (player_id primary key) -- both players already have a private row.
insert into public.player_private (player_id, team_id, phone)
values (9001, 1, '555-9001'), (9002, 1, '555-9002');

select lives_ok(
  $$ select public.admin_merge_players(9001, 9002) $$,
  'merge succeeds despite conflicts in every conflict-bearing table'
);

select is(
  (select count(*)::int from public.season_players where season_id = 9001),
  1,
  'season_players: the conflicting row was dropped, not duplicated'
);
select is(
  (select player_id from public.season_players where season_id = 9001),
  9001,
  'season_players: the surviving row belongs to the keeper'
);
select is(
  (select count(*)::int from public.players where id = 9002),
  0,
  'the merged player row is gone'
);

select is(
  (select count(*)::int from public.game_attendance where game_id = 9101),
  1,
  'game_attendance: the conflicting row was dropped, not duplicated'
);
select is(
  (select player_id from public.game_attendance where game_id = 9101),
  9001,
  'game_attendance: the surviving row belongs to the keeper'
);

select is(
  (select count(*)::int from public.game_lineups where game_id = 9101 and lineup_name = 'O'),
  1,
  'game_lineups: the conflicting row was dropped, not duplicated (3-column match still holds)'
);
select is(
  (select player_id from public.game_lineups where game_id = 9101 and lineup_name = 'O'),
  9001,
  'game_lineups: the surviving row belongs to the keeper'
);

select is(
  (select count(*)::int from public.strategy_positions where step_id = 9301),
  1,
  'strategy_positions: the conflicting row was dropped, not duplicated'
);
select is(
  (select player_id from public.strategy_positions where step_id = 9301),
  9001,
  'strategy_positions: the surviving row belongs to the keeper'
);

select is(
  (select count(*)::int from public.player_links where player_id in (9001, 9002)),
  1,
  'player_links: the merged player''s row was dropped since the keeper already had one'
);
select is(
  (select player_id from public.player_links where player_id in (9001, 9002)),
  9001,
  'player_links: the surviving row belongs to the keeper'
);

select is(
  (select count(*)::int from public.player_private where player_id in (9001, 9002)),
  1,
  'player_private: the merged player''s row was dropped since the keeper already had one'
);
select is(
  (select player_id from public.player_private where player_id in (9001, 9002)),
  9001,
  'player_private: the surviving row belongs to the keeper'
);

-- A cross-organization merge is refused outright: repointing rows across
-- tenants is data corruption, not a correction. Confirm it is a genuine
-- no-op, not merely that an exception fired.
insert into public.organizations (id, name) values (9002, 'Other Org');
insert into public.players (id, display_name, organization_id)
values (9003, 'Keeper A', 1), (9004, 'Other Org Player', 9002);

select throws_ok(
  $$ select public.admin_merge_players(9003, 9004) $$,
  'players 9003 and 9004 are in different organizations',
  'a cross-organization merge is refused'
);
select is(
  (select organization_id from public.players where id = 9003),
  1::bigint,
  'player 9003 still exists in its original organization after the refused merge'
);
select is(
  (select organization_id from public.players where id = 9004),
  9002::bigint,
  'player 9004 still exists in its original organization after the refused merge'
);

-- --- admin_merge_players: non-conflict fixtures across every remaining column ---
--
-- Players 9501 (keeper) and 9502 (merged) each get a row in every table the
-- migration touches, but with no collision this time -- the keeper has no
-- row at all in these tables, so a plain repoint (not a delete) is what must
-- happen. This exercises the four columns that carry no unique constraint
-- (game_events.player_id/related_player_id, lineup_template_players.player_id,
-- strategy_arrows.start_player_id) in addition to re-proving the plain-repoint
-- path for the six conflict-bearing tables.

insert into public.players (id, display_name, organization_id)
values (9501, 'Keeper B', 1), (9502, 'Merged B', 1);

insert into public.game_attendance (game_id, player_id, organization_id)
values (9102, 9502, 1);

insert into public.game_lineups (game_id, player_id, lineup_name, organization_id)
values (9102, 9502, 'D', 1);

insert into public.strategy_positions (step_id, player_id, x, y, organization_id)
values (9302, 9502, 0.5, 0.5, 1);

insert into public.strategy_arrows (
  step_id, arrow_type, x1, y1, x2, y2, cx, cy, start_player_id, organization_id
) values (9302, 'run', 0.1, 0.1, 0.2, 0.2, 0.15, 0.15, 9502, 1);

insert into public.player_links (team_id, player_id, user_id, status)
values (1, 9502, (select id from auth.users where email = 'member@local.test'), 'approved');

insert into public.player_private (player_id, team_id, phone)
values (9502, 1, '555-9502');

insert into public.game_events (game_id, player_id, related_player_id, event_type, organization_id)
values (9102, 9502, null, 'Goal', 1),
       (9102, null, 9502, 'Assist', 1);

insert into public.lineup_templates (id, organization_id, season_id, name)
values (9401, 1, 1, 'Admin RPC Test Template');
insert into public.lineup_template_players (template_id, organization_id, lineup_name, player_id)
values (9401, 1, 'O', 9502);

select lives_ok(
  $$ select public.admin_merge_players(9501, 9502) $$,
  'merge succeeds with no conflicts (plain repoint across every referencing column)'
);

select is(
  (select player_id from public.game_attendance where game_id = 9102),
  9501,
  'game_attendance.player_id repointed to the keeper'
);
select is(
  (select player_id from public.game_lineups where game_id = 9102 and lineup_name = 'D'),
  9501,
  'game_lineups.player_id repointed to the keeper'
);
select is(
  (select player_id from public.strategy_positions where step_id = 9302),
  9501,
  'strategy_positions.player_id repointed to the keeper'
);
select is(
  (select player_id from public.player_links
    where user_id = (select id from auth.users where email = 'member@local.test')),
  9501,
  'player_links.player_id repointed to the keeper'
);
select is(
  (select player_id from public.player_private where phone = '555-9502'),
  9501,
  'player_private.player_id repointed to the keeper'
);
select is(
  (select count(*)::int from public.game_events where game_id = 9102 and player_id = 9501),
  1,
  'game_events.player_id repointed to the keeper'
);
select is(
  (select count(*)::int from public.game_events where game_id = 9102 and related_player_id = 9501),
  1,
  'game_events.related_player_id repointed to the keeper'
);
select is(
  (select player_id from public.lineup_template_players where template_id = 9401 and lineup_name = 'O'),
  9501,
  'lineup_template_players.player_id repointed to the keeper'
);
select is(
  (select start_player_id from public.strategy_arrows where step_id = 9302),
  9501,
  'strategy_arrows.start_player_id repointed to the keeper'
);
select is(
  (select count(*)::int from public.players where id = 9502),
  0,
  'the merged player row (non-conflict case) is gone'
);

-- Single assertion covering all ten referencing columns at once: a dropped
-- UPDATE anywhere in the migration would leave one of the two merged player
-- ids (9002 from the conflict merge, 9502 from the plain-repoint merge)
-- behind, and this would catch it regardless of which column.
select is(
  (select count(*)::int from (
    select 1 from public.game_attendance         where player_id in (9002, 9502)
    union all
    select 1 from public.game_events              where player_id in (9002, 9502)
    union all
    select 1 from public.game_events              where related_player_id in (9002, 9502)
    union all
    select 1 from public.game_lineups             where player_id in (9002, 9502)
    union all
    select 1 from public.lineup_template_players  where player_id in (9002, 9502)
    union all
    select 1 from public.season_players           where player_id in (9002, 9502)
    union all
    select 1 from public.strategy_arrows          where start_player_id in (9002, 9502)
    union all
    select 1 from public.strategy_positions       where player_id in (9002, 9502)
    union all
    select 1 from public.player_links             where player_id in (9002, 9502)
    union all
    select 1 from public.player_private           where player_id in (9002, 9502)
  ) dangling),
  0,
  'no row in any of the ten player-referencing columns still holds a merged player id'
);

select * from finish();
rollback;
