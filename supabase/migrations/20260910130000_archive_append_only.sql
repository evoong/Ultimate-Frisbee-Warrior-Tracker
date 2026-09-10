-- ============================================================
-- 20260910130000_archive_append_only.sql
--
-- deleted_rows_archive (20260910120000_deleted_row_recovery.sql) is the
-- entire safety net for the Brandon Ca incident class of bug -- but RLS
-- doesn't actually protect it from the role that caused that incident:
-- service_role bypasses RLS entirely, so a buggy script using the
-- service-role key (exactly what deleted a real player on 2026-09-04)
-- could just as easily `delete from deleted_rows_archive` and silently
-- erase the only copy of what it destroyed. Zero policies stops
-- anon/authenticated; it does nothing against service_role.
--
-- Triggers, unlike RLS, fire regardless of role -- there is no
-- "bypass triggers" privilege short of a superuser explicitly running
-- `alter table ... disable trigger`. This makes the archive genuinely
-- append-only: insert works, update/delete/truncate are rejected
-- unconditionally, for every role including service_role.
-- ============================================================

create or replace function public.reject_archive_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'deleted_rows_archive is append-only: % is not permitted', TG_OP;
end;
$$;

alter function public.reject_archive_mutation() owner to postgres;
revoke all on function public.reject_archive_mutation() from public, anon, authenticated;

drop trigger if exists deleted_rows_archive_no_update_delete on public.deleted_rows_archive;
create trigger deleted_rows_archive_no_update_delete
  before update or delete on public.deleted_rows_archive
  for each row execute function public.reject_archive_mutation();

drop trigger if exists deleted_rows_archive_no_truncate on public.deleted_rows_archive;
create trigger deleted_rows_archive_no_truncate
  before truncate on public.deleted_rows_archive
  for each statement execute function public.reject_archive_mutation();
