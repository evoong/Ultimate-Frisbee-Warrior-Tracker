-- Shared guard. Every write RPC calls this first.
create or replace function public.assert_not_guest()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if public.is_guest() or (select auth.uid()) is null then
    raise exception 'guests cannot perform this action';
  end if;
end;
$$;

create or replace function public.create_team(p_name text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team_id bigint;
begin
  perform public.assert_not_guest();

  if coalesce(btrim(p_name), '') = '' then
    raise exception 'team name is required';
  end if;

  insert into public.organizations (name, is_public)
  values (btrim(p_name), false)
  returning id into v_team_id;

  insert into public.team_members (team_id, user_id, role)
  values (v_team_id, (select auth.uid()), 'captain');

  return v_team_id;
end;
$$;

create or replace function public.invite_member(
  p_team_id bigint,
  p_email   text,
  p_role    text default 'member'
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email     text := lower(btrim(p_email));
  v_caller    uuid;
  v_is_captain boolean;
  v_invite_id bigint;
begin
  perform public.assert_not_guest();
  v_caller := (select auth.uid());

  if p_role not in ('member', 'editor') then
    raise exception 'invalid invite role: %', p_role;
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid email address';
  end if;

  if not (p_team_id = any (public.my_manage_team_ids())) then
    raise exception 'insufficient permissions on this team';
  end if;

  v_is_captain := p_team_id = any (public.my_captain_team_ids());
  if p_role = 'editor' and not v_is_captain then
    raise exception 'only a captain can grant the editor role';
  end if;

  if exists (
    select 1 from public.team_members m
     where m.team_id = p_team_id
       and m.user_id = (select u.id from auth.users u where lower(u.email) = v_email limit 1)
  ) then
    raise exception 'that person is already on this team';
  end if;

  insert into public.team_invites (team_id, email, role, invited_by)
  values (p_team_id, v_email, p_role, v_caller)
  on conflict (team_id, email) where accepted_at is null
  do update set role = excluded.role, invited_by = excluded.invited_by,
                expires_at = now() + interval '30 days'
  returning id into v_invite_id;

  return v_invite_id;
end;
$$;

create or replace function public.revoke_invite(p_invite_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team_id bigint;
begin
  perform public.assert_not_guest();

  select team_id into v_team_id
    from public.team_invites
   where id = p_invite_id and accepted_at is null;

  if v_team_id is null then
    raise exception 'no such pending invite';
  end if;
  if not (v_team_id = any (public.my_manage_team_ids())) then
    raise exception 'insufficient permissions on this team';
  end if;

  delete from public.team_invites where id = p_invite_id;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.assert_not_guest()',
    'public.create_team(text)',
    'public.invite_member(bigint, text, text)',
    'public.revoke_invite(bigint)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$$;
