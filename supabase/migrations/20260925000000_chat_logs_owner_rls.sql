-- Chat threads are per-user, not per-team. The tier-B "member read" set
-- from 20260903001200 let every org member SELECT/INSERT/UPDATE/DELETE
-- every chat_logs row in their org via the Supabase client directly, and
-- the service-role endpoints scoped history by (session_id, organization_id)
-- only -- so any member could read or delete any teammate's thread by
-- naming its session id. These policies keep chat_logs org-scoped AND
-- owner-scoped.
--
-- Rows written before this change carry user_id null and become invisible
-- to clients: chat_logs is never updated (no backfill target exists), and
-- the 30-day history limit ages them out, so no data is lost that any
-- client could still reach.
--
-- House form: every membership-helper call wrapped as
-- `(select public.fn())::bigint[]` per 20260903001200's InitPlan rule.

drop policy if exists "member read" on public.chat_logs;
drop policy if exists "member insert" on public.chat_logs;
drop policy if exists "member update" on public.chat_logs;
drop policy if exists "member delete" on public.chat_logs;

create policy "owner read" on public.chat_logs
  for select to authenticated
  using (organization_id = any ((select public.my_member_team_ids())::bigint[])
         and user_id = auth.uid()::text);

create policy "owner insert" on public.chat_logs
  for insert to authenticated
  with check (organization_id = any ((select public.my_member_team_ids())::bigint[])
         and user_id = auth.uid()::text);

create policy "owner delete" on public.chat_logs
  for delete to authenticated
  using (organization_id = any ((select public.my_member_team_ids())::bigint[])
         and user_id = auth.uid()::text);

-- Nothing in the app updates chat_logs; close the path entirely rather
-- than scoping it.
revoke update on public.chat_logs from authenticated;
