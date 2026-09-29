# Chat Interactive Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Chat page quick-action chips and review-and-confirm action cards for every chat write tool (events, undo, lineups, lineup templates), backed by a single-use, expiry-bound proposal store and a dedicated confirm endpoint on both runtimes.

**Architecture:** Write tool calls stop executing at the tool layer and instead store a validated proposal row (`chat_action_proposals`) and return a `{ proposed: true, ... }` marker to the model; the reply carries the proposal to the frontend, which renders an ActionCard. Confirm posts to `POST /api/chat/confirm`, which re-checks membership/role, claims the row with an atomic DELETE, and executes the original `callChatFunction` dispatch. Chips are pure prompt shortcuts gated on team role.

**Tech Stack:** PostgREST-over-fetch (`gateway/supabaseRest.ts`), zod (already a dep), LangChain/LangGraph (existing agent), pgTAP, React + vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-29-chat-interactive-features-design.md`

## Global Constraints

- **Never run `npm test`** — it reads production. Also never run `npm run test:gateway` (needs a live local stack).
- Offline suites: `npm run test:gateway:offline` (root). New offline test files must be appended to the `test:gateway:offline` script in `package.json` in the same task that adds them.
- DB work: QA stack is DISABLED on this device. `npm run qa:reset` + `npm run db:test` are allowed ONLY when a task's steps explicitly say to run them. Never run `npx supabase start` otherwise.
- Service role bypasses RLS — application code is the security boundary. Every confirm must fail closed on auth, ownership, expiry, and role. A revoked role takes effect within the 30s lookup TTL.
- Both runtimes (Express + Cloudflare Worker) share `gateway/chatProposals.ts`; do not fork logic per host.
- Worker limits: no TCP/node:pg in the request path; `crypto.randomUUID()` is available on both runtimes.
- `chat_logs` schema precedent: `session_id text`, `user_id text`, `organization_id bigint`, no FK. Mirror it in the new table.
- Chip/card visibility keys off the user's **team `role`** from `useAuth()`, never `can.record` (members have `can.record: true` but cannot write via chat).
- Frontend Chat page is global design scope: shadcn primitives from `frontend/lib/shadcn/`, lucide icons, no schedule/stats tokens.
- Proposals are never written into `chat_logs`; `GET /api/chat/history` response stays unchanged.
- Commits: conventional one-liners, commit after each task's tests pass.
- The pending `frontend/pages/Login.tsx` / `gateway/auth-handlers.ts` edits in the worktree belong to the account-deletion feature — do not stage, revert, or touch them.
- **Production rollout (from the spec):** `chat_action_proposals` must exist in prod BEFORE this branch merges (main auto-deploys). Apply the migration to prod via direct psql in a single transaction per the repo's migration gotcha — do not `supabase db push`. The human runs this; remind them at merge time.

## Review Focus

Five failure modes the spec implies; each pinned to its owning task's tests:

1. **A double-clicked or retried confirm** must not double-write — Task 5's race test (GET ok, DELETE claim returns `[]` → `ConfirmError` 409, dispatch never called).
2. **Another user's or team's proposal_id** must never confirm — Task 5's ownership test (filters on id+session+org+user return nothing → 404).
3. **An expired proposal** must be rejected AND consumed — Task 5's expiry test (created_at older than 15 min → 410, row deleted).
4. **A member (or freshly-demoted editor) confirming a write** gets 403 and the row is NOT consumed — Task 5's role test (zero DELETE calls before the role check passes).
5. **A team switch with a card pending** must discard the card client-side — Task 7's `currentTeamId` effect (the server would reject the confirm anyway on the org mismatch).

---

### Task 1: `chat_action_proposals` table + meta allowlist

**Files:**
- Create: `supabase/migrations/20260929120000_chat_action_proposals.sql`
- Modify: `supabase/tests/00_meta.test.sql:53-63` (allowlist)
- Create: `supabase/tests/25_chat_action_proposals.test.sql` (pgTAP — QA-stack-gated)

**Interfaces:**
- Produces: table `public.chat_action_proposals` with columns `id uuid pk`, `session_id text not null`, `organization_id bigint not null`, `user_id text not null`, `tool_name text not null`, `args jsonb not null default '{}'::jsonb`, `created_at timestamptz not null default now()`. RLS enabled with zero policies, no `anon`/`authenticated` grants. Task 2's REST helpers depend on exactly these column names.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260929120000_chat_action_proposals.sql`:

```sql
-- Pending chat action proposals (spec: 2026-09-29-chat-interactive-features).
-- When the chat agent's write tools fire, they store a validated proposal
-- here instead of writing; POST /api/chat/confirm claims a row (atomic
-- DELETE with return=representation) and executes it. Service-role only:
-- every read and write goes through the Express/Worker handlers holding the
-- service key, so RLS is enabled with zero policies and no client grants,
-- exactly the platform_admins precedent (see 00_meta.test.sql's allowlist).
--
-- Mirrors chat_logs' column style (session_id text, user_id text,
-- organization_id bigint, no FKs) per the baseline's dump-restoration form.

create table public.chat_action_proposals (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  organization_id bigint not null,
  user_id text not null,
  tool_name text not null,
  args jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.chat_action_proposals enable row level security;

revoke all on public.chat_action_proposals from anon, authenticated;
```

- [ ] **Step 2: Extend the 00_meta allowlist**

In `supabase/tests/00_meta.test.sql`, add a comment block after the `feature_flags` comment (after line 53):

```sql
-- chat_action_proposals (20260929120000_chat_action_proposals.sql) is
-- zero-policy for the same reason: the confirm endpoint reaches it only
-- under the service-role key; no client role is ever meant to see a row.
```

Edit the `not in (...)` list (lines 60-63) so it ends:

```sql
         and c.relname not in ('standings', 'feedback_clusters', 'feedback_reports',
                               'platform_admins', 'admin_audit_log', 'deleted_rows_archive',
                               'processed_stripe_events', 'feature_flags', 'org_feature_flags',
                               'deleted_accounts', 'chat_action_proposals')
```

- [ ] **Step 3: Write the pgTAP test**

Create `supabase/tests/25_chat_action_proposals.test.sql` following the header style of `supabase/tests/18_platform_admins.test.sql` (read its first 10 lines first; copy the `BEGIN; SELECT plan(n);` / `SELECT * FROM finish(); ROLLBACK;` form):

```sql
BEGIN;
-- chat_action_proposals: RLS enabled, zero policies, service-role only.
-- QA-stack-gated: runs under npm run db:test after npm run qa:reset.
SELECT plan(3);

SELECT has_table('public', 'chat_action_proposals', 'table exists');

SELECT ok(
  EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'chat_action_proposals' AND c.relrowsecurity),
  'RLS is enabled');

SELECT is_empty(
  $$ SELECT p.polname FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'chat_action_proposals' $$,
  'zero policies: service-role only');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 4: Syntax check without the QA stack**

Check psql exists: `psql --version`. If available, syntax-check in a throwaway database:

```bash
psql postgres -c 'create database ufwt_proposal_check;'
psql -v ON_ERROR_STOP=1 -d ufwt_proposal_check -f supabase/migrations/20260929120000_chat_action_proposals.sql
psql postgres -c 'drop database ufwt_proposal_check;'
```

If psql is unavailable, skip this step — do NOT start the QA stack; the pgTAP file runs under the Task 8 QA gate.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260929120000_chat_action_proposals.sql supabase/tests/00_meta.test.sql supabase/tests/25_chat_action_proposals.test.sql
git commit -m "feat(db): add chat_action_proposals table"
```

---

### Task 2: Proposal store (`gateway/chatProposals.ts`)

**Files:**
- Create: `gateway/chatProposals.ts`
- Create: `gateway/chatProposals.test.mjs`
- Modify: `package.json` (`test:gateway:offline` script — append `&& node node_modules/tsx/dist/cli.mjs gateway/chatProposals.test.mjs` after the `lineupActions.test.mjs` entry)

**Interfaces:**
- Consumes: `type ActionsConfig` and `sbGet`/`sbWrite` from `gateway/supabaseRest.ts`.
- Produces (Tasks 3, 4, 5 depend on these exact names):
  - `export interface ProposalRow { id: string; session_id: string; organization_id: number; user_id: string; tool_name: string; args: Record<string, unknown>; created_at: string }`
  - `export type ProposalFilter = Pick<ProposalRow, 'id' | 'session_id' | 'organization_id' | 'user_id'>`
  - `export const PROPOSAL_TTL_MS = 15 * 60 * 1000`
  - `export class ConfirmError extends Error { constructor(public status: number, message: string) }`
  - `createProposal(config: ActionsConfig, row: Omit<ProposalRow, 'id' | 'created_at'>): Promise<ProposalRow>` — mints the uuid app-side (Worker-safe), POSTs with `Prefer: return=representation` (which `sbWrite` already sends).
  - `getProposal(config, filter: ProposalFilter): Promise<ProposalRow | null>` — SELECT with all four ownership filters.
  - `takeProposal(config, filter: ProposalFilter): Promise<ProposalRow | null>` — atomic DELETE claim; the winner gets the row, everyone else gets `null`.
  - `deleteProposal(config, filter: ProposalFilter): Promise<void>`
  - `isExpired(row: ProposalRow, now?: number): boolean`

- [ ] **Step 1: Write the failing test**

Create `gateway/chatProposals.test.mjs`:

```js
import assert from 'node:assert/strict'
import {
  createProposal, getProposal, takeProposal, deleteProposal, isExpired, PROPOSAL_TTL_MS,
} from './chatProposals.ts'

const config = { supabaseUrl: 'https://example.test', supabaseSecretKey: 'service-role-key' }

// In-memory table; every REST call is recorded so ownership filters and
// single-use claims are asserted on the real request strings.
const rows = []
const calls = []
const origFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url))
  const method = init.method || 'GET'
  calls.push({ method, path: u.pathname, search: u.search })
  if (u.pathname !== '/rest/v1/chat_action_proposals') {
    throw new Error(`unexpected fetch ${method} ${u.pathname}`)
  }
  const f = k => u.searchParams.get(k)?.replace('eq.', '')
  const match = r => r.id === f('id') && r.session_id === f('session_id')
    && String(r.organization_id) === f('organization_id') && r.user_id === f('user_id')
  if (method === 'GET') return Response.json(rows.filter(match))
  if (method === 'POST') {
    const body = JSON.parse(init.body)
    rows.push(body)
    return Response.json([body])
  }
  if (method === 'DELETE') {
    const hit = rows.filter(match)
    for (const r of hit) rows.splice(rows.indexOf(r), 1)
    return Response.json(hit)
  }
  throw new Error(`unhandled ${method}`)
}

try {
  const base = {
    session_id: '11111111-1111-4111-8111-111111111111',
    organization_id: 7, user_id: 'user-1',
    tool_name: 'create_game_event', args: { eventType: 'Goal' },
  }

  // create → row with id + created_at
  const created = await createProposal(config, base)
  assert.ok(created.id, 'created row has an id')
  assert.equal(typeof created.created_at, 'string', 'created_at is a JSON string')

  // get with the right filter → row
  const filter = { id: created.id, session_id: base.session_id, organization_id: base.organization_id, user_id: base.user_id }
  assert.equal((await getProposal(config, filter))?.id, created.id)

  // get with the wrong user → null, and the filter went out in the query
  assert.equal(await getProposal(config, { ...filter, user_id: 'user-2' }), null, 'another user sees nothing')
  assert.ok(calls.some(c => c.search.includes('user_id=eq.user-2')), 'ownership enforced in the query string')

  // take → claims and deletes; a second take loses
  const claimed = await takeProposal(config, filter)
  assert.equal(claimed?.id, created.id)
  assert.equal(await takeProposal(config, filter), null, 'second claim loses the race')

  // expiry math
  const old = { ...base, id: 'x', created_at: new Date(Date.now() - PROPOSAL_TTL_MS - 1000).toISOString() }
  assert.equal(isExpired(old), true)
  assert.equal(isExpired({ ...old, created_at: new Date().toISOString() }), false)

  // deleteProposal removes silently
  const p2 = await createProposal(config, { ...base, tool_name: 'undo_last_event' })
  const filter2 = { id: p2.id, session_id: base.session_id, organization_id: base.organization_id, user_id: base.user_id }
  await deleteProposal(config, filter2)
  assert.equal(await getProposal(config, filter2), null)

  console.log('✓ gateway/chatProposals.test.mjs all passed')
} finally {
  globalThis.fetch = origFetch
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/tsx/dist/cli.mjs gateway/chatProposals.test.mjs`
Expected: FAIL — `Cannot find module './chatProposals.ts'`.

- [ ] **Step 3: Implement `gateway/chatProposals.ts`**

```ts
// Proposal store for chat action cards (spec:
// 2026-09-29-chat-interactive-features). The agent's write tools never
// execute: they store a proposal here and return a marker; POST
// /api/chat/confirm claims the row with an atomic DELETE (return=representation
// makes the DELETE the single-use primitive — the loser of a double-click gets
// an empty array) and executes. Service-role only, Workers-portable raw
// fetch, mirroring gameActions.ts/supabaseRest.ts conventions.
import type { ActionsConfig } from './gameActions.js'
import { sbGet, sbWrite } from './supabaseRest.js'

export interface ProposalRow {
  id: string
  session_id: string
  organization_id: number
  user_id: string
  tool_name: string
  args: Record<string, unknown>
  created_at: string
}

export type ProposalFilter = Pick<ProposalRow, 'id' | 'session_id' | 'organization_id' | 'user_id'>

export const PROPOSAL_TTL_MS = 15 * 60 * 1000

// HTTP-mappable error for the confirm endpoint: status is the response code.
export class ConfirmError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

function filterPath(f: ProposalFilter): string {
  return `/chat_action_proposals?id=eq.${f.id}&session_id=eq.${encodeURIComponent(f.session_id)}&organization_id=eq.${f.organization_id}&user_id=eq.${encodeURIComponent(f.user_id)}&select=*`
}

export async function createProposal(config: ActionsConfig, row: Omit<ProposalRow, 'id' | 'created_at'>): Promise<ProposalRow> {
  // uuid minted app-side: crypto.randomUUID exists on both runtimes and
  // keeps the store one round trip.
  const created = await sbWrite(config, 'POST', '/chat_action_proposals', { ...row, id: crypto.randomUUID() })
  return created[0] as ProposalRow
}

export async function getProposal(config: ActionsConfig, f: ProposalFilter): Promise<ProposalRow | null> {
  const rows = await sbGet(config, filterPath(f))
  return (rows ?? [])[0] ?? null
}

// The atomic claim: PostgREST DELETE returns the deleted rows, so exactly
// one caller ever sees a row back. sbWrite sends Prefer: return=representation.
export async function takeProposal(config: ActionsConfig, f: ProposalFilter): Promise<ProposalRow | null> {
  const rows = await sbWrite(config, 'DELETE', filterPath(f))
  return (rows ?? [])[0] ?? null
}

export async function deleteProposal(config: ActionsConfig, f: ProposalFilter): Promise<void> {
  await sbWrite(config, 'DELETE', filterPath(f))
}

export function isExpired(row: ProposalRow, now = Date.now()): boolean {
  return now - new Date(row.created_at).getTime() > PROPOSAL_TTL_MS
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/tsx/dist/cli.mjs gateway/chatProposals.test.mjs`
Expected: `✓ gateway/chatProposals.test.mjs all passed`

- [ ] **Step 5: Append to the offline suite and run it**

In `package.json`, `test:gateway:offline`, insert after the `lineupActions.test.mjs` entry:
`&& node node_modules/tsx/dist/cli.mjs gateway/chatProposals.test.mjs`

Run: `npm run test:gateway:offline`
Expected: all pass, including the new file.

- [ ] **Step 6: Commit**

```bash
git add gateway/chatProposals.ts gateway/chatProposals.test.mjs package.json
git commit -m "feat(chat): add proposal store"
```

---

### Task 3: Validated proposals with server-built summaries (`buildProposal`)

**Files:**
- Modify: `gateway/chatProposals.ts` (append `buildProposal` + `summarizeProposal`)
- Modify: `gateway/chatProposals.test.mjs` (append summary/validation tests)

**Interfaces:**
- Consumes: `resolveGame`, `resolvePlayer`, `resolveSeason` from `gateway/gameActions.ts` (all read-only); `WRITE_FUNCTIONS` from same.
- Produces: `buildProposal(config: ActionsConfig, ctx: { organization_id: number; session_id: string; user_id: string }, tool_name: string, args: Record<string, unknown>): Promise<{ id: string; tool_name: string; args: Record<string, unknown>; summary: string }>` — resolves/validates every name (throwing the same errors the real handler would), stores the row, and returns the payload the reply and card carry. Task 4's `propose` dep and Task 5's `confirmProposal` use it.

- [ ] **Step 1: Write the failing tests (append to `gateway/chatProposals.test.mjs`, inside a second `try` after the first block — extend the fetch mock to serve the gameActions reads)**

Append a new section. The fetch mock above only served `chat_action_proposals`; replace it for this section with a fuller mock. Insert this block before the closing `finally`:

```js
// ---- buildProposal: validation reads + summary + store (Task 3) ----
// Games/players/seasons fixtures mirroring the resolve helpers' REST shape.
const GAMES = [{ id: 201, season_id: 10, opponent: 'Rival A', game_date: '2026-09-29', game_time: '18:00' }]
const PLAYERS = [{ id: 101, display_name: 'Alice' }, { id: 102, display_name: 'Bob' }]
rows.length = 0 // clear proposal rows from the store block
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url))
  const path = u.pathname
  if (path === '/rest/v1/chat_action_proposals') {
    // reuse the store mock shape
    const method = init.method || 'GET'
    const f = k => u.searchParams.get(k)?.replace('eq.', '')
    const match = r => r.id === f('id') && r.session_id === f('session_id')
      && String(r.organization_id) === f('organization_id') && r.user_id === f('user_id')
    if (method === 'POST') { const b = JSON.parse(init.body); rows.push(b); return Response.json([b]) }
    return Response.json([])
  }
  if (path === '/rest/v1/games') return Response.json(GAMES)
  if (path === '/rest/v1/players') return Response.json(PLAYERS)
  throw new Error(`unexpected fetch ${init.method || 'GET'} ${path}`)
}

const cfg = { supabaseUrl: 'https://example.test', supabaseSecretKey: 'service-role-key' }
const ctx = { organization_id: 1, session_id: '11111111-1111-4111-8111-111111111111', user_id: 'user-1' }

// happy path: names resolved into the summary, row stored
const p = await buildProposal(cfg, ctx, 'add_to_lineup', { playerName: 'Alice', lineupGroupName: 'Line 1' })
assert.equal(p.tool_name, 'add_to_lineup')
assert.ok(p.id, 'proposal id present')
assert.ok(p.summary.includes('Alice') && p.summary.includes('Rival A'), `summary carries resolved names: "${p.summary}"`)
assert.equal(rows.length, 1, 'row stored')

// unknown player → throws, stores nothing
rows.length = 0
await assert.rejects(() => buildProposal(cfg, ctx, 'add_to_lineup', { playerName: 'Nobody' }), /No player found/)
assert.equal(rows.length, 0, 'nothing stored on validation failure')

// create_lineup resolves every player and summarizes groups
rows.length = 0
const lu = await buildProposal(cfg, ctx, 'create_lineup', {
  groups: [{ name: 'O-Line', players: [{ playerName: 'Alice' }, { playerName: 'Bob', role: 'Cutter' }] }],
})
assert.ok(lu.summary.includes('O-Line') && lu.summary.includes('Bob'), 'lineup summary lists group and players')
assert.equal(rows.length, 1)

// read-only tools are never proposable
await assert.rejects(() => buildProposal(cfg, ctx, 'view_lineup', {}), /Unknown write tool/)

console.log('✓ buildProposal checks passed')
```

Also add `buildProposal` to the import list at the top of the file:

```js
import {
  createProposal, getProposal, takeProposal, deleteProposal, isExpired, PROPOSAL_TTL_MS, buildProposal,
} from './chatProposals.ts'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/tsx/dist/cli.mjs gateway/chatProposals.test.mjs`
Expected: FAIL — `buildProposal` is not exported.

- [ ] **Step 3: Implement `buildProposal` + `summarizeProposal` (append to `gateway/chatProposals.ts`)**

```ts
import { resolveGame, resolvePlayer, WRITE_FUNCTIONS, type GameRow } from './gameActions.js'
import { sbGet } from './supabaseRest.js'

// Validates a write tool's args with the SAME resolution the real handler
// will use (reads only — no data is written at proposal time), so the card
// can show real dates/names and invalid input fails before anything is
// stored. Summaries are server-built from resolved names, never model text.
async function summarizeProposal(
  config: ActionsConfig, orgId: number, tool: string, args: Record<string, unknown>
): Promise<string> {
  const hint = { gameDate: args.gameDate as string | undefined, opponent: args.opponent as string | undefined }
  const gameLabel = (g: GameRow) => `the ${g.game_date} game vs ${g.opponent}`
  const str = (k: string) => (typeof args[k] === 'string' ? args[k] as string : undefined)

  switch (tool) {
    case 'create_game_event': {
      const game = await resolveGame(config, orgId, hint)
      const player = str('playerName') ? await resolvePlayer(config, orgId, str('playerName')!) : null
      const assister = str('assisterName') ? await resolvePlayer(config, orgId, str('assisterName')!) : null
      return `Log ${str('eventType')}${player ? ` for ${player.display_name}` : ''}${assister ? ` (assist: ${assister.display_name})` : ''} in ${gameLabel(game)}`
    }
    case 'undo_last_event': {
      const game = await resolveGame(config, orgId, hint)
      return `Undo the most recent event in ${gameLabel(game)}`
    }
    case 'add_to_lineup': {
      const game = await resolveGame(config, orgId, hint)
      const player = await resolvePlayer(config, orgId, str('playerName')!)
      return `Place ${player.display_name} in ${str('lineupGroupName') ?? 'the first lineup group'} for ${gameLabel(game)}`
    }
    case 'remove_from_lineup': {
      const game = await resolveGame(config, orgId, hint)
      const player = await resolvePlayer(config, orgId, str('playerName')!)
      return `Remove ${player.display_name} from the lineup of ${gameLabel(game)}`
    }
    case 'create_lineup_group': {
      const game = await resolveGame(config, orgId, hint)
      return `Add lineup group "${str('name')}" to ${gameLabel(game)}`
    }
    case 'create_lineup': {
      const game = await resolveGame(config, orgId, hint)
      const groups = args.groups as { name: string; players?: { playerName: string; role?: string }[] }[]
      if (!Array.isArray(groups) || groups.length === 0) throw new Error('create_lineup requires at least one lineup group.')
      const parts: string[] = []
      for (const g of groups) {
        const names: string[] = []
        for (const p of g.players ?? []) {
          const resolved = await resolvePlayer(config, orgId, p.playerName)
          names.push(resolved.display_name)
        }
        parts.push(`${g.name} (${names.join(', ')})`)
      }
      return `Set the lineup for ${gameLabel(game)}: ${parts.join('; ')}`
    }
    case 'save_lineup_template': {
      const game = await resolveGame(config, orgId, hint)
      return `Save ${gameLabel(game)}'s lineup as template "${str('name')}"`
    }
    case 'apply_lineup_template': {
      const game = await resolveGame(config, orgId, hint)
      const name = str('templateName')!
      // Same loose match the frontend/agent uses; fails loudly when absent.
      const templates: { id: number; name: string }[] = game.season_id
        ? await sbGet(config, `/lineup_templates?organization_id=eq.${orgId}&season_id=eq.${game.season_id}&select=id,name`)
        : await sbGet(config, `/lineup_templates?organization_id=eq.${orgId}&select=id,name`)
      const q = name.trim().toLowerCase()
      let matches = templates.filter(t => t.name.toLowerCase() === q)
      if (matches.length === 0) matches = templates.filter(t => t.name.toLowerCase().includes(q))
      if (matches.length === 0) throw new Error(`No lineup template found matching "${name}".`)
      if (matches.length > 1) throw new Error(`Multiple lineup templates match "${name}": ${matches.map(m => m.name).join(', ')}. Be more specific.`)
      return `Load lineup template "${matches[0]!.name}" into ${gameLabel(game)}`
    }
    default:
      throw new Error(`Unknown write tool: ${tool}`)
  }
}

export async function buildProposal(
  config: ActionsConfig,
  ctx: { organization_id: number; session_id: string; user_id: string },
  tool_name: string,
  args: Record<string, unknown>,
): Promise<{ id: string; tool_name: string; args: Record<string, unknown>; summary: string }> {
  if (!WRITE_FUNCTIONS.has(tool_name)) throw new Error(`Unknown write tool: ${tool_name}`)
  const summary = await summarizeProposal(config, ctx.organization_id, tool_name, args)
  const row = await createProposal(config, { ...ctx, tool_name, args })
  return { id: row.id, tool_name, args, summary }
}
```

Note: the `resolveGame`/`resolvePlayer`/`WRITE_FUNCTIONS` names merge into the file's existing `gameActions.js` import; `sbGet` merges into the existing `supabaseRest.js` import.

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/tsx/dist/cli.mjs gateway/chatProposals.test.mjs`
Expected: `✓ gateway/chatProposals.test.mjs all passed` and `✓ buildProposal checks passed`

- [ ] **Step 5: Run the offline suite**

Run: `npm run test:gateway:offline`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add gateway/chatProposals.ts gateway/chatProposals.test.mjs
git commit -m "feat(chat): build validated proposals with summaries"
```

---

### Task 4: Agent write tools propose instead of dispatch

**Files:**
- Modify: `gateway/agent/tools.ts` (`ChatToolDeps` + `run` wrapper, lines 10-33)
- Modify: `gateway/agent/context.ts` (prompt paragraphs, lines 277-279)
- Modify: `gateway/agent/agent.test.mjs`

**Interfaces:**
- Consumes: `buildProposal` from `gateway/chatProposals.ts` (host side — not in this task).
- Produces: extended `ChatToolDeps`:
  - `propose?: (name: string, args: Record<string, unknown>) => Promise<{ proposal_id: string; summary: string }>`
  - `onProposal?: (p: { id: string; tool_name: string; args: Record<string, unknown>; summary: string }) => void`
  - Write tools now return `{ proposed: true, proposal_id: string, summary: string }` instead of the handler result. `onProposal` fires once per proposal; hosts keep the latest (last wins — one card at a time).

- [ ] **Step 1: Update the failing tests in `gateway/agent/agent.test.mjs`**

Replace the "Editor + write tool -> dispatched" block (lines 30-40) with:

```js
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
```

Also update the existing member-write block (lines 18-29) to also assert `propose` was not called:

```js
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
```

Add one new block asserting the tool RESULT carries the marker (append before the final console.log):

```js
{
  // The proposal marker reaches the model as the tool result.
  const tools = makeChatTools({
    dispatch: async () => ({}),
    role: 'captain',
    propose: async () => ({ proposal_id: 'p9', summary: 'Place Alice in Line 1' }),
  })
  const seen = []
  const model = new (class extends StubModel {
    async invoke(msgs) { if (msgs.at(-1).getType?.() === 'tool') seen.push(msgs.at(-1).content); return super.invoke(msgs) }
  })([toolCallMsg('add_to_lineup', { playerName: 'Alice' }), new AIMessage('done')])
  await runToolAgent({ ...base, model, tools })
  const parsed = JSON.parse(seen[0])
  assert.equal(parsed.proposed, true)
  assert.equal(parsed.proposal_id, 'p9')
  assert.ok(parsed.summary.includes('Alice'))
}
```

(The `StubModel` subclass above must be declared after `StubModel` at the top of the file; if the `getType` shape differs, instead assert inside the `add_to_lineup` block via a custom `propose` spy and skip the ToolMessage introspection — the point is the marker, not the plumbing. Prefer making it work: `AIMessage.tool_calls` responses make `runToolAgent` emit a `ToolMessage` whose `content` is `JSON.stringify(out)` per `graph.ts:60`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/tsx/dist/cli.mjs gateway/agent/agent.test.mjs`
Expected: FAIL — `deps.propose` is not consulted; dispatch is called (or `proposals[0]` assertion fails).

- [ ] **Step 3: Implement the propose path in `gateway/agent/tools.ts`**

Update the header comment (lines 1-4) to say the tool layer is where the editor-tier write gate lives AND where write calls become proposals. Replace `ChatToolDeps` and `run` (lines 10-33) with:

```ts
export interface ChatProposal {
  id: string
  tool_name: string
  args: Record<string, unknown>
  summary: string
}

export interface ChatToolDeps {
  dispatch: (name: string, args: Record<string, unknown>) => Promise<unknown>
  role: TeamRole
  onSpan?: (name: string, args: unknown, result: { output?: unknown; error?: string }, latencyMs: number) => void
  /** Writes never dispatch: the host validates + stores a proposal instead. */
  propose?: (name: string, args: Record<string, unknown>) => Promise<{ proposal_id: string; summary: string }>
  /** Fired once per stored proposal; hosts keep the latest (last wins). */
  onProposal?: (p: ChatProposal) => void
}

function writeBlocked() {
  return { error: "you do not have permission to change this team's data" }
}

export function makeChatTools(deps: ChatToolDeps): DynamicStructuredTool[] {
  const run = (name: string) => async (args: Record<string, unknown>) => {
    const start = Date.now()
    try {
      let output: unknown
      if (WRITE_FUNCTIONS.has(name)) {
        if (!hasAtLeast(deps.role, 'editor')) return writeBlocked()
        if (!deps.propose) return { error: 'action confirmation is unavailable' }
        const p = await deps.propose(name, args)
        deps.onProposal?.({ id: p.proposal_id, tool_name: name, args, summary: p.summary })
        output = { proposed: true, proposal_id: p.proposal_id, summary: p.summary }
      } else {
        output = await deps.dispatch(name, args)
      }
      deps.onSpan?.(name, args, { output }, Date.now() - start)
      return output
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      deps.onSpan?.(name, args, { error }, Date.now() - start)
      return { error }
    }
  }
  // ...rest of makeChatTools unchanged (gameHint + tool list)
```

- [ ] **Step 4: Update the system prompt in `gateway/agent/context.ts` (lines 277-279)**

Replace the `query_stat_breakdown is read-only...` paragraph and the `YOU CAN MODIFY DATA:...` paragraph with:

```
READ-ONLY TOOLS: query_stat_breakdown, view_lineup, and list_lineup_templates are read-only (they never change data) — call them directly and silently whenever a stat question or lineup question needs them (e.g. "who is playing tonight?", "what does our lineup look like?", "what lineup templates exist?"), with no confirmation and no announcement.

YOU PROPOSE, THE CARD CONFIRMS: your data-changing tools (create_game_event, undo_last_event, add_to_lineup, remove_from_lineup, create_lineup_group, create_lineup, save_lineup_template, apply_lineup_template) do NOT change anything by themselves. They return {"proposed": true, "proposal_id": ..., "summary": ...} — the app shows the user a confirmation card above the chat input with exactly that summary. After such a tool call, tell the user in patois what the card says and that they can press Confirm on the card to apply it or Cancel to discard it. NEVER say something was logged, saved, or changed unless you are describing the card's summary — a proposal is not a change. The user CANNOT confirm by typing "yes" or "confirm" in chat: if they reply with an agreement, tell them kindly in patois to press the Confirm button on the card instead. If the tool returns an error instead of a proposal, report exactly what failed in patois and never guess a player, game, or season name. If a player name is ambiguous or you can't find a matching game, ask instead of guessing.
```

(The trailing backtick template literal and everything above line 277 stays unchanged.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `node node_modules/tsx/dist/cli.mjs gateway/agent/agent.test.mjs && npm run test:gateway:offline`
Expected: all pass (the hosts still pass `dispatch` without `propose` — write tools would return the unavailable marker, but no host test drives a write through the full agent until Task 5).

- [ ] **Step 6: Commit**

```bash
git add gateway/agent/tools.ts gateway/agent/context.ts gateway/agent/agent.test.mjs
git commit -m "feat(chat): agent write tools propose instead of dispatch"
```

---

### Task 5: Confirm endpoint on both runtimes

**Files:**
- Modify: `gateway/chatProposals.ts` (append `confirmProposal`)
- Modify: `gateway/chat.ts` (append `handleChatConfirmRequest`)
- Modify: `server/index.ts` (append `/api/chat/confirm` route after the `/api/chat` route, around line 438)
- Modify: `worker.ts:106-128` (route gate + handler)
- Modify: `gateway/chatProposals.test.mjs` (append confirm tests)
- Modify: `gateway/chat.ts` + `server/index.ts` chat handlers to thread `propose`/`onProposal` into `makeChatTools` and return `proposal` in the reply (see Step 5)
- Modify: `package.json` (no new file — confirm tests extend `chatProposals.test.mjs`, already in the suite)

**Interfaces:**
- Consumes: `confirmProposal(config, { id, session_id, organization_id, user_id, role }): Promise<unknown>`; `ConfirmError { status }`; `getProposal`/`takeProposal`/`deleteProposal`/`isExpired`; `callChatFunction`, `WRITE_FUNCTIONS` from `gateway/gameActions.ts`; `hasAtLeast` from `gateway/membership.js`.
- Produces: `POST /api/chat/confirm` with body `{ proposal_id, session_id, organization_id }` → `{ result }` on success; `{ error }` with status 400/401/403/404/409/410/500 otherwise. `POST /api/chat` response gains an optional `proposal` field: `{ id, tool_name, args, summary }`.

- [ ] **Step 1: Write the failing tests (append to `gateway/chatProposals.test.mjs`)**

First, add `confirmProposal` and `ConfirmError` to the static import at the top of the file:

```js
import {
  createProposal, getProposal, takeProposal, deleteProposal, isExpired, PROPOSAL_TTL_MS, buildProposal,
  confirmProposal, ConfirmError,
} from './chatProposals.ts'
```

Then append a `confirmProposal` section after the Task 3 section, still inside the file's single `try` (before the closing `finally`). `confirmProposal` executes `callChatFunction('add_to_lineup', ...)`, which reads `/rest/v1/games` + `/rest/v1/players` and writes `/rest/v1/game_lineup_groups` + `/rest/v1/game_lineups`, so the mock grows those four paths. Every test case seeds a proposal row directly (no `buildProposal` call — confirm must not depend on it):

```js
// ---- confirmProposal: claim, gates, single-use (Task 5) ----
rows.length = 0
const writeCalls = []
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url))
  const path = u.pathname
  const method = init.method || 'GET'
  if (path === '/rest/v1/chat_action_proposals') {
    const f = k => u.searchParams.get(k)?.replace('eq.', '')
    const match = r => r.id === f('id') && r.session_id === f('session_id')
      && String(r.organization_id) === f('organization_id') && r.user_id === f('user_id')
    if (method === 'POST') { const b = JSON.parse(init.body); rows.push(b); return Response.json([b]) }
    if (method === 'DELETE') {
      const hit = rows.filter(match)
      for (const r of hit) rows.splice(rows.indexOf(r), 1)
      return Response.json(hit)
    }
    return Response.json(rows.filter(match))
  }
  if (path === '/rest/v1/games') return Response.json(GAMES)
  if (path === '/rest/v1/players') return Response.json(PLAYERS)
  if (path === '/rest/v1/game_lineup_groups' || path === '/rest/v1/game_lineups') {
    writeCalls.push(`${method} ${path}`)
    return Response.json([{ ok: true }])
  }
  throw new Error(`unexpected fetch ${method} ${path}`)
}

const confirmCtx = {
  id: '',
  session_id: '11111111-1111-4111-8111-111111111111',
  organization_id: 1,
  user_id: 'user-1',
  role: 'editor',
}
const seed = (tool, args, ageMs = 0) => {
  const row = {
    id: crypto.randomUUID(),
    session_id: confirmCtx.session_id, organization_id: 1, user_id: 'user-1',
    tool_name: tool, args,
    created_at: new Date(Date.now() - ageMs).toISOString(),
  }
  rows.push(row)
  return row
}
const isConfirmError = (status) => (e) => e instanceof ConfirmError && e.status === status

// 1. happy path: editor confirms, the write executes, the row is consumed
let row = seed('add_to_lineup', { playerName: 'Alice' })
const result = await confirmProposal(cfg, { ...confirmCtx, id: row.id })
assert.ok(result, 'confirm returns the handler result')
assert.ok(writeCalls.some(c => c.startsWith('POST /rest/v1/game_lineups')), 'the write executed')
assert.equal(rows.length, 0, 'row consumed')

// 2. unknown / foreign id -> 404
await assert.rejects(() => confirmProposal(cfg, { ...confirmCtx, id: 'missing' }), isConfirmError(404))

// 3. expired -> 410 AND consumed
row = seed('add_to_lineup', { playerName: 'Alice' }, PROPOSAL_TTL_MS + 5000)
await assert.rejects(() => confirmProposal(cfg, { ...confirmCtx, id: row.id }), isConfirmError(410))
assert.equal(rows.length, 0, 'expired row was deleted')

// 4. member role -> 403 and NOT consumed (checked BEFORE the claim)
row = seed('add_to_lineup', { playerName: 'Alice' })
await assert.rejects(() => confirmProposal(cfg, { ...confirmCtx, id: row.id, role: 'member' }), isConfirmError(403))
assert.equal(rows[rows.length - 1].id, row.id, 'role-denied row is NOT consumed')

// 5. another user's id -> 404 (ownership filter fails the GET)
await assert.rejects(() => confirmProposal(cfg, { ...confirmCtx, id: row.id, user_id: 'user-2' }), isConfirmError(404))

// 6. lost claim race: GET sees the row, DELETE returns [] -> 409, no dispatch
writeCalls.length = 0
const raceDeletes = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url))
  if (u.pathname === '/rest/v1/chat_action_proposals' && init.method === 'DELETE') {
    return Response.json([]) // the other tab won the claim
  }
  if (u.pathname === '/rest/v1/game_lineup_groups' || u.pathname === '/rest/v1/game_lineups') {
    writeCalls.push(`RACE-EXEC ${init.method} ${u.pathname}`)
    return Response.json([{ ok: true }])
  }
  return raceDeletes(url, init) // everything else: the mock above
}
await assert.rejects(() => confirmProposal(cfg, { ...confirmCtx, id: row.id }), isConfirmError(409))
assert.ok(!writeCalls.some(c => c.startsWith('RACE-EXEC')), 'lost race never executes')
globalThis.fetch = raceDeletes

console.log('✓ confirmProposal checks passed')
```

`cfg`, `GAMES`, `PLAYERS`, `rows`, `assert`, `PROPOSAL_TTL_MS` are already in scope from the earlier sections.

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/tsx/dist/cli.mjs gateway/chatProposals.test.mjs`
Expected: FAIL — `confirmProposal` is not exported.

- [ ] **Step 3: Implement `confirmProposal` (append to `gateway/chatProposals.ts`)**

```ts
import { callChatFunction, WRITE_FUNCTIONS } from './gameActions.js'
import { hasAtLeast, type TeamRole } from './membership.js'

// The confirm endpoint's core. Order matters and is load-bearing:
// 1. GET (ownership-filtered) — not found means wrong id OR wrong
//    session/org/user; do not distinguish (no oracle).
// 2. expiry — an expired row is inert, so consume it while rejecting.
// 3. role — checked BEFORE the claim so a denial leaves the row pending
//    (spec: a role failure must not burn the user's proposal).
// 4. DELETE claim — the single-use primitive; losing it means a concurrent
//    confirm won, which must surface as 409, not as a double write.
// 5. dispatch the ORIGINAL tool via the same callChatFunction the agent used.
export async function confirmProposal(
  config: ActionsConfig,
  params: ProposalFilter & { role: TeamRole },
): Promise<unknown> {
  const row = await getProposal(config, params)
  if (!row) throw new ConfirmError(404, 'proposal not found or already used')
  if (isExpired(row)) {
    await deleteProposal(config, params)
    throw new ConfirmError(410, 'this proposal expired — ask the assistant again')
  }
  if (WRITE_FUNCTIONS.has(row.tool_name) && !hasAtLeast(params.role, 'editor')) {
    throw new ConfirmError(403, "you do not have permission to change this team's data")
  }
  const claimed = await takeProposal(config, params)
  if (!claimed) throw new ConfirmError(409, 'proposal already confirmed')
  return callChatFunction(config, params.organization_id, claimed.tool_name, claimed.args)
}
```

(Merge the two imports into the file's existing import statements; `ProposalFilter` is already exported from Task 2.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/tsx/dist/cli.mjs gateway/chatProposals.test.mjs`
Expected: all sections pass.

- [ ] **Step 5: Wire the two hosts**

**`gateway/chat.ts`** — add imports (`buildProposal`, `confirmProposal`, `ConfirmError` from `./chatProposals.js`), thread the deps into `makeChatTools` inside `handleChatRequest` (around line 155), and return the proposal:

```ts
// above handleChatRequest's tools construction:
let liveProposal: { id: string; tool_name: string; args: Record<string, unknown>; summary: string } | undefined
const tools = makeChatTools({
  dispatch: (name, args) => callChatFunction(actionsConfig, teamId, name, args, scope),
  role: user.role,
  // ChatToolDeps.propose returns { proposal_id, summary } — map buildProposal's { id, ... } shape.
  propose: async (name, args) => {
    const p = await buildProposal(actionsConfig, { organization_id: teamId, session_id, user_id: user.sub }, name, args)
    return { proposal_id: p.id, summary: p.summary }
  },
  onProposal: p => { liveProposal = p },   // last wins: one card at a time
  onSpan: (name, args, result, latencyMs) => posthog.capture({ /* unchanged */ }),
})
```

and change the return at line 205 to:

```ts
return json({ reply, proposal: liveProposal })
```

(`liveProposal` is `undefined` when no write tool fired — the field is omitted by JSON serialization.)

Then append the handler:

```ts
export async function handleChatConfirmRequest(config: ChatConfig, request: Request): Promise<Response> {
  try {
    const body: any = await request.json().catch(() => ({}))
    const { proposal_id, session_id, organization_id } = body as {
      proposal_id?: string; session_id?: string; organization_id?: number
    }
    if (!proposal_id || !session_id || !organization_id) return json({ error: 'proposal_id, session_id and organization_id required' }, 400)
    if (!isValidSessionId(session_id)) return json({ error: 'session_id must be a UUID' }, 400)

    const lookup = createMembershipLookup({
      supabaseUrl: config.supabaseUrl,
      supabaseSecretKey: config.supabaseSecretKey,
      onLookupError: (err) => Sentry.captureException(err),
    })
    const user = await requireTeamMember(config, request, Number(organization_id), 'member', lookup)
    if (!user.ok) return json({ error: user.error }, user.status)

    const actionsConfig: ActionsConfig = { supabaseUrl: config.supabaseUrl, supabaseSecretKey: config.supabaseSecretKey }
    try {
      const result = await confirmProposal(actionsConfig, {
        id: proposal_id, session_id, organization_id: Number(organization_id), user_id: user.sub, role: user.role,
      })
      return json({ result })
    } catch (err) {
      if (err instanceof ConfirmError) return json({ error: err.message }, err.status)
      throw err
    }
  } catch (err: unknown) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
}
```

**`server/index.ts`** — mirror both changes. First the `/api/chat` route: capture `let liveProposal` before `makeChatTools`, pass the same `propose` (wrap `buildProposal(actionsConfig, { organization_id: teamId, session_id, user_id: caller.sub }, name, args)` exactly like the Worker host above — mapping the return to `{ proposal_id: p.id, summary: p.summary }`), and `onProposal: p => { liveProposal = p }`, and change line 422 to `res.json({ reply, proposal: liveProposal });`. Then add the confirm route after the `/api/chat` route (before line 439):

```ts
app.post("/api/chat/confirm", async (req, res) => {
  try {
    const { proposal_id, session_id, organization_id } = req.body as {
      proposal_id?: string; session_id?: string; organization_id?: number
    };
    if (!proposal_id || !session_id || !organization_id) return res.status(400).json({ error: "proposal_id, session_id and organization_id required" });
    if (!isValidSessionId(session_id)) return res.status(400).json({ error: "session_id must be a UUID" });

    const webRequest = new Request(`${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`, {
      headers: { cookie: req.headers.cookie ?? "" },
    });
    const caller = await classifyChatCaller(webRequest, Number(organization_id));
    if (!caller.ok) return res.status(caller.status).json({ error: caller.error });

    const actionsConfig: ActionsConfig = { supabaseUrl: process.env.SUPABASE_URL || "", supabaseSecretKey: process.env.SUPABASE_SECRET_KEY || "" };
    const result = await confirmProposal(actionsConfig, {
      id: proposal_id, session_id, organization_id: Number(organization_id), user_id: caller.sub, role: caller.role,
    });
    res.json({ result });
  } catch (err: unknown) {
    if (err instanceof ConfirmError) return res.status(err.status).json({ error: err.message });
    Sentry.captureException(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
```

Add imports at the top of `server/index.ts`: `import { buildProposal, confirmProposal, ConfirmError } from "../gateway/chatProposals.js";` (match the file's existing import style for gateway modules — check how `callChatFunction`/`makeChatTools` are imported and follow it).

Confirm endpoint and quota: confirm runs no model, so it does NOT call `consumeAiMessage` — do not add quota logic.

**`worker.ts`** — extend the gate at line 106 to `if (url.pathname === "/api/chat" || url.pathname === "/api/chat/history" || url.pathname === "/api/chat/confirm") {` and add inside the block (before the closing brace, after the history DELETE branch):

```ts
if (url.pathname === "/api/chat/confirm" && request.method === "POST") {
  return handleChatConfirmRequest(chatConfig, request);
}
```

Add `handleChatConfirmRequest` to the existing `gateway/chat.js` import at line 7.

- [ ] **Step 6: Verify everything still passes + Worker bundles**

Run: `npm run test:gateway:offline`
Expected: all pass (including `agent.test.mjs`, whose stub hosts pass no `propose` — fine, those tests use `makeChatTools` directly).

Run: `npx wrangler deploy --dry-run --config wrangler.jsonc`
Expected: bundle succeeds (catches a Worker-incompatible import in the new module).

- [ ] **Step 7: Commit**

```bash
git add gateway/chatProposals.ts gateway/chatProposals.test.mjs gateway/chat.ts server/index.ts worker.ts
git commit -m "feat(chat): confirm endpoint on both runtimes"
```

---

### Task 6: Frontend chips + action card components

**Files:**
- Create: `frontend/components/chat/ChatChips.tsx`
- Create: `frontend/components/chat/ActionCard.tsx`
- Create: `frontend/components/chat/ChatChips.test.tsx`
- Create: `frontend/components/chat/ActionCard.test.tsx`

**Interfaces:**
- Consumes: `Button` from `frontend/lib/shadcn/button`, `Card, CardContent` from `frontend/lib/shadcn/card`, `TeamRole` from `frontend/lib/authClient` (type-only).
- Produces (Task 7 depends on exact names):
  - `ChatChips({ role, onSend, hidden }: { role: TeamRole | null; onSend: (message: string) => void; hidden?: boolean })`
  - `export type ChatProposal = { id: string; tool_name: string; args: Record<string, unknown>; summary: string }`
  - `export type ProposalStatus = 'pending' | 'confirming' | 'done' | 'error'`
  - `ActionCard({ proposal, status, outcome, onConfirm, onCancel, onDismiss }: { proposal: ChatProposal; status: ProposalStatus; outcome?: string | null; onConfirm: () => void; onCancel: () => void; onDismiss: () => void })`

- [ ] **Step 1: Write the failing component tests**

`frontend/components/chat/ChatChips.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ChatChips } from './ChatChips'

describe('ChatChips', () => {
  it('shows read chips to a member and hides write chips', () => {
    const onSend = vi.fn()
    render(<ChatChips role="member" onSend={onSend} />)
    expect(screen.getByRole('button', { name: 'View lineup' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Saved lineups' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Build lineup' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Log event' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo event' })).not.toBeInTheDocument()
  })

  it('shows every chip to an editor and sends preset messages', () => {
    const onSend = vi.fn()
    render(<ChatChips role="editor" onSend={onSend} />)
    fireEvent.click(screen.getByRole('button', { name: 'View lineup' }))
    expect(onSend).toHaveBeenCalledWith('Show me the current lineup')
    fireEvent.click(screen.getByRole('button', { name: 'Build lineup' }))
    expect(onSend).toHaveBeenCalledWith('Help me build a lineup for the next game')
    fireEvent.click(screen.getByRole('button', { name: 'Undo event' }))
    expect(onSend).toHaveBeenCalledWith('Undo the last event')
  })

  it('renders nothing when hidden or unauthenticated', () => {
    const { container } = render(<ChatChips role="editor" onSend={() => {}} hidden />)
    expect(container).toBeEmptyDOMElement()
    const { container: c2 } = render(<ChatChips role={null} onSend={() => {}} />)
    expect(c2).toBeEmptyDOMElement()
  })
})
```

`frontend/components/chat/ActionCard.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ActionCard, type ChatProposal } from './ActionCard'

const proposal: ChatProposal = {
  id: 'p1',
  tool_name: 'create_lineup',
  args: { groups: [{ name: 'O-Line', players: [{ playerName: 'Alice' }, { playerName: 'Bob', role: 'Cutter' }] }] },
  summary: "Set the lineup for the 2026-09-29 game vs Rival A: O-Line (Alice, Bob)",
}

describe('ActionCard', () => {
  it('pending shows the server summary, the args detail, and Confirm/Cancel', () => {
    render(<ActionCard proposal={proposal} status="pending" onConfirm={() => {}} onCancel={() => {}} onDismiss={() => {}} />)
    expect(screen.getByText(proposal.summary)).toBeInTheDocument()
    expect(screen.getByText('O-Line')).toBeInTheDocument()
    expect(screen.getByText(/Alice/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('confirming disables the buttons', () => {
    render(<ActionCard proposal={proposal} status="confirming" onConfirm={() => {}} onCancel={() => {}} onDismiss={() => {}} />)
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  it('done shows the outcome and a Dismiss button, no Confirm', () => {
    render(<ActionCard proposal={proposal} status="done" outcome="Confirmed — the change has been applied." onConfirm={() => {}} onCancel={() => {}} onDismiss={() => {}} />)
    expect(screen.getByText('Confirmed — the change has been applied.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  })

  it('error keeps Confirm enabled for a retry and shows the error', () => {
    const onConfirm = vi.fn()
    render(<ActionCard proposal={proposal} status="error" outcome="Failed to reach the server. Try again." onConfirm={onConfirm} onCancel={() => {}} onDismiss={() => {}} />)
    expect(screen.getByText('Failed to reach the server. Try again.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('cancel fires onCancel', () => {
    const onCancel = vi.fn()
    render(<ActionCard proposal={proposal} status="pending" onConfirm={() => {}} onCancel={onCancel} onDismiss={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run components/chat`
Expected: FAIL — cannot resolve `./ChatChips` / `./ActionCard`.

- [ ] **Step 3: Implement the components**

`frontend/components/chat/ChatChips.tsx`:

```tsx
import { Button } from '../../lib/shadcn/button'
import type { TeamRole } from '../../lib/authClient'

// Quick-action chips: preset PROMPTS, never writes — they go through the
// normal sendMessage path, so the assistant proposes and the card confirms.
type Chip = { label: string; message: string; write?: boolean }

const CHIPS: Chip[] = [
  { label: 'View lineup', message: 'Show me the current lineup' },
  { label: 'Build lineup', message: 'Help me build a lineup for the next game', write: true },
  { label: 'Log event', message: 'Log a goal', write: true },
  { label: 'Undo event', message: 'Undo the last event', write: true },
  { label: 'Saved lineups', message: 'What lineup templates do we have?' },
]

// Chips key off the team ROLE, not can.record: members have can.record
// (roster/schedule entry) but the chat write tools are editor-tier.
export function ChatChips({ role, onSend, hidden }: {
  role: TeamRole | null
  onSend: (message: string) => void
  hidden?: boolean
}) {
  if (hidden || role == null) return null
  const visible = CHIPS.filter(c => !c.write || role === 'editor' || role === 'captain')
  return (
    <div className="flex gap-2 flex-wrap">
      {visible.map(c => (
        <Button
          key={c.label}
          type="button"
          variant="outline"
          size="sm"
          className="bg-card border-border text-foreground text-muted-foreground hover:text-foreground"
          onClick={() => onSend(c.message)}
        >
          {c.label}
        </Button>
      ))}
    </div>
  )
}
```

`frontend/components/chat/ActionCard.tsx`:

```tsx
import { Button } from '../../lib/shadcn/button'
import { Card, CardContent } from '../../lib/shadcn/card'
import { Check, Loader2, X } from 'lucide-react'

export type ChatProposal = {
  id: string
  tool_name: string
  args: Record<string, unknown>
  summary: string
}

// pending: awaiting the user; confirming: request in flight;
// done: settled (success or terminal 403/404/410); error: transient, retryable.
export type ProposalStatus = 'pending' | 'confirming' | 'done' | 'error'

// The detail block derives from the PROPOSAL ARGS, never from the reply
// text — the summary is server-built, so the card cannot drift from what
// confirm will actually execute.
function renderDetails(proposal: ChatProposal) {
  if (proposal.tool_name === 'create_lineup') {
    const groups = (proposal.args.groups as { name: string; players?: { playerName: string; role?: string }[] }[]) ?? []
    return groups.map((g, i) => (
      <div key={i} className="text-xs">
        <span className="font-medium text-foreground">{g.name}:</span>{' '}
        <span className="text-muted-foreground">
          {(g.players ?? []).map(p => `${p.playerName}${p.role ? ` (${p.role})` : ''}`).join(', ') || '(empty)'}
        </span>
      </div>
    ))
  }
  const SKIP = new Set(['gameDate', 'opponent'])
  return Object.entries(proposal.args)
    .filter(([k]) => !SKIP.has(k))
    .map(([k, v]) => (
      <div key={k} className="text-xs">
        <span className="font-medium text-foreground">{k}:</span>{' '}
        <span className="text-muted-foreground">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
      </div>
    ))
}

export function ActionCard({ proposal, status, outcome, onConfirm, onCancel, onDismiss }: {
  proposal: ChatProposal
  status: ProposalStatus
  outcome?: string | null
  onConfirm: () => void
  onCancel: () => void
  onDismiss: () => void
}) {
  return (
    <Card className="bg-card border-border">
      <CardContent className="p-3 space-y-2">
        <p className="text-sm font-medium text-foreground leading-snug">{proposal.summary}</p>
        <div className="space-y-1">{renderDetails(proposal)}</div>
        {outcome && (
          <p className={`text-xs ${status === 'done' ? 'text-muted-foreground' : 'text-destructive'}`}>{outcome}</p>
        )}
        {status === 'done' ? (
          <Button size="sm" variant="outline" onClick={onDismiss} className="text-foreground">
            Dismiss
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={onConfirm}
              disabled={status === 'confirming'}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {status === 'confirming' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4 mr-1.5" />}
              Confirm
            </Button>
            <Button size="sm" variant="outline" onClick={onCancel} disabled={status === 'confirming'} className="text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4 mr-1.5" />
              Cancel
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run components/chat`
Expected: both files pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/components/chat
git commit -m "feat(chat): action card and chips components"
```

---

### Task 7: Wire cards + chips into the Chat page

**Files:**
- Modify: `frontend/pages/Chat.tsx`

**Interfaces:**
- Consumes: `ChatChips`, `ActionCard`, `ChatProposal`, `ProposalStatus` from `../components/chat/*`; `role` from `useAuth()`.

- [ ] **Step 1: Thread state and handlers (exact edits)**

Add imports after line 8:

```tsx
import { ChatChips } from '../components/chat/ChatChips'
import { ActionCard, type ChatProposal, type ProposalStatus } from '../components/chat/ActionCard'
```

Change the `useAuth` destructure at line 63 to also take `role`:

```tsx
const { can, currentTeamId, role } = useAuth()
```

Add state after line 60 (`const [clearing, setClearing] = useState(false)`):

```tsx
const [proposal, setProposal] = useState<ChatProposal | null>(null)
const [proposalStatus, setProposalStatus] = useState<ProposalStatus>('pending')
const [proposalOutcome, setProposalOutcome] = useState<string | null>(null)
```

In `sendMessage` (line 80), change the signature to accept an optional preset so chips bypass the setState race:

```tsx
const sendMessage = async (preset?: string) => {
  const text = (preset ?? input).trim()
  if (!text || loading || currentTeamId == null) return
  setInput('')
  // ...unchanged through the fetch...
  const data = await res.json()
  setMessages(prev => [...prev, { role: 'assistant', content: data.reply ?? data.error ?? 'No response' }])
  if (data.proposal) {
    setProposal(data.proposal as ChatProposal)
    setProposalStatus('pending')
    setProposalOutcome(null)
  }
}
```

(Leave the existing error `catch` and `finally` untouched.)

Add the confirm handler + the team-switch guard after `clearHistory`:

```tsx
const confirmProposal = async () => {
  if (!proposal || currentTeamId == null || proposalStatus === 'confirming') return
  setProposalStatus('confirming')
  try {
    const res = await fetch('/api/chat/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposal_id: proposal.id, session_id: sessionId.current, organization_id: currentTeamId }),
    })
    const data = await res.json()
    if (res.ok) {
      setProposalStatus('done')
      setProposalOutcome('Confirmed — the change has been applied.')
    } else if (res.status === 403 || res.status === 404 || res.status === 410) {
      setProposalStatus('done') // terminal: retrying cannot succeed
      setProposalOutcome(data.error ?? 'This proposal can no longer be confirmed.')
    } else {
      setProposalStatus('error') // transient: Confirm stays enabled for a retry
      setProposalOutcome(data.error ?? 'Failed to confirm. Try again.')
    }
  } catch {
    setProposalStatus('error')
    setProposalOutcome('Failed to reach the server. Try again.')
  }
}

// A pending card belongs to the team it was proposed for; switching teams
// discards it (the server would reject the confirm on the org mismatch
// anyway — this just keeps the UI from offering a dead button).
useEffect(() => {
  setProposal(null)
  setProposalStatus('pending')
  setProposalOutcome(null)
}, [currentTeamId])
```

Also clear the card when history is cleared — in `clearHistory` after `setMessages([])`:

```tsx
setProposal(null)
setProposalOutcome(null)
```

In the JSX, replace the input block opening (line 206, `{can.record ? (` down to the `<div className="flex gap-2 mt-3">`) with a column that stacks card + chips + input:

```tsx
{can.record ? (
  <div className="mt-3 space-y-2">
    {proposal && (
      <ActionCard
        proposal={proposal}
        status={proposalStatus}
        outcome={proposalOutcome}
        onConfirm={confirmProposal}
        onCancel={() => { setProposal(null); setProposalOutcome(null) }}
        onDismiss={() => { setProposal(null); setProposalOutcome(null) }}
      />
    )}
    <ChatChips role={role} onSend={m => sendMessage(m)} hidden={loading || proposal != null} />
    <div className="flex gap-2">
      {/* existing Input + Send Button, unchanged */}
    </div>
  </div>
) : (
```

(Keep the existing `<Input ... onKeyDown={... sendMessage()}>` and `<Button onClick={sendMessage}>` exactly as they are inside the new wrapper — `sendMessage()` with no args still reads the input.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck:frontend`
Expected: clean.

- [ ] **Step 3: Run the full frontend suite**

Run: `npm run test:frontend`
Expected: all pass (Chat page has no direct test; components carry the coverage).

- [ ] **Step 4: Run the full gateway suite**

Run: `npm run test:gateway:offline`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/pages/Chat.tsx
git commit -m "feat(chat): wire cards and chips into Chat page"
```

---

### Task 8: QA-stack DB gate (optional, human-approved)

**Files:** none new — runs the Task 1 pgTAP suite.

- [ ] **Step 1: ONLY if the human explicitly approves enabling the QA stack for this run** (it is stopped by default on this device):

Run: `npm run qa:reset && npm run db:test -- --filter 00_meta --filter 25_chat_action_proposals`
Expected: both suites pass.

Then free the resources: `npx supabase stop`

If the human does not approve, leave this task unchecked — the migration's SQL was syntax-checked in Task 1 and the human applies it to prod at rollout.

- [ ] **Step 2: Report**

State whether the DB gate ran; if skipped, remind the human that `chat_action_proposals` must be applied to prod via direct psql BEFORE this branch merges (main auto-deploys, and merged code would hit a missing table).

---

## Manual QA recipe (after Task 7, against the dev servers)

1. Sign in as an editor/captain. Chat page shows all five chips; as a member, only "View lineup" and "Saved lineups".
2. Tap "Build lineup" → assistant proposes → card appears above the input, chips hidden while pending.
3. Confirm → card settles to "Confirmed"; Schedule page's lineup for that game reflects the change.
4. Propose again → Cancel → Schedule page unchanged.
5. Propose, wait > 15 min (or confirm the same id twice via two tabs) → card settles with the expiry / already-used message; nothing written.
6. Switch teams with a card pending → card disappears.

## Self-review notes

- Spec coverage: chips (Tasks 6-7), cards from args (Task 6), proposal store/expiry/single-use (Tasks 2, 5), both hosts (Task 5), prompt (Task 4), role gating (Tasks 4-6), team-switch discard (Task 7), free-tier behavior unchanged (confirm reuses the same tier-gated handlers — no new gating), PostHog spans still fire for propose results (Task 4 wrapper).
- Known deviation from spec wording: "confirm-time auth/role failure: proposal stays pending" — implemented via role-check-BEFORE-claim in Task 5, tested in Task 5 Step 1 case 4.
- Non-goals respected: no card editing, no cards from history (proposal only ever travels in the POST /api/chat response body), no MCP changes.

