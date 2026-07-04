-- ============================================================
-- 003_secrets_vault.sql
-- Supabase Vault as the single source of truth for application secrets
-- that are NOT required to bootstrap the connection to Supabase itself.
--
-- SUPABASE_URL / SUPABASE_SECRET_KEY / SUPABASE_PUBLISHABLE_KEY still have
-- to live in each host's own env (Vercel, Cloudflare Workers, local .env)
-- because they're needed to reach Supabase in the first place. Everything
-- downstream of that (currently: GEMINI_API_KEY, GEMINI_MODEL) is stored
-- once here and fetched at runtime by the Node backend via the get_secret()
-- RPC below, using the service-role key it already holds. That means those
-- secrets only need to be set in one place (this database) instead of
-- separately across every deploy target.
--
-- Run this file in the Supabase SQL Editor (same workflow as
-- supabase-schema.sql). The `vault` schema and its functions
-- (vault.create_secret, vault.update_secret, vault.decrypted_secrets) are
-- built into every Supabase project already; this migration only adds the
-- RPC wrapper and grants.
--
-- MANUAL STEPS (Supabase SQL editor, after running this file):
--   select vault.create_secret('<actual gemini api key>', 'gemini_api_key', 'Gemini API key for the Chat feature');
--   select vault.create_secret('gemini-flash-lite-latest', 'gemini_model', 'Gemini model id for the Chat feature');
--
-- To rotate a secret later (look up its id first):
--   select id, name from vault.decrypted_secrets;
--   select vault.update_secret('<id>', '<new value>');
--
-- Once Vault is populated, the corresponding GEMINI_API_KEY / GEMINI_MODEL
-- entries can be removed from Vercel, Cloudflare, and local .env — the app
-- falls back to those env vars only if Vault has no value for a name, so
-- migration can happen without downtime.
-- ============================================================

-- get_secret(name) returns the decrypted value of a Vault secret by name,
-- or null if it doesn't exist. SECURITY DEFINER so it can read the vault
-- schema regardless of caller, but execute is revoked from everyone except
-- service_role — the anon/authenticated roles used by the public /db proxy
-- can never call this, only the privileged chat backend (which holds the
-- service-role key) can.
create or replace function public.get_secret(secret_name text)
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = secret_name
  limit 1
$$;

revoke all on function public.get_secret(text) from public, anon, authenticated;
grant execute on function public.get_secret(text) to service_role;
