-- Free-tier history limit, enforced at the read layer. Task 1 of
-- 2026-09-24-downgrade-handling-and-30-day-history.
--
-- The select policy on public.game_events that 20260903001200_strict_rls.sql
-- generates is membership-or-public only, with no tier awareness. This
-- replaces it for game_events with the same membership branches plus a
-- tier gate: organizations whose effective tier is not 'free' read all
-- their history; free organizations read only events whose game_date is
-- within the last 30 days.
--
-- Nothing is deleted on downgrade and nothing is backfilled on re-upgrade:
-- the window is a predicate on the read, computed from the live tier and
-- the live game_date, so a tier flip in either direction takes effect on
-- the very next query. `effective_tier()` is already granted to
-- authenticated (20260922000000_org_tiers_and_limits.sql).
--
-- The membership-helper calls keep the house form
-- `(select public.fn())::bigint[]` -- see the header comment of
-- 20260903001200_strict_rls.sql for why a bare `any (public.fn())` loses
-- InitPlan semantics and why `any (subquery)` fails to compile.
--
-- The 30-day check joins games rather than reading
-- game_events.event_timestamp: the spec's cutoff is the game's date, so
-- events recorded today against an old game are still history, and the
-- cutoff date current_date - interval '30 days' matches the brief exactly.
--
-- Performance note: this predicate runs per row under RLS. The
-- idx_game_events_game_id index (baseline) serves the games join;
-- game_events_organization_id_idx serves the membership branch. Free orgs
-- querying the window is the hot path for the Stats page, and the planner
-- already has both indexes available.

drop policy if exists "member read" on public.game_events;

create policy "member read" on public.game_events
  for select to authenticated
  using (
    (
      organization_id = any ((select public.my_member_team_ids())::bigint[])
      or organization_id = any ((select public.public_team_ids())::bigint[])
    )
    and (
      public.effective_tier(organization_id) != 'free'
      or exists (
        select 1 from public.games g
        where g.id = game_events.game_id
          and g.game_date >= (current_date - interval '30 days')
      )
    )
  );
