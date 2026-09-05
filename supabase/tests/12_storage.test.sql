begin;
select plan(3);

select tests.login_as('member@local.test');
select lives_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     values ('player-photos', '1/103.jpg', (select auth.uid())) $$,
  'a member can upload a photo under their own team prefix'
);
select throws_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     values ('player-photos', '2/104.jpg', (select auth.uid())) $$,
  '42501',
  null,
  'a member cannot upload under another team prefix'
);

select tests.logout();
select tests.login_as_guest();
select throws_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     values ('player-photos', '2/104.jpg', (select auth.uid())) $$,
  '42501',
  null,
  'a guest cannot upload at all'
);

select tests.logout();
select * from finish();
rollback;
