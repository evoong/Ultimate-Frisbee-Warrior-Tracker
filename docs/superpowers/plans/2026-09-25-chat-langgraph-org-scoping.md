# Chat LangGraph + Org/User/Player Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce who is using chat — per-user thread isolation, player-scoped context for linked members, editor-tier tool writes — and rewrite the chat loop as one shared LangGraph agent (both runtimes) with LangSmith tracing.

**Architecture:** One new shared module `gateway/agent/` (context builder, LangChain tools, stateless StateGraph) used by both the Express server (`server/index.ts`) and the Cloudflare Worker (`gateway/chat.ts`), which become thin HTTP shims. One DB migration tightens `chat_logs` RLS to owner-scoped rows. Membership lookup gains `playerLinkFor`. `chat_logs` stays the message store (no checkpointer — Worker cannot run node:pg).

**Tech Stack:** LangGraph JS (`@langchain/langgraph`), `@langchain/google-genai` (ChatGoogleGenerativeAI), `@langchain/langsmith`, zod v4 (already a dep), PostgREST-over-fetch (existing pattern), pgTAP.

**Spec:** `docs/superpowers/specs/2026-09-25-chat-langgraph-org-scoping-design.md`

## Global Constraints

- **Never run `npm test`** — it reads production. Also never run `npm run test:gateway` (needs live local stack; only `npm run db:test` uses the stack, after `npm run qa:reset`).
- Offline suites: `npm run test:gateway:offline` (root). New offline test files must be appended to the `test:gateway:offline` script in `package.json` in the same task that adds them.
- DB work: QA stack is DISABLED on this device. `npm run qa:reset` + `npm run db:test` are allowed ONLY when a task's steps explicitly say to run them (they rebuild the isolated local stack; `npx supabase start` must never be run otherwise).
- House RLS form: every membership-helper call is wrapped `(select public.fn())::bigint[]`. Copy this form verbatim.
- Service role bypasses RLS — application code is the security boundary. Every lookup fails closed. A revoked role takes effect within the 30s lookup TTL.
- Both runtimes (Express + Worker) share the one agent module; do not leave a second copy of the loop.
- Worker limits: no TCP/node:pg in request path; `nodejs_compat` is on.
- The system prompt's Patois instructions, the tool-confirmation rules, and the free-tier 30-day data-window behavior must survive the rewrite verbatim in effect.
- PostHog `$ai_span` events per tool call and one `$ai_generation`-equivalent per request must keep firing (manual capture — the `@posthog/ai` Gemini wrapper goes away with the old loop).
- Frontend has its own package.json; only `frontend/pages/Chat.tsx` is touched, logic only — no UI/styling changes.
- Commits: conventional one-liners, commit after each task's tests pass.

## Review Focus

Five input classes the spec implies but no single task fully exercises; each is pinned to its owning task:

1. **A teammate naming another member's session_id** must get zero rows, not their thread — pgTAP Task 2 (`is_empty` on teammate + cross-org cases) and Task 4's `user_id=eq` filters.
2. **A revoked member mid-session** must be denied within 30s and a Supabase outage must never read as "allowed" — Task 3's `playerLinkFor` must THROW (never resolve null) on lookup failure; Task 2 RLS is the second wall.
3. **A linked member asking about a teammate's stats** must get only their own player's data — Task 6 context filtering + `queryStatBreakdown` scope; assert teammate's section absent.
4. **A member invoking a write tool via chat or MCP** must get a permission error relayed by the model, never a 500 — Task 7 (`writeBlocked` in tools) and Task 5 (`canUseMcpTool`).
5. **Blank LANGSMITH_API_KEY** must mean tracing fully off with chat still working — Task 7 (tracer only constructed when key present) + Task 8 wiring.

---

### Task 1: Spike — LangChain/LangGraph deps bundle and API-verify on the Worker

**Files:**
- Modify: `package.json`, `package-lock.json` (deps stay; spike code deleted)
- Create (temporary, deleted before commit): `gateway/agent/spike.ts`
- Modify (temporary, reverted before commit): `worker.ts`

**Interfaces:**
- Produces: `@langchain/core`, `@langchain/langgraph`, `@langchain/google-genai`, `@langchain/langsmith` in `package.json`; a written report of bundle size + `process.env` writability finding, appended to the report file (Task 7 consumes the process.env finding).

- [ ] **Step 1: Install deps**

Run: `npm install @langchain/core @langchain/langgraph @langchain/google-genai @langchain/langsmith`
Expected: lockfile updated, no peer conflicts (zod v4 is already a root dep; if npm reports a zod peer conflict, record the exact message in the report and install the version of `@langchain/core` that accepts zod ^4).

- [ ] **Step 2: Write the throwaway probe**

Create `gateway/agent/spike.ts`:

```ts
// Spike for the LangGraph rewrite plan, Task 1. Throwaway: deleted before
// commit. Verifies the three things a dry-run can catch — the packages
// bundle for workerd, zod v4 works with DynamicStructuredTool, and the
// StateGraph API matches the shape Task 7 assumes.
import { StateGraph, MessagesAnnotation, START, END } from '@langchain/langgraph'
import { ChatGoogleGenerativeAI } from '@langchain/google-genai'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'

export const SPIKE_PROBE = 'langgraph-bundle-probe'

const spikeTool = new DynamicStructuredTool({
  name: 'spike_tool',
  description: 'spike',
  schema: z.object({ x: z.string() }),
  func: async ({ x }) => x,
})

export async function spikeGraph() {
  const model = new ChatGoogleGenerativeAI({ apiKey: 'x', model: 'gemini-flash-lite-latest' })
  return new StateGraph(MessagesAnnotation)
    .addNode('agent', async (s: any) => ({ messages: [await model.bindTools([spikeTool]).invoke(s.messages)] }))
    .addNode('tools', async (s: any) => {
      const call = (s.messages.at(-1) as any)?.tool_calls?.[0]
      return { messages: [await spikeTool.invoke(call?.args ?? { x: 'none' })] }
    })
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', (s: any) => ((s.messages.at(-1) as any)?.tool_calls?.length ?? 0) > 0 ? 'tools' : '__end__', { tools: 'tools', __end__: END })
    .addEdge('tools', 'agent')
    .compile()
}

// process.env writability probe: Task 7 materializes LANGSMITH_* into
// process.env per request; workerd must expose a mutable object.
export function spikeEnvWrite(): boolean {
  try {
    ;(globalThis as any).process = (globalThis as any).process ?? {}
    ;(globalThis as any).process.env = (globalThis as any).process.env ?? {}
    ;(globalThis as any).process.env.__UFWT_SPIKE__ = '1'
    return (globalThis as any).process.env.__UFWT_SPIKE__ === '1'
  } catch {
    return false
  }
}
```

- [ ] **Step 3: Reference it from the Worker so the bundler keeps it**

In `worker.ts`, add the import next to the existing gateway imports:

```ts
import { spikeGraph, spikeEnvWrite } from './gateway/agent/spike.js'
```

Inside the `fetch` handler, immediately after `const url = new URL(request.url);`, add:

```ts
    // SPIKE (Task 1, deleted before commit)
    if (url.pathname === '/__spike') {
      return new Response(JSON.stringify({ graph: typeof spikeGraph, envWrite: spikeEnvWrite() }), { status: 200 })
    }
```

- [ ] **Step 4: Dry-run build and record size**

Run: `npx wrangler deploy --config wrangler.jsonc --dry-run --outdir /tmp/opencode/spike-dist 2>&1 | tail -30`
(The build command runs `npm run build` — the frontend build; it is part of any real deploy anyway. If frontend node_modules are missing, run `cd frontend && npm install` first.)
Record the reported script size (gzip) in the report file.

**GATE:** if the dry-run errors on the LangChain imports (unbundlable Node built-ins other than what nodejs_compat provides) or script size exceeds 5MB gzip, STOP — do not commit — report BLOCKED with the exact error.

- [ ] **Step 5: Sanity-check the offline suite**

Run: `npm run test:gateway:offline`
Expected: all pass (deps alone must break nothing).

- [ ] **Step 6: Revert spike code, keep deps, commit**

Remove the `/__spike` block and the import from `worker.ts`; delete `gateway/agent/spike.ts`. Then:

```bash
git add package.json package-lock.json
git commit -m "deps: add @langchain/core, langgraph, google-genai, langsmith for chat agent rewrite"
```

Write findings (script size, zod4 ok/not, any API surprises vs Task 7's assumed StateGraph shape) to the report file.

### Task 2: chat_logs owner-scoped RLS migration + pgTAP suite

**Files:**
- Create: `supabase/migrations/20260925000000_chat_logs_owner_rls.sql`
- Create: `supabase/tests/24_chat_logs_rls.test.sql`

**Interfaces:**
- Consumes: `public.my_member_team_ids()` (exists, `20260903000600_permission_helpers.sql`); seeded users `captain@local.test`/`editor@local.test`/`member@local.test`/`outsider@local.test` (org 1 = private, org 2 = public; `outsider@local.test` is org-2 captain).
- Produces: policies `owner read` / `owner insert` / `owner delete` on `public.chat_logs`; UPDATE revoked from `authenticated`. `00_meta.test.sql` allowlist untouched (chat_logs keeps ≥1 policy).

- [ ] **Step 1: Write the migration**

`supabase/migrations/20260925000000_chat_logs_owner_rls.sql`:

```sql
-- Chat threads are per-user, not per-team. The tier-B "member read" set
-- from 20260903001200 let every org member SELECT/INSERT/UPDATE/DELETE
-- every chat_logs row in their org via the Supabase client directly, and
-- the service-role endpoints scoped history by (session_id, organization_id)
-- only -- so any member could read or delete any teammate's thread by
-- naming its session id. These policies keep chat_logs org-scoped AND
-- owner-scoped.
--
-- Rows written before this change carry user_id null and become invisible
-- to clients: chat_logs is never updated (no backfill target exists), and
-- the 30-day history limit ages them out, so no data is lost that any
-- client could still reach.
--
-- House form: every membership-helper call wrapped as
-- `(select public.fn())::bigint[]` per 20260903001200's InitPlan rule.

drop policy if exists "member read" on public.chat_logs;
drop policy if exists "member insert" on public.chat_logs;
drop policy if exists "member update" on public.chat_logs;
drop policy if exists "member delete" on public.chat_logs;

create policy "owner read" on public.chat_logs
  for select to authenticated
  using (organization_id = any ((select public.my_member_team_ids())::bigint[])
         and user_id = auth.uid()::text);

create policy "owner insert" on public.chat_logs
  for insert to authenticated
  with check (organization_id = any ((select public.my_member_team_ids())::bigint[])
         and user_id = auth.uid()::text);

create policy "owner delete" on public.chat_logs
  for delete to authenticated
  using (organization_id = any ((select public.my_member_team_ids())::bigint[])
         and user_id = auth.uid()::text);

-- Nothing in the app updates chat_logs; close the path entirely rather
-- than scoping it.
revoke update on public.chat_logs from authenticated;
```

- [ ] **Step 2: Write the pgTAP suite**

`supabase/tests/24_chat_logs_rls.test.sql`:

```sql
begin;
select plan(7);

-- Seed while running as postgres (bypasses RLS): one row owned by the
-- org-1 editor, one legacy row with no owner, both in the private org 1.
insert into public.chat_logs (session_id, user_id, role, content, organization_id)
select 'seed-editor', u.id::text, 'user', 'editor thread', 1
  from auth.users u where u.email = 'editor@local.test';
insert into public.chat_logs (session_id, user_id, role, content, organization_id)
values ('seed-legacy', null, 'user', 'legacy thread', 1);

-- chat_logs.user_id is text (baseline schema); auth.uid() is uuid, so every
-- comparison/insert casts uuid -> text on the auth side.
select tests.login_as('editor@local.test');
select is_empty(
  $$ select id from public.chat_logs where session_id = 'seed-legacy' $$,
  'a legacy row with null user_id is invisible to every client'
);
select lives_ok(
  $$ insert into public.chat_logs (session_id, user_id, role, content, organization_id)
     values ('seed-editor-2', auth.uid()::text, 'user', 'own row', 1) $$,
  'the owner can insert a chat row as themselves'
);

select tests.logout();
select tests.login_as('member@local.test');
select is_empty(
  $$ select id from public.chat_logs where session_id = 'seed-editor' $$,
  'a teammate cannot read another member''s chat thread'
);
select throws_ok(
  $$ insert into public.chat_logs (session_id, user_id, role, content, organization_id)
     select 'spoof', (select id::text from auth.users where email = 'editor@local.test'), 'user', 'spoofed', 1 $$,
  '42501', null,
  'a member cannot insert a chat row attributed to another user'
);
select throws_ok(
  $$ delete from public.chat_logs where session_id = 'seed-editor' $$,
  '42501', null,
  'a member cannot delete a teammate''s thread'
);

select tests.logout();
select tests.login_as('outsider@local.test');
select is_empty(
  $$ select id from public.chat_logs where organization_id = 1 $$,
  'an org-2 captain cannot read org-1 chat logs'
);

select tests.logout();
select tests.login_as('editor@local.test');
select lives_ok(
  $$ delete from public.chat_logs where session_id = 'seed-editor' $$,
  'the owner can delete their own thread'
);

select * from finish();
rollback;
```

- [ ] **Step 3: Reset QA stack and run DB tests**

Run: `npm run qa:reset`
Then: `npm run db:test`
Expected: all suites pass including `24_chat_logs_rls.test.sql` (7/7) and `00_meta` canaries.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260925000000_chat_logs_owner_rls.sql supabase/tests/24_chat_logs_rls.test.sql
git commit -m "rls: chat_logs rows are owner-scoped, not team-scoped"
```

### Task 3: Membership lookup gains playerLinkFor (approved player link, fail-closed by throwing)

**Files:**
- Modify: `gateway/membership.ts`
- Create: `gateway/playerLink.test.mjs`
- Modify: `package.json` (append test file to `test:gateway:offline`)

**Interfaces:**
- Consumes: `createMembershipLookup` config shape (`MembershipConfig`), TTL pattern, fail-closed doctrine.
- Produces: `MembershipLookup.playerLinkFor(userId: string, teamId: number): Promise<number | null>` — THROWS on lookup failure/non-2xx/non-array body; resolves `player_id` for an approved link, `null` for a genuinely unlinked user. Tasks 6/8 consume it.

- [ ] **Step 1: Write the failing test**

`gateway/playerLink.test.mjs` (offline, mocked fetch):

```js
import assert from 'node:assert/strict'
import { createMembershipLookup } from './membership.ts'

const realFetch = globalThis.fetch.bind(globalThis)
let mode = 'empty'
globalThis.fetch = async (url) => {
  const u = String(url)
  if (mode === 'approved') {
    return Response.json([{ player_id: 101 }])
  }
  if (mode === 'error') return new Response('boom', { status: 500 })
  if (mode === 'malformed') return Response.json({ not: 'an array' })
  return Response.json([])
}
// Distinct userIds per scenario: linkCache is keyed by user, so a cached
// result from one case would satisfy the next without a fetch and hide a
// fail-open bug.
try {
  const lookup = createMembershipLookup({ supabaseUrl: 'https://example.test', supabaseSecretKey: 'k' })

  mode = 'approved'
  assert.equal(await lookup.playerLinkFor('u1', 1), 101, 'approved link resolves the player_id')

  mode = 'empty'
  assert.equal(await lookup.playerLinkFor('u2', 1), null, 'no approved link resolves null')

  mode = 'error'
  await assert.rejects(() => lookup.playerLinkFor('u3', 1), /player link lookup failed: 500/,
    'a non-2xx lookup THROWS, never resolves null')

  mode = 'malformed'
  await assert.rejects(() => lookup.playerLinkFor('u4', 1), /player link lookup returned a non-array body/,
    'a non-array body THROWS, never resolves null')

  mode = 'approved'
  assert.equal(await lookup.playerLinkFor('u1', 1), 101, '30s TTL cache serves repeat calls for the same user')
  console.log('✓ gateway/playerLink.test.mjs all passed')
} finally {
  globalThis.fetch = realFetch
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node node_modules/tsx/dist/cli.mjs gateway/playerLink.test.mjs`
Expected: FAIL — `playerLinkFor is not a function`.

- [ ] **Step 3: Implement**

In `gateway/membership.ts`, extend the interface and the factory. Add to `MembershipLookup`:

```ts
export interface MembershipLookup {
  roleFor(userId: string, teamId: number): Promise<TeamRole | null>
  teamsFor(userId: string): Promise<TeamRoleRow[]>
  // A member's APPROVED player link for one team, or null when they
  // genuinely have none (player_links.status = 'approved'; the table's
  // unique (team_id, user_id) means at most one).
  //
  // THROWS on lookup failure instead of resolving null. This is the
  // opposite direction from load()'s fail-closed deny: null here WIDENS
  // the chat context to the whole team (the spec's "unlinked = full"
  // rule), so an unavailable lookup must never be readable as
  // "unlinked". Callers turn the throw into a 5xx, never into a wider
  // context.
  playerLinkFor(userId: string, teamId: number): Promise<number | null>
}
```

Inside `createMembershipLookup`, add a second cache next to the first:

```ts
  const linkCache = new Map<string, { at: number; playerId: number | null }>()
```

and return from the factory (alongside `teamsFor`/`roleFor`):

```ts
    async playerLinkFor(userId, teamId) {
      const key = `${userId}:${teamId}`
      const hit = linkCache.get(key)
      if (hit && Date.now() - hit.at < TTL_MS) return hit.playerId

      const url =
        `${config.supabaseUrl}/rest/v1/player_links` +
        `?select=player_id&user_id=eq.${encodeURIComponent(userId)}` +
        `&team_id=eq.${encodeURIComponent(String(teamId))}&status=eq.approved&limit=1`
      const res = await fetch(url, {
        headers: {
          apikey: config.supabaseSecretKey,
          Authorization: `Bearer ${config.supabaseSecretKey}`,
        },
      })
      if (!res.ok) {
        const err = new Error(`player link lookup failed: ${res.status} ${await res.text().catch(() => '')}`)
        config.onLookupError?.(err)
        throw err
      }
      const rows = (await res.json()) as { player_id: number }[]
      if (!Array.isArray(rows)) {
        const err = new Error('player link lookup returned a non-array body')
        config.onLookupError?.(err)
        throw err
      }
      const playerId = rows.length > 0 ? rows[0].player_id : null
      linkCache.set(key, { at: Date.now(), playerId })
      return playerId
    },
```

Append the test to `package.json`'s `test:gateway:offline` script: `&& node node_modules/tsx/dist/cli.mjs gateway/playerLink.test.mjs` (keep it after the membership-free files, e.g. right after `gateway/jamSync.test.mjs`).

- [ ] **Step 4: Run tests**

Run: `node node_modules/tsx/dist/cli.mjs gateway/playerLink.test.mjs`
Expected: PASS.
Run: `npm run test:gateway:offline`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add gateway/membership.ts gateway/playerLink.test.mjs package.json
git commit -m "feat: membership lookup exposes approved player link (throws on outage)"
```

### Task 4: chat_logs user_id writes, user-scoped history/delete, UUID session ids (both runtimes + frontend)

**Files:**
- Create: `gateway/sessionId.ts`
- Create: `gateway/sessionId.test.mjs`
- Modify: `gateway/chat.ts` (insertChatLogs, handleChatRequest, handleChatHistoryRequest, handleChatHistoryDeleteRequest)
- Modify: `server/index.ts` (`POST /api/chat` ~line 677 insert block, `GET /api/chat/history` ~line 721, `DELETE /api/chat/history` ~line 751)
- Modify: `frontend/pages/Chat.tsx` (`getSessionId`, lines 39-46)
- Modify: `package.json` (append test to `test:gateway:offline`)

**Interfaces:**
- Consumes: `requireTeamMember` / `classifyChatCaller` already return `sub` (verified JWT subject).
- Produces: `isValidSessionId(value: unknown): value is string` in `gateway/sessionId.ts`; `insertChatLogs(config, organizationId, userId, rows)` signature change in `gateway/chat.ts`.

- [ ] **Step 1: Write the failing test**

`gateway/sessionId.test.mjs`:

```js
import assert from 'node:assert/strict'
import { isValidSessionId } from './sessionId.ts'

assert.equal(isValidSessionId(crypto.randomUUID()), true, 'a real UUID passes')
assert.equal(isValidSessionId('s_1695000000_abc123def'), false, 'the old localStorage format is rejected')
assert.equal(isValidSessionId('not-a-uuid'), false, 'garbage rejected')
assert.equal(isValidSessionId(null), false, 'null rejected')
assert.equal(isValidSessionId(12345), false, 'non-string rejected')
assert.equal(isValidSessionId(''), false, 'empty rejected')
console.log('✓ gateway/sessionId.test.mjs all passed')
```

- [ ] **Step 2: Verify it fails**

Run: `node node_modules/tsx/dist/cli.mjs gateway/sessionId.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the validator**

`gateway/sessionId.ts`:

```ts
// Chat session ids stay client-minted (localStorage), but must be UUIDs.
// User scoping makes guessing someone else's id useless — this is format
// hygiene, not auth: it stops arbitrary strings reaching the session_id
// text column and retires the pre-2026 `s_<ts>_<rand>` format on the wire.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}
```

- [ ] **Step 4: Run test**

Run: `node node_modules/tsx/dist/cli.mjs gateway/sessionId.test.mjs`
Expected: PASS.

- [ ] **Step 5: Enforce in gateway/chat.ts**

Add `import { isValidSessionId } from './sessionId.js'` and change three handlers:

`handleChatRequest` — after the `organization_id` check (line ~469):

```ts
    if (!isValidSessionId(session_id)) return json({ error: 'session_id must be a UUID' }, 400)
```

`insertChatLogs` (line ~50) gains `userId` and stamps every row:

```ts
async function insertChatLogs(config: ChatConfig, organizationId: number, userId: string, rows: { session_id: string; role: string; content: string }[]): Promise<void> {
  await fetch(`${config.supabaseUrl}/rest/v1/chat_logs`, {
    method: 'POST',
    headers: {
      apikey: config.supabaseSecretKey,
      Authorization: `Bearer ${config.supabaseSecretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(rows.map(r => ({ ...r, organization_id: organizationId, user_id: userId }))),
  }).catch(() => void 0)
}
```

Its call site passes `user.sub`. `handleChatHistoryRequest` — validate `sessionId` the same 400 way and append the user filter to the query (line ~519):

```ts
      `/chat_logs?select=role,content,created_at&session_id=eq.${encodeURIComponent(sessionId)}&organization_id=eq.${organizationId}&user_id=eq.${encodeURIComponent(user.sub)}&order=created_at.asc`
```

`handleChatHistoryDeleteRequest` — same validation; append to the DELETE URL (line ~538):

```ts
    await fetch(`${config.supabaseUrl}/rest/v1/chat_logs?session_id=eq.${encodeURIComponent(sessionId)}&organization_id=eq.${organizationId}&user_id=eq.${encodeURIComponent(user.sub)}`, {
```

- [ ] **Step 6: Mirror in server/index.ts**

`POST /api/chat`: add the same 400 after the `organization_id` check (uses `import { isValidSessionId } from "../gateway/sessionId.js";`), and stamp both inserted rows (line ~677):

```ts
    const { error: chatLogError } = await supabase.from("chat_logs").insert([
      { session_id, role: "user", content: message, organization_id: teamId, user_id: caller.sub },
      { session_id, role: "assistant", content: reply, organization_id: teamId, user_id: caller.sub },
    ]);
```

`GET /api/chat/history`: same 400; add `.eq("user_id", caller.sub)` to the chain. `DELETE /api/chat/history`: same 400; add `.eq("user_id", caller.sub)`.

- [ ] **Step 7: Frontend mints UUIDs**

`frontend/pages/Chat.tsx` — replace `getSessionId` (keep it a local copy; frontend and gateway bundles are separate, same deliberate-duplication rule as `crestInitials` in the ledger):

```tsx
// Same shape as gateway/sessionId.ts, duplicated on purpose: the frontend
// bundle never imports gateway code. Old `s_<ts>_<rand>` values fail the
// regex and are silently re-minted; their rows are unreachable under the
// new owner-scoped RLS anyway (user_id was never written for them).
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function getSessionId() {
  let id = localStorage.getItem('ufwt_chat_session')
  if (!id || !SESSION_ID_RE.test(id)) {
    id = crypto.randomUUID()
    localStorage.setItem('ufwt_chat_session', id)
  }
  return id
}
```

- [ ] **Step 8: Run suites**

Run: `npm run test:gateway:offline` (append sessionId.test.mjs to the script first, same pattern as Task 3)
Run: `cd frontend && npm run typecheck`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add gateway/sessionId.ts gateway/sessionId.test.mjs gateway/chat.ts server/index.ts frontend/pages/Chat.tsx package.json
git commit -m "feat: chat threads are per-user — user_id on writes, owner-scoped history, UUID sessions"
```

### Task 5: Editor-tier gate on MCP write tools

**Files:**
- Modify: `gateway/mcpTools.ts` (add exports; no behavior change to tool bodies)
- Modify: `gateway/mcpAgent.ts` (lines 98-103, the per-call wrap)
- Modify: `gateway/mcpTools.test.mjs` (append checks)

**Interfaces:**
- Consumes: `TeamRole`, `hasAtLeast` from `gateway/membership.js`; the 14 registered tool names.
- Produces: `MCP_WRITE_TOOLS: ReadonlySet<string>` and `canUseMcpTool(role: TeamRole | null, toolName: string): boolean` (pure).

- [ ] **Step 1: Write the failing checks**

Append to `gateway/mcpTools.test.mjs` (match its existing `check()` style; add imports of `MCP_WRITE_TOOLS, canUseMcpTool` from `./mcpTools.ts`):

```js
// Write tools follow the spec's editor-tier rule (same gate as chat's
// WRITE_FUNCTIONS, Task 7). Kept next to the classification so a new
// registered tool fails here until someone classifies it.
const MCP_READ_ONLY = new Set([
  'list_games', 'get_current_game', 'get_game_details', 'list_game_events',
  'get_player_stats', 'list_seasons', 'list_roster', 'list_lineups',
])
const MCP_REGISTERED = [
  'list_games', 'get_current_game', 'get_game_details', 'create_game_event',
  'update_game_event', 'delete_game_event', 'list_game_events', 'get_player_stats',
  'list_seasons', 'list_roster', 'list_lineups', 'create_lineup_group',
  'add_to_lineup', 'remove_from_lineup',
]

for (const name of MCP_WRITE_TOOLS) {
  check(`MCP_WRITE_TOOLS name "${name}" is a registered tool`, MCP_REGISTERED.includes(name))
}
for (const name of MCP_REGISTERED) {
  check(`MCP tool "${name}" is classified exactly once (write xor read-only)`,
    MCP_WRITE_TOOLS.has(name) !== MCP_READ_ONLY.has(name))
}
check('member cannot use an MCP write tool', canUseMcpTool('member', 'create_game_event') === false)
check('editor can use an MCP write tool', canUseMcpTool('editor', 'create_game_event') === true)
check('captain can use an MCP write tool', canUseMcpTool('captain', 'add_to_lineup') === true)
check('member can use an MCP read tool', canUseMcpTool('member', 'list_games') === true)
check('no role means no tool at all', canUseMcpTool(null, 'list_games') === false)
check('unknown tool names pass only with a role (fail on lookup elsewhere)',
  canUseMcpTool('member', 'not_a_tool') === true)
```

- [ ] **Step 2: Verify failure**

Run: `node node_modules/tsx/dist/cli.mjs gateway/mcpTools.test.mjs`
Expected: FAIL — exports not defined.

- [ ] **Step 3: Implement**

`gateway/mcpTools.ts` — add near the top imports and exports (descriptions of the registered tools already live in this file; do not touch tool bodies):

```ts
import { hasAtLeast, type TeamRole } from './membership.js'

// The MCP twins of gameActions.ts's WRITE_FUNCTIONS: registered tools
// that write. Names here are the registerTool() names, which differ from
// the chat function names (update_game_event / delete_game_event exist
// only here). canUseMcpTool is the single gate the agent's per-call wrap
// consults.
export const MCP_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'create_game_event',
  'update_game_event',
  'delete_game_event',
  'create_lineup_group',
  'add_to_lineup',
  'remove_from_lineup',
])

export function canUseMcpTool(role: TeamRole | null, toolName: string): boolean {
  if (role === null) return false
  return MCP_WRITE_TOOLS.has(toolName) ? hasAtLeast(role, 'editor') : true
}
```

`gateway/mcpAgent.ts` — replace the per-call wrap's deny branch (lines 98-103). The registration-time check at line 71 stays as-is (any member may see the tool list):

```ts
    server.executeToolHandler = async (tool, args, extra) => {
      const role = await lookup.roleFor(userId, orgId)
      const toolName = (tool as { name?: string })?.name ?? ''
      if (!canUseMcpTool(role, toolName)) {
        throw new Error(
          role === null
            ? `MCP: ${email} is no longer a member of team ${orgId}`
            : `MCP: ${email} must be an editor or captain to use ${toolName} on team ${orgId}`
        )
      }
      return inner.call(server, tool, args, extra)
    }
```

(Add `canUseMcpTool` to the existing `import { registerUfwtMcpTools ... } from './mcpTools.js'` line, or a new import line from the same module.)

- [ ] **Step 4: Run tests**

Run: `node node_modules/tsx/dist/cli.mjs gateway/mcpTools.test.mjs`
Expected: PASS.
Run: `npm run test:gateway:offline`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add gateway/mcpTools.ts gateway/mcpAgent.ts gateway/mcpTools.test.mjs
git commit -m "feat: MCP write tools require editor tier"
```

### Task 6: Player-scoped team context + queryStatBreakdown scope

**Files:**
- Create: `gateway/agent/context.ts` (getTeamContext moved here, verbatim, plus the scope param)
- Modify: `gateway/chat.ts` (delete its `getTeamContext` body, import + re-export from `./agent/context.js`)
- Modify: `server/index.ts` (delete its local `getTeamContext` copy, lines ~293-541; keep an exported thin wrapper so `server/test/freeTierHistory.test.mjs`'s `await import('../index.ts')` still resolves)
- Modify: `gateway/gameActions.ts` (`queryStatBreakdown`, `callChatFunction`)
- Modify: `server/test/freeTierHistory.test.mjs` (extend fetch mock for `id=eq.` / `player_id=eq.`; add scoped assertions)
- Create: `gateway/queryScope.test.mjs`
- Modify: `package.json` (append queryScope test to `test:gateway:offline`)

**Interfaces:**
- Produces: `ChatScope = { playerId: number; playerName: string }` exported from `gateway/agent/context.ts`; `getTeamContext(config: { supabaseUrl: string; supabaseSecretKey: string }, organizationId: number, scope?: ChatScope): Promise<string>`; `callChatFunction(config, orgId, name, args, scope?: ChatScope)`; `queryStatBreakdown(config, orgId, params, scope?: ChatScope)`. Task 7/8 consume `ChatScope` and the scoped `callChatFunction`.
- Consumes: Task 1's installed deps are NOT needed here (pure move + filter).

- [ ] **Step 1: Write the failing scope tests**

`gateway/queryScope.test.mjs` (offline; mocked fetch modeled on `server/test/freeTierHistory.test.mjs`'s mock — same fixtures org 7, players 701 "Old Timer" / 702 "Recent Star", event id 3 = Goal 702 assisted by 701, event id 4 below):

```js
import assert from 'node:assert/strict'

// Fixtures for org 7 (same shape as server/test/freeTierHistory.test.mjs).
const now = Date.now()
const EVENTS = [
  { id: 3, player_id: 702, related_player_id: 701, event_type: 'Goal', game_id: 901, event_timestamp: new Date(now - 86400000).toISOString(), organization_id: 7 },
  { id: 4, player_id: 701, related_player_id: null, event_type: 'Goal', game_id: 901, event_timestamp: new Date(now - 86000000).toISOString(), organization_id: 7 },
]
const PLAYERS = [
  { id: 701, display_name: 'Old Timer' },
  { id: 702, display_name: 'Recent Star' },
]

const realFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (url) => {
  const target = new URL(String(url))
  if (target.hostname === '127.0.0.1' || target.hostname === 'localhost') return realFetch(url)
  const search = decodeURIComponent(target.search)
  if (target.pathname === '/rest/v1/rpc/effective_tier') return Response.json('paid')
  if (target.pathname === '/rest/v1/players') return Response.json(PLAYERS)
  if (target.pathname === '/rest/v1/game_events') {
    let rows = EVENTS
    const gid = search.match(/game_id=in\.\(([^)]*)\)/)
    if (gid) {
      const ids = gid[1].split(',').map(Number)
      rows = rows.filter(r => ids.includes(r.game_id))
    }
    return Response.json(rows)
  }
  if (target.pathname === '/rest/v1/games') {
    return Response.json([{ id: 901, season_id: 50, opponent: 'Fresh Rival', game_date: new Date(now - 86400000).toISOString().slice(0, 10), game_time: '19:00' }])
  }
  if (target.pathname === '/rest/v1/seasons') {
    return Response.json([{ id: 50, name: 'Summer', year: 2026, organizer: 'Jam' }])
  }
  throw new Error(`unmocked fetch: ${url}`)
}

try {
  const { queryStatBreakdown } = await import('./gameActions.ts')
  const config = { supabaseUrl: 'https://example.test', supabaseSecretKey: 'k' }

  const unscoped = await queryStatBreakdown(config, 7, { metric: 'goals' })
  assert.equal(unscoped.rows.length, 2, 'unscoped goals returns both players')

  const scoped = await queryStatBreakdown(config, 7, { metric: 'goals' }, { playerId: 702, playerName: 'Recent Star' })
  assert.equal(scoped.rows.length, 1, 'scoped goals returns only the linked player')
  assert.equal(scoped.rows[0].player, 'Recent Star')

  const scopedAssists = await queryStatBreakdown(config, 7, { metric: 'assists', byAssistPairing: true }, { playerId: 701, playerName: 'Old Timer' })
  assert.equal(scopedAssists.rows.length, 1, 'scoped assist pairing keeps rows involving the linked player')
  assert.equal(scopedAssists.rows[0].count, 1)

  const scopedOther = await queryStatBreakdown(config, 7, { metric: 'goals' }, { playerId: 701, playerName: 'Old Timer' })
  assert.deepEqual(scopedOther.rows.map(r => r.player), ['Old Timer'], 'the other player sees their own goals only')

  console.log('✓ gateway/queryScope.test.mjs all passed')
} finally {
  globalThis.fetch = realFetch
}
```

- [ ] **Step 2: Verify it fails**

Run: `node node_modules/tsx/dist/cli.mjs gateway/queryScope.test.mjs`
Expected: FAIL — `queryStatBreakdown` takes 3 args; the 4th-arg scoped assertions see both players.

- [ ] **Step 3: Move getTeamContext to gateway/agent/context.ts**

Create `gateway/agent/context.ts` containing `getTeamContext` moved VERBATIM from `gateway/chat.ts:104-349` (the whole function body, comments included — the Patois prompt text is load-bearing), with three changes:

1. New imports at top (supabaseServiceFetch + tier helpers move with it):

```ts
import { getOrgEffectiveTier, gameDateWithinFreeWindow } from '../supabaseRest.js'
```

(`supabaseServiceFetch` moves into this file as a local copy — chat.ts keeps its own for the log endpoints.)

2. New exported type + signature:

```ts
// Player-scoped context for a linked member (spec: linked = scoped,
// unlinked/captain/editor = full). playerId filters the DB queries and the
// derived player-facing sections; team-level facts (game results) stay
// intact because a game's score is not a player's data.
export interface ChatScope {
  playerId: number
  playerName: string
}

export type TeamContextConfig = { supabaseUrl: string; supabaseSecretKey: string }

export async function getTeamContext(config: TeamContextConfig, organizationId: number, scope?: ChatScope): Promise<string> {
```

3. Scoped filtering inside the moved body:

- players query (currently `/players?select=...&order=display_name.asc`) — append when scoped:

```ts
    supabaseServiceFetch(config, `/players?select=id,display_name,position,gender_match,is_sub&${orgFilter}${scope ? `&id=eq.${scope.playerId}` : ''}&order=display_name.asc`),
```

- seasonPlayers query — append `&player_id=eq.${scope.playerId}` when scoped (before the closing quote).

- `eventTimelines` — inside the `.map`, filter the game's events to the linked player:

```ts
      const gameEvents = (eventsByGame.get(g.id) ?? [])
        .filter((e: any) => !scope || e.player_id === scope.playerId || e.related_player_id === scope.playerId)
        .slice()
        .sort((a: any, b: any) => (a.event_timestamp ?? '').localeCompare(b.event_timestamp ?? ''))
```

- `assistPairingLines` and `assistPairingsBySeasonLines` — the `.map((p: any) => ...)` over players already yields only filtered players once the players query is scoped; no further change.

- Prompt: when scoped, insert after the `eventsNote` line:

```ts
  const scopeNote = scope
    ? `\nSCOPED VIEW: the user is linked to player ${scope.playerName}, and the data above contains only THAT player's individual stats. If asked about another player's individual stats or totals, say in patois that yuh can only see data for ${scope.playerName} and suggest they ask a captain or editor. Team-level facts (game results, season names) are fine to discuss.`
    : ''
```

and add `${scopeNote}` next to `${eventsNote}` in the returned template.

In `gateway/chat.ts`: delete the moved body (lines 104-349) and replace with:

```ts
import { getTeamContext as buildTeamContext, type ChatScope } from './agent/context.js'
export { getTeamContext } from './agent/context.js'
```

Also drop `getOrgEffectiveTier`/`gameDateWithinFreeWindow` from chat.ts's `./supabaseRest.js` import (they moved to context.ts; chat.ts's own `supabaseServiceFetch` stays for the log endpoints).

(chat.ts's own handler continues to call `buildTeamContext(config, teamId)` — unscoped until Task 8.)

In `server/index.ts`: delete the local `getTeamContext` function (lines ~293-541) and replace with a thin re-export wrapper so `await import('../index.ts').getTeamContext(7)` keeps working:

```ts
import { getTeamContext as buildTeamContext, type ChatScope } from "../gateway/agent/context.js";
// Kept exported for server/test/freeTierHistory.test.mjs, which imports it
// off this module; thin wrapper so the signature matches the old local one.
export function getTeamContext(organizationId: number, scope?: ChatScope) {
  return buildTeamContext(
    { supabaseUrl: process.env.SUPABASE_URL || "", supabaseSecretKey: process.env.SUPABASE_SECRET_KEY || "" },
    organizationId,
    scope
  );
}
```

(Delete server/index.ts's now-unused `@google/genai`-era helpers only if nothing else references them — the Gemini loop deletion is Task 8; leave those imports alone here.)

- [ ] **Step 4: Add scope to queryStatBreakdown + callChatFunction**

`gateway/gameActions.ts`:

```ts
import type { ChatScope } from './agent/context.js'
```

`queryStatBreakdown` gains a 4th parameter and metric-aware event filtering:

```ts
export async function queryStatBreakdown(
  config: ActionsConfig, orgId: number,
  params: { metric: StatMetric; seasonName?: string; gameDate?: string; opponent?: string; byAssistPairing?: boolean },
  scope?: ChatScope
): Promise<unknown> {
```

After `events` is fetched (the existing `const events: ... = archived ? [] : await sbGet(...)`), add:

```ts
  // Player-scope gate (spec: a linked member's tool results are filtered to
  // their own player, exactly like the prompt context). Applied after fetch
  // so it composes with the free-tier game_id filter instead of fighting it.
  const scopedEvents = scope
    ? params.metric === 'assists'
      ? events.filter(e => e.related_player_id === scope.playerId)
      : events.filter(e => e.player_id === scope.playerId)
    : events
```

In the `byAssistPairing` branch, iterate `scopedEvents` instead of `events` (a pairing row survives when either endpoint is the linked player — that is the "their own data" rule for pairings, since an assist is a fact about both endpoints):

```ts
    for (const e of scopedEvents) {
      if (e.event_type !== 'Goal' || !e.player_id || !e.related_player_id) continue
      if (scope && e.player_id !== scope.playerId && e.related_player_id !== scope.playerId) continue
      ...
```

In the by-player tally branch, iterate `scopedEvents` and keep only the linked player's key:

```ts
  for (const e of scopedEvents) {
    ...
  }
  // (the id keys are player ids; for a scoped member every surviving event
  //  already IS the linked player under the metric's own semantics, so no
  //  extra filter is needed here)
```

`callChatFunction` passes scope through to the one read tool (writes never see scope — by Task 7 they are editor-gated, and editors are never scoped):

```ts
export async function callChatFunction(config: ActionsConfig, orgId: number, name: string, args: Record<string, unknown>, scope?: ChatScope): Promise<unknown> {
  switch (name) {
    case 'create_game_event': return createGameEvent(config, orgId, args as any)
    case 'undo_last_event': return undoLastEvent(config, orgId, args as any)
    case 'add_to_lineup': return addToLineup(config, orgId, args as any)
    case 'remove_from_lineup': return removeFromLineup(config, orgId, args as any)
    case 'create_lineup_group': return createLineupGroup(config, orgId, args as any)
    case 'query_stat_breakdown': return queryStatBreakdown(config, orgId, args as any, scope)
    default: throw new Error(`Unknown function: ${name}`)
  }
}
```

- [ ] **Step 5: Extend freeTierHistory.test.mjs**

In `server/test/freeTierHistory.test.mjs`: the fetch mock serves `/rest/v1/players` and `/rest/v1/season_players` — make both honor the new eq filters (mirror the existing `game_id` filter helper's style):

```js
  function filterEq(rows, search, param) {
    const m = search.match(new RegExp(`(?:[?&])${param}=eq\\.(\\d+)`))
    return m ? rows.filter(r => r[param] === Number(m[1])) : rows
  }
```

Apply `filterEq(PLAYERS, search, 'id')` to the players response and `filterEq(SEASON_PLAYERS, search, 'player_id')` to the season_players response. Then append a scoped-context block:

```js
console.log('--- 4. Player-scoped getTeamContext ---')
{
  const scopedContext = await gatewayContext(chatConfigForOrg7, 7, { playerId: 702, playerName: 'Recent Star' })
  assert.ok(scopedContext.includes('SCOPED VIEW'), 'scoped context carries the scoped-view instruction')
  assert.ok(scopedContext.includes('Recent Star'), 'linked player is present')
  assert.ok(!scopedContext.includes('Old Timer ('), "teammate's player section is absent when scoped")
}
```

(Adapt the config variable to however the file already builds it — its gateway call passes a `ChatConfig`-shaped object; reuse it.)

- [ ] **Step 6: Run tests**

Run: `node node_modules/tsx/dist/cli.mjs gateway/queryScope.test.mjs` → PASS
Run: `node node_modules/tsx/dist/cli.mjs server/test/freeTierHistory.test.mjs` → PASS (append `gateway/queryScope.test.mjs` to `test:gateway:offline` in `package.json` too)
Run: `npm run test:gateway:offline` → all pass.

- [ ] **Step 7: Commit**

```bash
git add gateway/agent/context.ts gateway/chat.ts server/index.ts gateway/gameActions.ts gateway/queryScope.test.mjs server/test/freeTierHistory.test.mjs package.json
git commit -m "feat: player-scoped chat context and stat breakdown for linked members"
```

### Task 7: LangGraph agent module (graph + tools + runChatAgent + LangSmith)

**Files:**
- Create: `gateway/agent/tools.ts`
- Create: `gateway/agent/graph.ts`
- Create: `gateway/agent/agent.ts`
- Create: `gateway/agent/agent.test.mjs`
- Modify: `package.json` (append agent test to `test:gateway:offline`)

**Interfaces:**
- Consumes: `WRITE_FUNCTIONS` from `gateway/gameActions.js`; `hasAtLeast`/`TeamRole` from `gateway/membership.js`; Task 1's verified StateGraph API and process.env finding.
- Produces: `makeChatTools(deps: ChatToolDeps): DynamicStructuredTool[]`; `runToolAgent(opts): Promise<string>`; `runChatAgent({ apiKey, model, systemPrompt, history, message, tools, langSmith? }): Promise<string>` — Task 8 consumes all three.

- [ ] **Step 1: Write the failing agent test**

`gateway/agent/agent.test.mjs`:

```js
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
  // Endless tool calls hit the recursion limit and throw, never loop.
  const tools = makeChatTools({ dispatch: async () => ({}), role: 'captain' })
  await assert.rejects(
    () => runToolAgent({ ...base, model: new StubModel(Array(50).fill(0).map(() => toolCallMsg('query_stat_breakdown', { metric: 'goals' }))), tools }),
    /recursion/i
  )
}
console.log('✓ gateway/agent/agent.test.mjs all passed')
```

- [ ] **Step 2: Verify it fails**

Run: `node node_modules/tsx/dist/cli.mjs gateway/agent/agent.test.mjs`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement tools.ts**

`gateway/agent/tools.ts`:

```ts
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
      // description: copy VERBATIM from CHAT_FUNCTION_DECLARATIONS' create_game_event entry (gateway/gameActions.ts:128-143)
      description: 'Logs a scoring or game event.',
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
      description: 'Deletes the most recently logged event for a game (same as the app\'s "Undo last event" button).',
      schema: gameHint,
      func: run('undo_last_event'),
    }),
    new DynamicStructuredTool({
      name: 'add_to_lineup',
      description: 'Places a player in a lineup group for a game (creating the group if needed).',
      schema: gameHint.extend({
        playerName: z.string(),
        lineupGroupName: z.string().optional(),
        role: z.string().optional().describe('e.g. "Handler", "Deep Cutter".'),
      }),
      func: run('add_to_lineup'),
    }),
    new DynamicStructuredTool({
      name: 'remove_from_lineup',
      description: 'Removes a player from every lineup group in a game.',
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
      description: 'Computes an exact, code-verified stat breakdown scoped to one season or game.',
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
```

Note: the short descriptions above must be replaced with the FULL description strings from `CHAT_FUNCTION_DECLARATIONS` (gateway/gameActions.ts:128-205) — including `query_stat_breakdown`'s long STRICT OUTPUT RULE text — so model behavior does not regress. Copy each one verbatim into the matching tool.

- [ ] **Step 4: Implement graph.ts**

`gateway/agent/graph.ts`:

```ts
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
      const out = await tool.invoke(call.args ?? {})
      results.push(new ToolMessage({ tool_call_id: call.id ?? '', content: typeof out === 'string' ? out : JSON.stringify(out) }))
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
```

- [ ] **Step 5: Implement agent.ts**

`gateway/agent/agent.ts`:

```ts
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
  return runToolAgent(opts)
}
```

- [ ] **Step 6: Run tests**

Run: `node node_modules/tsx/dist/cli.mjs gateway/agent/agent.test.mjs` → PASS
Run: `npm run test:gateway:offline` (append the new test to the script) → all pass.

- [ ] **Step 7: Commit**

```bash
git add gateway/agent/tools.ts gateway/agent/graph.ts gateway/agent/agent.ts gateway/agent/agent.test.mjs package.json
git commit -m "feat: shared LangGraph chat agent with editor-tier write gate"
```

### Task 8: Rewire both shims to runChatAgent; LangSmith wiring; docs

**Files:**
- Modify: `gateway/chat.ts` (handleChatRequest body; delete `callGemini`, `isTransientGeminiError`, `sleep`; ChatConfig fields)
- Modify: `server/index.ts` (`POST /api/chat` loop body; delete inline loop + `GoogleGenAI` import + `CHAT_FUNCTION_DECLARATIONS`/`WRITE_FUNCTIONS`/`callChatFunction` old usage)
- Modify: `worker.ts` (chatConfig fields, lines ~103-111)
- Modify: `wrangler.jsonc` (`vars`: add `"LANGSMITH_PROJECT": "ufwt-chat"`)
- Modify: `CLAUDE.md` (env list — `LANGSMITH_API_KEY` optional, blank = tracing off)

**Interfaces:**
- Consumes: `runChatAgent`, `makeChatTools`, `getTeamContext(config, orgId, scope?)`, `ChatScope`, `lookup.playerLinkFor`, `callChatFunction(config, orgId, name, args, scope?)` (Tasks 3, 6, 7).
- Produces: final behavior — per-user scoped, role-tiered, LangGraph-driven chat in both runtimes; `LANGSMITH_API_KEY` optional everywhere.

- [ ] **Step 1: gateway/chat.ts — rewrite handleChatRequest**

Extend `ChatConfig` (after `posthogHost?`):

```ts
  // LangSmith tracing: absent/blank key = tracing fully off (Global
  // Constraint #5).
  langsmithApiKey?: string
  langsmithProject?: string
```

Change `requireTeamMember` to accept an OPTIONAL lookup as its last parameter (history/delete keep calling it without one; the chat handler passes its own so `playerLinkFor` shares the same 30s cache):

```ts
async function requireTeamMember(
  config: ChatConfig,
  request: Request,
  organizationId: number,
  required: TeamRole = 'member',
  lookup?: ReturnType<typeof createMembershipLookup>
): Promise<ChatCaller> {
  const resolved = lookup ?? createMembershipLookup({
    supabaseUrl: config.supabaseUrl,
    supabaseSecretKey: config.supabaseSecretKey,
    onLookupError: (err) => Sentry.captureException(err),
  })
```

(body otherwise unchanged — `resolved` replaces the internal `createMembershipLookup` call; `required` keeps its default so existing 3-arg call sites compile.)

New `handleChatRequest` body, from the `requireTeamMember` call down:

```ts
    const lookup = createMembershipLookup({
      supabaseUrl: config.supabaseUrl,
      supabaseSecretKey: config.supabaseSecretKey,
      onLookupError: (err) => Sentry.captureException(err),
    })
    const user = await requireTeamMember(config, request, Number(organization_id), 'member', lookup)
    if (!user.ok) return json({ error: user.error }, user.status)

    const teamId = Number(organization_id)

    // Player scope (spec: captain/editor = full team; member with an
    // approved link = their player only; member unlinked = full team).
    // playerLinkFor throws on outage so a broken lookup can never widen
    // the context (Task 3).
    let scope: ChatScope | undefined
    if (user.role === 'member') {
      const linkedId = await lookup.playerLinkFor(user.sub, teamId)
      if (linkedId != null) {
        const rows = await supabaseServiceFetch(config, `/players?select=display_name&id=eq.${linkedId}`)
        const name = Array.isArray(rows) && rows[0]?.display_name ? rows[0].display_name : null
        if (name) scope = { playerId: linkedId, playerName: name }
      }
    }

    const systemContext = await buildTeamContext(config, teamId, scope)
    // (buildTeamContext is the local alias for agent/context.ts's
    // getTeamContext, imported in Task 6; the re-export stays for
    // freeTierHistory.test.mjs.)
    const geminiApiKey = await getVaultSecret(config, 'gemini_api_key', config.geminiApiKey)
    const geminiModel = await getVaultSecret(config, 'gemini_model', config.geminiModel) ?? DEFAULT_GEMINI_MODEL
    if (!geminiApiKey) return json({ error: 'Gemini API key not configured' }, 500)
    const actionsConfig: ActionsConfig = { supabaseUrl: config.supabaseUrl, supabaseSecretKey: config.supabaseSecretKey }

    const posthog = new PostHog(config.posthogProjectToken!, { host: config.posthogHost, flushAt: 1, flushInterval: 0 })
    let reply: string
    try {
      const traceId = crypto.randomUUID()
      const tools = makeChatTools({
        dispatch: (name, args) => callChatFunction(actionsConfig, teamId, name, args, scope),
        role: user.role,
        onSpan: (name, args, result, latencyMs) => posthog.capture({
          distinctId: user.sub,
          event: '$ai_span',
          properties: {
            $ai_trace_id: traceId,
            $ai_session_id: session_id,
            $ai_span_id: crypto.randomUUID(),
            $ai_span_name: name,
            $ai_input_state: args,
            $ai_output_state: result.error ? { error: result.error } : result.output,
            $ai_latency: latencyMs / 1000,
          },
        }),
      })
      const agentStart = Date.now()
      reply = await runChatAgent({
        apiKey: geminiApiKey,
        model: geminiModel,
        systemPrompt: systemContext,
        history,
        message,
        tools,
        langSmith: config.langsmithApiKey ? { apiKey: config.langsmithApiKey, project: config.langsmithProject ?? 'ufwt-chat' } : undefined,
      })
      // Replaces the @posthog/ai wrapper's auto $ai_generation: one manual
      // event per request keeps PostHog's AI observability dashboards alive.
      posthog.capture({
        distinctId: user.sub,
        event: '$ai_generation',
        properties: {
          $ai_trace_id: traceId,
          $ai_session_id: session_id,
          $ai_model: geminiModel,
          $ai_latency: (Date.now() - agentStart) / 1000,
          $ai_output: reply,
          $ai_org_id: teamId,
        },
      })
    } finally {
      await posthog.shutdown()
    }

    await insertChatLogs(config, teamId, user.sub, [
      { session_id, role: 'user', content: message },
      { session_id, role: 'assistant', content: reply },
    ])

    return json({ reply })
```

Fix imports: add `runChatAgent` (`./agent/agent.js`), `makeChatTools` (`./agent/tools.js`), `callChatFunction` now comes with `ActionsConfig` from `./gameActions.js` (drop `CHAT_FUNCTION_DECLARATIONS`, `WRITE_FUNCTIONS` from that import; keep `type ActionsConfig`). Delete `callGemini`, `isTransientGeminiError`, `sleep`, the `@posthog/ai/gemini` and `@google/genai` imports, and the now-unused `hasAtLeast` import if nothing else references it. Keep `getTeamContext` re-export (freeTierHistory.test.mjs imports it) — the handler now calls the imported `getTeamContext` directly with `(config, teamId, scope)`.

- [ ] **Step 2: server/index.ts — same rewrite on Express**

Replace the loop inside `POST /api/chat` (from `const systemContext = await getTeamContext(teamId);` at ~line 575 through the `MAX_FUNCTION_ROUNDS` loop ending ~line 673) with the same shape as the Worker: player scope via the module-scope `membership.lookup.playerLinkFor(caller.sub, teamId)` (only when `caller.role === "member"`; `supabase.from("players").select("display_name").eq("id", linkedId).limit(1).single()` for the name — tolerate a null result by falling back to no scope), `getTeamContext(teamId, scope)` (the thin wrapper from Task 6), `makeChatTools({ dispatch: (name, args) => callChatFunction(actionsConfig, teamId, name, args, scope), role: caller.role, onSpan: ... })` using the existing `posthogAi` `$ai_span` shape, then:

```ts
    const aiTraceId = crypto.randomUUID();
    const agentStart = Date.now();
    const reply = await runChatAgent({
      apiKey: geminiApiKey,
      model: geminiModel,
      systemPrompt: systemContext,
      history,
      message,
      tools,
      langSmith: process.env.LANGSMITH_API_KEY
        ? { apiKey: process.env.LANGSMITH_API_KEY, project: process.env.LANGSMITH_PROJECT ?? "ufwt-chat" }
        : undefined,
    });
    posthogAi.capture({
      distinctId,
      event: "$ai_generation",
      properties: {
        $ai_trace_id: aiTraceId,
        $ai_session_id: session_id,
        $ai_model: geminiModel,
        $ai_latency: (Date.now() - agentStart) / 1000,
        $ai_output: reply,
        $ai_org_id: teamId,
      },
    });
```

Keep, in order and unchanged: `consumeAiMessage(teamId)` 429 gate, `quotaOrgId`/`quotaConsumed` refund logic, `posthogAi.flush()`, chat_logs insert (Task 4 already stamped `user_id`), `track(...)`. Delete: `GoogleGenAI` construction + `genaiConfig`/`contents` building + both retry/round loops + `isTransientGeminiError`/`sleep` + `import { GoogleGenAI } from "@posthog/ai/gemini"` (or wherever it's imported — follow the existing import) + `CHAT_FUNCTION_DECLARATIONS`/`WRITE_FUNCTIONS` from the gameActions import (keep `callChatFunction`, `type ActionsConfig`). The old comment about threading history through generateContent goes too — `history` now goes to `runChatAgent` as-is.

- [ ] **Step 3: worker.ts + wrangler.jsonc env plumbing**

`worker.ts` chatConfig (~line 103) — add after `posthogHost`:

```ts
          langsmithApiKey: env.LANGSMITH_API_KEY,
          langsmithProject: env.LANGSMITH_PROJECT,
```

`wrangler.jsonc` `vars` — add (NOT a secret: project name is public config; the API key stays out of vars):

```jsonc
    "LANGSMITH_PROJECT": "ufwt-chat",
```

- [ ] **Step 4: CLAUDE.md env note**

In the new-environment setup section, extend the `.env` line to include `LANGSMITH_API_KEY` and note: optional, blank = LangSmith tracing off, same blank-is-fine rule as `SENTRY_DSN`. Add one line to the same bullet: on the Worker the key is a wrangler secret (`wrangler secret put LANGSMITH_API_KEY`), `LANGSMITH_PROJECT` is a committed var.

- [ ] **Step 5: Full suites**

Run: `npm run test:gateway:offline` → all pass (freeTierHistory imports `server/index.ts` with mock env, so it doubles as the import-smoke for the Express side; `gateway/chat.ts` is exercised the same way).
Run: `cd frontend && npm run typecheck` → pass.

- [ ] **Step 6: Commit**

```bash
git add gateway/chat.ts server/index.ts worker.ts wrangler.jsonc CLAUDE.md
git commit -m "feat: chat runs on the shared LangGraph agent in both runtimes, with LangSmith tracing"
```

- [ ] **Step 7: Deploy note (documentation only — do NOT deploy)**

Append to the report file for the human: deploy order is DB migration first (`supabase db push`), then Worker + Express. `npx wrangler secret put LANGSMITH_API_KEY` before the Worker deploy, or tracing stays off (which is safe). Old chat_logs rows (user_id null) become invisible to clients — accepted in the spec; they age out within 30 days.




