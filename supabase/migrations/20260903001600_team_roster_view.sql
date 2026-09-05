-- Roster with display emails. security_invoker means the caller's own RLS
-- on team_members applies, so this view leaks nothing that the table would
-- not already show them.
create or replace view public.team_roster
with (security_invoker = true)
as
  select m.id, m.team_id, m.user_id, m.role, m.created_at,
         u.email,
         l.player_id
    from public.team_members m
    join auth.users u on u.id = m.user_id
    left join public.player_links l
           on l.user_id = m.user_id and l.team_id = m.team_id and l.status = 'approved';

revoke all on public.team_roster from anon;
grant select on public.team_roster to authenticated;
