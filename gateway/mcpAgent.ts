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

interface Env {
  SUPABASE_URL: string
  SUPABASE_SECRET_KEY: string
  MCP_ORGANIZATION_ID?: string
}

// `McpAuthProps` (just `{ email }`) is the identity OAuthProvider verified
// at login via gateway/mcpOAuth.ts's Supabase password-grant check; tool
// calls still run under the service-role key below (same trust model as
// mcp-server/index.ts), so `this.props.email` isn't consulted for access
// control yet — it's available for a future per-action attribution feature.
export class UfwtMcp extends McpAgent<Env, {}, McpAuthProps> {
  server = new McpServer({ name: 'ultimate-frisbee-warrior-tracker', version: '1.0.0' })

  async init() {
    const orgId = this.env.MCP_ORGANIZATION_ID ? parseInt(this.env.MCP_ORGANIZATION_ID) : 1
    registerUfwtMcpTools(this.server, { supabaseUrl: this.env.SUPABASE_URL, supabaseSecretKey: this.env.SUPABASE_SECRET_KEY }, orgId)
  }
}
