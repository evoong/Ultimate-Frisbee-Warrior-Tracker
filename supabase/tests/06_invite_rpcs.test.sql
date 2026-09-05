begin;
select plan(7);

-- create_team is the only way a team comes into existence, and it creates
-- the caller's captain row in the same statement. That atomicity is what
-- lets team_members carry no self-insert policy at all.
select tests.login_as('member@local.test');
select lives_ok(
  $$ select public.create_team('Brand New Team') $$,
  'any signed-in user can create a team'
);

select tests.logout();
select is(
  (select m.role from public.team_members m
     join auth.users u on u.id = m.user_id
    where u.email = 'member@local.test'
      and m.team_id = (select max(id) from public.organizations)),
  'captain',
  'the creator is the new team''s captain'
);

select tests.login_as_guest();
select throws_ok(
  $$ select public.create_team('Guest Team') $$,
  'P0001', 'guests cannot perform this action',
  'a guest cannot create a team'
);

select tests.logout();
select tests.login_as('editor@local.test');
select lives_ok(
  $$ select public.invite_member(1, 'NewPerson@Local.test', 'member') $$,
  'an editor can invite a member (email is normalized)'
);
select throws_ok(
  $$ select public.invite_member(1, 'another@local.test', 'editor') $$,
  'P0001', 'only a captain can grant the editor role',
  'an editor cannot mint another editor'
);

select tests.logout();
select tests.login_as('member@local.test');
select throws_ok(
  $$ select public.invite_member(1, 'nope@local.test', 'member') $$,
  'P0001', 'insufficient permissions on this team',
  'a plain member cannot invite'
);

select tests.logout();
select tests.login_as('outsider@local.test');
select throws_ok(
  $$ select public.invite_member(1, 'nope2@local.test', 'member') $$,
  'P0001', 'insufficient permissions on this team',
  'a captain of another team cannot invite into team 1'
);

select tests.logout();
select * from finish();
rollback;
