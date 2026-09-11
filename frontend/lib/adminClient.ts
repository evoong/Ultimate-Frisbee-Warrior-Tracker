import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

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
// would issue two identical /whoami requests. AuthContext's logout() is a
// pure SPA state reset (no page reload), so a user can sign out and a
// different user can sign in within the same page load -- the cache is keyed
// by signed-in user id so a change of identity always gets a fresh fetch,
// while repeated mounts for the *same* identity still share one in-flight
// request. This is enforced, not assumed: see the identity-switch tests.
let whoamiCache: { userId: string | null; promise: Promise<AdminRole | null> } | null = null

function fetchAdminRole(userId: string | null): Promise<AdminRole | null> {
  if (!whoamiCache || whoamiCache.userId !== userId) {
    whoamiCache = {
      userId,
      promise: adminGet<{ role: AdminRole }>('/whoami')
        .then(r => r.role)
        // A 403 is the normal case for the overwhelming majority of users and is
        // not an error worth surfacing -- it simply means no admin link.
        .catch(() => null),
    }
  }
  return whoamiCache.promise
}

// The nav gate.
//
// This is a RENDERING hint only. It is never the authorization decision:
// every /api/admin/* request re-checks server-side, so forging this state in
// devtools buys a menu item and a 403.
export function useAdminRole(): { role: AdminRole | null; loading: boolean } {
  const { user, loading: authLoading } = useAuth()
  const userId = user?.id ?? null
  const [role, setRole] = useState<AdminRole | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // AuthContext's own session fetch is async, so `user` starts as `null`
    // and only settles to its real value (a signed-in id, or null for a
    // guest/signed-out visitor) once that resolves. Firing on every change
    // of `userId` without waiting for it to settle would fetch once for the
    // transient `null` and again for the real id on every fresh page load --
    // exactly the double-request this hook exists to avoid. Waiting for
    // authLoading to clear means we key off the settled identity, and still
    // react correctly to a later sign-out/sign-in (authLoading stays false
    // after the initial resolution, so those transitions fire normally).
    if (authLoading) return
    let cancelled = false
    setLoading(true)
    fetchAdminRole(userId)
      .then(r => { if (!cancelled) setRole(r) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [userId, authLoading])

  return { role, loading }
}
