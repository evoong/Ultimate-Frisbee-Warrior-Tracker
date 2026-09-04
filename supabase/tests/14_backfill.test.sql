begin;
select plan(6);

-- Fixture: an org in the pre-migration shape, mirroring production.
insert into public.organizations (id, name, is_public) overriding system value
values (900, 'My Team', false);

insert into public.organization_members (organization_id, email, role)
values (900, 'captain@local.test',  'owner'),     -- has an account
       (900, 'member@local.test',   'member'),    -- has an account
       (900, 'ghost@local.test',    'member');    -- no account anywhere

select public.backfill_team_memberships();

select is(
  (select role from public.team_members
    where team_id = 900
      and user_id = (select id from auth.users where email = 'captain@local.test')),
  'captain',
  'owner is carried over as captain'
);
select is(
  (select role from public.team_members
    where team_id = 900
      and user_id = (select id from auth.users where email = 'member@local.test')),
  'member',
  'member role is preserved'
);
select is(
  (select count(*)::int from public.team_invites
    where team_id = 900 and email = 'ghost@local.test' and accepted_at is null),
  1,
  'a member with no account becomes a pending invite, never a deletion'
);
select is(
  (select (expires_at - created_at) > interval '60 days' from public.team_invites
    where team_id = 900 and email = 'ghost@local.test'),
  true,
  'backfill invites get the longer 90-day expiry'
);
select is(
  (select count(*)::int from public.team_members where team_id = 900),
  2,
  'no membership row was invented for an accountless email'
);

-- Idempotence: re-running must not duplicate anything.
select public.backfill_team_memberships();
select is(
  (select count(*)::int from public.team_members where team_id = 900),
  2,
  'the backfill is safely re-runnable'
);

select * from finish();
rollback;
