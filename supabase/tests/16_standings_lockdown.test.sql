begin;
select plan(3);

-- 20260905000200_lockdown_standings.sql dropped the only policy on
-- public.standings ("authenticated read" ... USING (true)), which let any
-- authenticated user on any team read every row, including every other
-- team's standings. The table is deprecated/unused by application code
-- (see that migration's comment), so the fix is default-deny with no
-- replacement policy rather than a tenant-scoped one.
--
-- Seeded as postgres (bypasses RLS) so the assertions below have a real
-- row to fail on, not an empty table that would pass either way.
insert into public.standings (season_id, team_name) values (1, 'Disc-iples');

select tests.login_as('member@local.test');
select is_empty(
  $$ select id from public.standings $$,
  'an authenticated team member cannot read any row in standings'
);
select tests.logout();

-- Not just members of the seeded row's own team -- no authenticated role
-- at all should see it, captain included.
select tests.login_as('captain@local.test');
select is_empty(
  $$ select id from public.standings $$,
  'an authenticated captain cannot read any row in standings'
);
select tests.logout();

select tests.login_as_guest();
select is_empty(
  $$ select id from public.standings $$,
  'a guest cannot read any row in standings'
);
select tests.logout();

select * from finish();
rollback;
