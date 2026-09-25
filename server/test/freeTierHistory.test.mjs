import assert from 'node:assert/strict'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

process.env.VERCEL = '1'
process.env.SUPABASE_URL = 'https://example.test'
process.env.SUPABASE_SECRET_KEY = 'service-role-key'
process.env.SUPABASE_PUBLISHABLE_KEY = 'publishable-key'
process.env.SUPABASE_JWKS_URL = 'https://example.test/auth/v1/.well-known/jwks.json'
process.env.POSTHOG_PROJECT_TOKEN = 'posthog-token'
process.env.STRIPE_SECRET_KEY = 'sk_test_mock'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_mock'
process.env.APP_URL = 'http://localhost:5199'

// Fixtures for org 7.
// Game 900 is ancient (dated > 30 days ago).
// Game 901 is recent (3 days ago).
const now = Date.now()
const threeDaysAgoIso = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString()
const threeDaysAgoDate = threeDaysAgoIso.slice(0, 10)

const PLAYERS = [
  { id: 701, display_name: 'Old Timer', position: 'Handler', gender_match: 'open', is_sub: false, organization_id: 7 },
  { id: 702, display_name: 'Recent Star', position: 'Cutter', gender_match: 'open', is_sub: false, organization_id: 7 },
]

const SEASONS = [
  { id: 50, name: 'Summer', year: 2026, organizer: 'Jam', location: null, start_date: '2025-06-01', end_date: '2026-08-31', organization_id: 7 },
]

const GAMES = [
  { id: 900, season_id: 50, opponent: 'Ancient Rival', game_date: '2025-08-01', game_time: '18:00', game_type: null, notes: null, outcome_override: null, result: 'Win', organization_id: 7 },
  { id: 901, season_id: 50, opponent: 'Fresh Rival', game_date: threeDaysAgoDate, game_time: '19:00', game_type: null, notes: null, outcome_override: null, result: 'Win', organization_id: 7 },
]

const GAME_EVENTS = [
  // Old game, old event:
  { id: 1, player_id: 701, related_player_id: null, event_type: 'Goal', game_id: 900, event_timestamp: '2025-08-01T18:30:00Z', notes: null, organization_id: 7 },
  // Old game, freshly logged event (backfill probe):
  { id: 2, player_id: 702, related_player_id: null, event_type: 'Goal', game_id: 900, event_timestamp: new Date(now - 1000).toISOString(), notes: null, organization_id: 7 },
  // Recent game event:
  { id: 3, player_id: 702, related_player_id: 701, event_type: 'Goal', game_id: 901, event_timestamp: threeDaysAgoIso, notes: null, organization_id: 7 },
]

const LINEUPS = [
  { id: 1, game_id: 900, player_id: 701, lineup_name: 'Lineup 1', sort_order: 0, role: 'Handler', organization_id: 7 },
  { id: 2, game_id: 901, player_id: 702, lineup_name: 'Lineup 1', sort_order: 0, role: 'Cutter', organization_id: 7 },
]

let tierState = 'free'

const realFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(String(url))
  if (target.hostname === '127.0.0.1' || target.hostname === 'localhost') {
    return realFetch(url, init)
  }

  const path = target.pathname
  const search = decodeURIComponent(target.search)

  const accept = init.headers?.get?.('accept') || init.headers?.Accept || (init.headers && init.headers['accept']) || ''
  const wantsSingle = typeof accept === 'string' && accept.includes('vnd.pgrst.object+json')
  const respond = (rows) => wantsSingle ? Response.json(rows[0] ?? null) : Response.json(rows)

  if (path === '/rest/v1/rpc/effective_tier') {
    return Response.json(tierState)
  }

  // Parse game_id filters if present
  function filterEvents(rows) {
    // game_id=eq.900
    const eqMatch = search.match(/(?:[?&])game_id=eq\.(\d+)/)
    if (eqMatch) {
      const gid = Number(eqMatch[1])
      return rows.filter(r => r.game_id === gid)
    }
    // game_id=in.(900,901) or game_id=in.(-1)
    const inMatch = search.match(/(?:[?&])game_id=in\.\(([^)]*)\)/)
    if (inMatch) {
      const raw = inMatch[1].trim()
      if (!raw || raw === '-1') return []
      const ids = new Set(raw.split(',').map(s => Number(s.trim())))
      return rows.filter(r => ids.has(r.game_id))
    }
    return rows
  }

  function filterGames(rows) {
    const eqMatch = search.match(/(?:[?&])id=eq\.(\d+)/)
    if (eqMatch) {
      const gid = Number(eqMatch[1])
      return rows.filter(r => r.id === gid)
    }
    return rows
  }

  if (path === '/rest/v1/players') return respond(PLAYERS)
  if (path === '/rest/v1/seasons') return respond(SEASONS)
  if (path === '/rest/v1/games') return respond(filterGames(GAMES))
  if (path === '/rest/v1/game_events') return respond(filterEvents(GAME_EVENTS))
  if (path === '/rest/v1/game_lineups') return respond(LINEUPS)
  if (path === '/rest/v1/season_players') return respond([])
  if (path === '/rest/v1/game_lineup_groups') return respond([])

  throw new Error(`Unexpected fetch in freeTierHistory.test.mjs: ${url}`)
}

console.log('--- 1. Gateway Chat getTeamContext (Free vs Paid) ---')
const { getTeamContext: gatewayContext } = await import('../../gateway/chat.ts')
const chatConfig = {
  supabaseUrl: 'https://example.test',
  supabaseSecretKey: 'service-role-key',
  jwksUrl: 'https://example.test/auth/v1/.well-known/jwks.json',
}

// Free tier: old game events withheld
tierState = 'free'
const freeChatCtx = await gatewayContext(chatConfig, 7)
assert(freeChatCtx.includes('DATA WINDOW: this team is on the Free plan'), 'Free prompt includes window note')
assert(freeChatCtx.includes('Old Timer (Handler). All-time: 0G 1A 0TO'), 'Old Timer has 0G 1A on Free (ancient game withheld, recent assist counted)')
assert(freeChatCtx.includes('Recent Star (Cutter). All-time: 1G 0A 0TO'), 'Recent Star has 1G 0A on Free')
assert(freeChatCtx.includes('Ancient Rival'), 'Ancient game fixture is still listed on Free')
assert(freeChatCtx.includes('- 2025-08-01 vs Ancient Rival [Jam Summer 2026]: 0-0 Win'), 'Ancient game score is 0-0 on Free (events withheld)')
assert(freeChatCtx.includes(`- ${threeDaysAgoDate} vs Fresh Rival [Jam Summer 2026]: 1-0 Win`), 'Recent game score shows 1-0 on Free')
console.log('✓ gateway getTeamContext enforces 30-day window on Free')

// Paid tier: immediately restored
tierState = 'plus'
const paidChatCtx = await gatewayContext(chatConfig, 7)
assert(!paidChatCtx.includes('DATA WINDOW'), 'Paid prompt has no window note')
assert(paidChatCtx.includes('Old Timer (Handler). All-time: 1G 1A 0TO'), 'Old Timer gets full 1G 1A on Paid')
assert(paidChatCtx.includes('Recent Star (Cutter). All-time: 2G 0A 0TO'), 'Recent Star gets 2G (both games) on Paid')
assert(paidChatCtx.includes('- 2025-08-01 vs Ancient Rival [Jam Summer 2026]: 2-0 Win'), 'Ancient game score shows full 2-0 on Paid')
console.log('✓ gateway getTeamContext restores full history on Paid')

console.log('\n--- 2. Server getTeamContext (Free vs Paid) ---')
const { getTeamContext: serverContext } = await import('../index.ts')

tierState = 'free'
const freeServerCtx = await serverContext(7)
assert(freeServerCtx.includes('DATA WINDOW: this team is on the Free plan'))
assert(freeServerCtx.includes('Old Timer (Handler). All-time: 0G 1A 0TO'))
assert(freeServerCtx.includes('Recent Star (Cutter). All-time: 1G 0A 0TO'))
console.log('✓ server getTeamContext enforces 30-day window on Free')

tierState = 'premium'
const paidServerCtx = await serverContext(7)
assert(!paidServerCtx.includes('DATA WINDOW'))
assert(paidServerCtx.includes('Old Timer (Handler). All-time: 1G 1A 0TO'))
assert(paidServerCtx.includes('Recent Star (Cutter). All-time: 2G 0A 0TO'))
console.log('✓ server getTeamContext restores full history on Premium')

console.log('\n--- 3. Gateway MCP Tools (Free vs Paid) ---')
const { registerUfwtMcpTools } = await import('../../gateway/mcpTools.ts')
const mcpServer = new McpServer({ name: 'test', version: '0' })
registerUfwtMcpTools(mcpServer, { supabaseUrl: 'https://example.test', supabaseSecretKey: 'service-role-key' }, 7)
const statsHandler = mcpServer._registeredTools['get_player_stats'].handler
const listEventsHandler = mcpServer._registeredTools['list_game_events'].handler
const gameDetailsHandler = mcpServer._registeredTools['get_game_details'].handler

// Free tier: stats only count recent events, but attendance counts all games
tierState = 'free'
const freeStatsRes = await statsHandler({})
const freeStats = JSON.parse(freeStatsRes.content[0].text)
const freeOldTimer = freeStats.find(p => p.player_id === 701)
const freeRecentStar = freeStats.find(p => p.player_id === 702)
assert.equal(freeOldTimer.goals, 0, 'Old Timer 0G on Free')
assert.equal(freeOldTimer.games_played, 1, 'Old Timer attendance visible on Free (lineup retained)')
assert.equal(freeRecentStar.goals, 1, 'Recent Star 1G on Free')

const freeOldEventsRes = await listEventsHandler({ gameId: 900 })
assert.deepEqual(JSON.parse(freeOldEventsRes.content[0].text), [], 'Old game events list is empty on Free')

const freeRecentEventsRes = await listEventsHandler({ gameId: 901 })
assert.equal(JSON.parse(freeRecentEventsRes.content[0].text).length, 1, 'Recent game events returned on Free')

const freeOldDetailsRes = await gameDetailsHandler({ gameId: 900 })
const freeOldDetails = JSON.parse(freeOldDetailsRes.content[0].text)
assert.equal(freeOldDetails.our_score, 0, 'Old game score is 0 on Free')
assert.deepEqual(freeOldDetails.recent_events, [], 'Old game details recent_events is empty on Free')
console.log('✓ gateway MCP tools gate game events on Free while preserving attendance')

// Paid tier: restored
tierState = 'plus'
const paidStatsRes = await statsHandler({})
const paidStats = JSON.parse(paidStatsRes.content[0].text)
const paidOldTimer = paidStats.find(p => p.player_id === 701)
const paidRecentStar = paidStats.find(p => p.player_id === 702)
assert.equal(paidOldTimer.goals, 1, 'Old Timer 1G on Paid')
assert.equal(paidRecentStar.goals, 2, 'Recent Star 2G on Paid')

const paidOldEventsRes = await listEventsHandler({ gameId: 900 })
assert.equal(JSON.parse(paidOldEventsRes.content[0].text).length, 2, 'Old game events returned on Paid')
console.log('✓ gateway MCP tools restore full event history on Paid')

console.log('\n--- 4. mcp-server index.ts (Free vs Paid) ---')
async function loadMcpServerHandlers(orgId) {
  const handlers = new Map()
  const originalRegisterTool = McpServer.prototype.registerTool
  McpServer.prototype.registerTool = function (name, toolConfig, cb) {
    handlers.set(name, cb)
    return originalRegisterTool.call(this, name, toolConfig, cb)
  }
  const overrides = {
    SUPABASE_URL: 'https://example.test',
    SUPABASE_SECRET_KEY: 'service-role-key',
    MCP_ORGANIZATION_ID: String(orgId),
    POSTHOG_PROJECT_TOKEN: 'phc_test_stub',
    DOTENV_CONFIG_QUIET: 'true',
  }
  const saved = {}
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
  try {
    await import(`../../mcp-server/index.ts?freeTierHistoryTest=${Date.now()}-${Math.random()}`)
  } catch {
    // connect(transport) throws under headless test; handlers captured before that
  } finally {
    McpServer.prototype.registerTool = originalRegisterTool
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  return {
    get_player_stats: handlers.get('get_player_stats'),
    list_game_events: handlers.get('list_game_events'),
    get_game_details: handlers.get('get_game_details'),
  }
}

const stdioHandlers = await loadMcpServerHandlers(7)

tierState = 'free'
const stdioFreeStatsRes = await stdioHandlers.get_player_stats({})
const stdioFreeStats = JSON.parse(stdioFreeStatsRes.content[0].text)
assert.equal(stdioFreeStats.find(p => p.player_id === 701).goals, 0, '[mcp-server] Old Timer 0G on Free')
assert.equal(stdioFreeStats.find(p => p.player_id === 701).games_played, 1, '[mcp-server] attendance preserved')
assert.equal(stdioFreeStats.find(p => p.player_id === 702).goals, 1, '[mcp-server] Recent Star 1G on Free')

const stdioFreeEvents = await stdioHandlers.list_game_events({ gameId: 900 })
assert.deepEqual(JSON.parse(stdioFreeEvents.content[0].text), [], '[mcp-server] old game events empty on Free')

tierState = 'plus'
const stdioPaidStatsRes = await stdioHandlers.get_player_stats({})
const stdioPaidStats = JSON.parse(stdioPaidStatsRes.content[0].text)
assert.equal(stdioPaidStats.find(p => p.player_id === 701).goals, 1, '[mcp-server] Old Timer 1G on Paid')
assert.equal(stdioPaidStats.find(p => p.player_id === 702).goals, 2, '[mcp-server] Recent Star 2G on Paid')

const stdioPaidEvents = await stdioHandlers.list_game_events({ gameId: 900 })
assert.equal(JSON.parse(stdioPaidEvents.content[0].text).length, 2, '[mcp-server] old game events returned on Paid')
console.log('✓ mcp-server handlers enforce 30-day window on Free and restore on Paid')

console.log('\nAll Task 2 free-tier history tests passed!')
