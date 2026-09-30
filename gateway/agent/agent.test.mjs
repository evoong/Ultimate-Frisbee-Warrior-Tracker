import assert from 'node:assert/strict'
import { AIMessage } from '@langchain/core/messages'
import { runToolAgent } from './graph.ts'
import { makeChatTools } from './tools.ts'
import { callChatFunction } from '../gameActions.ts'

// Stub model: a bindTools-capable object is all the graph requires. `seen`
// records the message list each invoke receives, so tests can inspect the
// ToolMessage content that actually reaches the model.
class StubModel {
  constructor(responses) { this.responses = [...responses]; this.seen = [] }
  bindTools(tools) { this.boundTools = tools; return this }
  async invoke(messages) { this.seen.push(messages); return this.responses.shift() }
}

const toolCallMsg = (name, args) =>
  new AIMessage({ content: '', tool_calls: [{ name, args, id: 'call_1' }] })

const base = { systemPrompt: 'sys', history: [], message: 'hi' }

// The ToolMessage the tools node produced for the single tool call a test
// made (second model invoke receives [system, human, ai(call), toolMessage]).
const toolResultOf = (model) => {
  const msg = model.seen[1].find((m) => m?.tool_call_id !== undefined)
  assert.ok(msg, 'a ToolMessage reached the model')
  return JSON.parse(msg.content)
}

// In-memory PostgREST stub, same convention as chatRecovery.test.mjs: eq
// filters, order=...desc, limit, PATCH/DELETE returning matched rows,
// chat_actions POST applying the table's defaults.
function restStub(tables) {
  const handler = async (url, init) => {
    const u = new URL(String(url))
    const table = u.pathname.split('/rest/v1/')[1]
    const params = u.searchParams
    const method = init?.method ?? 'GET'
    const body = init?.body !== undefined ? JSON.parse(init.body) : undefined
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
      table === 'chat_actions' ? { id: `gen-${r.request_id}`, status: 'applied', ...r } : { ...r })
    store.push(...inserted)
    return { ok: true, status: 200, text: async () => JSON.stringify(inserted), json: async () => inserted }
  }
  return handler
}

async function withStubbedFetch(tables, fn) {
  const realFetch = globalThis.fetch
  globalThis.fetch = restStub(tables)
  try {
    return await fn()
  } finally {
    globalThis.fetch = realFetch
  }
}

const RECOVERY = { sessionId: 's-1', userId: 'u-1', requestId: 'r-1' }
const RECOVERY_CONFIG = { supabaseUrl: 'http://stub.invalid', supabaseSecretKey: 'stub-key' }

{
  // Member + write tool -> permission error, dispatch untouched.
  const dispatch = []
  const tools = makeChatTools({ dispatch: async (n, a) => { dispatch.push([n, a]); return { ok: true } }, role: 'member' })
  const reply = await runToolAgent({
    ...base,
    model: new StubModel([toolCallMsg('create_game_event', { eventType: 'Goal' }), new AIMessage('done')]),
    tools,
  })
  assert.equal(reply, 'done')
  assert.equal(dispatch.length, 0, 'member write never reaches dispatch')
}
{
  // Editor + write tool -> dispatched.
  const dispatch = []
  const tools = makeChatTools({ dispatch: async (n, a) => { dispatch.push([n, a]); return { our_score: 1 } }, role: 'editor' })
  await runToolAgent({
    ...base,
    model: new StubModel([toolCallMsg('create_game_event', { eventType: 'Goal' }), new AIMessage('done')]),
    tools,
  })
  assert.deepEqual(dispatch, [['create_game_event', { eventType: 'Goal' }]])
}
{
  // Member + read-only tool -> dispatched; span emitted.
  const spans = []
  const tools = makeChatTools({ dispatch: async () => ({ rows: [] }), role: 'member', onSpan: (n) => spans.push(n) })
  await runToolAgent({
    ...base,
    model: new StubModel([toolCallMsg('query_stat_breakdown', { metric: 'goals' }), new AIMessage('done')]),
    tools,
  })
  assert.equal(spans.length, 1)
  assert.equal(spans[0], 'query_stat_breakdown')
}
{
  // Plain reply, no tools.
  const tools = makeChatTools({ dispatch: async () => ({}), role: 'captain' })
  const reply = await runToolAgent({ ...base, model: new StubModel([new AIMessage('direct answer')]), tools })
  assert.equal(reply, 'direct answer')
}
{
  // Zod-invalid tool arg -> ToolMessage error, not a rejection; dispatch untouched.
  const dispatch = []
  const tools = makeChatTools({ dispatch: async (n, a) => { dispatch.push([n, a]); return { rows: [] } }, role: 'captain' })
  const reply = await runToolAgent({
    ...base,
    model: new StubModel([toolCallMsg('query_stat_breakdown', { metric: 'bogus' }), new AIMessage('handled gracefully')]),
    tools,
  })
  assert.equal(reply, 'handled gracefully')
  assert.equal(dispatch.length, 0, 'invalid arg never reaches dispatch')
}
{
  // Endless tool calls hit the recursion limit and throw, never loop.
  const tools = makeChatTools({ dispatch: async () => ({}), role: 'captain' })
  await assert.rejects(
    () => runToolAgent({ ...base, model: new StubModel(Array(50).fill(0).map(() => toolCallMsg('query_stat_breakdown', { metric: 'goals' }))), tools }),
    /recursion/i
  )
}
{
  // Editor + write tool + recovery deps -> recordChatAction fires and the
  // receipt reaches onActionReceipt; the model-visible ToolMessage carries
  // ONLY the dispatch result (no __receipt, no receipt payload).
  const receipts = []
  const posted = []
  const tables = { chat_actions: [] }
  await withStubbedFetch(tables, async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      const u = new URL(String(url))
      if (u.pathname.endsWith('/chat_actions') && init?.method === 'POST') posted.push(JSON.parse(init.body))
      return realFetch(url, init)
    }
    try {
      const model = new StubModel([
        toolCallMsg('create_game_event', { eventType: 'Goal', playerName: 'Alex' }),
        new AIMessage('done'),
      ])
      const tools = makeChatTools({
        dispatch: async () => ({
          our_score: 1,
          __receipt: { before: {}, after: { event: { id: 42 } }, description: 'Logged Goal: Alex' },
        }),
        role: 'editor',
        recovery: RECOVERY,
        actionsConfig: RECOVERY_CONFIG,
        orgId: 7,
        onActionReceipt: (r) => receipts.push(r),
      })
      const reply = await runToolAgent({ ...base, model, tools })
      assert.equal(reply, 'done')
      assert.equal(posted.length, 1, 'exactly one receipt row posted')
      assert.deepEqual(posted[0], {
        organization_id: 7,
        session_id: 's-1',
        user_id: 'u-1',
        request_id: 'r-1',
        action_type: 'create_game_event',
        description: 'Logged Goal: Alex',
        before_rows: {},
        after_rows: { event: { id: 42 } },
      })
      assert.deepEqual(receipts, [{ id: 'gen-r-1', request_id: 'r-1', description: 'Logged Goal: Alex', status: 'applied' }])
      assert.deepEqual(toolResultOf(model), { our_score: 1 }, 'ToolMessage content is only the result, receipt stripped')
    } finally {
      globalThis.fetch = realFetch
    }
  })
}
{
  // Write with NO receipt on the dispatch result (e.g. ignored-duplicate
  // create_lineup_group) records nothing and emits nothing.
  const receipts = []
  await withStubbedFetch({ chat_actions: [] }, async () => {
    const model = new StubModel([toolCallMsg('create_lineup_group', { name: 'Line 2' }), new AIMessage('done')])
    const tools = makeChatTools({
      dispatch: async () => ({ created: { note: 'already exists' } }),
      role: 'editor',
      recovery: RECOVERY,
      actionsConfig: RECOVERY_CONFIG,
      orgId: 7,
      onActionReceipt: (r) => receipts.push(r),
    })
    await runToolAgent({ ...base, model, tools })
    assert.equal(receipts.length, 0, 'no receipt for a no-op write')
  })
}
{
  // Editor + rollback_last_action -> resolves via findLatestActionToRollback
  // + executeRollback, never via dispatch, and confirms what was undone.
  const dispatch = []
  const EVENT = { id: 42, organization_id: 1, game_id: 10, player_id: 5, related_player_id: null, event_type: 'Goal' }
  const tables = {
    chat_actions: [{ id: 'act-9', organization_id: 1, session_id: 's-1', user_id: 'u-1', status: 'applied', action_type: 'create_game_event', description: 'Logged Goal: Alex', before_rows: {}, after_rows: { event: { ...EVENT } }, created_at: '2026-09-29T10:00:00Z' }],
    game_events: [{ ...EVENT }],
  }
  await withStubbedFetch(tables, async () => {
    const model = new StubModel([toolCallMsg('rollback_last_action', {}), new AIMessage('undone')])
    const tools = makeChatTools({
      dispatch: async (n) => { dispatch.push(n); return {} },
      role: 'editor',
      recovery: RECOVERY,
      actionsConfig: RECOVERY_CONFIG,
      orgId: 1,
    })
    const reply = await runToolAgent({ ...base, model, tools })
    assert.equal(reply, 'undone')
    assert.equal(dispatch.length, 0, 'rollback resolves in the recovery layer, not via dispatch')
    assert.deepEqual(toolResultOf(model), { undone: { id: 'act-9', description: 'Logged Goal: Alex' } })
    assert.equal(tables.chat_actions[0].status, 'undone', 'receipt flipped to undone')
    assert.equal(tables.game_events.length, 0, 'inverse op deleted the created event')
  })
}
{
  // Rollback with nothing applied -> error object, not a crash.
  await withStubbedFetch({ chat_actions: [] }, async () => {
    const model = new StubModel([toolCallMsg('rollback_last_action', {}), new AIMessage('ok')])
    const tools = makeChatTools({
      dispatch: async () => { throw new Error('dispatch must not run') },
      role: 'editor',
      recovery: RECOVERY,
      actionsConfig: RECOVERY_CONFIG,
      orgId: 1,
    })
    await runToolAgent({ ...base, model, tools })
    assert.deepEqual(toolResultOf(model), { error: 'no recent action to undo' })
  })
}
{
  // Member role is blocked from rollback_last_action; dispatch never called.
  const dispatch = []
  const model = new StubModel([toolCallMsg('rollback_last_action', {}), new AIMessage('ok')])
  const tools = makeChatTools({ dispatch: async (n) => { dispatch.push(n); return {} }, role: 'member' })
  await runToolAgent({ ...base, model, tools })
  assert.equal(dispatch.length, 0, 'member rollback never reaches dispatch')
  assert.deepEqual(toolResultOf(model), { error: "you do not have permission to change this team's data" })
}
{
  // recordChatAction failure (write happened, log failed) -> the tool call
  // reports the error; onActionReceipt does NOT fire.
  const receipts = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url))
    if (u.pathname.endsWith('/chat_actions')) {
      return { ok: false, status: 502, text: async () => 'log write failed', json: async () => [] }
    }
    throw new Error(`unexpected fetch ${url}`)
  }
  try {
    const model = new StubModel([
      toolCallMsg('create_game_event', { eventType: 'Goal', playerName: 'Alex' }),
      new AIMessage('done'),
    ])
    const tools = makeChatTools({
      dispatch: async () => ({ our_score: 1, __receipt: { before: {}, after: { event: { id: 42 } }, description: 'Logged Goal: Alex' } }),
      role: 'editor',
      recovery: RECOVERY,
      actionsConfig: RECOVERY_CONFIG,
      orgId: 7,
      onActionReceipt: (r) => receipts.push(r),
    })
    await runToolAgent({ ...base, model, tools })
    assert.equal(receipts.length, 0, 'no receipt event on a failed record')
    const result = toolResultOf(model)
    assert.ok(result.error?.includes('Supabase POST failed'), `error surfaces to the model: ${JSON.stringify(result)}`)
  } finally {
    globalThis.fetch = realFetch
  }
}
{
  // remove_from_lineup on a player not in any lineup is a no-op: NO receipt
  // is recorded (an empty removed_rows receipt is un-invertible and would
  // strand itself as the newest applied action, blocking rollback of the
  // prior real write forever). The prior action stays the rollback target.
  const receipts = []
  const EVENT = { id: 42, organization_id: 1, game_id: 10, player_id: 5, related_player_id: null, event_type: 'Goal' }
  const tables = {
    chat_actions: [{ id: 'act-9', organization_id: 1, session_id: 's-1', user_id: 'u-1', status: 'applied', action_type: 'create_game_event', description: 'Logged Goal: Alex', before_rows: {}, after_rows: { event: { ...EVENT } }, created_at: '2026-09-29T10:00:00Z' }],
    game_events: [{ ...EVENT }],
    games: [{ id: 10, season_id: null, opponent: 'Huck Huck Goose', game_date: '2026-09-29', game_time: null, organization_id: 1 }],
    players: [{ id: 5, display_name: 'Alex', organization_id: 1 }],
    game_lineups: [],
  }
  await withStubbedFetch(tables, async () => {
    const model = new StubModel([
      toolCallMsg('remove_from_lineup', { playerName: 'Alex' }),
      toolCallMsg('rollback_last_action', {}),
      new AIMessage('done'),
    ])
    const tools = makeChatTools({
      dispatch: (name, args) => callChatFunction(RECOVERY_CONFIG, 1, name, args),
      role: 'editor',
      recovery: RECOVERY,
      actionsConfig: RECOVERY_CONFIG,
      orgId: 1,
      onActionReceipt: (r) => receipts.push(r),
    })
    await runToolAgent({ ...base, model, tools })
    assert.equal(receipts.length, 0, 'no-op removal records no receipt')
    assert.equal(tables.chat_actions.length, 1, 'no receipt row added for the no-op')
    const firstTool = JSON.parse(model.seen[1].find((m) => m?.tool_call_id !== undefined).content)
    assert.equal(firstTool.removed_rows, 0)
    assert.equal('__receipt' in firstTool, false, 'no receipt payload on the no-op result')
    const secondTool = JSON.parse([...model.seen[2]].reverse().find((m) => m?.tool_call_id !== undefined).content)
    assert.deepEqual(secondTool, { undone: { id: 'act-9', description: 'Logged Goal: Alex' } }, 'rollback still targets the prior real action')
    assert.equal(tables.chat_actions[0].status, 'undone', 'prior receipt flipped to undone')
    assert.equal(tables.game_events.length, 0, 'prior action was inverted')
  })
}
console.log('✓ gateway/agent/agent.test.mjs all passed')
