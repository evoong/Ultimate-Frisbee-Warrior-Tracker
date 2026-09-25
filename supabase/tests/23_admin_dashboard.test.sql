-- pgTAP suite for the admin dashboard RPCs
-- (supabase/migrations/20260926000000_admin_dashboard.sql).
--
-- Payload shapes are pinned to docs/superpowers/specs/2026-09-25-admin-orgs-dashboard-design.md §RPCs.
begin;
select plan(37);

-- --- Privileges: same lockdown as every other admin RPC ---
select ok(
  not has_function_privilege('authenticated', 'public.admin_list_organizations(text,text,text,int,int)', 'EXECUTE'),
  'authenticated cannot execute admin_list_organizations'
);
select ok(
  not has_function_privilege('authenticated', 'public.admin_dashboard(date,date,text)', 'EXECUTE'),
  'authenticated cannot execute admin_dashboard'
);

-- --- admin_list_organizations ---

-- No filter: every org comes back.
select is(
  (select jsonb_array_length(public.admin_list_organizations(null,'name','asc',200,0) -> 'rows')),
  (select count(*)::int from public.organizations),
  'list returns every org with no filter');
select is(
  (select (public.admin_list_organizations(null,'name','asc',200,0) -> 'total')::text),
  (select count(*)::text from public.organizations),
  'total matches the org count');

-- Whitelists.
select throws_ok(
  $$ select public.admin_list_organizations(null,'bogus_sort; drop table','asc',50,0) $$,
  'invalid sort column: bogus_sort; drop table',
  'sort whitelist enforced');
select throws_ok(
  $$ select public.admin_list_organizations(null,'name','sideways',50,0) $$,
  'invalid dir: sideways',
  'dir whitelist enforced');

-- q filter narrows both rows and total.
select is(
  (select jsonb_array_length(public.admin_list_organizations('Team A','name','asc',50,0) -> 'rows')),
  1,
  'q filter narrows rows');
select is(
  (select (public.admin_list_organizations('Team A','name','asc',50,0) -> 'total')::text),
  '1',
  'q filter narrows total');

-- Paging: limit and offset.
select is(
  (select jsonb_array_length(public.admin_list_organizations(null,'name','asc',1,0) -> 'rows')),
  1,
  'limit 1 returns one row');
select is(
  (select (public.admin_list_organizations(null,'name','asc',1,0) -> 'rows' -> 0 ->> 'name')),
  'Team A (private)',
  'name asc puts Team A first');
select is(
  (select (public.admin_list_organizations(null,'name','asc',1,1) -> 'rows' -> 0 ->> 'name')),
  'Team B (public)',
  'offset 1 returns the second org');

-- Member count correctness for a known org.
select is(
  (select count(*)::int from public.team_members where team_id = 1),
  4,
  'seed sanity: org 1 has 4 members');
select is(
  (select (r ->> 'members')::int
     from jsonb_array_elements(public.admin_list_organizations(null,'name','asc',200,0) -> 'rows') r
    where (r ->> 'id')::int = 1),
  (select count(*)::int from public.team_members where team_id = 1),
  'members matches team_members for org 1');

-- Null last_activity sorts last on desc. The QA seed has no zero-activity
-- org (both seeded orgs have game_events and strategy_plays), so create one
-- and remove it again before the dashboard section below reads org counts.
insert into public.organizations (name, is_public)
values ('__pgtap_no_activity__', false);

select is(
  (select ((public.admin_list_organizations(null,'last_activity','desc',200,0) -> 'rows'
            -> (jsonb_array_length(public.admin_list_organizations(null,'last_activity','desc',200,0) -> 'rows') - 1))
           ->> 'last_activity') is null),
  true,
  'null last_activity sorts last on desc');
select is(
  (select ((public.admin_list_organizations(null,'last_activity','desc',200,0) -> 'rows' -> 0)
           ->> 'last_activity') is not null),
  true,
  'most recent activity sorts first on desc');

delete from public.organizations where name = '__pgtap_no_activity__';

-- --- admin_dashboard ---

-- Range validation.
select throws_ok(
  $$ select public.admin_dashboard('1900-01-01'::date, '2026-09-25'::date, 'day') $$,
  'range too large: max 370 days',
  'range cap raises');
select throws_ok(
  $$ select public.admin_dashboard(current_date - 371, current_date, 'day') $$,
  'range too large: max 370 days',
  'range cap raises at 371 days');
select is(
  (select public.admin_dashboard(current_date - 370, current_date, 'day') -> 'range' ->> 'from'),
  (current_date - 370)::text,
  '370-day span allowed');
select throws_ok(
  $$ select public.admin_dashboard('2026-09-25'::date, '2026-09-24'::date, 'day') $$,
  'invalid range: from after to',
  'inverted range rejected');
select throws_ok(
  $$ select public.admin_dashboard('2026-09-01'::date, '2026-09-25'::date, 'fortnight') $$,
  'invalid grain: fortnight',
  'grain whitelist enforced');

-- Null from/to defaults: 30-day window ending today.
select is(
  (select public.admin_dashboard(null, null, 'day') -> 'range' ->> 'from'),
  (current_date - 29)::text,
  'null from defaults to to - 29');
select is(
  (select public.admin_dashboard(null, null, 'day') -> 'range' ->> 'to'),
  current_date::text,
  'null to defaults to today');

-- Payload groups.
select ok(public.admin_dashboard('2026-09-01'::date, '2026-09-25'::date, 'day') ? 'usage', 'payload has usage');
select ok(public.admin_dashboard('2026-09-01'::date, '2026-09-25'::date, 'day') ? 'billing', 'payload has billing');
select ok(public.admin_dashboard('2026-09-01'::date, '2026-09-25'::date, 'day') ? 'engagement', 'payload has engagement');
select ok(public.admin_dashboard('2026-09-01'::date, '2026-09-25'::date, 'day') ? 'ops', 'payload has ops');
select ok(
  (public.admin_dashboard('2026-09-01'::date, '2026-09-25'::date, 'day') -> 'range') ?& array['from','to','grain']::text[],
  'range object has from, to, grain');

-- Zero-fill: every bucket from from..to is present, and the counts sum to
-- the rows that actually exist in the window (so the fill cannot lose data).
select is(
  (select count(*)::int from jsonb_array_elements(
     public.admin_dashboard('2026-08-01'::date, '2026-08-31'::date, 'day') -> 'usage' -> 'series' -> 'new_orgs')),
  31,
  'new_orgs series fills every day in range');
select is(
  (select sum((e ->> 'count')::int)::int from jsonb_array_elements(
     public.admin_dashboard('2026-08-01'::date, '2026-08-31'::date, 'day') -> 'usage' -> 'series' -> 'new_orgs') e),
  (select count(*)::int from public.organizations
    where created_at >= '2026-08-01'::date and created_at < '2026-09-01'::date),
  'new_orgs counts sum to orgs created in range');
select is(
  (select (public.admin_dashboard('2026-08-01'::date, '2026-08-31'::date, 'day') -> 'usage' -> 'series' -> 'new_orgs' -> 0 ->> 'bucket')),
  '2026-08-01',
  'series buckets are YYYY-MM-DD dates');
select is(
  (select count(*)::int from jsonb_array_elements(
     public.admin_dashboard('2026-09-01'::date, '2026-09-25'::date, 'day') -> 'engagement' -> 'sign_ins')),
  25,
  'sign_ins series fills every day in range');

-- tier_mix: all four keys, and the tier counts sum to every org
-- (employee_granted is a subset, counted separately).
select ok(
  (public.admin_dashboard('2026-09-01'::date, '2026-09-25'::date, 'day') -> 'billing' -> 'tier_mix')
    ?& array['free','plus','premium','employee_granted']::text[],
  'tier_mix has all four keys');
select is(
  (select ((public.admin_dashboard('2026-09-01'::date, '2026-09-25'::date, 'day') -> 'billing' -> 'tier_mix' ->> 'free')::int
         + (public.admin_dashboard('2026-09-01'::date, '2026-09-25'::date, 'day') -> 'billing' -> 'tier_mix' ->> 'plus')::int
         + (public.admin_dashboard('2026-09-01'::date, '2026-09-25'::date, 'day') -> 'billing' -> 'tier_mix' ->> 'premium')::int)),
  (select count(*)::int from public.organizations),
  'tier_mix sums to the org count');

-- ai_cap_by_tier is hardcoded to mirror the cap case statement (see
-- migration comment); pinned so the two cannot drift silently.
select is(
  public.admin_dashboard('2026-09-01'::date, '2026-09-25'::date, 'day') -> 'billing' -> 'ai_cap_by_tier',
  '{"free": 5, "plus": 100, "premium": 500}'::jsonb,
  'ai_cap_by_tier mirrors the hardcoded caps');

-- Engagement: active + dormant partitions every org for the range.
select is(
  (select ((public.admin_dashboard(null, null, 'day') -> 'engagement' ->> 'active_orgs_in_range')::int
         + (public.admin_dashboard(null, null, 'day') -> 'engagement' ->> 'dormant_orgs')::int)),
  (select count(*)::int from public.organizations),
  'active + dormant orgs equals every org');

-- Totals tie to source tables.
select is(
  (select (public.admin_dashboard(null, null, 'day') -> 'usage' -> 'totals' ->> 'members')::int),
  (select count(*)::int from public.team_members),
  'usage totals members matches team_members');

select ok(
  (public.admin_dashboard('2026-09-01'::date, '2026-09-25'::date, 'day') -> 'ops')
    ?& array['top_orgs_by_events','pending_invites','unclaimed_player_links','audit_events_in_range']::text[],
  'ops has all four keys');

select * from finish();
rollback;
