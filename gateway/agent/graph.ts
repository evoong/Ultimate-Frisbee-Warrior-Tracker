// Stateless LangGraph agent: one graph per request, history passed in,
// chat_logs remains the store. No checkpointer — the Postgres checkpointer
// needs node:pg (TCP), which cannot run on the Cloudflare Worker where
// production chat lives (see the spec's non-goals).
import { END, START, StateGraph, MessagesAnnotation } from '@langchain/langgraph'
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { DynamicStructuredTool } from '@langchain/core/tools'

export interface AgentOptions {
  model: BaseChatModel
  tools: DynamicStructuredTool[]
  systemPrompt: string
  history: { role: string; content: string }[]
  message: string
  langSmith?: { apiKey: string; project: string }
}

export async function runToolAgent(opts: AgentOptions): Promise<string> {
  if (opts.langSmith?.apiKey) {
    // workerd exposes env via the handler param, not process.env, and the
    // LangSmith tracer reads process.env — materialize the explicit config
    // before any LangChain object is constructed (process.env writability
    // verified in Task 1's spike; Node/Express is the same code path).
    const proc = (globalThis as { process?: { env: Record<string, string | undefined> } }).process
    if (proc) {
      proc.env.LANGSMITH_API_KEY = opts.langSmith.apiKey
      proc.env.LANGSMITH_TRACING = 'true'
      proc.env.LANGSMITH_PROJECT = opts.langSmith.project
    }
  }

  const messages: BaseMessage[] = [new SystemMessage(opts.systemPrompt)]
  for (const h of opts.history) {
    messages.push(h.role === 'assistant' ? new AIMessage(h.content) : new HumanMessage(h.content))
  }
  messages.push(new HumanMessage(opts.message))

  const modelWithTools = opts.model.bindTools(opts.tools)
  const last = (state: typeof MessagesAnnotation.State): AIMessage => state.messages[state.messages.length - 1] as AIMessage

  const callAgent = async (state: typeof MessagesAnnotation.State) => ({
    messages: [await modelWithTools.invoke(state.messages)],
  })

  const callTools = async (state: typeof MessagesAnnotation.State) => {
    const results: BaseMessage[] = []
    for (const call of last(state).tool_calls ?? []) {
      const tool = opts.tools.find(t => t.name === call.name)
      if (!tool) {
        results.push(new ToolMessage({ tool_call_id: call.id ?? '', content: JSON.stringify({ error: `Unknown tool ${call.name}` }) }))
        continue
      }
      // Contract: no error thrown inside a tool call may reject runToolAgent.
      // DynamicStructuredTool.invoke throws ToolInputParsingException on zod
      // schema mismatch BEFORE the func runs; relay any error as a
      // ToolMessage the model can explain, instead of aborting the graph.
      try {
        const out = await tool.invoke(call.args ?? {})
        results.push(new ToolMessage({ tool_call_id: call.id ?? '', content: typeof out === 'string' ? out : JSON.stringify(out ?? null) }))
      } catch (err) {
        results.push(new ToolMessage({ tool_call_id: call.id ?? '', content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }))
      }
    }
    return { messages: results }
  }

  const shouldContinue = (state: typeof MessagesAnnotation.State) =>
    (last(state).tool_calls?.length ?? 0) > 0 ? 'tools' : '__end__'

  const graph = new StateGraph(MessagesAnnotation)
    .addNode('agent', callAgent)
    .addNode('tools', callTools)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', shouldContinue, { tools: 'tools', __end__: END })
    .addEdge('tools', 'agent')
    .compile()

  const result = await graph.invoke({ messages }, { recursionLimit: 10 })
  const final = result.messages[result.messages.length - 1] as AIMessage
  return typeof final.content === 'string' ? final.content : ''
}
