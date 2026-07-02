-- ============================================================
-- 002_public_read_team_write.sql
-- Loosen access: ANY signed-in (authenticated) user may READ every table.
-- Only allowlisted "team" users (public.allowed_users, checked via
-- public.is_allowed()) may INSERT / UPDATE / DELETE.
--
-- Supersedes the single "allowlisted full access" FOR ALL policy created in
-- 001_auth_allowlist_rls.sql. Run this entire file in the Supabase SQL
-- Editor AFTER 001. Re-runnable (drops policies before recreating them).
--
-- What does NOT change:
--   * anon (not signed in) still gets nothing — reads require a session.
--   * The email allowlist + public.is_allowed() stay exactly as-is; being on
--     the allowlist now means "can write" rather than "can use the app".
--   * Storage player-photos writes stay team-only (already gated on is_allowed).
--   * The Express AI-chat endpoints (service role) stay team-only via
--     createRequireAllowedUser — non-team users cannot invoke them.
-- ============================================================

do $$
declare
  t text;
begin
  foreach t in array array[
    'teams', 'seasons', 'players', 'games', 'game_events',
    'season_players', 'game_lineups', 'standings', 'event_types',
    'game_attendance', 'chat_logs'
  ]
  loop
    if to_regclass('public.' || t) is null then
      raise notice 'skipping missing table: %', t;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', t);

    -- Remove the old combined-access policy from migration 001.
    execute format('drop policy if exists "allowlisted full access" on public.%I', t);

    -- READ: any authenticated user. (select ...) around the constant keeps
    -- parity with the write policies; true is evaluated once per statement.
    execute format('drop policy if exists "authenticated read" on public.%I', t);
    execute format(
      'create policy "authenticated read" on public.%I
         for select to authenticated
         using (true)',
      t
    );

    -- WRITE: allowlisted team only. Split by command because INSERT needs
    -- WITH CHECK, DELETE needs USING, and UPDATE needs both.
    execute format('drop policy if exists "team insert" on public.%I', t);
    execute format(
      'create policy "team insert" on public.%I
         for insert to authenticated
         with check ((select public.is_allowed()))',
      t
    );

    execute format('drop policy if exists "team update" on public.%I', t);
    execute format(
      'create policy "team update" on public.%I
         for update to authenticated
         using ((select public.is_allowed()))
         with check ((select public.is_allowed()))',
      t
    );

    execute format('drop policy if exists "team delete" on public.%I', t);
    execute format(
      'create policy "team delete" on public.%I
         for delete to authenticated
         using ((select public.is_allowed()))',
      t
    );
  end loop;
end
$$;
