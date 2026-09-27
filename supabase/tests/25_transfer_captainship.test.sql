begin;
select plan(5);

create temp table t_uids as
  select email, id from auth.users where email like '%@local.test';
grant select on t_uids to authenticated;

-- Member cannot transfer captainship
select tests.login_as('member@local.test');
select throws_ok(
  format(
    $$ select public.transfer_captainship(1, %L::uuid) $$,
    (select id from t_uids where email = 'editor@local.test')
  ),
  'P0001', 'only a captain can transfer captainship',
  'a member cannot transfer captainship'
);

-- Editor cannot transfer captainship
select tests.logout();
select tests.login_as('editor@local.test');
select throws_ok(
  format(
    $$ select public.transfer_captainship(1, %L::uuid) $$,
    (select id from t_uids where email = 'member@local.test')
  ),
  'P0001', 'only a captain can transfer captainship',
  'an editor cannot transfer captainship'
);

-- Captain cannot transfer to self
select tests.logout();
select tests.login_as('captain@local.test');
select throws_ok(
  format(
    $$ select public.transfer_captainship(1, %L::uuid) $$,
    (select id from t_uids where email = 'captain@local.test')
  ),
  'P0001', 'the captain cannot transfer captainship to themselves',
  'captain cannot transfer to themselves'
);

-- Captain can transfer captainship to an existing member/editor
select lives_ok(
  format(
    $$ select public.transfer_captainship(1, %L::uuid) $$,
    (select id from t_uids where email = 'editor@local.test')
  ),
  'captain successfully transfers captainship to editor'
);

-- Confirm roles after transfer: target is captain, former captain is editor
select results_eq(
  format(
    $$ select role from public.team_members where team_id = 1 and user_id in (%L::uuid, %L::uuid) order by user_id $$,
    (select id from t_uids where email = 'captain@local.test'),
    (select id from t_uids where email = 'editor@local.test')
  ),
  $$ values ('editor'::text), ('captain'::text) $$,
  'target promoted to captain, former captain demoted to editor'
);

select tests.logout();
select * from finish();
rollback;
