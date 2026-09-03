create or replace function public.is_guest()
returns boolean
language sql
stable
as $$
  select coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false);
$$;

-- Every membership helper returns an empty array for an anonymous caller,
-- so a guest cannot match any row before any explicit guest check runs.
create or replace function public.my_member_team_ids()
returns bigint[]
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.is_guest() then '{}'::bigint[]
         else coalesce((
           select array_agg(team_id order by team_id)
             from public.team_members
            where user_id = (select auth.uid())
         ), '{}'::bigint[]) end;
$$;

create or replace function public.my_manage_team_ids()
returns bigint[]
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.is_guest() then '{}'::bigint[]
         else coalesce((
           select array_agg(team_id order by team_id)
             from public.team_members
            where user_id = (select auth.uid())
              and role in ('captain', 'editor')
         ), '{}'::bigint[]) end;
$$;

create or replace function public.my_captain_team_ids()
returns bigint[]
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.is_guest() then '{}'::bigint[]
         else coalesce((
           select array_agg(team_id order by team_id)
             from public.team_members
            where user_id = (select auth.uid())
              and role = 'captain'
         ), '{}'::bigint[]) end;
$$;

create or replace function public.public_team_ids()
returns bigint[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select array_agg(id order by id) from public.organizations where is_public
  ), '{}'::bigint[]);
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.my_member_team_ids()', 'public.my_manage_team_ids()',
    'public.my_captain_team_ids()', 'public.public_team_ids()'
  ]
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$$;
