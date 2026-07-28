-- ============================================================
-- 021_fix_league_games_org_id.sql
--
-- Same bug class as 020, one table over: 016_organizations.sql added
-- organization_id not null to league_games too, but 020's rewrite of
-- sync_game_league_pair() only fixed the league_teams insert inside it
-- and missed the league_games insert a few lines later (the "if not
-- found" fallback that creates the paired row for a game's first
-- sync/insert). That insert has always omitted organization_id, so it
-- violates the not-null constraint the moment it actually runs (i.e.
-- the first time a game's pairing row doesn't already exist) — surfaced
-- by gateway/jamSync.ts auto-creating a brand-new game via the calendar
-- importer, which is exactly the path that hits this insert.
--
-- Fix: the league_games insert now also carries organization_id,
-- sourced from the games row that triggered it (new.organization_id) --
-- same source 020 used for the league_teams insert in this same
-- function.
--
-- Run this entire file in the Supabase SQL Editor AFTER 020.
-- ============================================================

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
      (season_id, organization_id, home_team_id, away_team_id, game_date, game_time, stage, our_game_id)
    values
      (new.season_id, new.organization_id, v_us, new.opponent_team_id, new.game_date, new.game_time, v_stage, new.id);
  end if;
  return new;
end
$$;
