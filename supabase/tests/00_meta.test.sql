begin;
select plan(5);

-- EXPECTED TO FAIL until Task 14 replaces 017's `using (true)` policies.
-- Do not weaken or skip this test; it is the suite's proof of validity.
--
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
        and c.relkind = 'r'
        and not c.relrowsecurity $$,
  'every table in public has RLS enabled'
);

-- standings is deprecated and intentionally has zero policies (016 dropped
-- them); nothing reads or writes it, so no access is the correct state.
select is_empty(
  $$ select c.relname::text
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
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

select * from finish();
rollback;
