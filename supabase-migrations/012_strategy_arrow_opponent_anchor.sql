-- ============================================================
-- 012_strategy_arrow_opponent_anchor.sql
-- Extends 008's arrow anchoring to opponent markers: a 'run' arrow drawn
-- starting from an opponent marker (not just a player) can now anchor its
-- tail to that marker, tracking it live if dragged within the same step.
-- Mutually exclusive with start_player_id (an arrow anchors to at most
-- one entity); enforced by a check constraint rather than a shared
-- polymorphic column since the two reference different tables.
-- ============================================================

alter table public.strategy_arrows
  add column if not exists start_opponent_id bigint references public.strategy_opponent_markers(id) on delete set null;

do $$ begin
  alter table public.strategy_arrows
    add constraint strategy_arrows_single_anchor
    check (start_player_id is null or start_opponent_id is null);
exception when duplicate_object then null;
end $$;
