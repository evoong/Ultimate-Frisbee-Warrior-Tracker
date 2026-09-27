import assert from 'node:assert/strict'

// Fixtures for org 7 (same shape as server/test/freeTierHistory.test.mjs).
const now = Date.now()
const EVENTS = [
  { id: 3, player_id: 702, related_player_id: 701, event_type: 'Goal', game_id: 901, event_timestamp: new Date(now - 86400000).toISOString(), organization_id: 7 },
  { id: 4, player_id: 701, related_player_id: null, event_type: 'Goal', game_id: 901, event_timestamp: new Date(now - 86000000).toISOString(), organization_id: 7 },
]
const PLAYERS = [
  { id: 701, display_name: 'Old Timer' },
  { id: 702, display_name: 'Recent Star' },
]

const realFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (url) => {
  const target = new URL(String(url))
  if (target.hostname === '127.0.0.1' || target.hostname === 'localhost') return realFetch(url)
  const search = decodeURIComponent(target.search)
  if (target.pathname === '/rest/v1/rpc/effective_tier') return Response.json('paid')
  if (target.pathname === '/rest/v1/players') return Response.json(PLAYERS)
  if (target.pathname === '/rest/v1/game_events') {
    let rows = EVENTS
    const gid = search.match(/game_id=in\.\(([^)]*)\)/)
    if (gid) {
      const ids = gid[1].split(',').map(Number)
      rows = rows.filter(r => ids.includes(r.game_id))
    }
    return Response.json(rows)
  }
  if (target.pathname === '/rest/v1/games') {
    return Response.json([{ id: 901, season_id: 50, opponent: 'Fresh Rival', game_date: new Date(now - 86400000).toISOString().slice(0, 10), game_time: '19:00' }])
  }
  if (target.pathname === '/rest/v1/seasons') {
    return Response.json([{ id: 50, name: 'Summer', year: 2026, organizer: 'Jam' }])
  }
  throw new Error(`unmocked fetch: ${url}`)
}

try {
  const { queryStatBreakdown } = await import('./gameActions.ts')
  const config = { supabaseUrl: 'https://example.test', supabaseSecretKey: 'k' }

  const unscoped = await queryStatBreakdown(config, 7, { metric: 'goals' })
  assert.equal(unscoped.rows.length, 2, 'unscoped goals returns both players')

  const scoped = await queryStatBreakdown(config, 7, { metric: 'goals' }, { playerId: 702, playerName: 'Recent Star' })
  assert.equal(scoped.rows.length, 1, 'scoped goals returns only the linked player')
  assert.equal(scoped.rows[0].player, 'Recent Star')

  const scopedAssists = await queryStatBreakdown(config, 7, { metric: 'assists', byAssistPairing: true }, { playerId: 701, playerName: 'Old Timer' })
  assert.equal(scopedAssists.rows.length, 1, 'scoped assist pairing keeps rows involving the linked player')
  assert.equal(scopedAssists.rows[0].count, 1)

  const scopedScorerPairings = await queryStatBreakdown(config, 7, { metric: 'assists', byAssistPairing: true }, { playerId: 702, playerName: 'Recent Star' })
  assert.equal(scopedScorerPairings.rows.length, 1, "linked player's own goals' pairings survive (they are data about them)")
  assert.equal(scopedScorerPairings.rows[0].scorer, 'Recent Star', 'row has the linked player as scorer')
  assert.equal(scopedScorerPairings.rows[0].assister, 'Old Timer')
  assert.equal(scopedScorerPairings.rows[0].count, 1)

  const scopedOther = await queryStatBreakdown(config, 7, { metric: 'goals' }, { playerId: 701, playerName: 'Old Timer' })
  assert.deepEqual(scopedOther.rows.map(r => r.player), ['Old Timer'], 'the other player sees their own goals only')

  console.log('✓ gateway/queryScope.test.mjs all passed')
} finally {
  globalThis.fetch = realFetch
}
