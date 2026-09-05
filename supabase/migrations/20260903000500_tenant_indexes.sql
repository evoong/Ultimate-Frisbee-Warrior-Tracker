alter table public.organizations add column if not exists photo_url text;

do $$
declare
  t record;
begin
  for t in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id'
     where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format(
      'create index if not exists %I on public.%I (organization_id)',
      t.relname || '_organization_id_idx', t.relname
    );
  end loop;
end
$$;
