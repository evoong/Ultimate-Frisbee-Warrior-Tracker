-- Converts the email-keyed organization_members model to uid-keyed
-- team_members. A member whose email has no account becomes a pending
-- invite rather than a deletion: cutover must not silently revoke access
-- from someone who was merely slow to sign up.
create or replace function public.backfill_team_memberships()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.team_members (team_id, user_id, role)
  select om.organization_id,
         u.id,
         case om.role when 'owner' then 'captain' else 'member' end
    from public.organization_members om
    join auth.users u on lower(u.email) = om.email
  on conflict (team_id, user_id) do nothing;

  insert into public.team_invites (team_id, email, role, invited_by, expires_at)
  select om.organization_id,
         om.email,
         case om.role when 'owner' then 'editor' else 'member' end,
         null,
         now() + interval '90 days'
    from public.organization_members om
   where not exists (select 1 from auth.users u where lower(u.email) = om.email)
  on conflict (team_id, email) where accepted_at is null do nothing;
end;
$$;

revoke all on function public.backfill_team_memberships() from public, anon, authenticated;

select public.backfill_team_memberships();
