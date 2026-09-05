-- 20260903001300_storage_policies.sql created player-photos and
-- team-photos as `public: true` buckets. Combined with the path
-- convention (first segment is the numeric team id, trivially
-- enumerable), that means any object in either bucket is fetchable by
-- anyone on the internet via Supabase's standard public-object URL, with
-- no authentication at all -- independent of whether any app code
-- currently constructs or displays those URLs (a repo-wide grep found
-- none, but the exposure exists at the storage-API level regardless).
--
-- This migration only removes that "world-readable regardless of auth"
-- exposure. It does not resolve the bigger "Plan 3" design question that
-- same migration's comments defer -- whether photo listing needs a
-- richer access model -- it just adds the minimum authenticated SELECT
-- policy needed to (a) stop anonymous world-readability and (b) make the
-- existing team-scoped UPDATE/DELETE policies non-inert, since Postgres
-- evaluates a table's SELECT policies to build the row set an
-- UPDATE/DELETE runs against.
update storage.buckets set public = false where id in ('player-photos', 'team-photos');

-- Same predicate shape as the existing member-tier INSERT/UPDATE/DELETE
-- policies for this bucket ("team member write/update/delete player
-- photos" in 20260903001300_storage_policies.sql): member-tier access,
-- scoped by the numeric team id embedded in the object path.
create policy "team member read player photos" on storage.objects
  for select to authenticated
  using (bucket_id = 'player-photos'
         and public.storage_path_team_id(name) = any ((select public.my_member_team_ids())::bigint[]));

-- Same predicate shape as the existing manage-tier INSERT/UPDATE/DELETE
-- policies for this bucket ("manager write/update/delete team photos"):
-- team-photos is team identity, so manage-tier rather than member-tier.
create policy "manager read team photos" on storage.objects
  for select to authenticated
  using (bucket_id = 'team-photos'
         and public.storage_path_team_id(name) = any ((select public.my_manage_team_ids())::bigint[]));
