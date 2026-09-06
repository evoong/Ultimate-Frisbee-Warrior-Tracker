-- Storage for the optional screenshot attached to an in-app bug/feature
-- report (POST /api/feedback in server/index.ts). Unlike player-photos and
-- team-photos, this bucket is never touched directly by the browser: the
-- Express server uploads the file and creates the signed URL itself using
-- the service-role client it already holds, which bypasses RLS entirely.
-- So, unlike those buckets, no storage.objects policies are needed here --
-- authenticated/anon can never read or write this bucket directly, only
-- the service role can, and it isn't bound by RLS in the first place.
--
-- public = false from the start: this is created private, not locked down
-- after the fact like 20260905000100_private_photo_buckets.sql had to do.
insert into storage.buckets (id, name, public)
values ('feedback-attachments', 'feedback-attachments', false)
on conflict (id) do nothing;
