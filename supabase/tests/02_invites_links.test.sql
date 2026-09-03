begin;
select plan(5);

select has_table('public', 'team_invites', 'team_invites exists');
select has_table('public', 'player_links', 'player_links exists');

-- Captaincy is granted by promotion, never by invitation. Enforced in the
-- schema so no RPC bug can widen it.
select throws_ok(
  $$ insert into public.team_invites (team_id, email, role)
     values (1, 'x@local.test', 'captain') $$,
  '23514',
  null,
  'an invite can never carry role captain'
);

select throws_ok(
  $$ insert into public.team_invites (team_id, email, role)
     values (1, 'MixedCase@local.test', 'member') $$,
  '23514',
  null,
  'invite emails must be lowercase'
);

select throws_ok(
  $$ insert into public.team_invites (team_id, email, role)
     values (1, 'first@local.test', 'member'),
            (1, 'first@local.test', 'member') $$,
  '23505',
  null,
  'duplicate pending invites for one email are rejected'
);

select * from finish();
rollback;
