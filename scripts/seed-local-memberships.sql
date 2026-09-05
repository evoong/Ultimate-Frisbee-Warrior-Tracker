-- Membership rows reference auth.users, which is populated by
-- seed-local-users.mjs after `supabase db reset` applies seed.sql. Run
-- this only after that script, never as part of seed.sql itself.
insert into public.team_members (team_id, user_id, role)
select 1, id, 'captain' from auth.users where email = 'captain@local.test'
union all select 1, id, 'editor'  from auth.users where email = 'editor@local.test'
union all select 1, id, 'member'  from auth.users where email = 'member@local.test'
union all select 1, id, 'member'  from auth.users where email = 'unlinked@local.test'
union all select 2, id, 'captain' from auth.users where email = 'outsider@local.test'
on conflict (team_id, user_id) do nothing;
