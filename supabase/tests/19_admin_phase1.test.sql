begin;
select plan(5);

select has_column('public', 'team_invites', 'token_hash', 'team_invites stores hashed direct invite tokens');
select has_function('public', 'admin_transfer_captainship', ARRAY['bigint', 'uuid', 'text'], 'captain transfer RPC exists');
select has_function('public', 'admin_create_invite_token', ARRAY['bigint', 'text', 'text', 'text'], 'invite-token RPC exists');

select function_privs_are(
  'public',
  'admin_transfer_captainship',
  ARRAY['bigint', 'uuid', 'text'],
  'anon',
  ARRAY[]::text[],
  'anon cannot execute captain transfer RPC'
);

select function_privs_are(
  'public',
  'admin_create_invite_token',
  ARRAY['bigint', 'text', 'text', 'text'],
  'authenticated',
  ARRAY[]::text[],
  'authenticated cannot execute invite-token RPC'
);

select * from finish();
rollback;