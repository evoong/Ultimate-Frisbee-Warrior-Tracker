-- ============================================================
-- 022_drop_dead_game_attendance_backfill.sql
--
-- game_attendance was retired in favor of lineup-derived attendance (see
-- "Lineups (attendance is derived from them, game_attendance is retired)"
-- in CLAUDE.md): nothing in the app reads or writes it anymore. But the
-- trg_backfill_game_attendance trigger (AFTER INSERT ON games) was never
-- removed, so it kept firing on every new game and inserting into that
-- dead table — including organization_id, which 016_organizations.sql
-- made not null on game_attendance too, but this trigger never set. That
-- made it the fourth and last instance of the same bug class as 020/021:
-- any brand-new game insert with at least one active season_players row
-- for its season (i.e. almost any real game) failed outright, which is
-- what actually blocked gateway/jamSync.ts from auto-creating new games
-- at all once organizations landed.
--
-- Fix: drop the trigger and its now-unused function rather than patch it
-- to also carry organization_id, since the table it writes has no reader
-- left to serve.
--
-- Run this entire file in the Supabase SQL Editor AFTER 021.
-- ============================================================

drop trigger if exists trg_backfill_game_attendance on public.games;
drop function if exists public.backfill_game_attendance();
