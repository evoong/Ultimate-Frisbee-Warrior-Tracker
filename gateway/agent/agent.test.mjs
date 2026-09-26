import assert from 'node:assert/strict'
import { AIMessage } from '@langchain/core/messages'
import { runToolAgent } from './graph.ts'
import { makeChatTools } from './tools.ts'

// Stub model: a bindTools-capable object is all the graph requires.
class StubModel {
  constructor(responses) { this.responses = [...responses] }
  bindTools(tools) { this.boundTools = tools; return this }
  async invoke() { return this.responses.shift() }
}

const toolCallMsg = (name, args) =>
  new AIMessage({ content: '', tool_calls: [{ name, args, id: 'call_1' }] })

const base = { systemPrompt: 'sys', history: [], message: 'hi' }

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
console.log('✓ gateway/agent/agent.test.mjs all passed')
