// Cloudflare-hosted counterpart to mcp-server/index.ts (which runs the same
// tools locally over stdio, talking to Supabase via @supabase/supabase-js).
// This Durable Object exposes the same tool set over the Streamable HTTP MCP
// transport at /mcp (see worker.ts), so Claude Code/Desktop (or any other MCP
// client) can connect to a URL instead of spawning a local process — useful
// from a machine that doesn't have this repo checked out. Mounted alongside
// the rest of worker.ts's routes; see "MCP server (AI tool access)" in
// CLAUDE.md for the bearer-token gate applied before requests reach here.
//
// Same single-organization-per-deployment model as mcp-server/index.ts (see
// that file's comment): there's no signed-in "current user" in this headless
// context, so MCP_ORGANIZATION_ID picks the org for the life of the Worker.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpAgent } from 'agents/mcp'
import { registerUfwtMcpTools } from './mcpTools.js'
import type { McpAuthProps } from './mcpOAuth.js'
import { createMembershipLookup } from './membership.js'
import * as Sentry from '@sentry/cloudflare'

interface Env {
  SUPABASE_URL: string
  SUPABASE_SECRET_KEY: string
  MCP_ORGANIZATION_ID?: string
  SENTRY_DSN_WORKER: string
}

// `McpAuthProps` (just `{ email }`) is the identity OAuthProvider verified
// at login via gateway/mcpOAuth.ts's Supabase password-grant check. Tool
// calls still run under the service-role key below (same trust model as
// mcp-server/index.ts), but `init()` now consults `this.props.email` before
// registering any tools: it is resolved to a Supabase user id and must hold
// a `team_members` role on `MCP_ORGANIZATION_ID`, or `init()` throws and no
// tools are registered at all.
class UfwtMcpBase extends McpAgent<Env, {}, McpAuthProps> {
  server = new McpServer({ name: 'ultimate-frisbee-warrior-tracker', version: '1.0.0' })

  async init() {
    // parseInt would take "1.9" as 1 and "2abc" as 2. Membership is still
    // checked against whatever id results, so a sloppy value cannot reach
    // another team's data, but it should not silently pick a team either.
    const raw = this.env.MCP_ORGANIZATION_ID
    const orgId = raw === undefined ? 1 : Number(raw)
    if (!Number.isInteger(orgId) || orgId < 1) {
      throw new Error(`MCP: MCP_ORGANIZATION_ID must be a positive integer, got ${JSON.stringify(raw)}`)
    }

    // The OAuth-authenticated identity must actually belong to the org these
    // tools operate on. Without this, any account that can complete the OAuth
    // flow gets service-role access to that team's data.
    const email = this.props?.email?.toLowerCase()
    if (!email) throw new Error('MCP: no authenticated identity')

    const users = await fetch(
      `${this.env.SUPABASE_URL}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`,
      { headers: { apikey: this.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${this.env.SUPABASE_SECRET_KEY}` } }
    )
      // Denials below all surface as `MCP: ...`; a transient Auth outage should
      // read the same way rather than escaping as a raw network rejection.
      .then(r => (r.ok ? r.json() : { users: [] }))
      .catch(() => ({ users: [] })) as { users?: { id: string; email?: string }[] }

    const userId = users.users?.find(u => u.email?.toLowerCase() === email)?.id
    if (!userId) throw new Error(`MCP: no account for ${email}`)

    const lookup = createMembershipLookup({
      supabaseUrl: this.env.SUPABASE_URL,
      supabaseSecretKey: this.env.SUPABASE_SECRET_KEY,
    })
    if ((await lookup.roleFor(userId, orgId)) === null) {
      throw new Error(`MCP: ${email} is not a member of team ${orgId}`)
    }

    registerUfwtMcpTools(
      this.server,
      { supabaseUrl: this.env.SUPABASE_URL, supabaseSecretKey: this.env.SUPABASE_SECRET_KEY },
      orgId
    )

    // Re-check membership on every tool call, not just here. init() runs once
    // when the Durable Object wakes (the agents SDK calls it from onStart), so
    // a role revoked afterwards would otherwise keep full service-role tool
    // access for the whole life of the warm instance -- well past the 30s the
    // design allows for a revocation to take effect. executeToolHandler is the
    // single point every tool call passes through, so wrapping it covers all
    // 14 tools without touching mcpTools.ts. The lookup caches for 30s, so this
    // costs at most one query per 30s per user.
    const server = this.server as unknown as {
      executeToolHandler?: (tool: unknown, args: unknown, extra: unknown) => Promise<unknown>
    }
    const inner = server.executeToolHandler
    if (typeof inner !== 'function') {
      // Fail closed and loudly rather than silently serving tools whose
      // membership check is frozen at wake time.
      throw new Error('MCP: cannot install the per-call membership check (SDK shape changed)')
    }
    server.executeToolHandler = async (tool, args, extra) => {
      if ((await lookup.roleFor(userId, orgId)) === null) {
        throw new Error(`MCP: ${email} is no longer a member of team ${orgId}`)
      }
      return inner.call(server, tool, args, extra)
    }
  }
}

export const UfwtMcp = Sentry.instrumentDurableObjectWithSentry(
  (env: Env) => ({ dsn: env.SENTRY_DSN_WORKER }),
  UfwtMcpBase,
)
