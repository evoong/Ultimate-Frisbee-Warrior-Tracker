// Minimal Supabase REST (service-role) helpers shared by gameActions.ts and
// mcpTools.ts. Raw fetch rather than @supabase/supabase-js so this stays
// portable across Cloudflare Workers, Vercel, and Express (see gameActions.ts
// and chat.ts's supabaseServiceFetch for the same reasoning) — the
// service-role key only ever needs plain REST, not the full client library.

export interface ActionsConfig {
  supabaseUrl: string
  supabaseSecretKey: string
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
