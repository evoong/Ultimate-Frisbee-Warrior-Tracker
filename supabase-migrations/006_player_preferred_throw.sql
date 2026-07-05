-- ============================================================
-- 006_player_preferred_throw.sql
-- Lets each player record their preferred throw (Backhand or Forehand)
-- from the roster edit-profile form.
--
-- Run this file in the Supabase SQL Editor. Re-runnable.
-- ============================================================

alter table public.players add column if not exists preferred_throw text;

alter table public.players drop constraint if exists players_preferred_throw_check;
alter table public.players add constraint players_preferred_throw_check
  check (preferred_throw is null or preferred_throw in ('Backhand', 'Forehand'));
