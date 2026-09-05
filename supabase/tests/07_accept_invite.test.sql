begin;
select plan(5);

insert into public.team_invites (team_id, email, role)
values (1, 'unconfirmed@local.test', 'member'),
       (1, 'outsider@local.test',    'member');

select tests.login_as('unconfirmed@local.test');
select throws_ok(
  $$ select * from public.accept_invite() $$,
  'P0001', 'confirm your email address before joining a team',
  'an unconfirmed email cannot accept an invite'
);

-- team_members has RLS on with zero policies until Task 13, so an
-- authenticated session sees no rows at all; this assertion has to run
-- as postgres (via tests.logout()) and identify the subject by email,
-- or it would pass vacuously regardless of whether a membership exists.
select tests.logout();
select is_empty(
  $$ select m.id from public.team_members m
       join auth.users u on u.id = m.user_id
      where m.team_id = 1 and u.email = 'unconfirmed@local.test' $$,
  'no membership was created for the unconfirmed user'
);

select tests.login_as('outsider@local.test');
select is(
  (select count(*)::int from public.accept_invite()),
  1,
  'a confirmed user consumes their pending invite'
);

select tests.logout();
select is(
  (select m.role from public.team_members m
     join auth.users u on u.id = m.user_id
    where m.team_id = 1 and u.email = 'outsider@local.test'),
  'member',
  'the invite role is what gets granted'
);

select tests.login_as('outsider@local.test');
select is(
  (select count(*)::int from public.accept_invite()),
  0,
  'accepting twice is a no-op'
);

select tests.logout();
select * from finish();
rollback;
