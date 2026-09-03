insert into storage.buckets (id, name, public)
values ('player-photos', 'player-photos', true),
       ('team-photos',   'team-photos',   true)
on conflict (id) do nothing;

-- Path convention: the first segment is the owning team id, which is what
-- makes a team-scoped policy expressible at all.
create or replace function public.storage_path_team_id(p_name text)
returns bigint
language sql
immutable
as $$
  select case
    when split_part(p_name, '/', 1) ~ '^[0-9]+$'
      then split_part(p_name, '/', 1)::bigint
    else null
  end;
$$;

-- Locally, storage.objects has zero policies (the baseline dump only
-- covers the public schema), so this drop loop is a no-op here. In
-- production it removes 001/016's any-member policies before the
-- team-scoped ones below replace them.
do $$
declare p text;
begin
  foreach p in array array[
    'allowlisted insert player photos', 'allowlisted update player photos',
    'allowlisted delete player photos', 'org member insert player photos',
    'org member update player photos',  'org member delete player photos'
  ]
  loop
    execute format('drop policy if exists %I on storage.objects', p);
  end loop;
end
$$;

create policy "team member write player photos" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'player-photos'
    and public.storage_path_team_id(name) = any ((select public.my_member_team_ids())::bigint[])
  );

create policy "team member update player photos" on storage.objects
  for update to authenticated
  using      (bucket_id = 'player-photos'
              and public.storage_path_team_id(name) = any ((select public.my_member_team_ids())::bigint[]))
  with check (bucket_id = 'player-photos'
              and public.storage_path_team_id(name) = any ((select public.my_member_team_ids())::bigint[]));

create policy "team member delete player photos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'player-photos'
         and public.storage_path_team_id(name) = any ((select public.my_member_team_ids())::bigint[]));

-- Team photos are team identity, so manage-tier rather than member-tier.
create policy "manager write team photos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'team-photos'
              and public.storage_path_team_id(name) = any ((select public.my_manage_team_ids())::bigint[]));

create policy "manager update team photos" on storage.objects
  for update to authenticated
  using      (bucket_id = 'team-photos'
              and public.storage_path_team_id(name) = any ((select public.my_manage_team_ids())::bigint[]))
  with check (bucket_id = 'team-photos'
              and public.storage_path_team_id(name) = any ((select public.my_manage_team_ids())::bigint[]));

create policy "manager delete team photos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'team-photos'
         and public.storage_path_team_id(name) = any ((select public.my_manage_team_ids())::bigint[]));
