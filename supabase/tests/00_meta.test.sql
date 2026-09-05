begin;
select plan(7);

-- Canary: proves RLS is actually applied under tests.login_as. If the test
-- session were running as a table owner or BYPASSRLS role, this returns
-- rows and every other policy test in this suite is meaningless.
select tests.login_as('outsider@local.test');
select is_empty(
  $$ select id from public.game_events where organization_id = 1 $$,
  'RLS canary: an outsider sees no rows from another org'
);
select tests.logout();

select is_empty(
  $$ select c.relname::text
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')
        and not c.relrowsecurity $$,
  'every table in public has RLS enabled'
);

-- standings is deprecated and now has zero policies: Task 4
-- (20260905000200_lockdown_standings.sql) dropped the last remaining one
-- ("authenticated read" using (true)) because the table is confirmed
-- dead/unused -- see that migration for the rationale. The exclusion
-- below is now load-bearing: without it, standings (having no policy at
-- all) would fail this "every table has at least one policy" assertion
-- the same way a misconfigured table would.
select is_empty(
  $$ select c.relname::text
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')
        and c.relname <> 'standings'
        and not exists (select 1 from pg_policy p where p.polrelid = c.oid) $$,
  'every table in public has at least one policy'
);

select is_empty(
  $$ select p.proname::text
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prosecdef
        and (p.proconfig is null
             or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')) $$,
  'every security definer function in public pins search_path'
);

select is_empty(
  $$ select p.proname::text
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prosecdef
        and has_function_privilege('anon', p.oid, 'EXECUTE') $$,
  'no security definer function in public is executable by anon'
);

-- FIX 2: event_types, standings and organization_members sat outside the
-- strict_rls tier loop and its explicit revokes, so anon kept TRUNCATE (and
-- every other grant) on them even after this migration claimed the rule
-- applied everywhere. Assert directly against the ACL rather than one
-- table at a time, so no future table can slip through the same way.
select is_empty(
  $$ select c.relname::text
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')
        and a.grantee = 'anon'::regrole $$,
  'anon holds no privilege on any table in public'
);

-- M4: 20260903000300_invites_and_links.sql states in a comment that no
-- policy anywhere reads player_links. Check both the USING and WITH CHECK
-- expressions of every policy in public and storage, so the comment stays
-- true rather than aspirational.
select is_empty(
  $$ select p.polname::text
       from pg_policy p
       join pg_class c on c.oid = p.polrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'storage')
        and (
          coalesce(pg_get_expr(p.polqual, p.polrelid), '') like '%player_links%'
          or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') like '%player_links%'
        ) $$,
  'no policy anywhere references player_links'
);

select * from finish();
rollback;
