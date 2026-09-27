-- Self-service ownership transfer: a captain promotes a member/editor to
-- captain and steps down to editor in one transaction. The admin RPC
-- (admin_transfer_captainship) is service-role only and cannot be reused
-- here: it assumes platform-admin authorization. This one gates on
-- my_captain_team_ids() exactly like set_member_role, so the last-captain
-- trigger can never fire mid-transfer (the UPDATE that would empty the
-- captain set never happens -- both writes land in the same statement pair
-- with the promote first).

create or replace function public.transfer_captainship(
  p_team_id        bigint,
  p_new_captain_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_not_guest();

  if not (p_team_id = any (public.my_captain_team_ids())) then
    raise exception 'only a captain can transfer captainship';
  end if;

  if p_new_captain_id = (select auth.uid()) then
    raise exception 'the captain cannot transfer captainship to themselves';
  end if;

  if not exists (
    select 1 from public.team_members
     where team_id = p_team_id and user_id = p_new_captain_id
  ) then
    raise exception 'that person is not on this team';
  end if;

  -- Promote target first. enforce_last_captain() is a BEFORE UPDATE OR
  -- DELETE trigger on team_members; because the promote lands before the
  -- demote, the demote never sees a captainless team.
  update public.team_members
     set role = 'captain'
   where team_id = p_team_id and user_id = p_new_captain_id;

  -- Step down: demote the caller only. Other captains (if any) keep their
  -- role -- this is "make owner and step down", not "consolidate".
  update public.team_members
     set role = 'editor'
   where team_id = p_team_id
     and user_id = (select auth.uid())
     and role = 'captain';
end;
$$;

revoke all on function public.transfer_captainship(bigint, uuid) from public, anon;
grant execute on function public.transfer_captainship(bigint, uuid) to authenticated;
