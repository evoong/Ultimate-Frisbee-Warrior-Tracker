// Membership lookups for routes that hold the service-role key and
// therefore bypass RLS. Everything here is a deliberate re-implementation
// of what a policy would have done automatically.

export type TeamRole = 'captain' | 'editor' | 'member'

const RANK: Record<TeamRole, number> = { member: 1, editor: 2, captain: 3 }

export function hasAtLeast(role: TeamRole | null, required: TeamRole): boolean {
  if (!role) return false
  return RANK[role] >= RANK[required]
}

export interface MembershipConfig {
  supabaseUrl: string
  supabaseSecretKey: string
}

// Named TeamRoleRow, not TeamMembership: auth-handlers.ts exports a
// TeamMembership of a different shape (it carries the team name and
// is_public for the session payload), and a file may import both.
export interface TeamRoleRow {
  team_id: number
  role: TeamRole
}

export interface MembershipLookup {
  roleFor(userId: string, teamId: number): Promise<TeamRole | null>
  teamsFor(userId: string): Promise<TeamRoleRow[]>
}

// Short TTL: a revoked role must stop working promptly, but a chat turn
// should not re-query per function call.
const TTL_MS = 30_000

// In the Worker, call this once per request, never hoist it to module
// scope. The cache below is intentionally scoped to the returned
// MembershipLookup instance, not shared globally: worker.ts constructs one
// of these inside the per-request handler that builds chatConfig, so a
// chat turn (one request) gets its own cache -- no cross-request
// staleness beyond that single turn, and no unbounded Map growth across
// the life of a long-lived Worker isolate as distinct users pass through
// it. Do not "fix" this by hoisting to a shared/module-level lookup there.
//
// server/index.ts is a deliberate exception to that rule, not a violation
// of it: Express has no per-isolate/per-request boundary to exploit the
// way the Worker does, isOrgMember/isEmailAllowed there are bare
// module-level functions, and a module-scoped lookup bounds the cache by
// distinct users rather than by request volume. The resulting
// cross-request staleness is capped by the TTL below, which the plan's
// Global Constraint explicitly permits ("cached for at most 30 seconds. A
// revoked role must take effect promptly").
export function createMembershipLookup(config: MembershipConfig): MembershipLookup {
  const cache = new Map<string, { at: number; rows: TeamRoleRow[] }>()

  async function load(userId: string): Promise<TeamRoleRow[]> {
    const hit = cache.get(userId)
    if (hit && Date.now() - hit.at < TTL_MS) return hit.rows

    const url =
      `${config.supabaseUrl}/rest/v1/team_members` +
      `?select=team_id,role&user_id=eq.${encodeURIComponent(userId)}`
    // Fail closed. An unavailable lookup must not read as "allowed",
    // whether "unavailable" means the request reached Supabase and got
    // rejected (res.ok false below) or never reached it at all (fetch
    // itself throwing -- refused connection, DNS failure, timeout, or a
    // non-JSON body that fails to parse). Both modes resolve to no
    // memberships and therefore to a denial. Deliberately NOT cached
    // either way: a transient outage must not lock a user out for the
    // remainder of the TTL once the backend recovers.
    try {
      const res = await fetch(url, {
        headers: {
          apikey: config.supabaseSecretKey,
          Authorization: `Bearer ${config.supabaseSecretKey}`,
        },
      })
      if (!res.ok) return []
      const rows = (await res.json()) as TeamRoleRow[]
      const safe = Array.isArray(rows) ? rows : []
      // Unlike the !res.ok and catch paths above, a 2xx response with an
      // unexpected (non-array) body IS cached as [] for the full TTL. That
      // asymmetry is intentional -- caching a deny is safe -- not a bug to
      // "fix" into an uncached path, which would reintroduce a lookup
      // storm during an outage that keeps returning malformed 2xx bodies.
      cache.set(userId, { at: Date.now(), rows: safe })
      return safe
    } catch {
      return []
    }
  }

  return {
    async teamsFor(userId) {
      return load(userId)
    },
    async roleFor(userId, teamId) {
      const rows = await load(userId)
      return rows.find(r => r.team_id === teamId)?.role ?? null
    },
  }
}
