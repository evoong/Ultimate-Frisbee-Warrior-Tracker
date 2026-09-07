begin;
select plan(5);

-- The triage tables are written only by the Express server under the
-- service-role key. Nothing in the browser reads or writes them, so they get
-- no policies at all -- and with RLS enabled and zero policies, every
-- authenticated role must see nothing. These assertions exist so that a
-- later "convenience" policy cannot quietly open them up.

insert into public.feedback_clusters (type, title, summary, github_issue_number, status)
values ('bug', 'Schedule fails to load', 'Repeated reports of a blank schedule', 900, 'open');

insert into public.feedback_reports
  (reporter_user_id, type, title, description, cluster_id, counts_toward_threshold)
select
  (select id from auth.users where email = 'member@local.test'),
  'bug', 'blank schedule', 'the schedule is blank',
  (select id from public.feedback_clusters where github_issue_number = 900),
  true;

select tests.login_as('member@local.test');
select is_empty(
  $$ select id from public.feedback_clusters $$,
  'an authenticated team member cannot read feedback_clusters'
);
select is_empty(
  $$ select id from public.feedback_reports $$,
  'an authenticated team member cannot read feedback_reports'
);
select tests.logout();

select tests.login_as('captain@local.test');
select is_empty(
  $$ select id from public.feedback_reports $$,
  'not even a captain can read feedback_reports'
);
select tests.logout();

-- Counting semantics: the threshold is distinct reporters, so one user
-- submitting twice must count once, and a report flagged as not counting
-- (a guest, or a user on no team) must not count at all.
insert into public.feedback_reports
  (reporter_user_id, type, title, description, cluster_id, counts_toward_threshold)
select
  (select id from auth.users where email = 'member@local.test'),
  'bug', 'blank schedule again', 'still blank',
  (select id from public.feedback_clusters where github_issue_number = 900),
  true;

insert into public.feedback_reports
  (reporter_user_id, type, title, description, cluster_id, counts_toward_threshold)
select
  (select id from auth.users where email = 'unlinked@local.test'),
  'bug', 'blank schedule', 'blank for me too',
  (select id from public.feedback_clusters where github_issue_number = 900),
  false;

select is(
  (select count(distinct reporter_user_id)
     from public.feedback_reports
    where cluster_id = (select id from public.feedback_clusters where github_issue_number = 900)
      and counts_toward_threshold),
  1::bigint,
  'two submissions from one reporter count once, and a non-counting report is excluded'
);

select is(
  (select count(*) from public.feedback_reports
    where cluster_id = (select id from public.feedback_clusters where github_issue_number = 900)),
  3::bigint,
  'every report is still stored, including the ones that do not count'
);

select * from finish();
rollback;
