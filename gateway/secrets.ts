// Fetches application secrets (e.g. GEMINI_API_KEY) from Supabase Vault so
// they're configured in exactly one place instead of separately across every
// deploy target (Vercel env vars, Cloudflare Workers secrets, local .env).
//
// This intentionally does NOT cover SUPABASE_URL / SUPABASE_SECRET_KEY /
// SUPABASE_PUBLISHABLE_KEY — those are needed to reach Supabase in the first
// place, so they still have to live in each host's own env as bootstrap
// credentials. Vault is for everything downstream of that.
//
// See supabase-migrations/003_secrets_vault.sql for the get_secret() RPC
// this calls (service-role only) and the manual steps to populate secrets.

export interface VaultSecretsConfig {
  supabaseUrl: string
  supabaseSecretKey: string
}

const CACHE_TTL_MS = 5 * 60_000
const cache = new Map<string, { value: string | undefined; expires: number }>()

// Resolves `name` from Supabase Vault. Falls back to `fallback` (e.g. an env
// var) if Vault has no value for that name or the fetch fails, so a host can
// still override a secret locally or bridge during migration to Vault.
export async function getVaultSecret(
  config: VaultSecretsConfig,
  name: string,
  fallback?: string
): Promise<string | undefined> {
  const cached = cache.get(name)
  if (cached && cached.expires > Date.now()) return cached.value ?? fallback

  let value: string | undefined
  try {
    const res = await fetch(`${config.supabaseUrl}/rest/v1/rpc/get_secret`, {
      method: 'POST',
      headers: {
        apikey: config.supabaseSecretKey,
        Authorization: `Bearer ${config.supabaseSecretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ secret_name: name }),
    })
    if (res.ok) {
      const data = await res.json()
      value = typeof data === 'string' ? data : undefined
    }
  } catch {
    value = undefined
  }

  cache.set(name, { value, expires: Date.now() + CACHE_TTL_MS })
  return value ?? fallback
}
