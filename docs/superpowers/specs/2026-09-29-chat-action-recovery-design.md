# Chat action recovery

Date: 2026-09-29
Status: design approved in chat; written spec awaiting review

## Intent

Editors and captains must be able to identify and reverse unintended changes made by the team chat assistant. Every successful chat write produces a durable, human-readable receipt with an Undo control. A user can also ask the assistant to undo its latest eligible action. Undo must target the exact rows changed, reject intervening edits rather than overwrite them, and remain available after reload or chat-history clearing. Read-only chat queries stay unchanged.

## Current state

`gateway/agent/tools.ts` registers eight write tools; `gateway/gameActions.ts` implements them with service-role REST calls, some comprising multiple independent requests. `gateway/agent/graph.ts` returns only reply text, and both Worker (`gateway/chat.ts`) and Express (`server/index.ts`) persist only user/assistant text in `chat_logs`. The frontend (`frontend/pages/Chat.tsx`) renders text bubbles. `undo_last_event` deletes the newest game event, not necessarily the assistant's own previous change. Existing `deleted_rows_archive` captures deleted rows but has no per-chat-action linkage, and its generic restore RPC is service-role-only; it is not an automatic end-user Undo mechanism.

Write tools in scope: `create_game_event`, `undo_last_event`, `add_to_lineup`, `remove_from_lineup`, `create_lineup_group`, `create_lineup`, `save_lineup_template`, `apply_lineup_template`. `view_lineup`, `list_lineup_templates`, and `query_stat_breakdown` are read-only. MCP tools, Schedule's Undo button, and non-chat writes remain out of scope.

## Approach

Recommended: transactional change receipts. Resolve names and validate permissions in existing application code; execute each chat write's row mutations and receipt creation as one database transaction through purpose-specific, service-role-only RPCs. Undo runs as one transaction: lock receipt and affected rows, verify ownership and unchanged post-action state, apply inverse, and mark receipt undone. A single successful write corresponds to one receipt, even when it changes multiple tables. This avoids claiming recovery for partly completed multi-request writes.

Alternatives rejected: (1) logging inverse REST requests after existing writes leaves an unlogged-write window and partial multi-request failures; (2) restoring from `deleted_rows_archive` alone does not track inserts or updates, tie rows to a chat request, or protect newer edits.

## Data and authority

Add `public.chat_actions` via a repo migration: UUID primary key; `organization_id`, `session_id`, `user_id`, `request_id` (one UUID per chat POST), `action_type`, short `description`, `status` (`applied` or `undone`), `before_rows` and `after_rows` JSONB, `created_at`, and `undone_at`. Add nullable `request_id` to `chat_logs` for new user/assistant turns; legacy rows remain null. This links receipts to an assistant message without relying on timestamps or message content. Store exact row identities and complete snapshots needed for inversion, including dependent rows created by automatic season-player enrollment. Index `(organization_id, user_id, session_id, created_at desc)` and enforce valid action types and status in DB. No secrets or prompt text in snapshots. Do not expose snapshots in API responses.

RLS allows only authenticated owner SELECT when `organization_id` belongs to their team and `user_id = auth.uid()::text`. No authenticated insert/update/delete policy or grants; only service role writes. Receipt rows survive chat-history clearing; the UI shows recent remaining receipts in a separate recovery list when conversation messages are gone. Limit returned receipts and paginate older ones. Apply a retention policy only after an explicit product decision; do not silently expire Undo.

Both Worker and Express authenticate JWT and re-check team membership and editor-or-captain role for each write and undo. Service-role endpoints derive owner from verified auth identity, not request body. Browser Undo accepts a receipt ID and team ID for consistency only; server scopes lookup by verified owner and team. Conversation undo scopes to the verified owner's current session and team. Session ID remains UUID-validated. Never hand an arbitrary receipt ID or raw rollback payload to the model.

## Action semantics

A write receipt records a full affected-row set, including absence before insertion and empty result on ignored upsert. For replacement actions, snapshot complete existing target groups/players/templates and generated rows before mutation, then record post-state and generated IDs. Transaction fails atomically if any step fails. No-op writes produce an explicit no-change result and no Undo receipt.

- `create_game_event`: remove the exact inserted event ID on undo.
- `undo_last_event`: restore the exact deleted event with its original ID and fields, not the then-latest event.
- `add_to_lineup`: restore player's prior lineup rows; remove only newly created group and season-player rows if this action created them and they remain unchanged.
- `remove_from_lineup`: restore exact deleted lineup rows.
- `create_lineup_group`: remove exact newly created group only; ignored duplicate is a no-op. Reject undo if another row now depends on that group.
- `create_lineup` and `apply_lineup_template`: restore complete previous game lineup and groups, remove replacement rows, and revert only season-player rows newly created by the action.
- `save_lineup_template`: restore previous template groups/players if overwritten, or remove newly created template and its children if inserted.

Before undo, compare the current affected set with receipt's `after_rows` under row locks, including new dependent rows where removal would cascade or invalidate references. On mismatch or intervening edit, reject with conflict and leave data and receipt unchanged; explain manual correction is needed. Database transaction makes concurrent Undo idempotent: first succeeds; subsequent call returns already-undone without replaying inverse. Preserve IDs where possible so existing references remain valid; repair identity sequence if explicit-ID restores require it. Undo-created deletions may still appear in the existing generic archive, which remains an operational backup, not the receipt source of truth.

## Agent, API, UI

Shared chat tool wrapper collects successful action receipts in order under the request UUID, separate from model narration, and passes `{ reply, actions: [{ id, request_id, description, status }] }` to both API implementations. Failed/no-op calls do not produce actionable receipts. Add `rollback_last_action` tool, editor-gated; it selects latest `applied` action in verified team/user/session and invokes same transactional Undo function. Update `undo_last_event` tool description to distinguish deleting a game's newest event from reversing the assistant's latest action. On a request that invokes rollback, return updated receipt status in the response.

`POST /api/chat/undo` receives `{ action_id, organization_id }` and returns receipt ID/status; `GET /api/chat/history` returns `{ messages, actions }`, scoped to verified user/team/session, with request IDs on new messages and receipts for deterministic grouping. `DELETE /api/chat/history` removes only messages, not recovery receipts. Keep legacy array response handling in frontend for a Worker/Express deployment mismatch; do not send an Undo request without a valid receipt ID.

Render one receipt card under each assistant reply with action description, applied/undone state, and per-card Undo button for eligible users. Show latest receipts separately if their message has been cleared. On click, disable while pending; success marks `Undone`; conflict leaves action visible with clear error and refreshes current state. Do not display rollback JSON or imply Undo succeeded until server confirms. Agent's conversational undo uses same authorization and conflict rules. Existing chat text history remains model context; receipt metadata is server/UI-only except the rollback tool's safe description and status result.

## Failure handling and verification

A failed write transaction creates no receipt and no partial data change. A failed undo transaction leaves both action status and domain rows unchanged. Distinguish 403 permission, 404 inaccessible action, 409 already-undone/conflict, and 500 unexpected error without leaking another user's action. Action logging failure must fail the write, not silently create an untracked mutation. Guard against overlapping requests and duplicate Undo clicks in DB, not only UI.

Tests: DB transaction tests for all eight actions, including no-op upserts, dependent-row changes, rollback conflict, concurrent double undo, rejected cross-team/cross-user access, and partial write failure. Gateway offline tests for tool receipts, conversational rollback, endpoint auth/error shape, and Worker/Express parity. Frontend tests for rendering, pending/error/undone states, reload, cleared-history receipt list, and legacy history shape. Run repository lint/typecheck and offline suites; local Supabase QA is disabled on this device unless human explicitly requests it. Production migration history diverges: never blind `supabase db push`; apply reviewed migration surgically before code merge because `main` auto-deploys.

## Non-goals

No pre-write approval, automatic rollback of other users' edits, broad database restore UI, or expansion to MCP/Schedule operations. A later approval flow can intercept write calls before transactional execution without changing receipt semantics.
