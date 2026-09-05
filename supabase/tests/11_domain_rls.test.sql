begin;
select plan(12);

-- Seeded while still running as postgres, before any login. An empty
-- table is exactly what let 017's leftover permissive policies hide on
-- lineup_templates and its siblings during the first pass at this task --
-- querying an empty table as an outsider returns zero rows either way,
-- leak or no leak. This row gives the later assertions something to fail
-- on if a permissive policy resurfaces.
insert into public.lineup_templates (organization_id, season_id, name)
values (1, 1, 'Org 1 Template');

-- Tier A: public teams are readable by anyone, including guests.
select tests.login_as_guest();
select isnt_empty(
  $$ select id from public.games where organization_id = 2 $$,
  'a guest can read a public team''s games'
);
select is_empty(
  $$ select id from public.games where organization_id = 1 $$,
  'a guest cannot read a private team''s games'
);

-- Tier B has no public branch at all, not even for a public team.
select is_empty(
  $$ select id from public.strategy_plays where organization_id = 2 $$,
  'a guest cannot read strategy on a public team'
);
select is_empty(
  $$ select player_id from public.player_private $$,
  'a guest cannot read player phone numbers anywhere'
);
select throws_ok(
  $$ insert into public.game_events (game_id, player_id, event_type, organization_id)
     values (2, 104, 'Goal', 2) $$,
  '42501',
  null,
  'a guest cannot write, even to a public team'
);

-- Members write their own team and nothing else.
select tests.logout();
select tests.login_as('member@local.test');
select lives_ok(
  $$ insert into public.game_events (game_id, player_id, event_type, organization_id)
     values (1, 103, 'Goal', 1) $$,
  'a member can record events on their own team'
);
select throws_ok(
  $$ insert into public.game_events (game_id, player_id, event_type, organization_id)
     values (2, 104, 'Goal', 2) $$,
  '42501',
  null,
  'a member cannot write into another team'
);
select throws_ok(
  $$ update public.games set organization_id = 2 where id = 1 $$,
  '42501',
  null,
  'a member cannot move a row into another team'
);

-- Team settings are manage-tier.
-- A member's update policy filters this row out via USING before it ever
-- reaches WITH CHECK -- Postgres treats a row excluded by USING as simply
-- not selected for update, not as a permission error, so this is an
-- UPDATE 0 rather than a thrown 42501. Assert on the observable effect
-- (the name is unchanged) rather than an exception that RLS never raises
-- for this shape of denial.
update public.organizations set name = 'Hijacked' where id = 1;
select isnt(
  (select name from public.organizations where id = 1),
  'Hijacked',
  'a member cannot rename the team'
);
select tests.logout();
select tests.login_as('editor@local.test');
select lives_ok(
  $$ update public.organizations set name = 'Renamed By Editor' where id = 1 $$,
  'an editor can rename the team'
);

-- Regression coverage for the tier-B table-inventory gap: lineup_templates
-- (and its siblings, added to tier_b alongside it) originally kept 017's
-- permissive policies because neither array named them. outsider@ is a
-- real captain of org 2, with no relationship to org 1 at all.
select tests.logout();
select tests.login_as('outsider@local.test');
select is_empty(
  $$ select id from public.lineup_templates where organization_id = 1 $$,
  'an outsider cannot read another team''s lineup templates'
);
select throws_ok(
  $$ insert into public.lineup_templates (organization_id, season_id, name)
     values (1, 1, 'Hijacked Template') $$,
  '42501',
  null,
  'an outsider cannot write into another team''s lineup templates'
);

select tests.logout();
select * from finish();
rollback;
