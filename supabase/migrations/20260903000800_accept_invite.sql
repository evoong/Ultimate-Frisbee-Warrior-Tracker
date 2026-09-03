create or replace function public.accept_invite()
returns table (team_id bigint, role text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid       uuid;
  v_email     text;
  v_confirmed timestamptz;
begin
  perform public.assert_not_guest();
  v_uid := (select auth.uid());

  select lower(u.email), u.email_confirmed_at
    into v_email, v_confirmed
    from auth.users u
   where u.id = v_uid;

  if v_confirmed is null then
    raise exception 'confirm your email address before joining a team';
  end if;

  return query
  with claimed as (
    update public.team_invites i
       set accepted_at = now(), accepted_by = v_uid
     where i.email = v_email
       and i.accepted_at is null
       and i.expires_at > now()
       and not exists (
         select 1 from public.team_members m
          where m.team_id = i.team_id and m.user_id = v_uid
       )
    returning i.team_id, i.role, i.invited_by
  ), inserted as (
    insert into public.team_members (team_id, user_id, role, invited_by)
    select c.team_id, v_uid, c.role, c.invited_by from claimed c
    on conflict (team_id, user_id) do nothing
    returning team_members.team_id, team_members.role
  )
  select i.team_id, i.role from inserted i;
end;
$$;

revoke all on function public.accept_invite() from public, anon;
grant execute on function public.accept_invite() to authenticated;
