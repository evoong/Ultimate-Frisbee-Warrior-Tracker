-- Membership is read-only to clients. Every change goes through a
-- security definer RPC that derives the caller from auth.uid(). Revoking
-- the privilege outright is stronger than a policy: a policy can be
-- misread, an absent grant cannot be satisfied.
do $$
declare t text;
begin
  foreach t in array array['team_members', 'team_invites', 'player_links']
  loop
    execute format('revoke insert, update, delete on public.%I from authenticated', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end
$$;

drop policy if exists "member read roster" on public.team_members;
create policy "member read roster" on public.team_members
  for select to authenticated
  using (team_id = any ((select public.my_member_team_ids())::bigint[]));

drop policy if exists "manager read invites" on public.team_invites;
create policy "manager read invites" on public.team_invites
  for select to authenticated
  using (team_id = any ((select public.my_manage_team_ids())::bigint[]));

drop policy if exists "member read links" on public.player_links;
create policy "member read links" on public.player_links
  for select to authenticated
  using (team_id = any ((select public.my_member_team_ids())::bigint[]));
