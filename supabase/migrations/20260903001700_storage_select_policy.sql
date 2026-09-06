-- 20260903001300_storage_policies.sql shipped six write policies on
-- storage.objects and deliberately zero SELECT policies, leaving the
-- decision of whether members may read photo objects to "Plan 3" (this
-- branch). That deferral turned out to be load-bearing in a way the
-- earlier migration's own comment did not anticipate: Supabase's
-- storage-api does not do a plain INSERT when you upload -- it does
-- `INSERT ... RETURNING`, and RETURNING re-evaluates the table's SELECT
-- policies against the just-inserted row. With no SELECT policy at all,
-- `authenticated` can insert a row but cannot see it come back, and
-- PostgREST/storage-api surfaces that as 42501 "new row violates row-level
-- security policy" on every single upload -- first upload and replace
-- alike, for every role, in both buckets. Confirmed directly against the
-- local database: a plain insert succeeds; the same insert with
-- `returning id` fails 42501.
--
-- Plan 3 ships a new team-photo upload and a fixed-path upsert:true player
-- photo, both of which need RETURNING to work at all, so the decision is
-- made here: members may read photo objects for the teams they belong to,
-- at member tier for both buckets, mirroring the existing write tiers'
-- team-scoping (but not their manage/member split -- SELECT is granted at
-- the more permissive member tier for both, since team-photos is public
-- team identity that any member should be able to see, and this does not
-- widen either bucket's write access).
do $$
begin
  execute format('drop policy if exists %I on storage.objects', 'member read photos');
end
$$;

create policy "member read photos" on storage.objects
  for select to authenticated
  using (
    bucket_id in ('player-photos','team-photos')
    and public.storage_path_team_id(name) = any ((select public.my_member_team_ids())::bigint[])
  );
