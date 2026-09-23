begin;
select plan(3);

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

select * from finish();
rollback;