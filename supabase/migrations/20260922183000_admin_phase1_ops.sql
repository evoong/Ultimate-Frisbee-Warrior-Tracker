-- Phase 1 Admin Operations: Captain Transfer & Direct Invite Tokens

-- Add token_hash column to team_invites for secure direct invite links
alter table public.team_invites add column if not exists token_hash text unique;

create or replace function public.admin_transfer_captainship(
  p_org_id bigint,
  p_new_captain_id uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_captains uuid[];
begin
  if not exists (select 1 from public.organizations where id = p_org_id) then
    raise exception 'organization % does not exist', p_org_id;
  end if;

  if not exists (select 1 from public.team_members where team_id = p_org_id and user_id = p_new_captain_id) then
    raise exception 'user % is not a member of organization %', p_new_captain_id, p_org_id;
  end if;

  select array_agg(user_id) into v_old_captains
    from public.team_members
   where team_id = p_org_id and role = 'captain';

  -- 1. Promote target
  update public.team_members
     set role = 'captain'
   where team_id = p_org_id and user_id = p_new_captain_id;

  -- 2. Demote others to editor
  update public.team_members
     set role = 'editor'
   where team_id = p_org_id and role = 'captain' and user_id <> p_new_captain_id;

  return jsonb_build_object(
    'organization_id', p_org_id,
    'new_captain', p_new_captain_id,
    'demoted_captains', coalesce(v_old_captains, array[]::uuid[]),
    'reason', p_reason
  );
end;
$$;

create or replace function public.admin_create_invite_token(
  p_org_id bigint,
  p_email text,
  p_role text,
  p_token_hash text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite_id bigint;
begin
  if not exists (select 1 from public.organizations where id = p_org_id) then
    raise exception 'organization % does not exist', p_org_id;
  end if;

  insert into public.team_invites (team_id, email, role, token_hash, expires_at)
  values (p_org_id, lower(trim(p_email)), p_role, p_token_hash, now() + interval '14 days')
  returning id into v_invite_id;

  return jsonb_build_object('invite_id', v_invite_id, 'expires_at', now() + interval '14 days');
end;
$$;

revoke all on function public.admin_transfer_captainship(bigint, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_create_invite_token(bigint, text, text, text) from public, anon, authenticated;