import assert from 'node:assert/strict'
import {
  createProposal, getProposal, takeProposal, deleteProposal, isExpired, PROPOSAL_TTL_MS, buildProposal,
  confirmProposal, ConfirmError,
} from './chatProposals.ts'

const config = { supabaseUrl: 'https://example.test', supabaseSecretKey: 'service-role-key' }

// In-memory table; every REST call is recorded so ownership filters and
// single-use claims are asserted on the real request strings.
const rows = []
const calls = []
const origFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url))
  const method = init.method || 'GET'
  calls.push({ method, path: u.pathname, search: u.search })
  if (u.pathname !== '/rest/v1/chat_action_proposals') {
    throw new Error(`unexpected fetch ${method} ${u.pathname}`)
  }
  const f = k => u.searchParams.get(k)?.replace('eq.', '')
  const match = r => r.id === f('id') && r.session_id === f('session_id')
    && String(r.organization_id) === f('organization_id') && r.user_id === f('user_id')
  if (method === 'GET') return Response.json(rows.filter(match))
  if (method === 'POST') {
    const body = JSON.parse(init.body)
    // The DB supplies created_at via its default now(); the REST response
    // echoes it back — simulate that so isExpired tests run on real shape.
    const stored = { ...body, created_at: new Date().toISOString() }
    rows.push(stored)
    return Response.json([stored])
  }
  if (method === 'DELETE') {
    const hit = rows.filter(match)
    for (const r of hit) rows.splice(rows.indexOf(r), 1)
    return Response.json(hit)
  }
  throw new Error(`unhandled ${method}`)
}

try {
  const base = {
    session_id: '11111111-1111-4111-8111-111111111111',
    organization_id: 7, user_id: 'user-1',
    tool_name: 'create_game_event', args: { eventType: 'Goal' },
  }

  // create → row with id + created_at
  const created = await createProposal(config, base)
  assert.ok(created.id, 'created row has an id')
  assert.equal(typeof created.created_at, 'string', 'created_at is a JSON string')

  // get with the right filter → row
  const filter = { id: created.id, session_id: base.session_id, organization_id: base.organization_id, user_id: base.user_id }
  assert.equal((await getProposal(config, filter))?.id, created.id)

  // get with the wrong user → null, and the filter went out in the query
  assert.equal(await getProposal(config, { ...filter, user_id: 'user-2' }), null, 'another user sees nothing')
  assert.ok(calls.some(c => c.search.includes('user_id=eq.user-2')), 'ownership enforced in the query string')

  // take → claims and deletes; a second take loses
  const claimed = await takeProposal(config, filter)
  assert.equal(claimed?.id, created.id)
  assert.equal(await takeProposal(config, filter), null, 'second claim loses the race')

  // expiry math
  const old = { ...base, id: 'x', created_at: new Date(Date.now() - PROPOSAL_TTL_MS - 1000).toISOString() }
  assert.equal(isExpired(old), true)
  assert.equal(isExpired({ ...old, created_at: new Date().toISOString() }), false)

  // deleteProposal removes silently
  const p2 = await createProposal(config, { ...base, tool_name: 'undo_last_event' })
  const filter2 = { id: p2.id, session_id: base.session_id, organization_id: base.organization_id, user_id: base.user_id }
  await deleteProposal(config, filter2)
  assert.equal(await getProposal(config, filter2), null)

  console.log('✓ gateway/chatProposals.test.mjs all passed')

  // ---- buildProposal: validation reads + summary + store (Task 3) ----
  const GAMES = [{ id: 201, season_id: 10, opponent: 'Rival A', game_date: '2026-09-29', game_time: '18:00' }]
  const PLAYERS = [{ id: 101, display_name: 'Alice' }, { id: 102, display_name: 'Bob' }]
  rows.length = 0
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    const path = u.pathname
    if (path === '/rest/v1/chat_action_proposals') {
      const method = init.method || 'GET'
      const f = k => u.searchParams.get(k)?.replace('eq.', '')
      const match = r => r.id === f('id') && r.session_id === f('session_id')
        && String(r.organization_id) === f('organization_id') && r.user_id === f('user_id')
      if (method === 'POST') { const b = JSON.parse(init.body); const stored = { ...b, created_at: new Date().toISOString() }; rows.push(stored); return Response.json([stored]) }
      return Response.json(rows.filter(match))
    }
    if (path === '/rest/v1/games') return Response.json(GAMES)
    if (path === '/rest/v1/players') return Response.json(PLAYERS)
    throw new Error(`unexpected fetch ${init.method || 'GET'} ${path}`)
  }

  const cfg = { supabaseUrl: 'https://example.test', supabaseSecretKey: 'service-role-key' }
  const ctx = { organization_id: 1, session_id: '11111111-1111-4111-8111-111111111111', user_id: 'user-1' }

  // happy path: names resolved into the summary, row stored
  const p = await buildProposal(cfg, ctx, 'add_to_lineup', { playerName: 'Alice', lineupGroupName: 'Line 1' })
  assert.equal(p.tool_name, 'add_to_lineup')
  assert.ok(p.id, 'proposal id present')
  assert.ok(p.summary.includes('Alice') && p.summary.includes('Rival A'), `summary carries resolved names: "${p.summary}"`)
  assert.equal(rows.length, 1, 'row stored')

  // unknown player → throws, stores nothing
  rows.length = 0
  await assert.rejects(() => buildProposal(cfg, ctx, 'add_to_lineup', { playerName: 'Nobody' }), /No player found/)
  assert.equal(rows.length, 0, 'nothing stored on validation failure')

  // create_lineup resolves every player and summarizes groups
  rows.length = 0
  const lu = await buildProposal(cfg, ctx, 'create_lineup', {
    groups: [{ name: 'O-Line', players: [{ playerName: 'Alice' }, { playerName: 'Bob', role: 'Cutter' }] }],
  })
  assert.ok(lu.summary.includes('O-Line') && lu.summary.includes('Bob'), 'lineup summary lists group and players')
  assert.equal(rows.length, 1)

  // read-only tools are never proposable
  await assert.rejects(() => buildProposal(cfg, ctx, 'view_lineup', {}), /Unknown write tool/)

  console.log('✓ buildProposal checks passed')

  // ---- confirmProposal: claim, gates, single-use (Task 5) ----
  rows.length = 0
  const writeCalls = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    const path = u.pathname
    const method = init.method || 'GET'
    if (path === '/rest/v1/chat_action_proposals') {
      const f = k => u.searchParams.get(k)?.replace('eq.', '')
      const match = r => r.id === f('id') && r.session_id === f('session_id')
        && String(r.organization_id) === f('organization_id') && r.user_id === f('user_id')
      if (method === 'POST') { const b = JSON.parse(init.body); const stored = { ...b, created_at: new Date().toISOString() }; rows.push(stored); return Response.json([stored]) }
      if (method === 'DELETE') {
        const hit = rows.filter(match)
        for (const r of hit) rows.splice(rows.indexOf(r), 1)
        return Response.json(hit)
      }
      return Response.json(rows.filter(match))
    }
    if (path === '/rest/v1/games') return Response.json(GAMES)
    if (path === '/rest/v1/players') return Response.json(PLAYERS)
    if (path === '/rest/v1/game_lineup_groups' || path === '/rest/v1/game_lineups') {
      if (method === 'GET') return Response.json([])
      writeCalls.push(`${method} ${path}`)
      return Response.json([{ ok: true }])
    }
    if (path === '/rest/v1/season_players') return Response.json([])
    throw new Error(`unexpected fetch ${method} ${path}`)
  }

  const confirmCtx = {
    id: '',
    session_id: '11111111-1111-4111-8111-111111111111',
    organization_id: 1,
    user_id: 'user-1',
    role: 'editor',
  }
  const seed = (tool, args, ageMs = 0) => {
    const row = {
      id: crypto.randomUUID(),
      session_id: confirmCtx.session_id, organization_id: 1, user_id: 'user-1',
      tool_name: tool, args,
      created_at: new Date(Date.now() - ageMs).toISOString(),
    }
    rows.push(row)
    return row
  }
  const isConfirmError = (status) => (e) => e instanceof ConfirmError && e.status === status

  // 1. happy path: editor confirms, the write executes, the row is consumed
  let row = seed('add_to_lineup', { playerName: 'Alice' })
  const result = await confirmProposal(cfg, { ...confirmCtx, id: row.id })
  assert.ok(result, 'confirm returns the handler result')
  assert.ok(writeCalls.some(c => c.startsWith('POST /rest/v1/game_lineups')), 'the write executed')
  assert.equal(rows.length, 0, 'row consumed')

  // 2. unknown / foreign id -> 404
  await assert.rejects(() => confirmProposal(cfg, { ...confirmCtx, id: 'missing' }), isConfirmError(404))

  // 3. expired -> 410 AND consumed
  row = seed('add_to_lineup', { playerName: 'Alice' }, PROPOSAL_TTL_MS + 5000)
  await assert.rejects(() => confirmProposal(cfg, { ...confirmCtx, id: row.id }), isConfirmError(410))
  assert.equal(rows.length, 0, 'expired row was deleted')

  // 4. member role -> 403 and NOT consumed (checked BEFORE the claim)
  row = seed('add_to_lineup', { playerName: 'Alice' })
  await assert.rejects(() => confirmProposal(cfg, { ...confirmCtx, id: row.id, role: 'member' }), isConfirmError(403))
  assert.equal(rows[rows.length - 1].id, row.id, 'role-denied row is NOT consumed')

  // 5. another user's id -> 404 (ownership filter fails the GET)
  await assert.rejects(() => confirmProposal(cfg, { ...confirmCtx, id: row.id, user_id: 'user-2' }), isConfirmError(404))

  // 6. lost claim race: GET sees the row, DELETE returns [] -> 409, no dispatch
  writeCalls.length = 0
  const baseFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname === '/rest/v1/chat_action_proposals' && init.method === 'DELETE') {
      return Response.json([]) // the other tab won the claim
    }
    if (u.pathname === '/rest/v1/game_lineup_groups' || u.pathname === '/rest/v1/game_lineups') {
      writeCalls.push(`RACE-EXEC ${init.method} ${u.pathname}`)
      return Response.json([{ ok: true }])
    }
    return baseFetch(url, init) // everything else: the mock above
  }
  await assert.rejects(() => confirmProposal(cfg, { ...confirmCtx, id: row.id }), isConfirmError(409))
  assert.ok(!writeCalls.some(c => c.startsWith('RACE-EXEC')), 'lost race never executes')
  globalThis.fetch = baseFetch

  console.log('✓ confirmProposal checks passed')
} finally {
  globalThis.fetch = origFetch
}
