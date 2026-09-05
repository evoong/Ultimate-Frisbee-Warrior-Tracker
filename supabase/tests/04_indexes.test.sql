begin;
select plan(2);

select has_column('public', 'organizations', 'photo_url', 'organizations has photo_url');

select is_empty(
  $$ select c.relname::text
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id'
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')
        and not exists (
          select 1 from pg_index i
           where i.indrelid = c.oid
             and a.attnum = any (i.indkey)
        ) $$,
  'every table with organization_id has an index that includes it'
);

select * from finish();
rollback;
