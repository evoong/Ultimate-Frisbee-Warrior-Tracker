-- Invitee-side of team invites. Until now accept_invite() joined a user to
-- every team that had invited their email the moment their session loaded:
-- silent, with no way to see which team asked or to say no. These three
-- functions let the invitee see their invitations and accept or decline each.
-- accept_invite() stays (pgTAP covers it) but the gateway no longer calls it.
create or replace function public.my_pending_invites()
returns table (
  id               bigint,
  team_id          bigint,
  team_name        text,
  role             text,
  invited_by_email text,
  expires_at       timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, i.team_id, o.name, i.role, u.email::text, i.expires_at
    from public.team_invites i
    join public.organizations o on o.id = i.team_id
    left join auth.users u on u.id = i.invited_by
   where i.accepted_at is null
     and i.expires_at > now()
     -- Only a confirmed, non-anonymous address can hold an invitation.
     and i.email = (
       select lower(a.email) from auth.users a
        where a.id = (select auth.uid())
          and a.email_confirmed_at is not null
          and not coalesce(a.is_anonymous, false)
     )
   order by i.created_at desc;
$$;

create or replace function public.accept_team_invite(p_invite_id bigint)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid     uuid;
  v_email   text;
  v_team_id bigint;
  v_role    text;
  v_by      uuid;
begin
  perform public.assert_not_guest();
  v_uid := (select auth.uid());

  select lower(u.email) into v_email
    from auth.users u where u.id = v_uid and u.email_confirmed_at is not null;
  if v_email is null then
    raise exception 'confirm your email address before joining a team';
  end if;

  update public.team_invites i
     set accepted_at = now(), accepted_by = v_uid
   where i.id = p_invite_id
     and i.email = v_email
     and i.accepted_at is null
     and i.expires_at > now()
  returning i.team_id, i.role, i.invited_by into v_team_id, v_role, v_by;
  -- Someone else's invite and a nonexistent one read the same.
  if v_team_id is null then
    raise exception 'no such invitation';
  end if;

  insert into public.team_members (team_id, user_id, role, invited_by)
  values (v_team_id, v_uid, v_role, v_by)
  on conflict (team_id, user_id) do nothing;

  return v_team_id;
end;
$$;

create or replace function public.decline_team_invite(p_invite_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted bigint;
begin
  perform public.assert_not_guest();
  delete from public.team_invites i
   where i.id = p_invite_id
     and i.accepted_at is null
     and i.email = (
       select lower(u.email) from auth.users u where u.id = (select auth.uid())
     )
  returning i.id into v_deleted;
  if v_deleted is null then
    raise exception 'no such invitation';
  end if;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.my_pending_invites()',
    'public.accept_team_invite(bigint)',
    'public.decline_team_invite(bigint)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$$;
