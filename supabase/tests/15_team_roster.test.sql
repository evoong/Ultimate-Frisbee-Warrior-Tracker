begin;
select plan(4);

-- team_roster is a SECURITY DEFINER view (see the migration's comment for
-- why it can't be security_invoker), so its cross-team safety rests
-- entirely on the explicit my_member_team_ids() predicate in its
-- definition. These tests exist because pgTAP's usual RLS coverage does
-- not reach a view at all -- there is no policy to exercise.

select tests.login_as('captain@local.test');
select lives_ok(
  $$ select * from public.team_roster where team_id = 1 $$,
  'a team member can select from team_roster without a 42501 on auth.users'
);
select is(
  (select count(*)::int from public.team_roster where team_id = 1),
  4,
  'captain@local.test sees exactly their own team''s 4 roster rows'
);

-- The leak case: outsider@local.test is a captain of team 2 only, with no
-- membership on team 1 at all.
select tests.logout();
select tests.login_as('outsider@local.test');
select is_empty(
  $$ select * from public.team_roster where team_id = 1 $$,
  'outsider@local.test (team 2 captain) sees zero rows for team 1'
);

-- Guests: my_member_team_ids() returns '{}' for an anonymous caller, so
-- the predicate excludes every row.
select tests.logout();
select tests.login_as_guest();
select is_empty(
  $$ select * from public.team_roster $$,
  'a guest sees zero team_roster rows anywhere'
);

select tests.logout();
select * from finish();
rollback;
