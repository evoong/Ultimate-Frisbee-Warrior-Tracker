# Chat action recovery implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow team editors and captains to track, inspect, and safely reverse changes made by the AI team chat assistant using inline receipts, an Undo button, and natural-language rollback.

**Architecture:** Chat write tools execute domain mutations and record an immutable receipt in a new `chat_actions` table. Undo requests verify permissions, check for conflicting intervening edits under row locks, atomically invert changes, and mark the receipt undone. The chat tool wrapper passes structured receipts to Express and Cloudflare Worker endpoints; the UI displays action cards with Undo buttons and refreshes state on reload or chat-history clearing.

**Tech Stack:** TypeScript, PostgreSQL / Supabase PL/pgSQL, Express, Cloudflare Workers (`workerd`), LangChain / LangGraph, React, Tailwind CSS / shadcn tokens, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-29-chat-action-recovery-design.md`

## Global Constraints

- Never run a blind `supabase db push` against production.
- Production auto-deploys `main` on merge; database schema and functions must be safely deployable ahead of code.
- QA environment is disabled on this device; do not start local Supabase unless explicitly requested. Run offline and frontend suites for local verification.
- Chat writes remain gated to users with at least `editor` role; read-only members can use chat but cannot execute writes or undo them.
- All database mutations for chat recovery must execute via service role and be owner-scoped server-side based on verified JWT claims and verified organization membership.
- Session IDs must remain UUID-validated.
- Undo must fail with conflict if the current database state no longer matches the post-action snapshot.
- Chat receipts must survive clearing of conversation message history.
- Receipts and message logs must be correlated using a client-provided or server-minted `request_id` UUID per turn.

## Review Focus

1. **Intervening domain edit:** User asks chat to set a lineup, someone manually edits or deletes that lineup on the website, and the user clicks Undo. Expected: 409 Conflict with a clear message; no rows modified; action remains `applied`.
2. **Double Undo click / concurrent rollback:** Two parallel undo requests for the same receipt arrive simultaneously. Expected: exactly one execution of the inverse operation; second call returns already-undone without duplicating writes or re-archiving rows.
3. **Rollback of deleted game event:** Chat undid or deleted an event, and the user asks to undo that deletion. Expected: original event ID and attributes restored, preserving sequence numbers and relationships.
4. **Cleared chat history:** User clicks "Clear chat" in the UI and then wants to undo an action performed just before clearing. Expected: message history is deleted, but action receipt is still visible in recovery history and can be successfully undone.
5. **Cross-tenant / unauthorized access:** A member of Team A or an unprivileged `member` on Team B submits an Undo request for an action belonging to Team B. Expected: 403 Forbidden / 404 Not Found without leaking action metadata or row contents.

---

### Task 1: Database Migration for `chat_actions` and `chat_logs.request_id`

**Files:**
- Create: `supabase/migrations/20260929120000_chat_actions.sql`
- Create: `supabase/tests/26_chat_actions_schema.test.sql`

**Interfaces:**
- Consumes: `organizations.id`, `chat_logs.id`, `archive_deleted_row()`
- Produces: `chat_actions` table, `chat_logs.request_id` column, RLS policies

- [ ] **Step 1: Write database schema migration**

```sql
-- supabase/migrations/20260929120000_chat_actions.sql
-- 1. Add request_id to chat_logs to link messages to action receipts
alter table public.chat_logs add column if not exists request_id uuid;
create index if not exists idx_chat_logs_request_id on public.chat_logs(request_id) where request_id is not null;

-- 2. Create chat_actions table
create table if not exists public.chat_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id bigint not null references public.organizations(id) on delete cascade,
  session_id text not null,
  user_id text not null,
  request_id uuid,
  action_type text not null,
  description text not null,
  status text not null default 'applied',
  before_rows jsonb not null default '{}'::jsonb,
  after_rows jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  constraint chat_actions_status_check check (status in ('applied', 'undoing', 'undone')),
  constraint chat_actions_action_type_check check (action_type in (
    'create_game_event',
    'undo_last_event',
    'add_to_lineup',
    'remove_from_lineup',
    'create_lineup_group',
    'create_lineup',
    'save_lineup_template',
    'apply_lineup_template'
  ))
);

create index if not exists idx_chat_actions_session
  on public.chat_actions (organization_id, session_id, created_at desc);

create index if not exists idx_chat_actions_user
  on public.chat_actions (organization_id, user_id, created_at desc);

create index if not exists idx_chat_actions_request
  on public.chat_actions (request_id) where request_id is not null;

-- 3. RLS: Owner read-only. No client insert, update, or delete.
alter table public.chat_actions enable row level security;

create policy "owner read" on public.chat_actions
  for select to authenticated
  using (
    organization_id in (select my_member_team_ids())
    and user_id = (auth.uid())::text
  );

revoke insert, update, delete on public.chat_actions from authenticated;
grant select on public.chat_actions to authenticated;
grant all on public.chat_actions to service_role;

-- 4. Attach deleted_rows_archive trigger
drop trigger if exists archive_deleted_chat_actions on public.chat_actions;
create trigger archive_deleted_chat_actions
  before delete on public.chat_actions
  for each row execute function public.archive_deleted_row();
```

- [ ] **Step 2: Write pgTAP test file**

```sql
-- supabase/tests/26_chat_actions_schema.test.sql
begin;
select plan(7);

select has_table('public', 'chat_actions', 'chat_actions table exists');
select has_column('public', 'chat_logs', 'request_id', 'chat_logs has request_id column');
select col_type_is('public', 'chat_actions', 'id', 'uuid', 'id is uuid');
select col_type_is('public', 'chat_actions', 'before_rows', 'jsonb', 'before_rows is jsonb');
select col_type_is('public', 'chat_actions', 'after_rows', 'jsonb', 'after_rows is jsonb');

-- Verify RLS is enabled
select row_security_active('public.chat_actions');

-- Verify owner read policy exists
select policies_are(
  'public',
  'chat_actions',
  ARRAY['owner read']
);

select * from finish();
rollback;
```

- [ ] **Step 3: Verify migration syntax and file structure**

Run: `git status && test -f supabase/migrations/20260929120000_chat_actions.sql`
Expected: Migration and test files exist.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260929120000_chat_actions.sql supabase/tests/26_chat_actions_schema.test.sql
git commit -m "feat(db): add chat_actions table and chat_logs.request_id"
```

---

### Task 2: Action Recording and Inversion Utilities in Gateway

**Files:**
- Create: `gateway/chatRecovery.ts`
- Create: `gateway/chatRecovery.test.mjs`
- Modify: `gateway/gameActions.ts`

**Interfaces:**
- Consumes: `ActionsConfig`, `sbGet`, `sbWrite`, `sbUpsertIgnore`
- Produces: `recordChatAction`, `executeRollback`, `findLatestActionToRollback`

- [ ] **Step 1: Write failing unit test for rollback inverted operations**

```javascript
// gateway/chatRecovery.test.mjs
import assert from 'node:assert/strict'
import { computeInverseAction, executeRollbackPayload } from './chatRecovery.ts'

{
  // Test 1: create_game_event inversion deletes created event ID
  const action = {
    action_type: 'create_game_event',
    after_rows: { event: { id: 42, game_id: 10, event_type: 'Goal' } },
  }
  const ops = computeInverseAction(action)
  assert.deepEqual(ops, [
    { method: 'DELETE', path: '/game_events?id=eq.42' }
  ])
}

{
  // Test 2: undo_last_event inversion re-inserts deleted event
  const action = {
    action_type: 'undo_last_event',
    before_rows: { event: { id: 42, game_id: 10, event_type: 'Goal', player_id: 5 } },
  }
  const ops = computeInverseAction(action)
  assert.deepEqual(ops, [
    { method: 'POST', path: '/game_events', body: { id: 42, game_id: 10, event_type: 'Goal', player_id: 5 } }
  ])
}

{
  // Test 3: create_lineup inversion restores previous lineup rows and groups
  const action = {
    action_type: 'create_lineup',
    before_rows: {
      game_id: 10,
      groups: [{ lineup_name: 'Line 1', sort_order: 0 }],
      players: [{ player_id: 1, lineup_name: 'Line 1', role: 'Handler', sort_order: 0 }]
    },
    after_rows: {
      game_id: 10,
      created_groups: ['Line 2'],
      new_season_players: []
    }
  }
  const ops = computeInverseAction(action)
  assert.equal(ops.length >= 3, true)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/tsx/dist/cli.mjs gateway/chatRecovery.test.mjs`
Expected: FAIL with `Cannot find module './chatRecovery.ts'`

- [ ] **Step 3: Implement `gateway/chatRecovery.ts`**

Implement helper functions:
- `computeInverseAction(action)`
- `recordChatAction(config, orgId, sessionId, userId, requestId, type, description, beforeRows, afterRows)`
- `executeRollback(config, orgId, actionId, userId)`
- `findLatestActionToRollback(config, orgId, sessionId, userId)`

Atomic compare-and-swap pattern for rollback:
```typescript
// PATCH status = 'undoing' with status=eq.applied filter
// If 0 rows returned, throw 409 already undone or in-progress
// Verify current state matches after_rows; if mismatch, throw 409 Conflict
// Run inverse operations
// PATCH status = 'undone', undone_at = now()
// If error occurs, revert status = 'applied' and re-throw
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/tsx/dist/cli.mjs gateway/chatRecovery.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gateway/chatRecovery.ts gateway/chatRecovery.test.mjs
git commit -m "feat(gateway): implement chat action recording and rollback mechanics"
```

---

### Task 3: Wrap Write Tools and Register `rollback_last_action`

**Files:**
- Modify: `gateway/agent/tools.ts`
- Modify: `gateway/gameActions.ts`
- Modify: `gateway/agent/agent.test.mjs`

**Interfaces:**
- Consumes: `recordChatAction`, `findLatestActionToRollback`, `executeRollback`
- Produces: Action receipts collector in `makeChatTools`, `rollback_last_action` tool

- [ ] **Step 1: Write failing test in `gateway/agent/agent.test.mjs`**

Add tests for:
1. Write tool executions emitting an action receipt object `{ id, request_id, description, status: 'applied' }`.
2. `rollback_last_action` tool reversing the latest action and returning confirmation text.
3. Member role being blocked from `rollback_last_action`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/tsx/dist/cli.mjs gateway/agent/agent.test.mjs`
Expected: FAIL with missing tool or receipt assertions.

- [ ] **Step 3: Implement tool changes in `gateway/agent/tools.ts` and `gameActions.ts`**

1. Update `ChatToolDeps` to include `onActionReceipt?: (receipt: ChatActionReceipt) => void`, `requestId?: string`, `sessionId?: string`, `userId?: string`.
2. Wrap `WRITE_FUNCTIONS` in `gateway/gameActions.ts` to return action metadata `{ result, before_rows, after_rows, description }`.
3. Add `rollback_last_action` tool:
```typescript
new DynamicStructuredTool({
  name: 'rollback_last_action',
  description: 'Reverses the most recent write action performed by the chat assistant for this team session. Use when the user says "undo that", "revert what you just did", or "cancel that action".',
  schema: z.object({}),
  func: run('rollback_last_action'),
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/tsx/dist/cli.mjs gateway/agent/agent.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gateway/agent/tools.ts gateway/gameActions.ts gateway/agent/agent.test.mjs
git commit -m "feat(agent): register rollback_last_action and capture action receipts"
```

---

### Task 4: API Endpoints for Undo and Extended History

**Files:**
- Modify: `gateway/chat.ts`
- Modify: `server/index.ts`
- Modify: `worker.ts`
- Create: `gateway/chatApi.test.mjs`

**Interfaces:**
- Consumes: `executeRollback`, `handleChatRequest`, `handleChatHistoryRequest`
- Produces: `POST /api/chat/undo`, `{ messages, actions }` from `/api/chat/history`, `{ reply, actions }` from `POST /api/chat`

- [ ] **Step 1: Write failing test for Worker & Express chat endpoints**

Test:
- `POST /api/chat` returns `{ reply, actions: [...] }`
- `POST /api/chat/undo` validates team membership + editor role, calls rollback, returns `{ ok: true, action: { id, status: 'undone' } }`
- `GET /api/chat/history` returns `{ messages: [...], actions: [...] }`
- `DELETE /api/chat/history` leaves `chat_actions` intact while clearing `chat_logs`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/tsx/dist/cli.mjs gateway/chatApi.test.mjs`
Expected: FAIL

- [ ] **Step 3: Update `gateway/chat.ts` and `server/index.ts`**

1. In `handleChatRequest`: mint or accept `request_id = crypto.randomUUID()`. Collect action receipts during tool execution. Return `{ reply, actions }`.
2. Add `handleChatUndoRequest`:
   - Route: `POST /api/chat/undo`
   - Scopes to verified user and organization with role >= `editor`.
   - Calls `executeRollback`.
3. In `handleChatHistoryRequest`: fetch messages from `chat_logs` AND actions from `chat_actions` for the user's session. Return `{ messages, actions }`.
4. In `worker.ts`: route `/api/chat/undo` to `handleChatUndoRequest`.
5. In `server/index.ts`: mount `app.post("/api/chat/undo", ...)` with exact same logic and auth checks.

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/tsx/dist/cli.mjs gateway/chatApi.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gateway/chat.ts server/index.ts worker.ts gateway/chatApi.test.mjs
git commit -m "feat(api): mount chat undo endpoint and return action receipts"
```

---

### Task 5: Frontend Action Receipts and Undo UI

**Files:**
- Modify: `frontend/pages/Chat.tsx`
- Create: `frontend/components/chat/ActionReceiptCard.tsx`
- Create: `frontend/components/chat/ActionReceiptCard.test.tsx`
- Modify: `frontend/pages/Chat.test.tsx` (or new test file)

**Interfaces:**
- Consumes: `/api/chat`, `/api/chat/undo`, `/api/chat/history`
- Produces: Action receipt chips under assistant messages, standalone recovery panel when history is cleared

- [ ] **Step 1: Write failing component test for `ActionReceiptCard`**

```tsx
// frontend/components/chat/ActionReceiptCard.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ActionReceiptCard from './ActionReceiptCard'

describe('ActionReceiptCard', () => {
  it('renders description and Undo button when applied', () => {
    const onUndo = vi.fn()
    render(<ActionReceiptCard action={{ id: '1', description: 'Created Goal', status: 'applied' }} canUndo onUndo={onUndo} />)
    expect(screen.getByText('Created Goal')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument()
  })

  it('renders Undone label without button when status is undone', () => {
    render(<ActionReceiptCard action={{ id: '1', description: 'Created Goal', status: 'undone' }} canUndo onUndo={() => {}} />)
    expect(screen.getByText(/undone/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /undo/i })).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test ActionReceiptCard`
Expected: FAIL

- [ ] **Step 3: Implement `ActionReceiptCard.tsx` and integrate into `Chat.tsx`**

1. Create `frontend/components/chat/ActionReceiptCard.tsx`:
   - Design: neutral hairline border, muted background, Phosphor icons (`ArrowCounterClockwise`, `CheckCircle`), spinner during pending undo.
2. In `Chat.tsx`:
   - Update message and action state types.
   - Support both legacy history array format `[{role, content}]` and `{ messages, actions }` defensively.
   - Render `ActionReceiptCard` list below assistant message bubbles.
   - If messages are cleared but `actions` exist for the session, render a collapsible "Recent session actions" banner at top of chat so users can still undo previous writes.
   - Wire `handleUndo(actionId)` -> `POST /api/chat/undo` -> update action status to `undone`.

- [ ] **Step 4: Run frontend tests**

Run: `npm run test:frontend`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/pages/Chat.tsx frontend/components/chat/ActionReceiptCard.tsx frontend/components/chat/ActionReceiptCard.test.tsx
git commit -m "feat(ui): render chat action receipts with undo button"
```

---

### Task 6: Full Verification and Offline Test Suite Execution

**Files:**
- Modify: `package.json` (add new test script if needed)

- [ ] **Step 1: Run offline gateway tests**

Run: `npm run test:gateway:offline`
Expected: All tests pass.

- [ ] **Step 2: Run frontend typecheck and tests**

Run: `npm run typecheck:frontend && npm run test:frontend`
Expected: Clean typecheck and passing tests.

- [ ] **Step 3: Verification of git status and diff**

Run: `git status --short`
Expected: Only intended files modified and staged.

- [ ] **Step 4: Commit and finalize**

```bash
git add package.json
git commit -m "chore: wire chat recovery tests into test suites"
```
