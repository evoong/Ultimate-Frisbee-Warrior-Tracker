-- Per-member metrics in admin_user_detail + live_scoring flag seed.
--
-- NOTE: this suite runs wherever the local QA stack is up (npm run db:test);
-- on devices where the stack is kept stopped it runs in CI.
begin;
select plan(6);

-- live_scoring seeded, default off, and chat_langgraph deliberately absent
select is(
  (select default_on from public.feature_flags where key = 'live_scoring'),
  false,
  'live_scoring seeded with default_on false');
select is(
  (select count(*)::int from public.feature_flags where key = 'chat_langgraph'),
  0,
  'chat_langgraph is not seeded (old chat loop was deleted by PR #158)');

-- user detail metrics shape, against the QA seed's known admin user
select is(
  (select count(*)::int from public.game_events where created_by = (select id from auth.users where email = 'ericxvoong+admin@gmail.com')),
  (select (public.admin_user_detail((select id from auth.users where email = 'ericxvoong+admin@gmail.com'))::jsonb->'metrics'->>'events_recorded')::int),
  'metrics.events_recorded matches game_events.created_by count');

select has_key(
  (select public.admin_user_detail((select id from auth.users where email = 'ericxvoong+admin@gmail.com'))::jsonb->'metrics'),
  'chat_messages',
  'metrics carries chat_messages');
select has_key(
  (select public.admin_user_detail((select id from auth.users where email = 'ericxvoong+admin@gmail.com'))::jsonb->'metrics'),
  'last_event_at',
  'metrics carries last_event_at');

-- every pre-existing key survived the replace
select is(
  (select count(*)::int from jsonb_object_keys(public.admin_user_detail((select id from auth.users where email = 'ericxvoong+admin@gmail.com'))::jsonb)
   where jsonb_object_keys in ('user', 'memberships', 'player_links', 'pending_invites', 'feedback_report_count')),
  5,
  'all pre-existing payload keys survived');

select * from finish();
rollback;
