begin;
select plan(5);

-- Seeded while still running as postgres (bypasses RLS), so there is a
-- concrete team-1 row for the cross-team SELECT check below to fail to see.
insert into storage.objects (bucket_id, name, owner)
values ('team-photos', '1/existing-logo.jpg', null);

-- This is the exact operation that was broken: storage-api's real upload
-- path does `INSERT ... RETURNING`, not a plain INSERT, and with zero
-- SELECT policies on storage.objects that RETURNING failed 42501 for
-- every role, in both buckets. captain@local.test and member@local.test
-- are both on team 1 (scripts/seed-local-memberships.sql).
select tests.login_as('captain@local.test');
select lives_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     values ('team-photos', '1/logo.jpg', (select auth.uid()))
     returning id $$,
  'a captain''s team-photo upload succeeds with RETURNING (storage-api''s real insert shape)'
);
select isnt_empty(
  $$ select id from storage.objects where bucket_id = 'team-photos' and name = '1/existing-logo.jpg' $$,
  'a captain can read their own team''s photo objects'
);

select tests.logout();
select tests.login_as('member@local.test');
select lives_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     values ('player-photos', '1/101.jpg', (select auth.uid()))
     returning id $$,
  'a member''s player-photo upload succeeds with RETURNING (storage-api''s real insert shape)'
);

-- outsider@local.test is a captain of team 2 only (scripts/seed-local-
-- memberships.sql), with no relationship to team 1 at all.
select tests.logout();
select tests.login_as('outsider@local.test');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     values ('player-photos', '1/999.jpg', (select auth.uid())) $$,
  '42501',
  null,
  'the new SELECT policy does not widen write access -- an outsider still cannot write into another team''s path'
);
select is_empty(
  $$ select id from storage.objects where bucket_id = 'team-photos' and name = '1/existing-logo.jpg' $$,
  'an outsider (team 2 captain) cannot read another team''s photo objects'
);

select tests.logout();
select * from finish();
rollback;
