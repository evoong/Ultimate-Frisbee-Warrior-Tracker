-- Per-member usage metrics in admin_user_detail + live_scoring rollout flag.
--
-- live_scoring seeds the registry ahead of the live-scoring surfaces (see
-- .worktrees/live-scoring-polling / live-indicator). Default off; admins
-- pilot it per org via the Flags page. chat_langgraph is deliberately NOT
-- seeded: the LangGraph rewrite (PR #158) deleted the old chat loop, so
-- there is no implementation pair left for that flag to switch.

insert into public.feature_flags (key, description, default_on)
values ('live_scoring',
        'Live in-game scoring and indicator (rollout flag — enable per org to pilot)',
        false)
on conflict (key) do nothing;

-- Extended admin_user_detail: adds a metrics block for the per-member
-- detail page. Every existing key keeps its shape — existing callers
-- (frontend/pages/admin/UserDetail.tsx, gateway/admin/reads.ts) are
-- untouched by the addition.
create or replace function public.admin_user_detail(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_uid_text text := p_user_id::text;
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
    ),
    -- Per-member usage. Both created_by and user_id are text columns in this
    -- schema, so v_uid_text (p_user_id::text) is used rather than bare uuid.
    'metrics', jsonb_build_object(
      'events_recorded', (select count(*) from public.game_events
                           where created_by = v_uid_text),
      'chat_messages',   (select count(*) from public.chat_logs
                           where user_id = v_uid_text),
      'last_event_at',   (select max(created_at) from public.game_events
                           where created_by = v_uid_text)
    )
  );
end;
$$;

revoke all on function public.admin_user_detail(uuid) from public, anon, authenticated;
