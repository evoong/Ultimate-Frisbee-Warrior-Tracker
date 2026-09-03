begin;
select plan(5);

-- auth.users is unreadable once tests.login_as switches the session role to
-- `authenticated`, so capture the ids while still running as the owner.
create temp table t_uids as
  select email, id from auth.users where email like '%@local.test';
grant select on t_uids to authenticated;

-- player_links has RLS on with zero policies until Task 13/14, so an
-- authenticated session cannot read back a row it just inserted via the
-- definer RPC. Stash the returned link id while logged in, then read the
-- stored status back as postgres.
create temp table t_links(label text, link_id bigint);
grant insert, select on t_links to authenticated;

select tests.login_as('member@local.test');
insert into t_links values ('m103', public.claim_player(103));
select tests.logout();
select is(
  (select status from public.player_links
    where id = (select link_id from t_links where label = 'm103')),
  'pending',
  'a member self-claim starts pending'
);

select tests.login_as('member@local.test');
select throws_ok(
  $$ select public.claim_player(104) $$,
  'P0001', 'no such player on your teams',
  'a member cannot claim a player on a team they do not belong to'
);
select throws_ok(
  format(
    $$ select public.set_player_link(101, %L::uuid) $$,
    (select id from t_uids where email = 'member@local.test')
  ),
  'P0001', 'insufficient permissions on this team',
  'a member cannot assign links'
);

select tests.logout();
select tests.login_as('captain@local.test');
insert into t_links values ('c101', public.set_player_link(
  101, (select id from t_uids where email = 'captain@local.test')));
select tests.logout();
select is(
  (select status from public.player_links
    where id = (select link_id from t_links where label = 'c101')),
  'approved',
  'a captain-assigned link is approved immediately'
);

select tests.login_as_guest();
select throws_ok(
  $$ select public.claim_player(103) $$,
  'P0001', 'guests cannot perform this action',
  'a guest cannot claim a player'
);

select tests.logout();
select * from finish();
rollback;
