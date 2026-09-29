# Chat Interactive Features — Quick-Action Chips and Action Cards

Date: 2026-09-29
Status: Approved (design review passed in chat; spec review pending)

## Summary

Add two interactive layers above the Chat input bar, covering **all chat
write actions** (lineups, lineup templates, game-event logging, undo):

1. **Quick-action chips** — a row of preset prompts above the chat input
   that send prepared messages to the assistant. Read chips are visible to
   every member; write-intent chips are hidden unless the user's team role
   is `editor` or `captain`. Chips never write data themselves.
2. **Action cards** — when the assistant proposes a data change, the
   backend returns a structured **action proposal** alongside the text
   reply, and the frontend renders a review card above the input bar. The
   user confirms or cancels the **exact, server-validated change** shown
   on the card. Confirmed actions execute through a dedicated endpoint;
   the model never executes a write off a typed "yes" alone while a
   proposal is pending.

The existing typed-confirmation flow (the model restating the action and
the user typing "yes") is replaced by the card flow for every write tool,
so there is exactly one confirmation path and it cannot drift from what
the model said.

## Background

- Chat page: `frontend/pages/Chat.tsx` — message list + input bar, no
  interactive controls today.
- Chat agent tools: `gateway/gameActions.ts` + `gateway/agent/tools.ts`.
  Write tools (`WRITE_FUNCTIONS`): `create_game_event`,
  `undo_last_event`, `add_to_lineup`, `remove_from_lineup`,
  `create_lineup_group`, `create_lineup`, `save_lineup_template`,
  `apply_lineup_template`. Read tools: `query_stat_breakdown`,
  `view_lineup`, `list_lineup_templates`.
- Agent runtime: stateless LangGraph (`gateway/agent/graph.ts`); history
  is passed in per request, `chat_logs` is the only store.
- Hosted twice: Cloudflare Worker (`worker.ts` → `gateway/chat.ts`) and
  Express (`server/index.ts`). Both call `handleChatRequest`.
- Write gating today: `WRITE_FUNCTIONS` in `gateway/gameActions.ts`,
  enforced in `makeChatTools` (`gateway/agent/tools.ts`) via
  `hasAtLeast(role, 'editor')`; membership re-checked per request in
  `requireTeamMember` (`gateway/chat.ts`).
- Frontend capabilities: `can.record` is true for plain members
  (`frontend/contexts/AuthContext.tsx`), which does **not** match the
  chat write gate. Chips and cards must key off the user's **team role**
  (`role` from `AuthContext`), not `can.record`.

## Scope

In: chips, action cards, proposal storage + confirm endpoint, agent
changes to emit proposals instead of executing writes, role-gated chip
visibility, tests on both hosts.

Out: editing proposed values inside a card (review-and-confirm only),
per-field editing, card rendering of past sessions' proposals (old chat
history stays text-only), MCP server tools, strategy/board actions.

## Architecture

```
User message ──▶ /api/chat ──▶ runChatAgent
                                   │
                 write tool called? ──▶ tool func returns a PROPOSAL
                                   │      (stores it, does not write)
                                   ▼
                          reply + proposal_id + proposal payload
                                   │
                     Frontend renders ActionCard above input
                                   │
                    Confirm ──▶ POST /api/chat/confirm {proposal_id}
                                   │
                 Server: membership + role recheck → resolve names
                 → execute via callChatFunction → single-use delete
                                   ▼
                          result ──▶ card shows outcome
```

### Proposal creation (agent side)

`makeChatTools`'s `run` wrapper intercepts `WRITE_FUNCTIONS` calls.
Instead of dispatching the write, it:

1. Validates + resolves arguments the same way the real handler would
   (game resolution, player-name resolution) so the card can show real
   dates/opponents/names and invalid input fails early — **no data is
   written during proposal**.
2. Stores a proposal: `{ id, session_id, organization_id, user_id,
   tool_name, args, created_at }` in a new `chat_action_proposals`
   table (or equivalent server-side store; see Storage).
3. Returns a structured marker (e.g. `{ proposed: true, proposal_id,
   summary }`) as the tool result so the model can phrase its reply.

The system prompt (`gateway/agent/context.ts`) changes: write tools now
PROPOSE, the card flow handles confirmation, and the model must never
claim a write happened from a tool result that is a proposal. Typed "yes"
while a proposal is pending does not trigger a write — the model replies
that the card must be used (belt-and-braces; the tool layer enforces it
anyway by only proposing).

### Proposal confirmation (server side)

`POST /api/chat/confirm` (both hosts):

1. `requireTeamMember` — same auth/membership as `/api/chat`.
2. Load proposal by id; enforce `session_id`, `organization_id`,
   `user_id` match the caller, and expiry (proposals older than
   **15 minutes** are rejected as expired).
3. Re-check role against `WRITE_FUNCTIONS` (member role revocation takes
   effect immediately).
4. Re-resolve game/player/season names from stored args at execution
   time (defense-in-depth: names resolve once more server-side).
5. Execute via the existing `callChatFunction` dispatch, then **delete
   the proposal row in the same flow** — proposals are single-use;
   replaying a confirmed id returns "not found / already used".
6. Return the handler's result payload; the card renders success
   (updated score/lineup details) or error inline.

Cancellation is client-side only (dismiss card); orphaned proposals
simply expire server-side. No cancel endpoint needed.

### Storage

New table `chat_action_proposals`:

- `id uuid pk default gen_random_uuid()`
- `session_id uuid`, `organization_id int`, `user_id uuid`
- `tool_name text`, `args jsonb`
- `created_at timestamptz default now()`
- RLS: none needed (service-role only, like `chat_logs` writes), but it
  must be added to the `00_meta.test.sql` RLS allowlist per repo rule if
  policies are required for `public` tables — follow the
  `platform_admins` precedent: RLS enabled with **zero policies** and
  no `anon`/`authenticated` grants, plus allowlist entry.
- Expiry is `created_at`-based; a scheduled sweep is unnecessary
  (orphaned rows are inert and can be ignored or cleaned by ops later —
  ponytail: add a cleanup job only if the table grows).

Both hosts share this table via Supabase REST with the service role
(same `supabaseRest.ts` helpers — Workers-portable, no new deps).

### Frontend — chips

Row above the input, wrapping on narrow screens, in `Chat.tsx`:

- "View lineup" → sends "Show me the current lineup"
- "Build lineup" → sends "Help me build a lineup for the next game"
  (write-intent; editor/captain only)
- "Log event" → sends "Log a goal" (write-intent; editor/captain only)
- "Undo event" → sends "Undo the last event" (write-intent;
  editor/captain only)
- "Saved lineups" → sends "What lineup templates do we have?"

Chip visibility uses `role` from `useAuth()` (`editor`/`captain` =
write chips visible). Chips are hidden while an action card is pending
or while a request is in flight. Chips send prompts through the normal
`sendMessage` path — they are shortcuts, not direct writes.

### Frontend — action cards

When a reply carries `proposal`:

- Card renders above the input bar in place of the chips: title
  (e.g. "Set lineup — tonight vs Rival A"), body listing the exact
  change (groups → players with roles; or event details), and
  Confirm / Cancel buttons.
- Confirm calls `/api/chat/confirm`, disables while in flight, then
  shows the outcome (success detail or error) in the card; the card
  remains until dismissed after resolution.
- Cancel dismisses immediately; the assistant is NOT informed (the user
  simply stopped the action — if they type about it afterwards, the
  model sees no write happened and can propose again).
- Expired proposal on confirm: card shows "this proposal expired — ask
  again".
- History reloads (`GET /api/chat/history`) do not resurrect cards:
  proposals are returned only with live replies, never stored in
  `chat_logs` content.

### Data flow summary

- `POST /api/chat` response shape becomes `{ reply, proposal? }` where
  `proposal` is `{ id, tool_name, args, summary }` (summary is a
  server-built human string, NOT model text — the card body derives
  from `args` so it cannot lie).
- `POST /api/chat/confirm { proposal_id, session_id, organization_id }`
  → `{ result }` or `{ error }`.

## Error handling

- Proposal resolution failure (unknown player, ambiguous game): tool
  returns the error as today; no card renders; model explains.
- Confirm-time auth/role failure: 403 with error message rendered in
  the card; proposal stays pending (role revoke mid-session is rare;
  staying pending is safe because it can never be confirmed by a
  lower-privileged caller and expires otherwise).
- Confirm-time validation failure (data changed since proposal, e.g.
  roster edit renamed a player): error rendered in card; proposal is
  consumed (single-use) so a stale confirm cannot partially apply.
- Network failure on confirm: card stays pending with an error hint;
  user may retry (idempotency comes from single-use semantics — a
  retried id that already executed returns "already used" and the card
  settles as success-unknown, telling the user to check state).
- Team switch while card pending: card is discarded client-side on
  `currentTeamId` change; server would reject the confirm anyway
  (organization_id mismatch).

## Security

- Confirm endpoint performs the full membership + role check — never
  trusts the client's rendering of a card.
- Proposals are bound to session, team, and user at creation; confirm
  re-verifies all three.
- No new client-visible secrets; Supabase access stays service-role
  behind the gateway/Express.
- Rate limiting: confirm rides the same per-session flow as chat; no
  separate limiter needed (each proposal is single-use and
  membership-bound).

## Testing

Backend (offline, appended to `test:gateway:offline`):

- Proposal creation: write tool returns `proposed` marker and writes a
  proposal row; no data mutation at proposal time (mock fetch asserts no
  POST/DELETE to data tables).
- Confirm: executes exactly once; second confirm returns already-used;
  expiry (age > 15 min) rejected; wrong user/session/org rejected;
  member-role confirm of a write proposal rejected 403.
- `agent.test.mjs`: model calling a write tool receives a proposal
  result, not a dispatch; dispatch never sees write tool names.
- gameActions invariants: `WRITE_FUNCTIONS` unchanged; read-only set
  unchanged; proposal path is a new seam, not a reclassification.
- Free-tier: proposals for archived-game writes behave as today's
  handlers (score gates unchanged — confirm runs the same functions).

Frontend (`npm run test:frontend`):

- Chips render per role (member: read chips only; editor/captain: all).
- Card renders from `proposal.args` (not reply text); Confirm posts to
  `/api/chat/confirm`; Cancel dismisses; in-flight disables buttons.
- Expired/already-used confirm renders the settle-state message.
- Team switch clears pending card.

DB (pgTAP, when QA stack is enabled):

- `chat_action_proposals`: RLS enabled, zero policies, allowlisted in
  `00_meta.test.sql`.

Manual QA: full card flow against a live stack — propose lineup via
"Build lineup" chip, confirm, verify Schedule page reflects it; cancel a
proposal and verify nothing changed.

## Non-goals

- Editing proposed values inside cards.
- Cards for read-only tools.
- Restoring cards from chat history.
- Streaming replies.
- MCP-server equivalents.

## Rollout

DB table first (per repo rule: schema lands before dependent code
merges, since main auto-deploys). Then gateway/server changes, then
frontend. No feature flag — single-PR rollout, both hosts share
`handleChatRequest`/confirm handlers.
