begin;
select plan(6);

-- auth.users is unreadable once tests.login_as switches the session role to
-- `authenticated`, so capture the ids while still running as the owner.
create temp table t_uids as
  select email, id from auth.users where email like '%@local.test';
grant select on t_uids to authenticated;

select tests.login_as('member@local.test');
select throws_ok(
  format(
    $$ select public.set_member_role(1, %L::uuid, 'captain') $$,
    (select id from t_uids where email = 'member@local.test')
  ),
  'P0001', 'only a captain can change roles',
  'a member cannot promote themselves to captain'
);

select tests.logout();
select tests.login_as('editor@local.test');
select throws_ok(
  format(
    $$ select public.set_member_role(1, %L::uuid, 'editor') $$,
    (select id from t_uids where email = 'member@local.test')
  ),
  'P0001', 'only a captain can change roles',
  'an editor cannot change roles'
);
select throws_ok(
  format(
    $$ select public.remove_member(1, %L::uuid) $$,
    (select id from t_uids where email = 'captain@local.test')
  ),
  'P0001', 'only a captain can remove a captain or an editor',
  'an editor cannot remove a captain'
);
select lives_ok(
  format(
    $$ select public.remove_member(1, %L::uuid) $$,
    (select id from t_uids where email = 'unlinked@local.test')
  ),
  'an editor can remove a plain member'
);

select tests.logout();
select tests.login_as('captain@local.test');
select throws_ok(
  format(
    $$ select public.set_member_role(1, %L::uuid, 'member') $$,
    (select id from t_uids where email = 'captain@local.test')
  ),
  'P0001', 'team 1 must have at least one captain',
  'the last captain cannot demote themselves'
);
select lives_ok(
  format(
    $$ select public.set_member_role(1, %L::uuid, 'editor') $$,
    (select id from t_uids where email = 'member@local.test')
  ),
  'a captain can grant the editor role'
);

select tests.logout();
select * from finish();
rollback;
