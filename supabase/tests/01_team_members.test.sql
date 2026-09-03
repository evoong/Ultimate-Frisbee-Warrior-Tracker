begin;
select plan(4);

select has_table('public', 'team_members', 'team_members exists');

select throws_ok(
  $$ insert into public.team_members (team_id, user_id, role)
     values (1, (select id from auth.users where email = 'member@local.test'), 'owner') $$,
  '23514',
  null,
  'role is constrained to captain/editor/member'
);

-- Seeded state: org 1 has exactly one captain.
select throws_ok(
  $$ delete from public.team_members
      where team_id = 1
        and user_id = (select id from auth.users where email = 'captain@local.test') $$,
  'P0001',
  'team 1 must have at least one captain',
  'removing the last captain raises'
);

select throws_ok(
  $$ update public.team_members set role = 'member'
      where team_id = 1
        and user_id = (select id from auth.users where email = 'captain@local.test') $$,
  'P0001',
  'team 1 must have at least one captain',
  'demoting the last captain raises'
);

select * from finish();
rollback;
