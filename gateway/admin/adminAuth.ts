// Platform-admin authorization for /api/admin/* handlers, which hold the
// service-role key and therefore bypass RLS. Everything here is a deliberate
// re-implementation of what a policy would have done automatically -- the same
// reasoning as gateway/membership.ts, which this module mirrors closely on
// purpose.

export type AdminRole = 'readonly' | 'support' | 'superadmin'

const RANK: Record<AdminRole, number> = { readonly: 1, support: 2, superadmin: 3 }

function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && value in RANK
}

export function hasAtLeastAdmin(role: AdminRole | null, required: AdminRole): boolean {
  if (!role) return false
  return RANK[role] >= RANK[required]
}

export interface AdminLookupConfig {
  supabaseUrl: string
  supabaseSecretKey: string
  // Called (never awaited, never allowed to affect the fail-closed deny below)
  // whenever a lookup fails. This module stays framework-agnostic, so callers
  // wire this to their own Sentry.captureException -- otherwise a Supabase
  // outage or a bad SUPABASE_SECRET_KEY reads as "denied" with no signal
  // anywhere.
  onLookupError?: (err: unknown) => void
}

export interface AdminLookup {
  roleFor(userId: string): Promise<AdminRole | null>
}

// Short TTL: a revoked admin must stop working promptly, but a burst of
// requests from one console page should not re-query per request. Matches
// membership.ts.
const TTL_MS = 30_000

// Construct one per request in the Worker, exactly as with
// createMembershipLookup: the cache is scoped to the returned instance so a
// long-lived isolate does not accumulate entries across distinct users.
// server/index.ts is the same documented exception -- Express has no
// per-request isolate boundary, and a module-scoped lookup bounds the cache by
// distinct users rather than by request volume, with staleness capped by the
// TTL above.
export function createAdminLookup(config: AdminLookupConfig): AdminLookup {
  const cache = new Map<string, { at: number; role: AdminRole | null }>()

  return {
    async roleFor(userId: string): Promise<AdminRole | null> {
      const hit = cache.get(userId)
      if (hit && Date.now() - hit.at < TTL_MS) return hit.role

      const url =
        `${config.supabaseUrl}/rest/v1/platform_admins` +
        `?select=role&user_id=eq.${encodeURIComponent(userId)}`

      // Fail closed. An unavailable lookup must never read as "allowed",
      // whether the request reached Supabase and was rejected or never
      // arrived at all. Neither mode is cached: a transient outage must not
      // lock an admin out for the remainder of the TTL after recovery.
      try {
        const res = await fetch(url, {
          headers: {
            apikey: config.supabaseSecretKey,
            Authorization: `Bearer ${config.supabaseSecretKey}`,
          },
        })
        if (!res.ok) {
          config.onLookupError?.(new Error(`platform_admins lookup failed (${res.status})`))
          return null
        }
        const rows = await res.json()
        const role = Array.isArray(rows) && rows.length > 0 ? rows[0]?.role : null
        // An unrecognized role string is not trusted through: a row added by
        // hand with a typo must deny, not crash a rank comparison later.
        const resolved = isAdminRole(role) ? role : null
        cache.set(userId, { at: Date.now(), role: resolved })
        return resolved
      } catch (err) {
        config.onLookupError?.(err)
        return null
      }
    },
  }
}
