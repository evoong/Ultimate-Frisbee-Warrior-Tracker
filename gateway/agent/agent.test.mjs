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
  // Member + write tool -> permission error, dispatch and propose untouched.
  const dispatch = []
  const proposals = []
  const tools = makeChatTools({
    dispatch: async (n, a) => { dispatch.push([n, a]); return { ok: true } },
    role: 'member',
    propose: async (n) => { proposals.push(n); return { proposal_id: 'p1', summary: 's' } },
  })
  const reply = await runToolAgent({
    ...base,
    model: new StubModel([toolCallMsg('create_game_event', { eventType: 'Goal' }), new AIMessage('done')]),
    tools,
  })
  assert.equal(reply, 'done')
  assert.equal(dispatch.length, 0, 'member write never reaches dispatch')
  assert.equal(proposals.length, 0, 'member write never proposes')
}
{
  // Editor + write tool -> proposal created, dispatch never called.
  const dispatch = []
  const proposals = []
  const tools = makeChatTools({
    dispatch: async (n, a) => { dispatch.push([n, a]); return { our_score: 1 } },
    role: 'editor',
    propose: async (n) => { proposals.push(n); return { proposal_id: 'p1', summary: 'Log Goal in the 2026-09-29 game vs Rival A' } },
    onProposal: p => proposals.push(p),
  })
  const reply = await runToolAgent({
    ...base,
    model: new StubModel([toolCallMsg('create_game_event', { eventType: 'Goal' }), new AIMessage('done')]),
    tools,
  })
  assert.equal(reply, 'done')
  assert.equal(dispatch.length, 0, 'write tool never reaches dispatch')
  assert.equal(proposals[0], 'create_game_event', 'propose was called with the tool name')
  assert.equal(proposals[1].id, 'p1', 'onProposal carries the id')
  assert.equal(proposals[1].tool_name, 'create_game_event')
}
{
  // Editor + write tool + propose throws -> error marker result, no dispatch.
  const dispatch = []
  const tools = makeChatTools({
    dispatch: async (n, a) => { dispatch.push([n, a]); return {} },
    role: 'editor',
    propose: async () => { throw new Error('No game found matching {}.') },
  })
  const reply = await runToolAgent({
    ...base,
    model: new StubModel([toolCallMsg('create_game_event', { eventType: 'Goal' }), new AIMessage('handled gracefully')]),
    tools,
  })
  assert.equal(reply, 'handled gracefully')
  assert.equal(dispatch.length, 0, 'failed proposal never dispatches')
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
  // Member + lineup read tools -> dispatched
  const dispatch = []
  const tools = makeChatTools({ dispatch: async (n, a) => { dispatch.push([n, a]); return { groups: [] } }, role: 'member' })
  await runToolAgent({
    ...base,
    model: new StubModel([toolCallMsg('view_lineup', {}), new AIMessage('done')]),
    tools,
  })
  assert.equal(dispatch.length, 1)
  assert.equal(dispatch[0][0], 'view_lineup')
}
{
  // Member + create_lineup write tool -> permission error, dispatch untouched
  const dispatch = []
  const proposals = []
  const tools = makeChatTools({
    dispatch: async (n, a) => { dispatch.push([n, a]); return { ok: true } },
    role: 'member',
    propose: async (n) => { proposals.push(n); return { proposal_id: 'p2', summary: 's' } },
  })
  const reply = await runToolAgent({
    ...base,
    model: new StubModel([toolCallMsg('create_lineup', { groups: [{ name: 'Line 1' }] }), new AIMessage('done')]),
    tools,
  })
  assert.equal(reply, 'done')
  assert.equal(dispatch.length, 0, 'member cannot write lineup')
  assert.equal(proposals.length, 0, 'member write never proposes')
}
{
  // Editor + create_lineup write tool -> proposal, dispatch never called
  const dispatch = []
  const proposals = []
  const tools = makeChatTools({
    dispatch: async (n, a) => { dispatch.push([n, a]); return { groups: [] } },
    role: 'editor',
    propose: async (n) => { proposals.push(n); return { proposal_id: 'p3', summary: 'Set the lineup' } },
    onProposal: p => proposals.push(p),
  })
  await runToolAgent({
    ...base,
    model: new StubModel([toolCallMsg('create_lineup', { groups: [{ name: 'Line 1' }] }), new AIMessage('done')]),
    tools,
  })
  assert.equal(dispatch.length, 0, 'lineup write never reaches dispatch')
  assert.equal(proposals[0], 'create_lineup', 'propose called for the lineup tool')
  assert.equal(proposals[1].tool_name, 'create_lineup')
}
{
  // The proposal marker reaches the model as the tool result.
  const seen = []
  class SpyModel extends StubModel {
    async invoke(msgs) {
      const lastMsg = msgs[msgs.length - 1]
      if (lastMsg?.getType?.() === 'tool') seen.push(lastMsg.content)
      return super.invoke(msgs)
    }
  }
  const tools = makeChatTools({
    dispatch: async () => ({}),
    role: 'captain',
    propose: async () => ({ proposal_id: 'p9', summary: 'Place Alice in Line 1' }),
  })
  await runToolAgent({
    ...base,
    model: new SpyModel([toolCallMsg('add_to_lineup', { playerName: 'Alice' }), new AIMessage('done')]),
    tools,
  })
  assert.equal(seen.length, 1, 'exactly one tool result observed')
  const parsed = JSON.parse(seen[0])
  assert.equal(parsed.proposed, true)
  assert.equal(parsed.proposal_id, 'p9')
  assert.ok(parsed.summary.includes('Alice'))
{
  // Editor + rollback_last_action -> resolves via findLatestActionToRollback
  // + executeRollback, never via dispatch, and confirms what was undone.
  // In the merged world rollback stays a DIRECT tool (not proposed): it is
  // the recovery path for already-applied actions, card-confirming it would
  // deadlock the undo UX.
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
  // Editor + write tool with NO propose dep (unwired runtime) -> the
  // unavailable marker, never a silent dispatch. Receipt-at-dispatch tests
  // moved to the confirm layer (chatProposals.test.mjs): in the merged
  // runtime write tools never dispatch, so receipts are recorded by the
  // confirm endpoint instead.
  const dispatch = []
  const tools = makeChatTools({
    dispatch: async (n, a) => { dispatch.push([n, a]); return { our_score: 1 } },
    role: 'editor',
    recovery: RECOVERY,
    actionsConfig: RECOVERY_CONFIG,
    orgId: 7,
  })
  const model = new StubModel([toolCallMsg('create_game_event', { eventType: 'Goal' }), new AIMessage('done')])
  await runToolAgent({ ...base, model, tools })
  assert.equal(dispatch.length, 0, 'unwired runtime never dispatches a write')
  assert.deepEqual(toolResultOf(model), { error: 'action confirmation is unavailable' })
}
}
{
  const names = makeChatTools({ dispatch: async () => ({}), role: 'editor' }).map(t => t.name)
  assert.ok(names.includes('apply_lineup_template'), 'template apply remains available')
  assert.ok(names.includes('rollback_last_action'), 'rollback remains available')
}
{
  // The "next game" regression: with no gameDate/opponent hint the dispatch
  // layer resolves the most recently PLAYED game, so a hint-less view_lineup
  // call during a "build a lineup for the next game" request returned the
  // PREVIOUS game and the model relayed it as the next game. The tool text
  // is the only place the model can learn that, so it must state the
  // default precisely and point upcoming-game requests at gameDate.
  const tools = makeChatTools({ dispatch: async () => ({}), role: 'captain' })
  const viewLineup = tools.find(t => t.name === 'view_lineup')
  assert.match(viewLineup.description, /most recently played/i,
    'view_lineup description defines the default as imminent/today, else most recently played')
  assert.match(viewLineup.description, /next game/i,
    'view_lineup description tells the model to pass gameDate for the next game')
  const gameDateDesc = viewLineup.schema.shape.gameDate.description ?? ''
  assert.match(gameDateDesc, /most recently played/i,
    'gameDate field describe defines the hint-less default')
  assert.match(gameDateDesc, /next upcoming game/i,
    'gameDate field describe contrasts the default with the next upcoming game')
  const createEvent = tools.find(t => t.name === 'create_game_event')
  assert.match(createEvent.description, /most recently played/i,
    'create_game_event description defines the default too')
}
console.log('✓ gateway/agent/agent.test.mjs all passed')
