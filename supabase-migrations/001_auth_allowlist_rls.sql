-- ============================================================
-- 001_auth_allowlist_rls.sql
-- Authentication lockdown: email allowlist + RLS on every table.
--
-- Run this entire file in the Supabase SQL Editor (same workflow as
-- supabase-schema.sql). Run it BEFORE deploying the auth-gateway build:
-- once applied, the old deployed bundle fails closed (anon can no
-- longer read or write anything).
--
-- MANUAL DASHBOARD STEPS (required alongside this migration):
--   1. Google provider: create a Google Cloud OAuth web client with
--      authorized redirect URI
--        https://pyqngqyqwevfpaxcmfnd.supabase.co/auth/v1/callback
--      then paste client ID/secret into Auth -> Providers -> Google.
--   2. Auth -> URL Configuration:
--        Site URL = production Workers URL
--        Additional redirect URLs:
--          https://<prod-workers-domain>/auth/callback
--          https://<vercel-app>/auth/callback
--          http://localhost:5000/auth/callback
--          http://localhost:8787/auth/callback
--   3. Auth -> Email Templates -> Reset Password: change the action link to
--        {{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=recovery
--      (token_hash flow is required for the server-side verify).
--      If signup confirmations are enabled, point Confirm Signup at
--        {{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=signup
--   4. Auth -> Settings: disable anonymous sign-ins; keep signups enabled
--      (the allowlist below is the real gate); enable leaked-password
--      protection.
--   5. ROTATE THE SERVICE-ROLE SECRET KEY after the new worker deploys.
--      The old worker attached it to unauthenticated POST/PUT requests,
--      so treat it as compromised. Update SUPABASE_SECRET_KEY in the Node
--      .env and Vercel env, then `wrangler secret delete SUPABASE_SECRET_KEY`.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Allowlist table: which emails may use the app.
--    RLS enabled with ZERO policies + explicit revoke = clients can
--    never read or write it. Manage it here or in the dashboard.
-- ------------------------------------------------------------
create table if not exists public.allowed_users (
  email text primary key check (email = lower(email)),
  added_at timestamptz not null default now()
);

alter table public.allowed_users enable row level security;
revoke all on public.allowed_users from anon, authenticated;

-- ------------------------------------------------------------
-- 2. Helper for policies. SECURITY DEFINER so policies can consult the
--    allowlist without granting clients SELECT on it. The email claim is
--    a top-level signed JWT claim (NOT user_metadata, which users can
--    edit themselves).
-- ------------------------------------------------------------
create or replace function public.is_allowed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.allowed_users
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke all on function public.is_allowed() from public, anon;
grant execute on function public.is_allowed() to authenticated;

-- ------------------------------------------------------------
-- 3. Enable RLS + one FOR ALL policy per table.
--    Every allowlisted authenticated user has identical full access.
--    FOR ALL supplies both USING and WITH CHECK, which covers the
--    UPDATE-needs-both-clauses rule. (select ...) wrapping lets Postgres
--    cache the result per statement instead of per row.
--    NOTE: game_attendance and chat_logs exist in the live DB but are
--    missing from supabase-schema.sql — they are included here.
-- ------------------------------------------------------------
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
    execute format('drop policy if exists "allowlisted full access" on public.%I', t);
    execute format(
      'create policy "allowlisted full access" on public.%I
         for all to authenticated
         using ((select public.is_allowed()))
         with check ((select public.is_allowed()))',
      t
    );
  end loop;
end
$$;

-- ------------------------------------------------------------
-- 4. Defense in depth: anon gets nothing at all, and authenticated
--    keeps sequence usage so serial-column inserts still work.
-- ------------------------------------------------------------
revoke all on all tables in schema public from anon;
grant usage, select on all sequences in schema public to authenticated;

-- ------------------------------------------------------------
-- 5. Storage: the player-photos bucket stays PUBLIC-READ because
--    players.photo_url holds direct public object URLs rendered in <img>
--    tags. Writes are gated on the allowlist.
-- ------------------------------------------------------------
drop policy if exists "allowlisted insert player photos" on storage.objects;
create policy "allowlisted insert player photos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'player-photos' and (select public.is_allowed()));

drop policy if exists "allowlisted update player photos" on storage.objects;
create policy "allowlisted update player photos" on storage.objects
  for update to authenticated
  using (bucket_id = 'player-photos' and (select public.is_allowed()))
  with check (bucket_id = 'player-photos' and (select public.is_allowed()));

drop policy if exists "allowlisted delete player photos" on storage.objects;
create policy "allowlisted delete player photos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'player-photos' and (select public.is_allowed()));

-- ------------------------------------------------------------
-- 6. Seed the allowlist. Add teammates with additional inserts here or
--    via the dashboard Table Editor.
-- ------------------------------------------------------------
insert into public.allowed_users (email)
values ('lrubino2000@gmail.com')
on conflict do nothing;
