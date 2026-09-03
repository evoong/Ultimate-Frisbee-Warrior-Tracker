begin;
select plan(9);

-- Every assertion below turns one row of the spec's escalation-vector
-- table into a test that must fail loudly. A suite that only proves
-- people can do things proves nothing about security.

-- 1. Self-promotion through the table.
select tests.login_as('member@local.test');
select throws_ok(
  $$ update public.team_members set role = 'captain' where user_id = (select auth.uid()) $$,
  '42501', null,
  'ESCALATION: member cannot UPDATE their own role to captain'
);

-- 2. Self-insertion of a membership row.
select throws_ok(
  $$ insert into public.team_members (team_id, user_id, role)
     values (2, (select auth.uid()), 'member') $$,
  '42501', null,
  'ESCALATION: member cannot INSERT themselves into another team'
);

-- 3. Self-promotion through the RPC.
select throws_ok(
  format($$ select public.set_member_role(1, %L::uuid, 'captain') $$, (select auth.uid())),
  'P0001', 'only a captain can change roles',
  'ESCALATION: member cannot promote themselves via RPC'
);

-- 4. Editors cannot widen their own grant.
select tests.logout();
select tests.login_as('editor@local.test');
select throws_ok(
  $$ select public.invite_member(1, 'newedit@local.test', 'editor') $$,
  'P0001', 'only a captain can grant the editor role',
  'ESCALATION: editor cannot mint another editor'
);

-- 5. Cross-tenant row movement, both directions.
select tests.logout();
select tests.login_as('member@local.test');
select throws_ok(
  $$ update public.game_events set organization_id = 2 where organization_id = 1 $$,
  '42501', null,
  'ESCALATION: member cannot move their team''s rows into another team'
);
-- game_events is a tier A table: reads are "members OR the owning team is
-- public", and org 2 is seeded public (see 11_domain_rls.test.sql, "a
-- guest can read a public team's games"). So a member of org 1 seeing
-- org 2's game_events is the public-team feature working as designed, not
-- an escalation -- asserting is_empty here would be false, and "fixing"
-- it would mean tightening tier A reads and destroying the public-team
-- feature Task 14 built. Retargeted at strategy_plays, a tier B table,
-- where isolation is absolute with no public branch at all (see the same
-- suite, "a guest cannot read strategy on a public team"). Do not retarget
-- this back to game_events.
select is_empty(
  $$ select id from public.strategy_plays where organization_id = 2 $$,
  'ESCALATION: member cannot see another team''s strategy, even a public team''s'
);

-- 6. Guests write nothing, anywhere.
select tests.logout();
select tests.login_as_guest();
select throws_ok(
  $$ insert into public.players (first_name, organization_id) values ('Ghost', 2) $$,
  '42501', null,
  'ESCALATION: guest cannot insert into a public team'
);

-- 7. Guests cannot enumerate rosters.
select is_empty(
  $$ select id from public.team_members $$,
  'ESCALATION: guest cannot enumerate any team roster'
);

-- 8. The last captain is immovable.
select tests.logout();
select tests.login_as('captain@local.test');
select throws_ok(
  format($$ select public.remove_member(1, %L::uuid) $$, (select auth.uid())),
  'P0001', 'team 1 must have at least one captain',
  'ESCALATION: the last captain cannot leave and orphan the team'
);

select tests.logout();
select * from finish();
rollback;
