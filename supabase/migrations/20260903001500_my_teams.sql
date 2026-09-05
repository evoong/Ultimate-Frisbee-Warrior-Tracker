-- Replace my_organizations() (email-keyed organization_members lookup, predates
-- Plan 1) with my_teams(), which reads the real team_members table and also
-- returns the caller's role on each team.
create or replace function public.my_teams()
returns table (organization_id bigint, name text, role text, is_public boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.name, m.role, o.is_public
    from public.team_members m
    join public.organizations o on o.id = m.team_id
   where m.user_id = (select auth.uid())
   order by o.id;
$$;

revoke all on function public.my_teams() from public, anon;
grant execute on function public.my_teams() to authenticated;

drop function if exists public.my_organizations();
