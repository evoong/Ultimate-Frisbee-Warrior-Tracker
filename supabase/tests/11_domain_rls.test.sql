begin;
select plan(10);

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

select tests.logout();
select * from finish();
rollback;
