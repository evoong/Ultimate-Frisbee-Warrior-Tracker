begin;
select plan(7);

insert into public.organizations (id, name, trial_started_at)
values (997, 'trial-once', now());
select ok(
  not public.can_start_trial(997),
  'org that already started trial cannot start another'
);

insert into public.organizations (id, name) values (996, 'trial-fresh');
select ok(
  public.can_start_trial(996),
  'org that never started trial can start one'
);

insert into public.organizations (id, name, trial_ends_at)
values (995, 'trial-legacy', now() + interval '10 days');
select ok(
  not public.can_start_trial(995),
  'legacy org with trial_ends_at cannot start another trial'
);

insert into public.organizations (id, name, stripe_customer_id)
values (994, 'stripe-trial', 'cus_billing_test');

select is(
  public.process_stripe_webhook_event('evt_trial', 'checkout.session.completed', 'cus_billing_test', 'sub_billing_test', 'trialing', now() + interval '30 days', 'premium', true),
  'ok', 'signed checkout event activates trial'
);
select ok(
  (select trial_started_at is not null and tier = 'premium' from public.organizations where id = 994),
  'trial records usage and premium entitlement'
);
select is(
  public.process_stripe_webhook_event('evt_trial', 'checkout.session.completed', 'cus_billing_test', 'sub_billing_test', 'trialing', now() + interval '30 days', 'premium', true),
  'duplicate', 'replayed checkout event ignored'
);
select is(
  public.process_stripe_webhook_event('evt_failed', 'invoice.payment_failed', 'cus_billing_test', 'sub_billing_test', 'past_due', now(), null, false),
  'ok', 'failed payment processed'
);

select * from finish();
rollback;