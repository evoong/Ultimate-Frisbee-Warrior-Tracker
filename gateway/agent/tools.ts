// LangChain tool wrappers over gameActions' dispatch — the same callChatFunction
// the old Gemini loop and the MCP server use. The tool layer is where the
// editor-tier write gate lives now (spec: member = queries only), and where
// the PostHog $ai_span per tool call is emitted via onSpan.
import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { hasAtLeast, type TeamRole } from '../membership.js'
import { WRITE_FUNCTIONS, EVENT_TYPES, STAT_METRICS } from '../gameActions.js'

export interface ChatToolDeps {
  dispatch: (name: string, args: Record<string, unknown>) => Promise<unknown>
  role: TeamRole
  onSpan?: (name: string, args: unknown, result: { output?: unknown; error?: string }, latencyMs: number) => void
}

function writeBlocked() {
  return { error: "you do not have permission to change this team's data" }
}

export function makeChatTools(deps: ChatToolDeps): DynamicStructuredTool[] {
  const run = (name: string) => async (args: Record<string, unknown>) => {
    if (WRITE_FUNCTIONS.has(name) && !hasAtLeast(deps.role, 'editor')) return writeBlocked()
    const start = Date.now()
    try {
      const output = await deps.dispatch(name, args)
      deps.onSpan?.(name, args, { output }, Date.now() - start)
      return output
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      deps.onSpan?.(name, args, { error }, Date.now() - start)
      return { error }
    }
  }

  const gameHint = z.object({
    gameDate: z.string().optional().describe('YYYY-MM-DD, only to target a specific non-current game.'),
    opponent: z.string().optional().describe('Opponent name/substring, only to target a specific non-current game.'),
  })

  return [
    new DynamicStructuredTool({
      name: 'create_game_event',
      description: `Logs a scoring or game event. Valid eventType values: ${EVENT_TYPES.join(', ')}. For "Goal", playerName is the scorer and assisterName (optional) credits the assist. For "Opponent Goal", omit both player names. For other types, playerName is whoever the event happened to/by. Omit gameDate/opponent to target the current/most relevant game; only pass them to target a different, specific game the user named.`,
      schema: gameHint.extend({
        eventType: z.enum(EVENT_TYPES).describe(`Valid eventType values: ${EVENT_TYPES.join(', ')}. For "Goal", playerName is the scorer and assisterName (optional) credits the assist. For "Opponent Goal", omit both player names. For other types, playerName is whoever the event happened to/by.`),
        playerName: z.string().optional(),
        assisterName: z.string().optional().describe('Only meaningful when eventType is "Goal".'),
        notes: z.string().optional(),
      }),
      func: run('create_game_event'),
    }),
    new DynamicStructuredTool({
      name: 'undo_last_event',
      description: 'Deletes the most recently logged event for a game (same as the app\'s "Undo last event" button). Use when the user says something like "undo that" or "that\'s wrong, remove it" right after logging.',
      schema: gameHint,
      func: run('undo_last_event'),
    }),
    new DynamicStructuredTool({
      name: 'add_to_lineup',
      description: 'Places a player in a lineup group for a game (creating the group if needed), which is what makes them count as attending. Defaults to the game\'s first lineup group if lineupGroupName is omitted.',
      schema: gameHint.extend({
        playerName: z.string(),
        lineupGroupName: z.string().optional(),
        role: z.string().optional().describe('e.g. "Handler", "Deep Cutter".'),
      }),
      func: run('add_to_lineup'),
    }),
    new DynamicStructuredTool({
      name: 'remove_from_lineup',
      description: 'Removes a player from every lineup group in a game, which is what makes them stop counting as attending.',
      schema: gameHint.extend({ playerName: z.string() }),
      func: run('remove_from_lineup'),
    }),
    new DynamicStructuredTool({
      name: 'create_lineup_group',
      description: 'Adds a new, initially empty lineup group (e.g. "Line 2") to a game.',
      schema: gameHint.extend({ name: z.string() }),
      func: run('create_lineup_group'),
    }),
    new DynamicStructuredTool({
      name: 'query_stat_breakdown',
      description: `Computes an exact, code-verified stat breakdown. The system prompt's PLAYER STATS and ASSIST PAIRINGS tables are pre-tallied but ALL-TIME ONLY — call this tool instead of counting from EVENT TIMELINE yourself whenever a question is scoped to one specific season or one specific game. Examples: "who assisted Eric the most this season" -> {metric: "assists", byAssistPairing: true, seasonName: "Jam Summer 2026"}. "top scorers in the game vs Huck Huck Goose" -> {metric: "goals", opponent: "Huck Huck Goose"}. "who had the most turnovers in Jam Summer 2026" -> {metric: "turnovers", seasonName: "Jam Summer 2026"}. "best pairing so far this season" -> {metric: "assists", byAssistPairing: true, seasonName: "<current season>"}. Omit seasonName/gameDate/opponent only for an all-time breakdown (rarely needed since PLAYER STATS/ASSIST PAIRINGS already cover all-time).
STRICT OUTPUT RULE: the "rows" you get back are the complete, final, already-correct answer for exactly the scope you asked for — quote a row's "count" verbatim, character for character, in your reply. Never recalculate, round, average, or "estimate" a count; never blend a scoped row with the separate ALL-TIME PLAYER STATS/ASSIST PAIRINGS numbers in the same sentence (e.g. do not say "4 this season (6 all-time)" — pick the one scope the user asked about and report only that). An empty "rows" array is a real, valid answer meaning zero matching events for that exact scope (check the "note" field, which spells this out) — say so plainly, do not treat it as a failure or fall back to guessing a number. If seasonName/gameDate/opponent fails to resolve, or metric is invalid, the call errors out instead of returning empty rows — tell the user you couldn't find that season/game/metric by name instead of guessing a number.`,
      schema: z.object({
        metric: z.enum(STAT_METRICS),
        byAssistPairing: z.boolean().optional().describe('Only for metric "assists": group by scorer+assister pair.'),
        seasonName: z.string().optional().describe('Season name/substring, e.g. "Jam Summer 2026".'),
        gameDate: z.string().optional().describe('YYYY-MM-DD.'),
        opponent: z.string().optional().describe('Opponent name/substring.'),
      }),
      func: run('query_stat_breakdown'),
    }),
  ]
}
