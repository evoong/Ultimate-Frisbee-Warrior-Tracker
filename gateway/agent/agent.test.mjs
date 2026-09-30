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
}
console.log('✓ gateway/agent/agent.test.mjs all passed')
