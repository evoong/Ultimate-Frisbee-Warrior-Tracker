-- ============================================================
-- 20260921174201_fix_archive_deleted_row_pk_lookup.sql
--
-- archive_deleted_row() (20260910120000_deleted_row_recovery.sql) hardcoded
-- old.id::text as the archived row's row_pk. That assumes every trigger-
-- attached table has an `id` primary key column. player_private
-- (20260903000400_player_private.sql) does not -- its primary key is
-- player_id -- so any delete on player_private (including the cascaded
-- delete inside admin_merge_players) raised "record 'old' has no field
-- 'id'" instead of archiving the row. Caught by the pgTAP suite
-- (19_admin_rpcs.test.sql, "merge succeeds despite conflicts in every
-- conflict-bearing table").
--
-- Fix: resolve the primary key column name from the catalog at trigger time
-- instead of assuming `id`, and pull that column's value out of the row's
-- own jsonb. row_pk is purely an informational lookup aid (row_data already
-- holds the full row for restore_deleted_row()), so a table with a
-- composite primary key just gets one of its columns here -- harmless,
-- since it's not used to reconstruct the row.
-- ============================================================

create or replace function public.archive_deleted_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pk_col text;
begin
  select a.attname into v_pk_col
  from pg_index i
  join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
  where i.indrelid = (quote_ident(TG_TABLE_SCHEMA) || '.' || quote_ident(TG_TABLE_NAME))::regclass
    and i.indisprimary
  limit 1;

  insert into public.deleted_rows_archive (table_name, row_pk, row_data, deleted_by)
  values (
    TG_TABLE_NAME,
    case when v_pk_col is not null then to_jsonb(old) ->> v_pk_col else null end,
    to_jsonb(old),
    nullif(coalesce(auth.jwt() ->> 'email', ''), '')
  );
  return old;
end;
$$;

alter function public.archive_deleted_row() owner to postgres;
revoke all on function public.archive_deleted_row() from public, anon, authenticated;
