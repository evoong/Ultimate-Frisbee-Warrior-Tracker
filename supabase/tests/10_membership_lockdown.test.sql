begin;
select plan(6);

select tests.login_as('member@local.test');

select throws_ok(
  $$ insert into public.team_members (team_id, user_id, role)
     values (2, (select auth.uid()), 'captain') $$,
  '42501',
  'permission denied for table team_members',
  'no INSERT privilege on team_members, at any role'
);
select throws_ok(
  $$ update public.team_members set role = 'captain' where user_id = (select auth.uid()) $$,
  '42501',
  'permission denied for table team_members',
  'no UPDATE privilege on team_members'
);
select throws_ok(
  $$ insert into public.team_invites (team_id, email, role)
     values (2, 'sneaky@local.test', 'editor') $$,
  '42501',
  'permission denied for table team_invites',
  'no INSERT privilege on team_invites'
);
select throws_ok(
  $$ update public.player_links set status = 'approved' where team_id = 1 $$,
  '42501',
  'permission denied for table player_links',
  'no UPDATE privilege on player_links'
);

select is(
  (select count(*)::int from public.team_members where team_id = 1),
  4,
  'a member can read their own team roster'
);
select is_empty(
  $$ select id from public.team_members where team_id = 2 $$,
  'a member cannot read another team roster'
);

select tests.logout();
select * from finish();
rollback;
