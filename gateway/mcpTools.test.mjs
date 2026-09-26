import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerUfwtMcpTools, MCP_WRITE_TOOLS, canUseMcpTool } from './mcpTools.ts'
import { sbGet, sbWrite } from './supabaseRest.ts'

let failed = 0
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'}  ${name}`)
  if (!cond) failed++
}

// Cross-tenant IDOR regression guard for update_game_event/delete_game_event
// in both gateway/mcpTools.ts (this file) and mcp-server/index.ts (below).
// Both handlers used to filter their PATCH/DELETE by `id` alone under a
// service-role connection that bypasses RLS entirely -- any org could edit
// or delete any other org's game events by guessing/enumerating a sequential
// id. The fix scopes both queries by organization_id too; these tests prove
// the cross-org case is rejected (and the row is untouched), and that the
// same-org case still works (a regression guard against over-scoping the
// fix and breaking legitimate same-org edits).
//
// Real queries against the local stack, same pattern as
// gateway/membership.test.mjs: an unreachable/misconfigured stack must fail
// this file loudly rather than silently pass.

function loadLocalEnv() {
  const text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
  const env = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m) env[m[1]] = m[2]
  }
  return env
}

const env = loadLocalEnv()
const supabaseUrl = env.SUPABASE_URL
const supabaseSecretKey = env.SUPABASE_SECRET_KEY

if (!supabaseUrl || !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(supabaseUrl)) {
  throw new Error(
    `gateway/mcpTools.test.mjs requires a local Supabase URL in .env.local, got: ${supabaseUrl ?? '(missing)'}`
  )
}
if (!supabaseSecretKey) {
  throw new Error('gateway/mcpTools.test.mjs requires SUPABASE_SECRET_KEY in .env.local')
}

const config = { supabaseUrl, supabaseSecretKey }

// Seeded fixture (supabase/seed.sql): org 1 ("Team A") owns game 1 and player
// 101 ("Cap"); org 2 ("Team B") is a different, unrelated org.
const ORG_A = 1
const ORG_B = 2
const GAME_A = 1
const PLAYER_A = 101

async function createEvent() {
  const [row] = await sbWrite(config, 'POST', '/game_events', {
    organization_id: ORG_A,
    game_id: GAME_A,
    player_id: PLAYER_A,
    related_player_id: null,
    event_type: 'Block',
    event_timestamp: new Date().toISOString(),
    notes: 'mcpTools.test.mjs fixture',
  })
  return row
}

async function fetchEvent(id) {
  const rows = await sbGet(config, `/game_events?id=eq.${id}&select=*`)
  return rows[0]
}

async function cleanupEvent(id) {
  await sbWrite(config, 'DELETE', `/game_events?id=eq.${id}`)
}

// === gateway/mcpTools.ts ===
//
// registerUfwtMcpTools wires tools onto a live McpServer instance rather
// than exporting the update/delete logic as standalone functions, so build
// one real McpServer per org and grab the raw handler off
// `_registeredTools` -- the exact callback the gateway registers, invoked
// without needing a transport or client.
function handlersFor(orgId) {
  const server = new McpServer({ name: 'mcpTools.test.mjs', version: '0.0.0' })
  registerUfwtMcpTools(server, config, orgId)
  return {
    update: server._registeredTools['update_game_event'].handler,
    delete: server._registeredTools['delete_game_event'].handler,
  }
}

const handlersA = handlersFor(ORG_A)
const handlersB = handlersFor(ORG_B)

{
  // --- update_game_event: cross-org rejection + same-org regression ---
  const event = await createEvent()

  const crossOrg = await handlersB.update({ eventId: event.id, playerName: '' })
  check('cross-org update_game_event is rejected (isError)', crossOrg.isError === true)
  check(
    'cross-org update_game_event error does not distinguish "wrong org" from "doesn\'t exist"',
    crossOrg.content[0].text === `No event found with id ${event.id}.`
  )

  const untouched = await fetchEvent(event.id)
  check('cross-org update_game_event left the row unchanged', untouched.player_id === PLAYER_A)

  const sameOrg = await handlersA.update({ eventId: event.id, playerName: '' })
  check('same-org update_game_event still succeeds (regression guard)', !sameOrg.isError)

  const updated = await fetchEvent(event.id)
  check('same-org update_game_event actually applied the change', updated.player_id === null)

  await cleanupEvent(event.id)
}

{
  // --- delete_game_event: cross-org rejection + same-org regression ---
  const event = await createEvent()

  const crossOrg = await handlersB.delete({ eventId: event.id })
  check('cross-org delete_game_event is rejected (isError)', crossOrg.isError === true)
  check(
    'cross-org delete_game_event error does not distinguish "wrong org" from "doesn\'t exist"',
    crossOrg.content[0].text === `No event found with id ${event.id}.`
  )

  const stillThere = await fetchEvent(event.id)
  check('cross-org delete_game_event left the row in place', stillThere?.id === event.id)

  const sameOrg = await handlersA.delete({ eventId: event.id })
  check('same-org delete_game_event still succeeds (regression guard)', !sameOrg.isError)

  const gone = await fetchEvent(event.id)
  check('same-org delete_game_event actually removed the row', gone === undefined)
}

// === mcp-server/index.ts ===
//
// Unlike mcpTools.ts, this module has no exported registration function --
// it registers tools directly on a module-scoped McpServer at import time,
// scoped to a single org read from MCP_ORGANIZATION_ID at import (see
// CLAUDE.md's "MCP server" section: one process = one team, by design).
// To exercise both org A and org B against the same code, the module is
// imported twice with a cache-busting query string (forcing a fresh module
// instance each time -- plain re-import would hit Node's ES module cache)
// and MCP_ORGANIZATION_ID set differently each time. The real
// `registerTool` callbacks are captured via a temporary patch on
// McpServer.prototype.registerTool installed before each import -- the
// exact handler the module wires up, just invoked directly instead of
// through a live stdio transport/client.
async function loadMcpServerHandlers(orgId) {
  const handlers = new Map()
  const originalRegisterTool = McpServer.prototype.registerTool
  McpServer.prototype.registerTool = function (name, toolConfig, cb) {
    handlers.set(name, cb)
    return originalRegisterTool.call(this, name, toolConfig, cb)
  }
  const overrides = {
    SUPABASE_URL: supabaseUrl,
    SUPABASE_SECRET_KEY: supabaseSecretKey,
    MCP_ORGANIZATION_ID: String(orgId),
    POSTHOG_PROJECT_TOKEN: 'phc_test_stub_do_not_send',
    // Silences dotenv's own promotional "tip" logging (mcp-server/index.ts's
    // dotenv.config() call) so this test's output stays pristine.
    DOTENV_CONFIG_QUIET: 'true',
  }
  const saved = {}
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
  try {
    await import(`../mcp-server/index.ts?mcpToolsTestOrg=${orgId}-${Date.now()}-${Math.random()}`)
  } catch {
    // The module's final line connects a StdioServerTransport; any failure
    // there is irrelevant here -- every registerTool call (and therefore the
    // handler capture above) happens earlier at import time, before that
    // line runs.
  } finally {
    McpServer.prototype.registerTool = originalRegisterTool
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  if (!handlers.has('update_game_event') || !handlers.has('delete_game_event')) {
    throw new Error(
      `mcp-server/index.ts did not register update_game_event/delete_game_event for org ${orgId} -- import may have failed before reaching them`
    )
  }
  return { update: handlers.get('update_game_event'), delete: handlers.get('delete_game_event') }
}

const mcpServerHandlersA = await loadMcpServerHandlers(ORG_A)
const mcpServerHandlersB = await loadMcpServerHandlers(ORG_B)

{
  // --- update_game_event: cross-org rejection + same-org regression ---
  const event = await createEvent()

  const crossOrg = await mcpServerHandlersB.update({ eventId: event.id, playerName: '' })
  check('[mcp-server] cross-org update_game_event is rejected (isError)', crossOrg.isError === true)

  const untouched = await fetchEvent(event.id)
  check('[mcp-server] cross-org update_game_event left the row unchanged', untouched.player_id === PLAYER_A)

  const sameOrg = await mcpServerHandlersA.update({ eventId: event.id, playerName: '' })
  check('[mcp-server] same-org update_game_event still succeeds (regression guard)', !sameOrg.isError)

  const updated = await fetchEvent(event.id)
  check('[mcp-server] same-org update_game_event actually applied the change', updated.player_id === null)

  await cleanupEvent(event.id)
}

{
  // --- delete_game_event: cross-org rejection + same-org regression ---
  const event = await createEvent()

  const crossOrg = await mcpServerHandlersB.delete({ eventId: event.id })
  check('[mcp-server] cross-org delete_game_event is rejected (isError)', crossOrg.isError === true)

  const stillThere = await fetchEvent(event.id)
  check('[mcp-server] cross-org delete_game_event left the row in place', stillThere?.id === event.id)

  const sameOrg = await mcpServerHandlersA.delete({ eventId: event.id })
  check('[mcp-server] same-org delete_game_event still succeeds (regression guard)', !sameOrg.isError)

  const gone = await fetchEvent(event.id)
  check('[mcp-server] same-org delete_game_event actually removed the row', gone === undefined)
}

// Write tools follow the spec's editor-tier rule (same gate as chat's
// WRITE_FUNCTIONS, Task 7). Kept next to the classification so a new
// registered tool fails here until someone classifies it.
const MCP_READ_ONLY = new Set([
  'list_games', 'get_current_game', 'get_game_details', 'list_game_events',
  'get_player_stats', 'list_seasons', 'list_roster', 'list_lineups',
])
const MCP_REGISTERED = [
  'list_games', 'get_current_game', 'get_game_details', 'create_game_event',
  'update_game_event', 'delete_game_event', 'list_game_events', 'get_player_stats',
  'list_seasons', 'list_roster', 'list_lineups', 'create_lineup_group',
  'add_to_lineup', 'remove_from_lineup',
]

for (const name of MCP_WRITE_TOOLS) {
  check(`MCP_WRITE_TOOLS name "${name}" is a registered tool`, MCP_REGISTERED.includes(name))
}
for (const name of MCP_REGISTERED) {
  check(`MCP tool "${name}" is classified exactly once (write xor read-only)`,
    MCP_WRITE_TOOLS.has(name) !== MCP_READ_ONLY.has(name))
}
check('member cannot use an MCP write tool', canUseMcpTool('member', 'create_game_event') === false)
check('editor can use an MCP write tool', canUseMcpTool('editor', 'create_game_event') === true)
check('captain can use an MCP write tool', canUseMcpTool('captain', 'add_to_lineup') === true)
check('member can use an MCP read tool', canUseMcpTool('member', 'list_games') === true)
check('no role means no tool at all', canUseMcpTool(null, 'list_games') === false)
check('unknown tool names pass only with a role (fail on lookup elsewhere)',
  canUseMcpTool('member', 'not_a_tool') === true)

console.log(failed === 0 ? '\nall mcpTools checks passed' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
