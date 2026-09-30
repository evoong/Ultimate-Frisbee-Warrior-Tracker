begin;
select plan(14);

select is(
  public.is_email_deleted('never-existed@local.test'),
  false,
  'a never-deleted email reports false'
);

insert into public.deleted_accounts (email, user_id, trial_used)
select 'gone@local.test', id, true from auth.users limit 1;

insert into public.deleted_accounts (email, user_id, trial_used)
select 'CASEGONE@LOCAL.TEST', id, false from auth.users limit 1;

select is(
  public.is_email_deleted('gone@local.test'),
  true,
  'a tombstoned email reports true'
);
select is(
  public.is_email_deleted('GONE@LOCAL.TEST'),
  true,
  'an uppercase lookup finds a lowercase tombstone'
);
select is(
  public.is_email_deleted('casegone@local.test'),
  true,
  'a lowercase lookup finds an uppercase tombstone'
);

delete from public.deleted_accounts
 where email in ('gone@local.test', 'CASEGONE@LOCAL.TEST');

select is(
  public.is_email_deleted('gone@local.test'),
  false,
  'a removed tombstone reports false again'
);
select is(
  public.is_email_deleted('CASEGONE@LOCAL.TEST'),
  false,
  'a removed uppercase tombstone reports false again'
);

select set_config('role', 'anon', true);
select throws_ok(
  $$ select email from public.deleted_accounts $$,
  '42501',
  null,
  'anon cannot SELECT deleted_accounts'
);
select throws_ok(
  $$ insert into public.deleted_accounts (email, user_id)
     values ('probe@local.test', '00000000-0000-0000-0000-000000000000') $$,
  '42501',
  null,
  'anon cannot INSERT into deleted_accounts'
);
select throws_ok(
  $$ update public.deleted_accounts set trial_used = true $$,
  '42501',
  null,
  'anon cannot UPDATE deleted_accounts'
);
select throws_ok(
  $$ delete from public.deleted_accounts $$,
  '42501',
  null,
  'anon cannot DELETE from deleted_accounts'
);
reset role;

select tests.login_as('member@local.test');
select throws_ok(
  $$ select email from public.deleted_accounts $$,
  '42501',
  null,
  'authenticated cannot SELECT deleted_accounts'
);
select throws_ok(
  $$ insert into public.deleted_accounts (email, user_id)
     values ('probe@local.test', '00000000-0000-0000-0000-000000000000') $$,
  '42501',
  null,
  'authenticated cannot INSERT into deleted_accounts'
);
select throws_ok(
  $$ update public.deleted_accounts set trial_used = true $$,
  '42501',
  null,
  'authenticated cannot UPDATE deleted_accounts'
);
select throws_ok(
  $$ delete from public.deleted_accounts $$,
  '42501',
  null,
  'authenticated cannot DELETE from deleted_accounts'
);
select tests.logout();

select * from finish();
rollback;
