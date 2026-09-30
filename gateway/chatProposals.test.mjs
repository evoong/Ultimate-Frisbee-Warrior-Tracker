import assert from 'node:assert/strict'
import {
  createProposal, getProposal, takeProposal, deleteProposal, isExpired, PROPOSAL_TTL_MS, buildProposal,
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
} finally {
  globalThis.fetch = origFetch
}
