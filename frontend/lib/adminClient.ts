import { useEffect, useState } from 'react'

export type AdminRole = 'readonly' | 'support' | 'superadmin'

const RANK: Record<AdminRole, number> = { readonly: 1, support: 2, superadmin: 3 }

export function adminRoleAtLeast(role: AdminRole | null, required: AdminRole): boolean {
  return role ? RANK[role] >= RANK[required] : false
}

export class AdminRequestError extends Error {
  constructor(message: string, readonly status: number, readonly requestId?: string) {
    super(message)
    this.name = 'AdminRequestError'
  }
}

async function parse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new AdminRequestError(
      (body as any)?.error ?? `admin request failed (${res.status})`,
      res.status,
      (body as any)?.request_id
    )
  }
  return body as T
}

export async function adminGet<T>(path: string): Promise<T> {
  return parse<T>(await fetch(`/api/admin${path}`, { credentials: 'same-origin' }))
}

export async function adminOp<T>(
  name: string,
  input: unknown,
  mode: 'preview' | 'apply'
): Promise<T> {
  return parse<T>(
    await fetch(`/api/admin/op/${name}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, mode }),
    })
  )
}

// Single-flight: the sidebar and the admin shell both need this, and they are
// in different component trees, so without sharing the promise one page load
// would issue two identical /whoami requests. Module scope is safe because the
// answer is per-session and the page reloads on sign-out.
let whoamiInFlight: Promise<AdminRole | null> | null = null

function fetchAdminRole(): Promise<AdminRole | null> {
  whoamiInFlight ??= adminGet<{ role: AdminRole }>('/whoami')
    .then(r => r.role)
    // A 403 is the normal case for the overwhelming majority of users and is
    // not an error worth surfacing -- it simply means no admin link.
    .catch(() => null)
  return whoamiInFlight
}

// The nav gate.
//
// This is a RENDERING hint only. It is never the authorization decision:
// every /api/admin/* request re-checks server-side, so forging this state in
// devtools buys a menu item and a 403.
export function useAdminRole(): { role: AdminRole | null; loading: boolean } {
  const [role, setRole] = useState<AdminRole | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetchAdminRole()
      .then(r => { if (!cancelled) setRole(r) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  return { role, loading }
}
