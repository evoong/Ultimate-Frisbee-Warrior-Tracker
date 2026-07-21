-- ============================================================
-- 020_fix_league_teams_org_id.sql
--
-- Fixes a bug introduced by 016_organizations.sql: it added
-- organization_id not null to league_teams, but never updated the two
-- trigger functions from 010_league_tracking.sql that insert into
-- league_teams (resolve_game_opponent_team, sync_game_league_pair), so
-- both inserts started failing with "null value in column
-- organization_id of relation league_teams violates not-null
-- constraint" any time a games row was inserted/updated and its
-- opponent or own team needed a fresh league_teams row created. Because
-- this fires inside a BEFORE trigger on games, the failure rolled back
-- the whole write: any INSERT into games silently failed, and any
-- UPDATE that touched opponent/season_id (e.g. jamSync picking up a
-- reschedule) silently failed to apply, leaving the game showing its
-- stale pre-reschedule date.
--
-- Fix: both inserts now carry organization_id, sourced from the games
-- row that triggered them (new.organization_id).
--
-- Run this entire file in the Supabase SQL Editor AFTER 019.
-- ============================================================

create or replace function public.resolve_game_opponent_team()
returns trigger
language plpgsql
as $$
declare
  v_name text := nullif(trim(coalesce(new.opponent, '')), '');
begin
  if new.season_id is null or v_name is null then
    return new;
  end if;
  if new.opponent_team_id is not null and exists (
    select 1 from public.league_teams lt
    where lt.id = new.opponent_team_id and lt.season_id = new.season_id
  ) then
    return new;
  end if;
  insert into public.league_teams (season_id, organization_id, name)
  values (new.season_id, new.organization_id, v_name)
  on conflict (season_id, name) do nothing;
  select id into new.opponent_team_id
  from public.league_teams
  where season_id = new.season_id and name = v_name;
  return new;
end
$$;

create or replace function public.sync_game_league_pair()
returns trigger
language plpgsql
as $$
declare
  v_us bigint;
  v_stage text;
begin
  if tg_op = 'DELETE' then
    delete from public.league_games where our_game_id = old.id;
    return old;
  end if;
  if new.season_id is null then
    delete from public.league_games where our_game_id = new.id;
    return new;
  end if;

  -- Ensure our own league team exists for this season.
  insert into public.league_teams (season_id, organization_id, name, is_us)
  select s.id, new.organization_id, coalesce(t.name, 'Warriors'), true
  from public.seasons s
  left join public.teams t on t.id = s.team_id
  where s.id = new.season_id
  on conflict do nothing;

  select id into v_us
  from public.league_teams
  where season_id = new.season_id and is_us;

  v_stage := case when new.game_type ilike 'playoff%' then 'playoff' else 'regular' end;

  update public.league_games set
    season_id = new.season_id,
    home_team_id = v_us,
    away_team_id = new.opponent_team_id,
    game_date = new.game_date,
    game_time = new.game_time,
    stage = v_stage
  where our_game_id = new.id;
  if not found then
    insert into public.league_games
      (season_id, home_team_id, away_team_id, game_date, game_time, stage, our_game_id)
    values
      (new.season_id, v_us, new.opponent_team_id, new.game_date, new.game_time, v_stage, new.id);
  end if;
  return new;
end
$$;
