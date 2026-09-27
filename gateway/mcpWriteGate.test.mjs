// Offline checks for the MCP write-tool gate: mcpTools.ts's MCP_WRITE_TOOLS
// classification and canUseMcpTool, the single gate mcpAgent.ts's per-call
// wrap consults (same editor-tier rule as chat's WRITE_FUNCTIONS, Task 7).
// Deliberately in its own always-run file: mcpTools.test.mjs's sections all
// need the local Supabase stack, so a gate regression would otherwise be
// invisible in every offline suite.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerUfwtMcpTools, MCP_WRITE_TOOLS, canUseMcpTool } from './mcpTools.ts'

let failed = 0
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'}  ${name}`)
  if (!cond) failed++
}

// Registered names come off a real McpServer rather than a hand-maintained
// list, so a brand-new registerTool() fails the xor below until someone
// classifies it. Registration only defines tools -- no fetch happens -- so a
// dummy config is safe here. `_registeredTools` is the same private seam
// mcpTools.test.mjs's handlersFor() already reads.
const server = new McpServer({ name: 'mcpWriteGate.test.mjs', version: '0.0.0' })
registerUfwtMcpTools(server, { supabaseUrl: 'https://example.test', supabaseSecretKey: 'k' }, 1)
const MCP_REGISTERED = Object.keys(server._registeredTools)

const MCP_READ_ONLY = new Set([
  'list_games', 'get_current_game', 'get_game_details', 'list_game_events',
  'get_player_stats', 'list_seasons', 'list_roster', 'list_lineups',
])

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

console.log(failed === 0 ? '\nall mcpWriteGate checks passed' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
