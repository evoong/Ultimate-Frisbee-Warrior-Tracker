begin;
-- chat_action_proposals: RLS enabled, zero policies, service-role only.
-- QA-stack-gated: runs under npm run db:test after npm run qa:reset.
select plan(3);

select has_table('public', 'chat_action_proposals', 'table exists');

select ok(
  exists (select 1 from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'chat_action_proposals' and c.relrowsecurity),
  'RLS is enabled');

select is_empty(
  $$ select p.polname::text from pg_policy p
       join pg_class c on c.oid = p.polrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'chat_action_proposals' $$,
  'zero policies: service-role only');

select * from finish();
rollback;
