-- storage.objects has zero SELECT policies (see the comment below the
-- INSERT policies), which means authenticated cannot see any object rows
-- at all. Postgres evaluates a table's SELECT policies to build the WHERE
-- clause an UPDATE or DELETE runs against, so with no SELECT policy the
-- UPDATE and DELETE policies below are correct but inert -- they never get
-- a row to evaluate, member-owned or not. Measured directly: an
-- own-team DELETE returns "DELETE 0", identical to a cross-team one.
--
-- The INSERT policies are the load-bearing ones today -- they are what
-- lets uploads happen at all -- and this migration does not add a SELECT
-- policy, because whether members may list photo objects is a product
-- decision that belongs in the spec and Plan 3, not one invented here at
-- the end of Plan 1. Plan 3 must decide whether photo replace/delete runs
-- through the service role (bypassing RLS, no SELECT policy needed) or
-- needs a scoped SELECT policy added so the UPDATE/DELETE policies here
-- can actually see rows.
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
set search_path = ''
as $$
  select case
    when split_part(p_name, '/', 1) ~ '^[0-9]+$'
     and length(split_part(p_name, '/', 1)) <= 18
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
