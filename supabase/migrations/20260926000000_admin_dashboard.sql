-- Admin organizations list + internal dashboard RPCs.
--
-- Read-only, service-role only: security definer, search_path pinned, revoked
-- from public/anon/authenticated at the bottom — same conventions as
-- 20260924000000_admin_org_profile_flags.sql. Payload shapes are pinned in
-- docs/superpowers/specs/2026-09-25-admin-orgs-dashboard-design.md §RPCs and
-- in supabase/tests/22_admin_dashboard.test.sql.

create or replace function public.admin_list_organizations(
  p_q text, p_sort text, p_dir text, p_limit int, p_offset int
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sort   text := coalesce(p_sort, 'name');
  v_dir    text := coalesce(p_dir, 'asc');
  v_limit  int  := least(coalesce(p_limit, 50), 200);
  v_offset int  := greatest(coalesce(p_offset, 0), 0);
  v_ord    text;
  v_total  bigint;
  v_rows   jsonb;
begin
  if v_sort not in ('name', 'members', 'created_at', 'last_activity', 'tier') then
    raise exception 'invalid sort column: %', v_sort;
  end if;
  if v_dir not in ('asc', 'desc') then
    raise exception 'invalid dir: %', v_dir;
  end if;

  -- Whitelist-only interpolation: both operands were validated just above.
  -- Nulls are placed explicitly (last on desc, first on asc — never implicit)
  -- and id breaks ties so pages are stable.
  v_ord := format('order by %s %s nulls %s, id', v_sort, v_dir,
                  case when v_dir = 'desc' then 'last' else 'first' end);

  select count(*) into v_total
    from public.organizations o
   where p_q is null or p_q = '' or o.name ilike '%' || p_q || '%';

  -- members counts team_members (team_id FK -> organizations.id).
  -- last_activity is the same recipe as admin_org_detail.metrics.last_activity:
  -- max created_at across chat_logs, game_events, game_attendance,
  -- strategy_plays; null when the org has none.
  -- The sort runs twice — once as the window ordering (assigning the global
  -- rank), once as the query ordering (picking the limit/offset slice) —
  -- because a window ORDER BY cannot see select-list aliases at its own
  -- level: members/last_activity only exist as columns of the derived x.
  execute format($f$
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', s.id, 'name', s.name, 'is_public', s.is_public, 'tier', s.tier,
             'members', s.members, 'created_at', s.created_at, 'last_activity', s.last_activity
           ) order by s.ord), '[]'::jsonb)
      from (
        select x.id, x.name, x.is_public, x.tier, x.members, x.created_at, x.last_activity,
               row_number() over (%s) as ord
          from (
            select o.id, o.name, o.is_public, o.tier, o.created_at,
                   (select count(*) from public.team_members m where m.team_id = o.id) as members,
                   (select max(u.dt) from (
                      select max(created_at) as dt from public.chat_logs          where organization_id = o.id
                      union all select max(created_at) from public.game_events     where organization_id = o.id
                      union all select max(created_at) from public.game_attendance where organization_id = o.id
                      union all select max(created_at) from public.strategy_plays  where organization_id = o.id
                    ) u) as last_activity
              from public.organizations o
             where $1 is null or $1 = '' or o.name ilike '%%' || $1 || '%%'
          ) x
          %s
          limit $2 offset $3
      ) s
  $f$, v_ord, v_ord) into v_rows using p_q, v_limit, v_offset;

  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

create or replace function public.admin_dashboard(p_from date, p_to date, p_grain text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_grain text := coalesce(p_grain, 'day');
  v_to    date := coalesce(p_to, current_date);
  v_from  date := coalesce(p_from, v_to - 29);
  v_step  interval;
  v_active int;
begin
  if v_grain not in ('day', 'week', 'month') then
    raise exception 'invalid grain: %', v_grain;
  end if;
  if v_from > v_to then
    raise exception 'invalid range: from after to';
  end if;
  if v_to - v_from > 370 then
    raise exception 'range too large: max 370 days';
  end if;
  v_step := ('1 ' || v_grain)::interval;

  -- Orgs with any row in the four activity tables in range; dormant is the
  -- rest (dormancy is relative to the selected range).
  select count(distinct organization_id) into v_active
    from (
      select organization_id from public.chat_logs
       where created_at >= v_from and created_at < v_to + 1
      union
      select organization_id from public.game_events
       where created_at >= v_from and created_at < v_to + 1
      union
      select organization_id from public.game_attendance
       where created_at >= v_from and created_at < v_to + 1
      union
      select organization_id from public.strategy_plays
       where created_at >= v_from and created_at < v_to + 1
    ) a;

  return jsonb_build_object(
    'range', jsonb_build_object(
      'from', to_char(v_from, 'YYYY-MM-DD'),
      'to', to_char(v_to, 'YYYY-MM-DD'),
      'grain', v_grain
    ),
    'usage', jsonb_build_object(
      'totals', jsonb_build_object(
        'orgs',        (select count(*) from public.organizations),
        'members',     (select count(*) from public.team_members),
        'players',     (select count(*) from public.players),
        'games',       (select count(*) from public.games),
        'game_events', (select count(*) from public.game_events)
      ),
      'series', jsonb_build_object(
        -- Buckets are generate_series left-joined to the counts, so every
        -- bucket in [from, to] appears, zero-filled. date_trunc is monotonic,
        -- so every counted row lands inside the generated bucket span.
        'new_orgs', coalesce((
          select jsonb_agg(jsonb_build_object('bucket', to_char(g.bucket, 'YYYY-MM-DD'),
                                              'count', coalesce(n.cnt, 0)) order by g.bucket)
            from generate_series(date_trunc(v_grain, v_from::timestamptz),
                                date_trunc(v_grain, v_to::timestamptz), v_step) as g(bucket)
            left join (select date_trunc(v_grain, created_at) as bucket, count(*) as cnt
                         from public.organizations
                        where created_at >= v_from and created_at < v_to + 1
                        group by 1) n on n.bucket = g.bucket
        ), '[]'::jsonb),
        'new_games', coalesce((
          select jsonb_agg(jsonb_build_object('bucket', to_char(g.bucket, 'YYYY-MM-DD'),
                                              'count', coalesce(n.cnt, 0)) order by g.bucket)
            from generate_series(date_trunc(v_grain, v_from::timestamptz),
                                date_trunc(v_grain, v_to::timestamptz), v_step) as g(bucket)
            left join (select date_trunc(v_grain, created_at) as bucket, count(*) as cnt
                         from public.games
                        where created_at >= v_from and created_at < v_to + 1
                        group by 1) n on n.bucket = g.bucket
        ), '[]'::jsonb),
        'new_events', coalesce((
          select jsonb_agg(jsonb_build_object('bucket', to_char(g.bucket, 'YYYY-MM-DD'),
                                              'count', coalesce(n.cnt, 0)) order by g.bucket)
            from generate_series(date_trunc(v_grain, v_from::timestamptz),
                                date_trunc(v_grain, v_to::timestamptz), v_step) as g(bucket)
            left join (select date_trunc(v_grain, created_at) as bucket, count(*) as cnt
                         from public.game_events
                        where created_at >= v_from and created_at < v_to + 1
                        group by 1) n on n.bucket = g.bucket
        ), '[]'::jsonb)
      )
    ),
    'billing', jsonb_build_object(
      -- Counts use the raw organizations.tier column (the enum is
      -- free/plus/premium); employee-granted orgs report via their tier value
      -- and are surfaced separately via is_employee_granted.
      'tier_mix', jsonb_build_object(
        'free', (select count(*) from public.organizations where tier = 'free'),
        'plus', (select count(*) from public.organizations where tier = 'plus'),
        'premium', (select count(*) from public.organizations where tier = 'premium'),
        'employee_granted', (select count(*) from public.organizations where is_employee_granted)
      ),
      'active_trials', (select count(*) from public.organizations where trial_ends_at > now()),
      -- chat_logs is the AI chat table; ai_usage_logs only keeps monthly
      -- counters, not dates, so the in-range count comes from here.
      'ai_messages_in_range', (select count(*) from public.chat_logs
                                where created_at >= v_from and created_at < v_to + 1),
      -- Hardcoded: mirrors the cap case statement in consume_ai_message
      -- (20260922000003_enforce_org_tier_limits.sql). No cap table exists;
      -- if that case statement changes, this constant changes with it.
      'ai_cap_by_tier', '{"free": 5, "pro": 100, "premium": null}'::jsonb
    ),
    'engagement', jsonb_build_object(
      -- Documented limitation: auth.users.last_sign_in_at is a single "last"
      -- timestamp, not an event log. The series counts users whose most
      -- recent sign-in falls in the bucket; it undercounts infrequent users
      -- and cannot show repeat activity. Best available without new
      -- instrumentation.
      'sign_ins', coalesce((
        select jsonb_agg(jsonb_build_object('bucket', to_char(g.bucket, 'YYYY-MM-DD'),
                                            'count', coalesce(n.cnt, 0)) order by g.bucket)
          from generate_series(date_trunc(v_grain, v_from::timestamptz),
                              date_trunc(v_grain, v_to::timestamptz), v_step) as g(bucket)
          left join (select date_trunc(v_grain, last_sign_in_at) as bucket, count(*) as cnt
                       from auth.users
                      where last_sign_in_at is not null
                        and last_sign_in_at >= v_from and last_sign_in_at < v_to + 1
                      group by 1) n on n.bucket = g.bucket
      ), '[]'::jsonb),
      'active_orgs_in_range', v_active,
      'dormant_orgs', (select count(*) from public.organizations) - v_active
    ),
    'ops', jsonb_build_object(
      'top_orgs_by_events', coalesce((
        select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'game_events', t.cnt)
                         order by t.cnt desc, t.name)
          from (select o.id, o.name, count(*) as cnt
                  from public.game_events ge
                  join public.organizations o on o.id = ge.organization_id
                 where ge.created_at >= v_from and ge.created_at < v_to + 1
                 group by o.id, o.name
                 order by count(*) desc, o.name
                 limit 5) t
      ), '[]'::jsonb),
      'pending_invites', (select count(*) from public.team_invites where accepted_at is null),
      'unclaimed_player_links', (select count(*) from public.player_links where status = 'pending'),
      'audit_events_in_range', (select count(*) from public.admin_audit_log
                                 where at >= v_from and at < v_to + 1)
    )
  );
end;
$$;

revoke all on function public.admin_list_organizations(text,text,text,int,int) from public, anon, authenticated;
revoke all on function public.admin_dashboard(date,date,text) from public, anon, authenticated;
