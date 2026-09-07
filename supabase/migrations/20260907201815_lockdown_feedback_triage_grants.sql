-- 20260906182105_feedback_triage_tables.sql enabled RLS on feedback_clusters
-- and feedback_reports with zero policies, on the assumption that
-- enabled-with-no-policies is enough: RLS alone default-denies every row to
-- every role once no permissive policy exists. That's true for row *access*,
-- but it doesn't touch the separate GRANT layer -- anon and authenticated
-- still hold whatever table-level privileges the public schema's default
-- grants gave them, same gap 20260903001100_membership_lockdown.sql's
-- comment calls out: "a policy can be misread, an absent grant cannot be
-- satisfied." supabase/tests/00_meta.test.sql's schema-wide ACL assertion
-- caught exactly this: both tables still showed up with privileges granted
-- to anon.
--
-- These two tables have no client access story at all -- unlike
-- team_members/team_invites/player_links in that migration, which get a
-- narrow `select` granted back to authenticated, nothing here re-grants
-- anything. The pipeline is entirely server-side under the service role.
do $$
declare t text;
begin
  foreach t in array array['feedback_clusters', 'feedback_reports']
  loop
    execute format('revoke all on public.%I from authenticated', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end
$$;
