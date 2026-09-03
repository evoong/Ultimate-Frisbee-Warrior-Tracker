-- Lets a highlighted zone or line be locked in place once it's positioned
-- correctly, so a stray drag on the field doesn't nudge it. Locked only
-- blocks the whole-shape drag (StrategyBoard.tsx's beginShapeDrag); recolor
-- and delete stay reachable through their own explicit controls regardless
-- (locking is about preventing an accidental single-gesture move, not
-- protecting every kind of edit).
--
-- Run this entire file in the Supabase SQL Editor AFTER 026.

alter table public.strategy_highlights add column if not exists locked boolean not null default false;
alter table public.strategy_lines add column if not exists locked boolean not null default false;
