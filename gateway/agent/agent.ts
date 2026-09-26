// The one entry point both runtimes call. Model choice + LangSmith live
// here; the graph in graph.ts stays model-agnostic for tests.
import { ChatGoogleGenerativeAI } from '@langchain/google-genai'
import type { DynamicStructuredTool } from '@langchain/core/tools'
import { runToolAgent } from './graph.js'

export async function runChatAgent(opts: {
  apiKey: string
  model: string
  systemPrompt: string
  history: { role: string; content: string }[]
  message: string
  tools: DynamicStructuredTool[]
  langSmith?: { apiKey: string; project: string }
}): Promise<string> {
  const model = new ChatGoogleGenerativeAI({ apiKey: opts.apiKey, model: opts.model, maxRetries: 4 })
  return runToolAgent({ ...opts, model })
}
