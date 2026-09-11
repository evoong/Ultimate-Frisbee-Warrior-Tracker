-- Read-side support for the admin console.
--
-- These are SQL functions rather than REST queries for one reason: auth.users
-- is not exposed over Supabase REST, so "find the user with this email" and
-- "when did this account last sign in" are unanswerable from the handler
-- layer. Paginating GoTrue's /admin/users endpoint instead would cap search at
-- a single page and vary across GoTrue versions.
--
-- Service-role-only, like every other admin function here.

create or replace function public.admin_search(p_q text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'query', p_q,
    'organizations', coalesce((
      select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'is_public', o.is_public)
                       order by o.name)
        from public.organizations o
       where o.name ilike '%' || p_q || '%'
       limit 25
    ), '[]'::jsonb),
    'users', coalesce((
      select jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email,
                                          'last_sign_in_at', u.last_sign_in_at)
                       order by u.email)
        from auth.users u
       where u.email ilike '%' || p_q || '%'
       limit 25
    ), '[]'::jsonb),
    'players', coalesce((
      select jsonb_agg(jsonb_build_object('id', pl.id, 'display_name', pl.display_name,
                                          'organization_id', pl.organization_id)
                       order by pl.display_name)
        from public.players pl
       where pl.display_name ilike '%' || p_q || '%'
       limit 25
    ), '[]'::jsonb)
  );
$$;

create or replace function public.admin_user_detail(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  select email into v_email from auth.users where id = p_user_id;
  if not found then
    raise exception 'user % does not exist', p_user_id;
  end if;

  return jsonb_build_object(
    'user', (
      select jsonb_build_object('id', u.id, 'email', u.email,
                                'created_at', u.created_at,
                                'last_sign_in_at', u.last_sign_in_at,
                                'is_anonymous', u.is_anonymous)
        from auth.users u where u.id = p_user_id
    ),
    -- team_members.team_id is a foreign key to organizations(id).
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object('organization_id', o.id, 'name', o.name,
                                          'role', m.role, 'since', m.created_at)
                       order by o.name)
        from public.team_members m
        join public.organizations o on o.id = m.team_id
       where m.user_id = p_user_id
    ), '[]'::jsonb),
    'player_links', coalesce((
      select jsonb_agg(jsonb_build_object('link_id', l.id, 'player_id', l.player_id,
                                          'display_name', pl.display_name,
                                          'organization_id', l.team_id, 'status', l.status)
                       order by l.id)
        from public.player_links l
        join public.players pl on pl.id = l.player_id
       where l.user_id = p_user_id
    ), '[]'::jsonb),
    -- Invites are addressed by email, so they are found by email, not user id.
    'pending_invites', coalesce((
      select jsonb_agg(jsonb_build_object('invite_id', i.id, 'organization_id', i.team_id,
                                          'role', i.role, 'expires_at', i.expires_at)
                       order by i.id)
        from public.team_invites i
       where i.email = lower(v_email) and i.accepted_at is null
    ), '[]'::jsonb),
    'feedback_report_count', (
      select count(*) from public.feedback_reports r where r.reporter_user_id = p_user_id
    )
  );
end;
$$;

create or replace function public.admin_org_detail(p_org_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.organizations where id = p_org_id) then
    raise exception 'organization % does not exist', p_org_id;
  end if;

  return jsonb_build_object(
    'organization', (
      select jsonb_build_object('id', o.id, 'name', o.name, 'is_public', o.is_public,
                                'created_at', o.created_at)
        from public.organizations o where o.id = p_org_id
    ),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', u.email,
                                          'role', m.role, 'since', m.created_at)
                       order by m.role, u.email)
        from public.team_members m
        join auth.users u on u.id = m.user_id
       where m.team_id = p_org_id
    ), '[]'::jsonb),
    'pending_invites', coalesce((
      select jsonb_agg(jsonb_build_object('invite_id', i.id, 'email', i.email,
                                          'role', i.role, 'expires_at', i.expires_at)
                       order by i.email)
        from public.team_invites i
       where i.team_id = p_org_id and i.accepted_at is null
    ), '[]'::jsonb),
    -- teams is a secondary grouping (games/seasons/league_games reference it),
    -- NOT the tenant. Listed for orientation only.
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by t.name)
        from public.teams t where t.organization_id = p_org_id
    ), '[]'::jsonb),
    'counts', jsonb_build_object(
      'players', (select count(*) from public.players  where organization_id = p_org_id),
      'seasons', (select count(*) from public.seasons  where organization_id = p_org_id),
      'games',   (select count(*) from public.games    where organization_id = p_org_id)
    ),
    -- organization_members predates team_members and its only reader,
    -- my_organizations(), was dropped by 20260903001500_my_teams.sql. Any rows
    -- here are stale. Surfaced rather than hidden so the operator can see
    -- legacy data instead of wondering why a member list disagrees.
    'legacy_organization_members', coalesce((
      select jsonb_agg(jsonb_build_object('email', om.email, 'role', om.role)
                       order by om.email)
        from public.organization_members om where om.organization_id = p_org_id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.admin_search(text)            from public, anon, authenticated;
revoke all on function public.admin_user_detail(uuid)       from public, anon, authenticated;
revoke all on function public.admin_org_detail(bigint)      from public, anon, authenticated;
