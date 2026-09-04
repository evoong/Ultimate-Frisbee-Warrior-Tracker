begin;
select plan(6);

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

-- Moving the last captain to another team must be blocked too: role
-- stays 'captain' so the earlier same-team early return doesn't apply,
-- but the origin team (1) would be left with none.
select throws_ok(
  $$ update public.team_members set team_id = 2
      where team_id = 1
        and user_id = (select id from auth.users where email = 'captain@local.test') $$,
  'P0001',
  'team 1 must have at least one captain',
  'moving the last captain to another team raises'
);

-- Deleting a team must cascade cleanly, even through the last-captain
-- guard: the parent organization row being gone means there is no team
-- left to orphan (FIX 1). Throwaway org so we don't disturb the seeded
-- fixtures the assertions above rely on.
insert into public.organizations (id, name, is_public) overriding system value
values (901, 'Deletable Team', false);

insert into public.team_members (team_id, user_id, role)
values (901, (select id from auth.users where email = 'captain@local.test'), 'captain');

select lives_ok(
  $$ delete from public.organizations where id = 901 $$,
  'a team with members can be deleted'
);

select * from finish();
rollback;
