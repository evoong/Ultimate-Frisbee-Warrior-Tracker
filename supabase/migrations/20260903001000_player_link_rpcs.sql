create or replace function public.claim_player(p_player_id integer)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team_id bigint;
  v_link_id bigint;
begin
  perform public.assert_not_guest();

  -- A nonexistent player id and a player on another team are collapsed into
  -- one message so an authenticated caller cannot enumerate player ids
  -- across tenant boundaries by distinguishing "does not exist" from
  -- "exists but is not yours" (same anti-pattern remove_member documents
  -- avoiding in 20260903000900_role_management.sql).
  select organization_id into v_team_id from public.players where id = p_player_id;
  if v_team_id is null or not (v_team_id = any (public.my_member_team_ids())) then
    raise exception 'no such player on your teams';
  end if;

  insert into public.player_links (team_id, player_id, user_id, status)
  values (v_team_id, p_player_id, (select auth.uid()), 'pending')
  returning id into v_link_id;

  return v_link_id;
end;
$$;

create or replace function public.set_player_link(p_player_id integer, p_user_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team_id bigint;
  v_link_id bigint;
begin
  perform public.assert_not_guest();

  -- A nonexistent player id and a player on another team are collapsed into
  -- one message so an authenticated caller cannot enumerate player ids
  -- across tenant boundaries by distinguishing "does not exist" from
  -- "exists but is not yours" (same anti-pattern remove_member documents
  -- avoiding in 20260903000900_role_management.sql). Once the caller is
  -- known to at least belong to the player's team, "wrong role" is a fact
  -- they are entitled to be told plainly.
  select organization_id into v_team_id from public.players where id = p_player_id;
  if v_team_id is null or not (v_team_id = any (public.my_member_team_ids())) then
    raise exception 'no such player on your teams';
  end if;
  if not (v_team_id = any (public.my_manage_team_ids())) then
    raise exception 'insufficient permissions on this team';
  end if;
  if not exists (
    select 1 from public.team_members where team_id = v_team_id and user_id = p_user_id
  ) then
    raise exception 'that person is not on this team';
  end if;

  insert into public.player_links (team_id, player_id, user_id, status)
  values (v_team_id, p_player_id, p_user_id, 'approved')
  on conflict (player_id) do update
    set user_id = excluded.user_id, status = 'approved'
  returning id into v_link_id;

  return v_link_id;
end;
$$;

create or replace function public.approve_claim(p_link_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team_id bigint;
begin
  perform public.assert_not_guest();

  -- A nonexistent link id and a link on another team are collapsed into one
  -- message so an authenticated caller cannot enumerate link ids across
  -- tenant boundaries by distinguishing "does not exist" from "exists but
  -- is not yours" (same anti-pattern remove_member documents avoiding in
  -- 20260903000900_role_management.sql). Once the caller is known to at
  -- least belong to the link's team, "wrong role" is a fact they are
  -- entitled to be told plainly.
  select team_id into v_team_id from public.player_links where id = p_link_id;
  if v_team_id is null or not (v_team_id = any (public.my_member_team_ids())) then
    raise exception 'no such claim on your teams';
  end if;
  if not (v_team_id = any (public.my_manage_team_ids())) then
    raise exception 'insufficient permissions on this team';
  end if;

  update public.player_links set status = 'approved' where id = p_link_id;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.claim_player(integer)',
    'public.set_player_link(integer, uuid)',
    'public.approve_claim(bigint)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$$;
