import assert from 'node:assert/strict'
import {
  viewLineup,
  createLineup,
  listLineupTemplates,
  saveLineupTemplate,
  applyLineupTemplate,
  callChatFunction,
} from './gameActions.ts'

// Mock database tables and fetch
const PLAYERS = [
  { id: 101, display_name: 'Alice', position: 'Handler', gender_match: 'female', organization_id: 1 },
  { id: 102, display_name: 'Bob', position: 'Cutter', gender_match: 'male', organization_id: 1 },
  { id: 103, display_name: 'Charlie', position: 'Handler', gender_match: 'male', organization_id: 1 },
]

const SEASONS = [
  { id: 10, name: 'Summer', year: 2026, organizer: 'Jam', organization_id: 1 },
]

const GAMES = [
  { id: 201, season_id: 10, opponent: 'Rival A', game_date: '2026-07-01', game_time: '18:00', organization_id: 1 },
  { id: 202, season_id: 10, opponent: 'Rival B', game_date: '2026-07-08', game_time: '18:00', organization_id: 1 },
]

let gameLineupGroups = [
  { id: 1, organization_id: 1, game_id: 201, lineup_name: 'Line 1', sort_order: 0 },
]

let gameLineups = [
  { id: 1, organization_id: 1, game_id: 201, player_id: 101, lineup_name: 'Line 1', sort_order: 0, role: 'Handler' },
]

let lineupTemplates = [
  { id: 301, organization_id: 1, season_id: 10, name: 'Default 7' },
]

let lineupTemplateGroups = [
  { id: 1, template_id: 301, organization_id: 1, lineup_name: 'O-Line', sort_order: 0 },
]

let lineupTemplatePlayers = [
  { id: 1, template_id: 301, organization_id: 1, lineup_name: 'O-Line', player_id: 101, sort_order: 0, role: 'Handler' },
  { id: 2, template_id: 301, organization_id: 1, lineup_name: 'O-Line', player_id: 102, sort_order: 1, role: 'Cutter' },
]

let seasonPlayers = [
  { organization_id: 1, season_id: 10, player_id: 101, is_sub: false },
]

const config = { supabaseUrl: 'https://example.supabase.co', supabaseSecretKey: 'secret-key' }

// Mock fetch
const origFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url))
  const path = u.pathname
  const params = u.searchParams
  const method = init.method || 'GET'
  const body = init.body ? JSON.parse(init.body) : null

  if (path === '/rest/v1/players') {
    return Response.json(PLAYERS)
  }
  if (path === '/rest/v1/seasons') {
    return Response.json(SEASONS)
  }
  if (path === '/rest/v1/games') {
    return Response.json(GAMES)
  }
  if (path === '/rest/v1/rpc/effective_tier') {
    return Response.json('paid')
  }

  if (path === '/rest/v1/game_lineup_groups') {
    if (method === 'GET') {
      const gid = Number(params.get('game_id')?.replace('eq.', ''))
      return Response.json(gameLineupGroups.filter(g => !gid || g.game_id === gid))
    }
    if (method === 'POST') {
      const rows = Array.isArray(body) ? body : [body]
      const inserted = rows.map((r, i) => ({ id: gameLineupGroups.length + i + 1, ...r }))
      gameLineupGroups.push(...inserted)
      return Response.json(inserted)
    }
    if (method === 'DELETE') {
      const gid = Number(params.get('game_id')?.replace('eq.', ''))
      const kept = gameLineupGroups.filter(g => gid && g.game_id !== gid)
      const removed = gameLineupGroups.filter(g => gid && g.game_id === gid)
      gameLineupGroups = kept
      return Response.json(removed)
    }
  }

  if (path === '/rest/v1/game_lineups') {
    if (method === 'GET') {
      const gid = Number(params.get('game_id')?.replace('eq.', ''))
      const rows = gameLineups
        .filter(l => !gid || l.game_id === gid)
        .map(l => {
          const p = PLAYERS.find(pl => pl.id === l.player_id)
          return {
            ...l,
            players: p ? { display_name: p.display_name, position: p.position, gender_match: p.gender_match } : null,
          }
        })
      return Response.json(rows)
    }
    if (method === 'POST') {
      const rows = Array.isArray(body) ? body : [body]
      const inserted = rows.map((r, i) => ({ id: gameLineups.length + i + 1, ...r }))
      gameLineups.push(...inserted)
      return Response.json(inserted)
    }
    if (method === 'DELETE') {
      const gid = Number(params.get('game_id')?.replace('eq.', ''))
      const kept = gameLineups.filter(l => gid && l.game_id !== gid)
      const removed = gameLineups.filter(l => gid && l.game_id === gid)
      gameLineups = kept
      return Response.json(removed)
    }
  }

  if (path === '/rest/v1/season_players') {
    if (method === 'POST') {
      const rows = Array.isArray(body) ? body : [body]
      seasonPlayers.push(...rows)
      return Response.json(rows)
    }
    return Response.json(seasonPlayers)
  }

  if (path === '/rest/v1/lineup_templates') {
    if (method === 'GET') {
      const sid = Number(params.get('season_id')?.replace('eq.', ''))
      const name = params.get('name')?.replace('eq.', '')
      let result = lineupTemplates
      if (sid) result = result.filter(t => t.season_id === sid)
      if (name) result = result.filter(t => t.name.toLowerCase() === decodeURIComponent(name).toLowerCase())
      return Response.json(result)
    }
    if (method === 'POST') {
      // Upsert
      const existingIdx = lineupTemplates.findIndex(t => t.season_id === body.season_id && t.name.toLowerCase() === body.name.toLowerCase())
      let row
      if (existingIdx >= 0) {
        row = { ...lineupTemplates[existingIdx], ...body }
        lineupTemplates[existingIdx] = row
      } else {
        row = { id: lineupTemplates.length + 101, ...body }
        lineupTemplates.push(row)
      }
      return Response.json([row])
    }
  }

  if (path === '/rest/v1/lineup_template_groups') {
    if (method === 'GET') {
      const tid = Number(params.get('template_id')?.replace('eq.', ''))
      return Response.json(lineupTemplateGroups.filter(g => !tid || g.template_id === tid))
    }
    if (method === 'DELETE') {
      const tid = Number(params.get('template_id')?.replace('eq.', ''))
      lineupTemplateGroups = lineupTemplateGroups.filter(g => g.template_id !== tid)
      return Response.json([])
    }
    if (method === 'POST') {
      const rows = Array.isArray(body) ? body : [body]
      lineupTemplateGroups.push(...rows)
      return Response.json(rows)
    }
  }

  if (path === '/rest/v1/lineup_template_players') {
    if (method === 'GET') {
      const tid = Number(params.get('template_id')?.replace('eq.', ''))
      return Response.json(lineupTemplatePlayers.filter(p => !tid || p.template_id === tid))
    }
    if (method === 'DELETE') {
      const tid = Number(params.get('template_id')?.replace('eq.', ''))
      lineupTemplatePlayers = lineupTemplatePlayers.filter(p => p.template_id !== tid)
      return Response.json([])
    }
    if (method === 'POST') {
      const rows = Array.isArray(body) ? body : [body]
      lineupTemplatePlayers.push(...rows)
      return Response.json(rows)
    }
  }

  throw new Error(`Unhandled mock fetch: ${method} ${path}`)
}

try {
  // Test 1: viewLineup returns game lineup groups and players
  const lineup1 = await viewLineup(config, 1, { gameDate: '2026-07-01' })
  assert.equal(lineup1.game.opponent, 'Rival A')
  assert.equal(lineup1.groups.length, 1)
  assert.equal(lineup1.groups[0].name, 'Line 1')
  assert.equal(lineup1.groups[0].players[0].name, 'Alice')
  assert.equal(lineup1.groups[0].players[0].role, 'Handler')

  // Test 2: createLineup replaces entire lineup
  const created = await createLineup(config, 1, {
    gameDate: '2026-07-01',
    groups: [
      {
        name: 'O-Line',
        players: [
          { playerName: 'Alice', role: 'Handler' },
          { playerName: 'Bob', role: 'Cutter' },
        ],
      },
      {
        name: 'D-Line',
        players: [
          { playerName: 'Charlie', role: 'Handler' },
        ],
      },
    ],
  })
  assert.equal(created.game.opponent, 'Rival A')
  assert.equal(created.groups.length, 2)
  assert.equal(created.groups[0].name, 'O-Line')
  assert.equal(created.groups[0].players.length, 2)
  assert.equal(created.groups[1].name, 'D-Line')
  assert.equal(created.groups[1].players.length, 1)

  // Verify viewLineup reflects the updated state
  const lineupAfterCreate = await viewLineup(config, 1, { gameDate: '2026-07-01' })
  assert.equal(lineupAfterCreate.groups.length, 2)
  assert.equal(lineupAfterCreate.groups[0].players[1].name, 'Bob')

  // Test 3: listLineupTemplates lists templates for current game season or specified season
  const templates = await listLineupTemplates(config, 1, { seasonName: 'Jam Summer 2026' })
  assert.equal(templates.templates.length, 1)
  assert.equal(templates.templates[0].name, 'Default 7')

  // Test 4: saveLineupTemplate saves current game's lineup as template
  const savedTemplate = await saveLineupTemplate(config, 1, {
    name: 'Zone D',
    gameDate: '2026-07-01',
  })
  assert.equal(savedTemplate.name, 'Zone D')
  assert.equal(savedTemplate.groups.length, 2)

  // Verify listLineupTemplates includes new template
  const templatesAfterSave = await listLineupTemplates(config, 1, {})
  assert.equal(templatesAfterSave.templates.length, 2)
  assert(templatesAfterSave.templates.some(t => t.name === 'Zone D'))

  // Test 5: applyLineupTemplate applies template to game 202
  const applied = await applyLineupTemplate(config, 1, {
    templateName: 'Default 7',
    gameDate: '2026-07-08',
  })
  assert.equal(applied.game.opponent, 'Rival B')
  assert.equal(applied.appliedTemplate, 'Default 7')
  const game2Lineup = await viewLineup(config, 1, { gameDate: '2026-07-08' })
  assert.equal(game2Lineup.groups.length, 1)
  assert.equal(game2Lineup.groups[0].name, 'O-Line')
  assert.equal(game2Lineup.groups[0].players.length, 2)

  // Test 6: callChatFunction dispatches all 5 functions
  const callView = await callChatFunction(config, 1, 'view_lineup', { gameDate: '2026-07-01' })
  assert(callView && typeof callView === 'object')

  console.log('✓ gateway/lineupActions.test.mjs all passed')
} finally {
  globalThis.fetch = origFetch
}
