import assert from 'node:assert/strict'
import { computeInverseAction, recordChatAction, executeRollback, findLatestActionToRollback } from './chatRecovery.ts'

let failed = 0
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'}  ${name}`)
  if (!cond) failed++
}
function deepEqual(name, actual, expected) {
  try {
    assert.deepEqual(actual, expected)
    check(name, true)
  } catch (e) {
    check(name, false)
    console.log('    ' + e.message.split('\n').join('\n    '))
  }
}
async function rejects(name, fn, message) {
  try {
    await fn()
    check(`${name} — expected rejection`, false)
  } catch (e) {
    check(name, message === undefined || e.message === message)
  }
}

// ---------- computeInverseAction: pure, no config, no fetch ----------

deepEqual('create_game_event inversion deletes the exact created event id',
  computeInverseAction({
    action_type: 'create_game_event',
    before_rows: {},
    after_rows: { event: { id: 42, game_id: 10, event_type: 'Goal' } },
  }),
  [{ method: 'DELETE', path: '/game_events?id=eq.42' }])

deepEqual('undo_last_event inversion re-inserts the deleted event with its original id',
  computeInverseAction({
    action_type: 'undo_last_event',
    before_rows: { event: { id: 42, game_id: 10, event_type: 'Goal', player_id: 5 } },
    after_rows: {},
  }),
  [{ method: 'POST', path: '/game_events', body: { id: 42, game_id: 10, event_type: 'Goal', player_id: 5 } }])

const createLineupAction = {
  action_type: 'create_lineup',
  before_rows: {
    game_id: 10,
    groups: [{ lineup_name: 'Line 1', sort_order: 0 }],
    players: [{ player_id: 1, lineup_name: 'Line 1', role: 'Handler', sort_order: 0 }],
  },
  after_rows: { game_id: 10, created_groups: ['Line 2'], new_season_players: [] },
}
const createLineupOps = computeInverseAction(createLineupAction)
check('create_lineup inversion produces at least 3 ops', createLineupOps.length >= 3)
deepEqual('create_lineup inversion restores previous groups/players and removes replacement rows',
  createLineupOps,
  [
    { method: 'DELETE', path: '/game_lineups?game_id=eq.10' },
    { method: 'DELETE', path: '/game_lineup_groups?game_id=eq.10' },
    { method: 'POST', path: '/game_lineup_groups', body: [{ lineup_name: 'Line 1', sort_order: 0, game_id: 10 }] },
    { method: 'POST', path: '/game_lineups', body: [{ player_id: 1, lineup_name: 'Line 1', role: 'Handler', sort_order: 0, game_id: 10 }] },
  ])

deepEqual('apply_lineup_template shares create_lineup inversion semantics',
  computeInverseAction({ ...createLineupAction, action_type: 'apply_lineup_template' }),
  createLineupOps)

deepEqual('remove_from_lineup inversion re-inserts the exact deleted rows',
  computeInverseAction({
    action_type: 'remove_from_lineup',
    before_rows: { removed_rows: [{ id: 7, game_id: 10, player_id: 1, lineup_name: 'Line 1', role: null, sort_order: 0 }] },
    after_rows: {},
  }),
  [{ method: 'POST', path: '/game_lineups', body: [{ id: 7, game_id: 10, player_id: 1, lineup_name: 'Line 1', role: null, sort_order: 0 }] }])

deepEqual('create_lineup_group inversion deletes the created group by exact id',
  computeInverseAction({
    action_type: 'create_lineup_group',
    before_rows: {},
    after_rows: { group: { id: 9, game_id: 10, lineup_name: 'Line 2', sort_order: 1 } },
  }),
  [{ method: 'DELETE', path: '/game_lineup_groups?id=eq.9' }])

deepEqual('add_to_lineup inversion removes the current row by exact id and restores prior rows',
  computeInverseAction({
    action_type: 'add_to_lineup',
    before_rows: { lineup_rows: [{ id: 7, game_id: 10, player_id: 1, lineup_name: 'Line 1', role: null, sort_order: 0 }] },
    after_rows: {
      lineup_row: { id: 8, game_id: 10, player_id: 1, lineup_name: 'Line 2', role: 'Handler', sort_order: 0 },
      group: { id: 9, game_id: 10, lineup_name: 'Line 2', sort_order: 1 },
      season_player: { id: 55, season_id: 3, player_id: 1, is_sub: true },
    },
  }),
  [
    { method: 'DELETE', path: '/game_lineups?id=eq.8' },
    { method: 'POST', path: '/game_lineups', body: [{ id: 7, game_id: 10, player_id: 1, lineup_name: 'Line 1', role: null, sort_order: 0 }] },
    { method: 'DELETE', path: '/game_lineup_groups?id=eq.9' },
    { method: 'DELETE', path: '/season_players?id=eq.55' },
  ])

await rejects('add_to_lineup inverse without a created-row id is refused',
  () => Promise.resolve().then(() => computeInverseAction({
    action_type: 'add_to_lineup',
    before_rows: {},
    after_rows: { lineup_row: { game_id: 10, player_id: 1, lineup_name: 'Line 2', role: null, sort_order: 0 } },
  })),
  'cannot invert add_to_lineup: after_rows.lineup_row.id is missing')

deepEqual('save_lineup_template inversion of a newly created template removes children then the template',
  computeInverseAction({
    action_type: 'save_lineup_template',
    before_rows: { template: null, groups: [], players: [] },
    after_rows: { template: { id: 5, name: 'Motion', season_id: 3 } },
  }),
  [
    { method: 'DELETE', path: '/lineup_template_players?template_id=eq.5' },
    { method: 'DELETE', path: '/lineup_template_groups?template_id=eq.5' },
    { method: 'DELETE', path: '/lineup_templates?id=eq.5' },
  ])

deepEqual('save_lineup_template inversion of an overwrite restores previous children under the template id',
  computeInverseAction({
    action_type: 'save_lineup_template',
    before_rows: {
      template: { id: 5, name: 'Motion', season_id: 3 },
      groups: [{ lineup_name: 'Line 1', sort_order: 0 }],
      players: [{ lineup_name: 'Line 1', player_id: 1, sort_order: 0, role: null }],
    },
    after_rows: { template: { id: 5, name: 'Motion', season_id: 3 } },
  }),
  [
    { method: 'DELETE', path: '/lineup_template_players?template_id=eq.5' },
    { method: 'DELETE', path: '/lineup_template_groups?template_id=eq.5' },
    { method: 'POST', path: '/lineup_template_groups', body: [{ lineup_name: 'Line 1', sort_order: 0, template_id: 5 }] },
    { method: 'POST', path: '/lineup_template_players', body: [{ lineup_name: 'Line 1', player_id: 1, sort_order: 0, role: null, template_id: 5 }] },
  ])

await rejects('unknown action type cannot be inverted',
  () => Promise.resolve().then(() => computeInverseAction({ action_type: 'nope', before_rows: {}, after_rows: {} })),
  'cannot invert unknown action type: nope')

// ---------- REST-stubbed tests ----------
//
// In-memory mock of the PostgREST tables chatRecovery touches, following the
// gateway fetch-stub convention (jamSync.test.mjs / feedbackStore.test.mjs):
// eq filters, order=...desc, limit, PATCH returning the representation of
// matched rows, DELETE returning removed rows. chat_actions POST applies the
// table's DB defaults (id, status) the way the real database would.

const CONFIG = { supabaseUrl: 'http://stub.invalid', supabaseSecretKey: 'stub' }
let seq = 0

function restStub(tables) {
  const calls = []
  const handler = async (url, init) => {
    const u = new URL(String(url))
    const table = u.pathname.split('/rest/v1/')[1]
    const params = u.searchParams
    const method = init?.method ?? 'GET'
    const body = init?.body !== undefined ? JSON.parse(init.body) : undefined
    calls.push({ url: String(url), method, body })
    const store = (tables[table] ??= [])
    const matches = () => store.filter((r) => {
      for (const [k, v] of params.entries()) {
        if (k === 'select' || k === 'order' || k === 'limit') continue
        if (!v.startsWith('eq.') || String(r[k]) !== v.slice(3)) return false
      }
      return true
    })
    if (method === 'GET') {
      let rows = matches()
      const order = params.get('order')
      if (order?.endsWith('.desc')) {
        const key = order.slice(0, -5)
        rows = [...rows].sort((a, b) => String(b[key]).localeCompare(String(a[key])))
      }
      const limit = params.get('limit')
      if (limit != null) rows = rows.slice(0, Number(limit))
      return { ok: true, status: 200, text: async () => JSON.stringify(rows), json: async () => rows }
    }
    if (method === 'PATCH') {
      const matched = matches()
      for (const r of matched) Object.assign(r, body)
      return { ok: true, status: 200, text: async () => JSON.stringify(matched), json: async () => matched }
    }
    if (method === 'DELETE') {
      const matched = matches()
      tables[table] = store.filter((r) => !matched.includes(r))
      return { ok: true, status: 200, text: async () => JSON.stringify(matched), json: async () => matched }
    }
    const inserted = (Array.isArray(body) ? body : [body]).map((r) =>
      table === 'chat_actions' ? { id: `gen-${++seq}`, status: 'applied', ...r } : { ...r })
    store.push(...inserted)
    return { ok: true, status: 200, text: async () => JSON.stringify(inserted), json: async () => inserted }
  }
  return { calls, handler }
}

async function withStubbedFetch(tables, fn) {
  const stub = restStub(tables)
  const realFetch = globalThis.fetch
  globalThis.fetch = stub.handler
  try {
    return await fn(stub)
  } finally {
    globalThis.fetch = realFetch
  }
}

const EVENT = { id: 42, organization_id: 1, game_id: 10, player_id: 5, related_player_id: null, event_type: 'Goal', event_timestamp: '2026-09-29T12:00:00.000Z', notes: null }
const ACTION = {
  id: '11111111-1111-1111-1111-111111111111',
  organization_id: 1,
  session_id: 's1',
  user_id: 'u1',
  request_id: '22222222-2222-2222-2222-222222222222',
  action_type: 'create_game_event',
  description: 'Logged Goal for Sam',
  status: 'applied',
  before_rows: {},
  after_rows: { event: { ...EVENT } },
  created_at: '2026-09-29T12:00:01.000Z',
  undone_at: null,
}

// --- executeRollback: applied -> undoing -> ops -> undone ---

{
  const tables = { chat_actions: [{ ...ACTION }], game_events: [{ ...EVENT }] }
  let calls
  const result = await withStubbedFetch(tables, async (stub) => {
    calls = stub.calls
    return executeRollback(CONFIG, 1, ACTION.id, 'u1')
  })
  check('happy path returns the undone receipt', result?.id === ACTION.id && result?.status === 'undone')
  check('happy path marks the receipt undone with undone_at',
    tables.chat_actions[0].status === 'undone' && typeof tables.chat_actions[0].undone_at === 'string')
  check('happy path deletes the created event', tables.game_events.length === 0)
  check('happy path makes exactly 5 REST calls', calls.length === 5)
  check('happy path fetches the receipt scoped by id+org+user',
    calls[0].method === 'GET' && calls[0].url.includes(`/chat_actions?id=eq.${ACTION.id}&organization_id=eq.1&user_id=eq.u1`))
  check('happy path CAS-patches applied -> undoing with the org filter',
    calls[1].method === 'PATCH' && calls[1].url.includes('status=eq.applied') &&
    calls[1].url.includes('organization_id=eq.1') && calls[1].body?.status === 'undoing')
  check('happy path verifies the current event before deleting',
    calls[2].method === 'GET' && calls[2].url.includes('/game_events?id=eq.42'))
  check('happy path deletes by exact id',
    calls[3].method === 'DELETE' && calls[3].url.includes('/game_events?id=eq.42'))
  check('happy path finalizes with status=undone, undone_at, and the org filter',
    calls[4].method === 'PATCH' && calls[4].body?.status === 'undone' &&
    typeof calls[4].body?.undone_at === 'string' && calls[4].url.includes('organization_id=eq.1'))
}

// --- the CAS race: another undo won between fetch and PATCH ---

{
  const tables = { chat_actions: [{ ...ACTION }], game_events: [{ ...EVENT }] }
  const stub = restStub(tables)
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'PATCH' && String(url).includes('status=eq.applied')) {
      return { ok: true, status: 200, text: async () => '[]', json: async () => [] }
    }
    return stub.handler(url, init)
  }
  let err = null
  try {
    await executeRollback(CONFIG, 1, ACTION.id, 'u1')
  } catch (e) {
    err = e
  } finally {
    globalThis.fetch = realFetch
  }
  check('CAS race rejects with not-in-applied-state', err?.message === 'action is not in applied state')
  check('CAS race executes no inverse ops', tables.game_events.length === 1)
  check('CAS race leaves the receipt untouched',
    tables.chat_actions[0].status === 'applied' && tables.chat_actions[0].undone_at == null)
}

// --- state mismatch: the affected row changed since the receipt ---

{
  const tables = { chat_actions: [{ ...ACTION }], game_events: [{ ...EVENT, notes: 'edited after the fact' }] }
  let calls
  await withStubbedFetch(tables, async (stub) => {
    calls = stub.calls
    let err = null
    try {
      await executeRollback(CONFIG, 1, ACTION.id, 'u1')
    } catch (e) {
      err = e
    }
    check('mismatch rejects with data-changed error',
      err?.message === 'action cannot be undone: the affected data has changed')
  })
  check('mismatch reverts the receipt to applied', tables.chat_actions[0].status === 'applied')
  check('mismatch leaves the edited event in place', tables.game_events.length === 1)
  check('mismatch issues a best-effort revert PATCH',
    calls.some((c) => c.method === 'PATCH' && c.body?.status === 'applied'))
}

// --- lookup guards ---

await withStubbedFetch({ chat_actions: [{ ...ACTION }], game_events: [{ ...EVENT }] }, async () => {
  await rejects('rollback for another user is not found',
    () => executeRollback(CONFIG, 1, ACTION.id, 'someone-else'), 'action not found')
  await rejects('rollback for another org is not found',
    () => executeRollback(CONFIG, 99, ACTION.id, 'u1'), 'action not found')
})

await withStubbedFetch({ chat_actions: [{ ...ACTION, status: 'undone' }] }, async () => {
  await rejects('rollback of an already-undone receipt is rejected',
    () => executeRollback(CONFIG, 1, ACTION.id, 'u1'), 'action is not in applied state')
})

// --- intervening edit on a bulk lineup replacement (create_lineup) ---

{
  const lineupAction = {
    ...ACTION,
    id: '33333333-3333-3333-3333-333333333333',
    action_type: 'create_lineup',
    before_rows: { game_id: 10, groups: [], players: [] },
    after_rows: {
      game_id: 10,
      lineup_rows: [
        { id: 71, game_id: 10, player_id: 1, lineup_name: 'Line 1', role: null, sort_order: 0 },
        { id: 72, game_id: 10, player_id: 2, lineup_name: 'Line 2', role: null, sort_order: 0 },
      ],
      group_rows: [{ id: 31, game_id: 10, lineup_name: 'Line 1', sort_order: 0 }],
      created_groups: ['Line 1', 'Line 2'],
      new_season_players: [],
    },
  }
  const tables = {
    chat_actions: [{ ...lineupAction }],
    game_lineups: [
      { id: 71, game_id: 10, player_id: 1, lineup_name: 'Line 1', role: null, sort_order: 0 },
      { id: 72, game_id: 10, player_id: 2, lineup_name: 'Line 2', role: null, sort_order: 0 },
      { id: 73, game_id: 10, player_id: 3, lineup_name: 'Line 1', role: null, sort_order: 0 },
    ],
    game_lineup_groups: [{ id: 31, game_id: 10, lineup_name: 'Line 1', sort_order: 0 }],
  }
  await withStubbedFetch(tables, async () => {
    await rejects('create_lineup undo with an intervening lineup row is rejected',
      () => executeRollback(CONFIG, 1, lineupAction.id, 'u1'),
      'action cannot be undone: the affected data has changed')
  })
  check('create_lineup undo leaves the current lineup untouched', tables.game_lineups.length === 3)
  check('create_lineup undo reverts the receipt to applied', tables.chat_actions[0].status === 'applied')
}

// --- create_lineup_group: a dependent row blocks the undo ---

{
  const groupAction = {
    ...ACTION,
    id: '44444444-4444-4444-4444-444444444444',
    action_type: 'create_lineup_group',
    before_rows: {},
    after_rows: { group: { id: 31, organization_id: 1, game_id: 10, lineup_name: 'Line 2', sort_order: 1 } },
  }
  const tables = {
    chat_actions: [{ ...groupAction }],
    game_lineup_groups: [{ id: 31, organization_id: 1, game_id: 10, lineup_name: 'Line 2', sort_order: 1 }],
    game_lineups: [{ id: 81, game_id: 10, player_id: 9, lineup_name: 'Line 2', role: null, sort_order: 0 }],
  }
  await withStubbedFetch(tables, async () => {
    await rejects('create_lineup_group undo with a dependent lineup row is rejected',
      () => executeRollback(CONFIG, 1, groupAction.id, 'u1'),
      'action cannot be undone: the affected data has changed')
  })
  check('create_lineup_group undo leaves the group and dependent row in place',
    tables.game_lineup_groups.length === 1 && tables.game_lineups.length === 1)
  check('create_lineup_group undo reverts the receipt to applied', tables.chat_actions[0].status === 'applied')
}

// --- final-status-PATCH failure must not strand the receipt in 'undoing' ---

{
  const tables = { chat_actions: [{ ...ACTION }], game_events: [{ ...EVENT }] }
  const stub = restStub(tables)
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'PATCH' && JSON.parse(init.body).status === 'undone') {
      return { ok: false, status: 502, text: async () => 'boom' }
    }
    return stub.handler(url, init)
  }
  let err = null
  try {
    await executeRollback(CONFIG, 1, ACTION.id, 'u1')
  } catch (e) {
    err = e
  } finally {
    globalThis.fetch = realFetch
  }
  check('final-PATCH failure rethrows', err?.message?.includes('Supabase PATCH failed') === true)
  check('final-PATCH failure reverts the receipt to applied (not stranded in undoing)',
    tables.chat_actions[0].status === 'applied' && tables.chat_actions[0].undone_at == null)
  check('final-PATCH failure still leaves the inverse applied (event deleted)', tables.game_events.length === 0)
}

// --- remove_from_lineup: intervening re-add blocks the undo ---

{
  const removeAction = {
    ...ACTION,
    id: '55555555-5555-5555-5555-555555555555',
    action_type: 'remove_from_lineup',
    before_rows: { removed_rows: [{ id: 7, organization_id: 1, game_id: 10, player_id: 1, lineup_name: 'Line 1', role: null, sort_order: 0 }] },
    after_rows: { game_id: 10, player_id: 1, lineup_rows: [] },
  }
  const tables = {
    chat_actions: [{ ...removeAction }],
    game_lineups: [{ id: 90, organization_id: 1, game_id: 10, player_id: 1, lineup_name: 'Line 2', role: null, sort_order: 0 }],
  }
  await withStubbedFetch(tables, async () => {
    await rejects('remove_from_lineup undo with an intervening re-add is rejected',
      () => executeRollback(CONFIG, 1, removeAction.id, 'u1'),
      'action cannot be undone: the affected data has changed')
  })
  check('remove_from_lineup undo leaves the intervening row in place', tables.game_lineups.length === 1)
  check('remove_from_lineup undo reverts the receipt to applied', tables.chat_actions[0].status === 'applied')
}

{
  const removeAction = {
    ...ACTION,
    id: '66666666-6666-6666-6666-666666666666',
    action_type: 'remove_from_lineup',
    before_rows: { removed_rows: [{ id: 7, organization_id: 1, game_id: 10, player_id: 1, lineup_name: 'Line 1', role: null, sort_order: 0 }] },
    after_rows: { game_id: 10, player_id: 1, lineup_rows: [] },
  }
  const tables = { chat_actions: [{ ...removeAction }], game_lineups: [] }
  const result = await withStubbedFetch(tables, () => executeRollback(CONFIG, 1, removeAction.id, 'u1'))
  check('remove_from_lineup undo with no intervening row succeeds',
    result?.status === 'undone' && tables.chat_actions[0].status === 'undone')
  deepEqual('remove_from_lineup undo restores the exact removed rows',
    tables.game_lineups,
    [{ id: 7, organization_id: 1, game_id: 10, player_id: 1, lineup_name: 'Line 1', role: null, sort_order: 0 }])
}

// --- recordChatAction + findLatestActionToRollback ---

await withStubbedFetch({ chat_actions: [] }, async (stub) => {
  const receipt = await recordChatAction(CONFIG, 1, {
    sessionId: 's1',
    userId: 'u1',
    requestId: '22222222-2222-2222-2222-222222222222',
    actionType: 'create_game_event',
    description: 'Logged Goal for Sam',
    beforeRows: {},
    afterRows: { event: { id: 42 } },
  })
  const post = stub.calls.find((c) => c.method === 'POST')
  deepEqual('recordChatAction posts the full receipt row', post?.body, {
    organization_id: 1,
    session_id: 's1',
    user_id: 'u1',
    request_id: '22222222-2222-2222-2222-222222222222',
    action_type: 'create_game_event',
    description: 'Logged Goal for Sam',
    before_rows: {},
    after_rows: { event: { id: 42 } },
  })
  check('recordChatAction returns the receipt identity',
    typeof receipt?.id === 'string' &&
    receipt.request_id === '22222222-2222-2222-2222-222222222222' &&
    receipt.description === 'Logged Goal for Sam' &&
    receipt.status === 'applied')
})

await withStubbedFetch({
  chat_actions: [
    { ...ACTION, id: 'older', created_at: '2026-09-29T10:00:00Z' },
    { ...ACTION, id: 'newest-but-undone', created_at: '2026-09-29T12:00:02Z', status: 'undone' },
    { ...ACTION, id: 'latest-applied', created_at: '2026-09-29T11:00:00Z' },
    { ...ACTION, id: 'other-session', created_at: '2026-09-29T13:00:00Z', session_id: 's2' },
  ],
}, async (stub) => {
  const row = await findLatestActionToRollback(CONFIG, 1, 's1', 'u1')
  check('findLatestActionToRollback returns the latest applied action in the session',
    row?.id === 'latest-applied')
  const url = stub.calls[0]?.url ?? ''
  check('findLatestActionToRollback filters org, session, user, and status',
    url.includes('organization_id=eq.1') && url.includes('session_id=eq.s1') &&
    url.includes('user_id=eq.u1') && url.includes('status=eq.applied'))
  check('findLatestActionToRollback orders by created_at desc with limit 1',
    url.includes('order=created_at.desc') && url.includes('limit=1'))
})

await withStubbedFetch({ chat_actions: [{ ...ACTION, status: 'undone' }] }, async () => {
  check('findLatestActionToRollback returns null with nothing applied',
    (await findLatestActionToRollback(CONFIG, 1, 's1', 'u1')) === null)
})

console.log(failed === 0 ? '\nall chatRecovery checks passed' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
