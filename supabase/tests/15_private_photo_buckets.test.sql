begin;
select plan(10);

-- 20260905000100_private_photo_buckets.sql flips player-photos and
-- team-photos from public to private and adds the SELECT policies this
-- file exercises. Objects are created via each uploader's own existing
-- INSERT policy (proven separately in 12_storage.test.sql), so a failure
-- to insert here would itself indicate those policies regressed, not
-- just the new SELECT ones.

-- player-photos is member-tier: any team_members row, any role.
select tests.login_as('member@local.test');
select lives_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     values ('player-photos', '1/201.jpg', (select auth.uid())) $$,
  'fixture: team-A member uploads a team-A player photo'
);
select isnt_empty(
  $$ select id from storage.objects
      where bucket_id = 'player-photos' and name = '1/201.jpg' $$,
  'a team-A member can select a player-photos object scoped to their own team'
);
select tests.logout();

-- outsider@local.test is captain of team 2, which is also a team_members
-- row for team 2 (member-tier includes every role), so this insert uses
-- the same member-tier policy against team 2's own prefix.
select tests.login_as('outsider@local.test');
select lives_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     values ('player-photos', '2/202.jpg', (select auth.uid())) $$,
  'fixture: team-B member uploads a team-B player photo'
);
select tests.logout();

select tests.login_as('member@local.test');
select is_empty(
  $$ select id from storage.objects
      where bucket_id = 'player-photos' and name = '2/202.jpg' $$,
  'a team-A member cannot select a player-photos object scoped to team B'
);
select tests.logout();

-- team-photos is manage-tier: editor@local.test is captain/editor role
-- on team 1 (my_manage_team_ids), unlike plain member@local.test above.
select tests.login_as('editor@local.test');
select lives_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     values ('team-photos', '1/301.jpg', (select auth.uid())) $$,
  'fixture: team-A manager uploads a team-A team photo'
);
select isnt_empty(
  $$ select id from storage.objects
      where bucket_id = 'team-photos' and name = '1/301.jpg' $$,
  'a team-A manager can select a team-photos object scoped to their own team'
);
select tests.logout();

-- outsider@local.test is captain of team 2, i.e. manage-tier there too.
select tests.login_as('outsider@local.test');
select lives_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     values ('team-photos', '2/302.jpg', (select auth.uid())) $$,
  'fixture: team-B manager uploads a team-B team photo'
);
select tests.logout();

select tests.login_as('editor@local.test');
select is_empty(
  $$ select id from storage.objects
      where bucket_id = 'team-photos' and name = '2/302.jpg' $$,
  'a team-A manager cannot select a team-photos object scoped to team B'
);
select tests.logout();

-- Guests (real anonymous auth sessions, per this repo's is_guest()
-- convention -- see my_member_team_ids/my_manage_team_ids, which both
-- return an empty array for a guest) get an empty array from both
-- helpers, so no row in either bucket can match, regardless of path.
select tests.login_as_guest();
select is_empty(
  $$ select id from storage.objects where bucket_id = 'player-photos' $$,
  'a guest can select nothing in player-photos'
);
select is_empty(
  $$ select id from storage.objects where bucket_id = 'team-photos' $$,
  'a guest can select nothing in team-photos'
);
select tests.logout();

select * from finish();
rollback;
