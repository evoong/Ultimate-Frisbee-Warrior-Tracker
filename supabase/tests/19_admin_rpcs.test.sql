begin;
select plan(12);

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

-- games.team_id references teams(id), NOT organizations(id). The preview must
-- not count it as a tenant dependent -- that was a real bug risk when the
-- dependent list was derived from column names instead of foreign keys.
select ok(
  (public.admin_preview_delete_org(1) -> 'dependents') ? 'team_members.team_id',
  'preview counts team_members.team_id (a real FK to organizations)'
);
select ok(
  not ((public.admin_preview_delete_org(1) -> 'dependents') ? 'games.team_id'),
  'preview does not count games.team_id (FK to teams, not organizations)'
);

-- --- admin_merge_players ---

insert into public.players (id, display_name, organization_id)
values (9001, 'Dup Keeper', 1), (9002, 'Dup Merged', 1);
insert into public.seasons (id, name, organization_id, team_id)
values (9001, 'Merge Test Season', 1, (select id from public.teams where organization_id = 1 limit 1));

-- Both players on the same season: unique (season_id, player_id) means a naive
-- repoint would raise. The keeper's row must win and the merged row must go.
insert into public.season_players (season_id, player_id, organization_id)
values (9001, 9001, 1), (9001, 9002, 1);

select lives_ok(
  $$ select public.admin_merge_players(9001, 9002) $$,
  'merge succeeds despite a season_players unique conflict'
);

select is(
  (select count(*)::int from public.season_players where season_id = 9001),
  1,
  'the conflicting season_players row was dropped, not duplicated'
);
select is(
  (select player_id from public.season_players where season_id = 9001),
  9001,
  'the surviving season_players row belongs to the keeper'
);
select is(
  (select count(*)::int from public.players where id = 9002),
  0,
  'the merged player row is gone'
);

-- A cross-organization merge is refused outright: repointing rows across
-- tenants is data corruption, not a correction.
insert into public.organizations (id, name) values (9002, 'Other Org');
insert into public.players (id, display_name, organization_id)
values (9003, 'Keeper A', 1), (9004, 'Other Org Player', 9002);

select throws_ok(
  $$ select public.admin_merge_players(9003, 9004) $$,
  'players 9003 and 9004 are in different organizations',
  'a cross-organization merge is refused'
);

select * from finish();
rollback;
