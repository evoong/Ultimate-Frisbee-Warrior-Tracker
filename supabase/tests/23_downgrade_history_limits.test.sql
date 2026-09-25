begin;
select plan(5);

-- Fixture: a free-tier org, one game 31 days old and one 15 days old,
-- one event on each. Seeded while running as postgres, before any login.
insert into public.organizations (id, name, tier, plan_source) overriding system value
values (1001, 'Free Org', 'free'::public.org_tier, 'stripe'::public.plan_source_type);

insert into public.games (id, organization_id, opponent, game_date, game_time, game_type)
values
  (101, 1001, 'Old Opponent', current_date - interval '31 days', '19:00', 'Regular'),
  (102, 1001, 'Recent Opponent', current_date - interval '15 days', '19:00', 'Regular');

insert into public.game_events (id, organization_id, game_id, event_type, event_timestamp)
values
  (1001, 1001, 101, 'Goal', now() - interval '31 days'),
  (1002, 1001, 102, 'Goal', now() - interval '15 days');

-- member@local.test must belong to org 1001 for the select policy's
-- membership branch to match at all.
insert into public.team_members (team_id, user_id, role)
values (1001, (select id from auth.users where email = 'member@local.test'), 'member');

-- 1. Free tier: only events whose game is within the 30-day window.
select tests.login_as('member@local.test');
select results_eq(
  $$ select count(*)::int from public.game_events where organization_id = 1001 $$,
  $$ values (1) $$,
  'Free org select RLS should restrict game events to those within past 30 days'
);

-- 2. The 31-day-old event itself is invisible.
select is_empty(
  $$ select 1 from public.game_events where organization_id = 1001 and game_id = 101 $$,
  'free tier cannot read an event on a game older than 30 days'
);

-- 3. The 15-day-old event is still readable.
select isnt_empty(
  $$ select 1 from public.game_events where organization_id = 1001 and game_id = 102 $$,
  'free tier can read an event on a game within 30 days'
);
select tests.logout();

-- 4. Automatic restore on re-upgrade: flip the tier, same rows, full history.
update public.organizations set tier = 'premium' where id = 1001;
select tests.login_as('member@local.test');
select results_eq(
  $$ select count(*)::int from public.game_events where organization_id = 1001 $$,
  $$ values (2) $$,
  're-upgrading to premium restores full history with no backfill'
);
select tests.logout();

-- 5. Downgrading again re-imposes the window.
update public.organizations set tier = 'free' where id = 1001;
select tests.login_as('member@local.test');
select results_eq(
  $$ select count(*)::int from public.game_events where organization_id = 1001 $$,
  $$ values (1) $$,
  'downgrading back to free re-imposes the 30-day window'
);
select tests.logout();

select * from finish();
rollback;
