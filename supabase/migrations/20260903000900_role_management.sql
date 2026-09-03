create or replace function public.set_member_role(
  p_team_id bigint,
  p_user_id uuid,
  p_role    text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_not_guest();

  if p_role not in ('captain', 'editor', 'member') then
    raise exception 'invalid role: %', p_role;
  end if;
  if not (p_team_id = any (public.my_captain_team_ids())) then
    raise exception 'only a captain can change roles';
  end if;

  update public.team_members
     set role = p_role
   where team_id = p_team_id and user_id = p_user_id;

  if not found then
    raise exception 'that person is not on this team';
  end if;
end;
$$;

-- An editor may remove a plain member, never a captain or another editor.
-- Anyone may remove themselves (leave). The last-captain trigger still
-- applies underneath all of it.
create or replace function public.remove_member(
  p_team_id bigint,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target_role text;
  v_is_self     boolean;
  v_is_captain  boolean;
  v_is_manager  boolean;
begin
  perform public.assert_not_guest();

  v_is_self    := p_user_id = (select auth.uid());
  v_is_captain := p_team_id = any (public.my_captain_team_ids());
  v_is_manager := p_team_id = any (public.my_manage_team_ids());

  select role into v_target_role
    from public.team_members
   where team_id = p_team_id and user_id = p_user_id;

  if v_target_role is null then
    raise exception 'that person is not on this team';
  end if;

  if not v_is_self then
    if not v_is_manager then
      raise exception 'insufficient permissions on this team';
    end if;
    if v_target_role <> 'member' and not v_is_captain then
      raise exception 'only a captain can remove a captain or an editor';
    end if;
  end if;

  delete from public.team_members
   where team_id = p_team_id and user_id = p_user_id;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.set_member_role(bigint, uuid, text)',
    'public.remove_member(bigint, uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$$;
