begin;
select plan(7);

select has_table('public', 'chat_actions', 'chat_actions table exists');
select has_column('public', 'chat_logs', 'request_id', 'chat_logs has request_id column');
select col_type_is('public', 'chat_actions', 'id', 'uuid', 'id is uuid');
select col_type_is('public', 'chat_actions', 'before_rows', 'jsonb', 'before_rows is jsonb');
select col_type_is('public', 'chat_actions', 'after_rows', 'jsonb', 'after_rows is jsonb');

-- pgTAP ships no row_security_active(); assert RLS against the catalog
-- the same way 21_feature_flags.test.sql does.
select is(
  (select c.relrowsecurity::int
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'chat_actions'),
  1,
  'chat_actions has RLS enabled'
);

-- The single owner-scoped select policy is the only policy on the table.
select policies_are(
  'public',
  'chat_actions',
  ARRAY['owner read']
);

select * from finish();
rollback;
