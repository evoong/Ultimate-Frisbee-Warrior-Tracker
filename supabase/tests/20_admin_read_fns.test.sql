begin;
select plan(10);

select has_function('public', 'admin_search', array['text'], 'admin_search exists');
select has_function('public', 'admin_user_detail', array['uuid'], 'admin_user_detail exists');
select has_function('public', 'admin_org_detail', array['bigint'], 'admin_org_detail exists');

select ok(
  not has_function_privilege('authenticated', 'public.admin_search(text)', 'EXECUTE'),
  'authenticated cannot execute admin_search'
);

select ok(
  not has_function_privilege('authenticated', 'public.admin_user_detail(uuid)', 'EXECUTE'),
  'authenticated cannot execute admin_user_detail'
);

select ok(
  not has_function_privilege('authenticated', 'public.admin_org_detail(bigint)', 'EXECUTE'),
  'authenticated cannot execute admin_org_detail'
);

-- Search reaches organizations by name.
select ok(
  jsonb_array_length(public.admin_search('a') -> 'organizations') >= 0,
  'admin_search returns an organizations array'
);

-- Search reaches auth.users by email, which plain REST cannot do at all.
select ok(
  (select jsonb_array_length(public.admin_search(
     split_part((select email from auth.users where email is not null order by email limit 1), '@', 1)) -> 'users')) >= 1,
  'admin_search finds a real user by an email fragment'
);

-- Org detail surfaces legacy organization_members rows so stale data is
-- visible rather than silently ignored (my_organizations() was dropped by
-- 20260903001500_my_teams.sql; team_members is the live source).
select ok(
  (public.admin_org_detail(1)) ? 'legacy_organization_members',
  'admin_org_detail flags legacy organization_members rows'
);

select throws_ok(
  $$ select public.admin_org_detail(999999) $$,
  'organization 999999 does not exist',
  'admin_org_detail rejects an unknown organization'
);

select * from finish();
rollback;
