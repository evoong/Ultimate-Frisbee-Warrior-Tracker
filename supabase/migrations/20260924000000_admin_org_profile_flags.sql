-- Admin org profile metrics & feature flags
--
-- Two tables: a global registry + per-org overrides.
-- Metrics computed on-demand in admin_org_detail.
-- Read via admin_flags (readonly+).

create table public.feature_flags (
  key          text primary key,
  description  text not null,
  default_on   boolean not null default false,
  updated_at   timestamptz not null default now()
);

create table public.org_feature_flags (
  org_id     bigint not null references public.organizations(id) on delete cascade,
  flag_key   text   not null references public.feature_flags(key) on delete cascade,
  enabled    boolean not null,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (org_id, flag_key)
);

alter table public.feature_flags enable row level security;
alter table public.org_feature_flags enable row level security;

revoke all on table public.feature_flags from anon, authenticated;
revoke all on table public.org_feature_flags from anon, authenticated;

-- Seed the turnover flag (matches current hardcoded false)
insert into public.feature_flags (key, description, default_on)
values ('show_turnovers', 'Show turnover metrics and columns (turnover events not yet recordable)', false)
on conflict (key) do nothing;

-- Extended admin_org_detail with metrics + feature_flags
create or replace function public.admin_org_detail(p_org_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_metrics jsonb;
  v_flags jsonb;
begin
  if not exists (select 1 from public.organizations where id = p_org_id) then
    raise exception 'organization % does not exist', p_org_id;
  end if;

  -- Metrics: counts and last activity across product tables
  select jsonb_build_object(
    'chat_messages',   (select count(*) from public.chat_logs          where organization_id = p_org_id),
    'game_events',     (select count(*) from public.game_events        where organization_id = p_org_id),
    'strategy_plays',  (select count(*) from public.strategy_plays     where organization_id = p_org_id),
    'attendance',      (select count(*) from public.game_attendance    where organization_id = p_org_id),
    'last_activity',   (
      select max(dt) from (
        select max(created_at) as dt from public.chat_logs          where organization_id = p_org_id
        union all select max(created_at) from public.game_events     where organization_id = p_org_id
        union all select max(created_at) from public.strategy_plays  where organization_id = p_org_id
        union all select max(created_at) from public.game_attendance where organization_id = p_org_id
      ) u
    )
  ) into v_metrics;

  -- Feature flags: effective value per flag for this org
  -- Use off_ as alias to avoid reserved keyword 'off'
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', ff.key,
    'description', ff.description,
    'default_on', ff.default_on,
    'override', off_.enabled,
    'effective', coalesce(off_.enabled, ff.default_on)
  ) order by ff.key), '[]'::jsonb) into v_flags
  from public.feature_flags ff
  left join public.org_feature_flags off_
    on off_.flag_key = ff.key and off_.org_id = p_org_id;

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
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by t.name)
        from public.teams t where t.organization_id = p_org_id
    ), '[]'::jsonb),
    'counts', jsonb_build_object(
      'players', (select count(*) from public.players  where organization_id = p_org_id),
      'seasons', (select count(*) from public.seasons  where organization_id = p_org_id),
      'games',   (select count(*) from public.games    where organization_id = p_org_id)
    ),
    'legacy_organization_members', coalesce((
      select jsonb_agg(jsonb_build_object('email', om.email, 'role', om.role)
                       order by om.email)
        from public.organization_members om where om.organization_id = p_org_id
    ), '[]'::jsonb),
    'metrics', v_metrics,
    'feature_flags', v_flags
  );
end;
$$;

-- admin_flags: full registry + all overrides (for Flags page)
create or replace function public.admin_flags()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'registry', (
      select jsonb_agg(jsonb_build_object('key', key, 'description', description, 'default_on', default_on) order by key)
      from public.feature_flags
    ),
    'overrides', (
      select coalesce(jsonb_agg(jsonb_build_object('org_id', off_.org_id, 'org_name', o.name, 'flag_key', off_.flag_key,
                                          'enabled', off_.enabled, 'updated_by', off_.updated_by, 'updated_at', off_.updated_at)
                       order by off_.org_id, off_.flag_key), '[]'::jsonb)
      from public.org_feature_flags off_
      join public.organizations o on o.id = off_.org_id
    )
  );
$$;

revoke all on function public.admin_org_detail(bigint) from public, anon, authenticated;
revoke all on function public.admin_flags()            from public, anon, authenticated;
