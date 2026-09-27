// Minimal Supabase REST (service-role) helpers shared by gameActions.ts and
// mcpTools.ts. Raw fetch rather than @supabase/supabase-js so this stays
// portable across Cloudflare Workers, Vercel, and Express (see gameActions.ts
// and chat.ts's supabaseServiceFetch for the same reasoning) — the
// service-role key only ever needs plain REST, not the full client library.

export interface ActionsConfig {
  supabaseUrl: string
  supabaseSecretKey: string
}

// Free-tier history window. Service-role queries bypass RLS, so the tier
// gate from 20260924150000_downgrade_history_limits.sql has to be applied
// by the caller: for free orgs, events of games dated before the window are
// withheld (date-only comparison, matching the policy's
// `game_date >= current_date - interval '30 days'`). Mirror of the helpers
// in server/lib/tierLimits.ts (duplicated rather than imported to keep this
// module Workers-portable — same accepted-duplication stance the header
// comment documents).
export const FREE_HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

export function gameDateWithinFreeWindow(gameDate: string, now = Date.now()): boolean {
  return gameDate >= new Date(now - FREE_HISTORY_WINDOW_MS).toISOString().slice(0, 10)
}

export async function getOrgEffectiveTier(config: ActionsConfig, orgId: number): Promise<'free' | 'plus' | 'premium'> {
  const res = await fetch(`${config.supabaseUrl}/rest/v1/rpc/effective_tier`, {
    method: 'POST',
    headers: {
      apikey: config.supabaseSecretKey,
      Authorization: `Bearer ${config.supabaseSecretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_org_id: orgId }),
  })
  if (!res.ok) throw new Error(`effective_tier RPC failed (${res.status})`)
  const tier = await res.json()
  return (tier as 'free' | 'plus' | 'premium') || 'free'
}

export async function sbGet(config: ActionsConfig, path: string): Promise<any> {
  const res = await fetch(`${config.supabaseUrl}/rest/v1${path}`, {
    headers: { apikey: config.supabaseSecretKey, Authorization: `Bearer ${config.supabaseSecretKey}` },
  })
  if (!res.ok) throw new Error(`Supabase query failed (${res.status}): ${path}`)
  return res.json()
}

export async function sbWrite(config: ActionsConfig, method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${config.supabaseUrl}/rest/v1${path}`, {
    method,
    headers: {
      apikey: config.supabaseSecretKey,
      Authorization: `Bearer ${config.supabaseSecretKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase ${method} failed (${res.status}): ${text || path}`)
  }
  const text = await res.text()
  return text ? JSON.parse(text) : []
}

// Upsert that silently no-ops on a conflict against `onConflict` (e.g. a
// player already on a season's roster, or a lineup group name that already
// exists on this game) instead of erroring — matches the `ignoreDuplicates`
// upserts already used for the same tables in frontend/hooks/backend/*.ts.
export async function sbUpsertIgnore(config: ActionsConfig, path: string, body: unknown, onConflict: string): Promise<any> {
  const sep = path.includes('?') ? '&' : '?'
  const res = await fetch(`${config.supabaseUrl}/rest/v1${path}${sep}on_conflict=${onConflict}`, {
    method: 'POST',
    headers: {
      apikey: config.supabaseSecretKey,
      Authorization: `Bearer ${config.supabaseSecretKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation,resolution=ignore-duplicates',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase upsert failed (${res.status}): ${text || path}`)
  }
  const text = await res.text()
  return text ? JSON.parse(text) : []
}
