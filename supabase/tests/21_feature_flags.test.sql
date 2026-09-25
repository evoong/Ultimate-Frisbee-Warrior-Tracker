begin;
select plan(13);

-- --- Tables exist ---
select has_table('public', 'feature_flags', 'feature_flags table exists');
select has_table('public', 'org_feature_flags', 'org_feature_flags table exists');

-- --- RLS enabled ---
select is(
  (select c.relrowsecurity::int
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'feature_flags'),
  1,
  'feature_flags has RLS enabled'
);
select is(
  (select c.relrowsecurity::int
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'org_feature_flags'),
  1,
  'org_feature_flags has RLS enabled'
);

-- --- No policies ---
select is_empty(
  $$ select p.polname::text
       from pg_policy p
       join pg_class c on c.oid = p.polrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in ('feature_flags', 'org_feature_flags') $$,
  'feature_flags and org_feature_flags have no policies'
);

-- --- Anon holds no privileges ---
select is_empty(
  $$ select c.relname::text
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where n.nspname = 'public'
        and c.relname in ('feature_flags', 'org_feature_flags')
        and a.grantee = 'anon'::regrole $$,
  'anon holds no privilege on feature_flags or org_feature_flags'
);
select is_empty(
  $$ select c.relname::text
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where n.nspname = 'public'
        and c.relname in ('feature_flags', 'org_feature_flags')
        and a.grantee = 'authenticated'::regrole $$,
  'authenticated holds no privilege on feature_flags or org_feature_flags'
);

-- --- Seed row ---
select is(
  (select count(*)::int from public.feature_flags where key = 'show_turnovers'),
  1,
  'seed row show_turnovers exists'
);
select is(
  (select default_on from public.feature_flags where key = 'show_turnovers'),
  false,
  'show_turnovers defaults to false'
);

-- --- admin_org_detail returns metrics and feature_flags keys for org 1 ---
select ok(
  public.admin_org_detail(1) ? 'metrics',
  'admin_org_detail returns metrics key'
);
select ok(
  (public.admin_org_detail(1) -> 'metrics') ?& array['chat_messages', 'game_events', 'strategy_plays', 'attendance', 'last_activity']::text[],
  'metrics holds all five metric keys'
);
select ok(
  (public.admin_org_detail(1) -> 'feature_flags') @> '[{"key": "show_turnovers"}]',
  'feature_flags includes show_turnovers for org 1'
);

-- --- admin_flags returns registry with show_turnovers ---
select ok(
  (public.admin_flags() -> 'registry') @> '[{"key": "show_turnovers"}]',
  'admin_flags registry includes show_turnovers'
);

select * from finish();
rollback;
