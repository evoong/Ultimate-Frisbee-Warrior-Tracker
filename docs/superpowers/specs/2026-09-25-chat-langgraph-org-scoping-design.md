# Chat: LangGraph agent, org/user/player scoping, LangSmith tracing

Date: 2026-09-25
Status: approved design (this doc), pending implementation plan

## Intent

Chat must enforce who is using it, not just which team: per-user thread
isolation, player-scoped context for linked members, role-tiered tool
writes, and verified cross-org isolation. The chat loop itself is rewritten
as a shared LangGraph agent used by both runtimes, with LangSmith tracing.

Non-goals:

- Durable/resumable threads (checkpointer). Production chat runs on the
  Cloudflare Worker, where the Postgres checkpointer (node:pg, TCP) cannot
  run. `chat_logs` remains the message store; history is passed into a
  stateless graph per request.
- Realtime chat updates.
- Any change to the Chat page UI beyond what the API shapes require.

## Current state and gaps

- Two parallel chat implementations: `server/index.ts` (Express, dev,
  `POST /api/chat` line 552, history 708, delete 736) and
  `gateway/chat.ts` (Worker, `handleChatRequest` line 462). Same shape,
  duplicated logic.
- `chat_logs.user_id` exists (baseline migration) but no writer populates
  it. History/delete scope only by `(session_id, organization_id)` after a
  membership check, so any org member can read or delete another member's
  thread by guessing the client-minted session id. RLS on `chat_logs`
  (tier B, `20260903001200_strict_rls.sql`) is org-members-wide: direct
  Supabase client access lets any member insert/update/delete other
  members' rows in-org.
- Tool writes gate at `hasAtLeast(role, 'member')` — members can write
  game events through chat tools.
- `player_links` (pending/approved, `team_id` + `player_id` + `user_id`)
  exists for stats identity but grants nothing in chat: every member gets
  full-team prompt context.
- Chat loop is a hand-rolled Gemini function-calling loop
  (`CHAT_FUNCTION_DECLARATIONS` in `gateway/gameActions.ts`), no tracing.
- 30-day history limit and free-tier `game_id` filtering are recent
  behaviors that must survive the rewrite.

## Restrictions to enforce

All four layers, verified server-side on every request (both chat
endpoints run service-role, so application code is the security boundary;
RLS additionally guards direct Supabase client access):

1. **Cross-org isolation.** Caller's org comes from the verified JWT's
   membership (`createMembershipLookup`, fail-closed), never from the
   request body beyond a consistency check. Every DB read/write — context
   build, tool calls, chat log write, history — carries that org id.
2. **Per-user thread isolation.**
   - Both runtimes populate `chat_logs.user_id` from the verified token.
   - History fetch and delete add `.eq('user_id', caller.uid)`.
   - `chat_logs` RLS: SELECT/DELETE require
     `organization_id = any(my_member_team_ids()) AND user_id = auth.uid()`;
     INSERT requires org membership and `user_id = auth.uid()` (with-check,
     not a default).
   - Session id stays client-minted (localStorage) and must be a UUID;
     anything else is rejected 400. User scoping makes guessing other
     sessions useless.
3. **Role-tiered tools.** Read-only tool calls: any member (chat access
   itself stays member-tier, matching `can.record`). Tool **writes** move
   from `hasAtLeast(role, 'member')` to `hasAtLeast(role, 'editor')` —
   in the agent and in the MCP server's game-action tools, which share the
   same dispatch.
4. **Player-scoped context.**
   - captain/editor: full team context.
   - member with ≥1 **approved** `player_links` row: context (team data
     in the prompt) and all tool query results filtered to their linked
     player ids.
   - member with no approved link: full team context.
   - Membership lookup returns `playerIds: number[] | null` alongside the
     role (`null` = unscoped/full). Free-tier game-id filtering composes
     with player scoping (both filters AND).

## LangGraph architecture

Approach A from brainstorming — shared agent module, thin shims:

```
gateway/agent/
  graph.ts        StateGraph: agent node <-> tool node -> END (stateless)
  tools.ts        LangChain tool wrappers over gameActions dispatch
  context.ts      getTeamContext + player scoping (moved from gateway/chat.ts)
shims (unchanged surface):
  gateway/chat.ts            Worker handlers -> gateway/agent
  server/index.ts           Express handlers -> gateway/agent
```

- `@langchain/core`, `@langchain/langgraph`, `@langchain/google-genai`.
  Gemini via `ChatGoogleGenerativeAI` using existing `GEMINI_API_KEY`.
- `gameActions.ts` core dispatch is untouched; LangChain tools and MCP
  tools wrap the same functions. MCP server behavior changes only in the
  write gate (member -> editor).
- Tier quota (`consumeAiMessage`, 429 + refund-on-failure) stays in the
  shim layer before the graph runs.
- Both runtimes keep identical response shapes — frontend Chat page
  unchanged except no change needed at all (same `/api/chat` contract).

## LangSmith tracing

- Env: `LANGSMITH_API_KEY`, `LANGSMITH_TRACING` (default on when key
  present), `LANGSMITH_PROJECT`. Secret on wrangler (`wrangler secret put
  LANGSMITH_API_KEY`), plain env for Express. Blank key = tracing off.
- Traces include chat content and team/player data (accepted at design
  review — full-fidelity default). If privacy posture changes later, mask
  via LangChain `hideInput`/`hideOutput` on the model call; that is the
  documented upgrade path, not built now.

## Testing

- pgTAP (`supabase/tests/`, run via `npm run db:test` against local QA):
  new `chat_logs` policies — owner-only read/delete in-org, cross-org
  denied, insert forces `user_id`; `00_meta` allowlist unchanged.
- Gateway offline tests (`npm run test:gateway:offline`): player-scope
  filtering in context builder, editor gate on write tools, existing
  `freeTierHistory` tests keep passing.
- Early spike (first implementation step): build the Worker with the
  LangChain/LangGraph deps and confirm bundle size, Worker runtime
  compatibility (including LangSmith tracer posting traces from the
  Worker), before any rewrite lands. Spike code is throwaway.

## Rollout notes

- One migration: RLS policy replacement only, no new columns.
- Deploy order: DB first, then Worker/Express (new writers populate
  `user_id`). Legacy rows with null `user_id` become unreadable to clients
  under the new SELECT policy; accepted because chat history is 30-day
  limited, so orphaned rows age out within 30 days of deploy.
- `server.test.mjs` / `npm test` untouched (reads production; not run
  here).
