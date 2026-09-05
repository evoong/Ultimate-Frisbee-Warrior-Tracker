-- Roster with display emails. This view is SECURITY DEFINER (Postgres's
-- default for a view -- there is no explicit `security definer` clause for
-- views the way there is for functions), not security_invoker: authenticated
-- has no SELECT grant on auth.users anywhere in this codebase, so an
-- invoker-rights view over that join fails for every real caller with
-- "permission denied for table users" (42501). The definer's elevated
-- privileges are gated by the explicit `where` predicate below instead of by
-- RLS: it reproduces public.my_member_team_ids(), the same security-definer
-- membership helper Plan 1 uses elsewhere, and returns '{}' for guests via
-- its own is_guest() guard. Do NOT remove that predicate -- a definer view
-- over team_members with no predicate exposes every team's roster and
-- emails to every caller, which is exactly the leak this view must not
-- cause.
create or replace view public.team_roster
as
  select m.id, m.team_id, m.user_id, m.role, m.created_at,
         u.email,
         l.player_id
    from public.team_members m
    join auth.users u on u.id = m.user_id
    left join public.player_links l
           on l.user_id = m.user_id and l.team_id = m.team_id and l.status = 'approved'
   where m.team_id = any (public.my_member_team_ids());

revoke all on public.team_roster from anon;
grant select on public.team_roster to authenticated;
