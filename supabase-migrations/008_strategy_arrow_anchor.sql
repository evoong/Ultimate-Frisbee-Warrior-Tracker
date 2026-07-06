-- ============================================================
-- 008_strategy_arrow_anchor.sql
-- Lets a 'run' arrow's tail be anchored to the player it was drawn from,
-- so the arrow tracks that player if they're dragged within the same step,
-- and so its head can drive that player's position in the next step.
-- ============================================================

alter table public.strategy_arrows
  add column if not exists start_player_id integer references public.players(id) on delete set null;
