-- ============================================================
-- 009_season_players_is_sub.sql
-- Player/Sub status is per-season (a player can be a full player in one
-- season and a sub in another), so it moves from the global players.is_sub
-- flag to a season_players.is_sub column. players.is_sub is kept as the
-- default for brand-new players not yet tied to a season.
-- ============================================================

alter table public.season_players
  add column if not exists is_sub boolean not null default false;

update public.season_players sp
set is_sub = true
from public.players p
where sp.player_id = p.id and p.is_sub is true;
