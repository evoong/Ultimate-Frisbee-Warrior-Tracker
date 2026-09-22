begin;
select plan(9);

-- Migration check: columns exist
select has_column('public', 'organizations', 'tier', 'organizations has tier');
select has_column('public', 'organizations', 'trial_ends_at', 'organizations has trial_ends_at');
select has_column('public', 'organizations', 'plan_source', 'organizations has plan_source');

-- Test effective_tier logic
insert into public.organizations (id, name) values (999, 'test-org');
update public.organizations set is_employee_granted = true where id = 999;
select is(
  public.effective_tier(999),
  'premium'::public.org_tier,
  'employee_granted org is premium'
);

-- RLS Check: insert a row in ai_usage_logs and verify no access to outsider
insert into public.ai_usage_logs (organization_id, month_key, message_count) values (999, '2026-09', 10);
select tests.login_as('outsider@local.test');
select is_empty(
  $$ select * from public.ai_usage_logs where organization_id = 999 $$,
  'RLS prevents outsider from seeing usage logs'
);
select tests.logout();

-- Test increment_ai_usage RPC
select public.increment_ai_usage(999);
select is(
  (select message_count from public.ai_usage_logs where organization_id = 999 and month_key = to_char(now(), 'YYYY-MM')),
  11,
  'increment_ai_usage atomically increments existing usage log'
);

select public.refund_ai_message(999);
select is(
  (select message_count from public.ai_usage_logs where organization_id = 999 and month_key = to_char(now(), 'YYYY-MM')),
  10,
  'refund_ai_message decrements current month usage'
);

select public.refund_ai_message(1000);
select is(
  (select message_count from public.ai_usage_logs where organization_id = 1000 and month_key = to_char(now(), 'YYYY-MM')),
  null,
  'refund_ai_message does nothing for non-existent log'
);

insert into public.ai_usage_logs (organization_id, month_key, message_count) values (1001, to_char(now(), 'YYYY-MM'), 0);
select public.refund_ai_message(1001);
select is(
  (select message_count from public.ai_usage_logs where organization_id = 1001 and month_key = to_char(now(), 'YYYY-MM')),
  0,
  'refund_ai_message does not decrement below zero'
);

select * from finish();
rollback;
