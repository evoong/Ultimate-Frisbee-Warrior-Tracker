# PostHog Everywhere — Design Spec

## Goal

Extend the existing PostHog integration (frontend autocapture, MCP server analytics,
self-driving) so that:

1. Every event is attributed to a real user, not an anonymous visitor.
2. Every meaningful persisted action (create/update/delete) across the app emits a
   named PostHog event, following a consistent taxonomy.
3. The Express backend has the same visibility `mcp-server/index.ts` already has:
   server-side events and exception capture.
4. None of this risks the PostHog free tier — local dev traffic never counts, and
   event volume stays proportional to real user actions (no per-frame drag spam,
   no per-item batch spam).

## Non-goals

- Feature flags, experiments, surveys — not requested, not added.
- Tracking read-only navigation, dialog open/close, or any other client-only UI
  state with no backend persistence.
- Changing `mcp-server/index.ts`'s existing PostHog instrumentation (already done
  in a prior session — see `posthog-mcp-analytics-report.md`).

## Architecture

### Identification

`frontend/contexts/AuthContext.tsx`:
- After `refreshSessionState()` resolves a `user`, call
  `posthog.identify(user.id, { email: user.email })`.
- In `logout()`, call `posthog.reset()` so subsequent anonymous activity isn't
  attributed to the previous person.

### Frontend analytics helper

New file `frontend/lib/analytics.ts`:

```ts
import { posthog } from './posthog'

export function track(event: string, properties?: Record<string, unknown>) {
  posthog.capture(event, properties)
}

export function trackError(error: unknown, properties?: Record<string, unknown>) {
  posthog.captureException(error, properties)
}
```

Single import point for all page components; keeps event names greppable
(`grep -rn "track(" frontend/pages`) and gives one place to add default
properties later if needed (e.g. `organization_id`) without touching every
call site.

Dev-safe behavior is inherited for free from `frontend/lib/posthog.ts`'s
existing `opt_out_capturing()` in dev mode — `track()` needs no gating of
its own.

### Backend analytics helper

New file `server/lib/posthog.ts`:

```ts
import { PostHog } from 'posthog-node'

const posthog = process.env.POSTHOG_PROJECT_TOKEN
  ? new PostHog(process.env.POSTHOG_PROJECT_TOKEN, { host: process.env.POSTHOG_HOST })
  : null

const enabled = process.env.NODE_ENV === 'production'

export function track(distinctId: string, event: string, properties?: Record<string, unknown>) {
  if (enabled) posthog?.capture({ distinctId, event, properties })
}

export function trackError(distinctId: string, error: unknown, properties?: Record<string, unknown>) {
  if (enabled) posthog?.captureException(error, distinctId, properties)
}

export async function shutdown() {
  await posthog?.shutdown()
}
```

`server/index.ts` calls `shutdown()` from a `SIGTERM` handler (matching the
pattern already in `mcp-server/index.ts`), so buffered events flush on
restart/kill.

`enabled` gates on `NODE_ENV === 'production'` — the same free-tier safety
net as the frontend's dev opt-out, applied server-side since `posthog-node`
has no built-in opt-out concept.

### Naming convention

- `<entity>_<verb_past_tense>`, e.g. `game_created`, `lineup_template_deleted`.
- Properties are IDs, counts, and enum-like values — never free text (chat
  messages, notes content, player names) or full row contents.
- The same underlying mutation (same hook/API call) always uses the same
  event name, regardless of which page/handler triggers it.

### Scope boundary

Tracked: every handler that awaits a Supabase/API call that creates, updates,
or deletes a row, fired once after success.

Not tracked:
- Client-only state (sort column, dialog open/close, local search/filter,
  navigation, `switchOrg`'s `localStorage` write).
- Per-frame drag/resize mechanics (`pointermove` handlers, `'preview'`-phase
  callbacks). A drag that commits a persisted change fires **one** event at
  the commit point (`'commit'` phase / `pointerup`), not per frame.
- A multi-item drag or delete on the Strategy board fires **one** batch event
  with per-kind counts (e.g. `play_selection_moved` with `player_count`,
  `arrow_count`, …), not one event per item.
- Undo/redo on the Strategy board re-issues the same create/update/delete
  calls it's undoing — those already-covered events fire again rather than a
  separate `undo`/`redo` event.

Exception: auth funnel events (`user_logged_in`, `user_logged_out`,
`password_reset_requested`) are tracked even though they don't mutate a
domain-table row, since they're standard funnel signal and effectively free
in volume (a handful of events per session).

## Backend routes & error tracking

Each Express route's existing `try`/`catch` gains a `track()` call on success
and a `trackError()` call in `catch`, using the resolved `user.id` (or
`"cron"` for the unauthenticated cron route) as `distinctId`:

| Route | Event | Properties |
|---|---|---|
| `POST /api/chat` | `chat_message_sent` | `organization_id`, `session_id`, `model`, `duration_ms`, `used_tool_call` |
| `DELETE /api/chat/history` | `chat_history_cleared` | `organization_id`, `session_id` |
| `POST /api/schedule/sync-jam` | `jam_sync_triggered` | `organization_id` |
| `GET /api/cron/sync-jam` | `jam_sync_triggered` (`via: "cron"`) | — |

`GET /api/chat/history` is a read — not tracked.

Frontend errors already reach PostHog via `capture_exceptions: true` in
`frontend/lib/posthog.ts`. Additionally, any page handler's own `catch` block
(where one exists) calls `trackError()` so a failed save is visible as an
error, not silently swallowed.

## Event taxonomy

### `frontend/pages/Schedule.tsx`

| Handler | Event | Properties |
|---|---|---|
| `handleAddEvent` / `handleAddOpponentGoal` | `game_event_added` | `game_id`, `event_type`, `is_opponent` |
| `handleUndo` | `game_event_deleted` (`via: "undo"`) | `game_id` |
| `handleSaveEventEdit` | `game_event_updated` | `game_id`, `event_id` |
| `handleDeleteEvent` | `game_event_deleted` | `game_id`, `event_id` |
| `handleEventDragStart`'s `onUp` | `game_event_reordered` | `game_id` |
| `handleSubmit` (new game) | `game_created` | `season_id` |
| `handleSaveEditGame` | `game_updated` | `game_id` |
| `handleDeleteGame` | `game_deleted` | `game_id` |
| `handleSaveOutcome` | `game_outcome_updated` | `game_id` |
| `handleSaveNotes` | `game_notes_updated` | `game_id` |
| `handleCreateNewSeason` | `season_created` | `season_id` |
| `handleSaveEditSeason` | `season_updated` | `season_id` |
| `handleSaveLineupTemplate` | `lineup_template_saved` | `game_id`, `template_id` |
| `handleApplyLineupTemplate` | `lineup_template_applied` | `game_id`, `template_id` |
| `handleDeleteLineupTemplate` | `lineup_template_deleted` | `template_id` |
| `handleCopySelectedLineup` | `lineup_copied` | `game_id` |
| `handleStartFreshLineup` | `lineup_reset` | `game_id` |
| `handleCreateGameFromConflict` | `game_created` (`source: "jam_sync"`) | `season_id`, `conflict_id` |
| `handleLinkJamConflict` | `jam_sync_conflict_linked` | `conflict_id`, `game_id` |
| `handleDismissJamConflict` | `jam_sync_conflict_dismissed` | `conflict_id` |
| `handleAddPlayer` / `handleAddAssister` | `player_created` | `game_id`, `source: "quick_add"` |
| `handleSyncJamNow`, navigation/dialog-open/local-selection handlers | *(not tracked)* | — |

### `frontend/pages/Roster.tsx`

| Handler | Event | Properties |
|---|---|---|
| `handleSaveEdit` | `player_updated` | `player_id` |
| `handleSaveSeasons` | `player_seasons_updated` | `player_id`, `season_count` |
| `handleDeletePlayer` | `player_deleted` | `player_id` |
| `handlePositionChange` | `player_role_updated` | `player_id`, `position` |
| `handleFileChange` | `player_photo_uploaded` | `player_id` |
| `handleCreatePlayer` | `player_created` | `player_id`, `season_count` |
| `handleCreateSeason` | `season_created` | `season_id` |
| `handleSaveManageRoster` | `season_roster_updated` | `season_id`, `added_count`, `removed_count` |
| Selection/edit-open/navigation handlers | *(not tracked)* | — |

### `frontend/pages/Stats.tsx`

| Handler | Event | Properties |
|---|---|---|
| `handleAddTeam` | `league_team_created` | `team_id`, `season_id` |
| `handleRenameTeam` | `league_team_renamed` | `team_id` |
| `handleDeleteTeam` | `league_team_deleted` | `team_id` |
| `handleSavePoints` | `season_points_updated` | `season_id` |
| `handleSaveNotes` | `league_team_notes_updated` | `team_id` |
| Column add/remove, sort, resize, game filter toggles | *(not tracked — client-only state)* | — |

### `frontend/pages/Strategy.tsx`

| Handler | Event | Properties |
|---|---|---|
| `handlePlace` | `play_player_moved` | `play_id`, `step_id`, `player_id` |
| `handleRemove` | `play_player_removed` | `play_id`, `step_id`, `player_id` |
| `handleAddOpponent` | `opponent_marker_created` | `play_id`, `step_id` |
| `handleMoveOpponent` | `opponent_marker_moved` | `play_id`, `step_id`, `opponent_marker_id` |
| `handleRenameOpponent` | `opponent_marker_renamed` | `play_id`, `step_id`, `opponent_marker_id` |
| `handleRemoveOpponent` | `opponent_marker_removed` | `play_id`, `step_id`, `opponent_marker_id` |
| `handleAddTextBox` | `text_box_created` | `play_id`, `step_id`, `text_box_id` |
| `handleMoveTextBox` | `text_box_moved` | `play_id`, `step_id`, `text_box_id` |
| `handleEditTextBox` | `text_box_text_edited` | `play_id`, `step_id`, `text_box_id` |
| `handleUpdateTextBoxStyle` | `text_box_style_updated` | `play_id`, `step_id`, `text_box_id` |
| `handleRemoveTextBox` | `text_box_removed` | `play_id`, `step_id`, `text_box_id` |
| `handleCreateArrow` | `arrow_created` | `play_id`, `step_id`, `arrow_id`, `arrow_type` |
| `handleUpdateArrow` | `arrow_moved` | `play_id`, `step_id`, `arrow_id` |
| `handleDeleteArrow` | `arrow_deleted` | `play_id`, `step_id`, `arrow_id` |
| `handleCreateHighlight` | `highlight_created` | `play_id`, `step_id`, `highlight_id` |
| `handleUpdateHighlightColor` | `highlight_color_updated` | `play_id`, `step_id`, `highlight_id` |
| `handleUpdateHighlightPoints` | `highlight_reshaped` | `play_id`, `step_id`, `highlight_id` |
| `handleUpdateHighlightLocked` | `highlight_lock_toggled` | `play_id`, `step_id`, `highlight_id`, `locked` |
| `handleDeleteHighlight` | `highlight_deleted` | `play_id`, `step_id`, `highlight_id` |
| `handleCreateLine` | `line_created` | `play_id`, `step_id`, `line_id` |
| `handleUpdateLineColor` | `line_color_updated` | `play_id`, `step_id`, `line_id` |
| `handleUpdateLinePoints` | `line_reshaped` | `play_id`, `step_id`, `line_id` |
| `handleUpdateLineLocked` | `line_lock_toggled` | `play_id`, `step_id`, `line_id`, `locked` |
| `handleDeleteLine` | `line_deleted` | `play_id`, `step_id`, `line_id` |
| `handleDeleteMany` | `play_selection_deleted` | `play_id`, `step_id`, `player_count`, `opponent_count`, `text_box_count`, `arrow_count` |
| `handleGroupMove` (`'commit'` phase only) | `play_selection_moved` | `play_id`, `step_id`, `player_count`, `opponent_count`, `text_box_count`, `arrow_count` |
| `handleCreate` | `play_created` | `play_id`, `game_id` |
| `handleRename` | `play_renamed` | `play_id` |
| `handleAssignGame` | `play_game_assigned` | `play_id`, `game_id` |
| `handleDelete` | `play_deleted` | `play_id` |
| `handleAddNewSub` | `player_created` | `player_id`, `game_id`, `is_sub: true`, `source: "strategy_add_sub"` |
| `handleAddExistingPlayer` | `game_player_added` | `player_id`, `game_id` |
| `handleAddStep` | `play_step_added` | `play_id`, `step_id` |
| `handleDeleteStep` | `play_step_deleted` | `play_id`, `step_id` |
| `undo`/`redo`, `'start'`/`'preview'`/`'cancel'` phases | *(not tracked — re-fires the underlying events, or no persistence)* | — |

`handleAddStep`'s seed calls (initial `upsertPosition`/`createOpponent`/
`createTextBox` for the new step's board) do **not** additionally fire
`play_player_moved`/`opponent_marker_created`/`text_box_created` — only
`play_step_added` fires, since the seeding is an implementation detail of
step creation, not a user-initiated edit of those items.

### `frontend/pages/Chat.tsx`

No frontend-only events — `sendMessage` and `clearHistory` are already
covered by the backend's `chat_message_sent` / `chat_history_cleared`
(see Backend routes above); tracking them again client-side would
double-count the same user action.

### Auth: `frontend/pages/Login.tsx`, `frontend/pages/CreateOrganization.tsx`, `frontend/contexts/AuthContext.tsx`

| Function | Event | Properties |
|---|---|---|
| `AuthContext.login` | `user_logged_in` | — |
| `AuthContext.loginWithPasskey` | `user_logged_in` (`via: "passkey"`) | — |
| `AuthContext.signup` | `user_signed_up` | — |
| `AuthContext.logout` | `user_logged_out` | — |
| `AuthContext.forgotPassword` | `password_reset_requested` | — |
| `AuthContext.createOrganization` | `organization_created` | `organization_id` |
| `AuthContext.joinOrganization` | `organization_joined` | `organization_id` |
| `switchOrg`, `loginWithGoogle` | *(not tracked)* | — |

Fired once, in `AuthContext.tsx` itself (not duplicated in `Login.tsx`/
`CreateOrganization.tsx`, which only call these context functions).
`loginWithGoogle` is a synchronous redirect (`window.location`) with no
awaited result to key success off, so a Google login doesn't fire
`user_logged_in` under this design — out of scope for now (YAGNI); if it
matters later, the natural hook is tracking on session-restore instead.

## Free-tier posture

- Dev traffic (frontend `import.meta.env.DEV`, backend `NODE_ENV !== 'production'`)
  never sends events, matching the pattern already established for the
  frontend `posthog.init()`.
- No per-frame or per-item event spam — drags fire once on commit, multi-selects
  fire one batched event.
- `person_profiles: 'identified_only'` (already configured) means anonymous
  pre-login browsing doesn't count as a billed person profile.
- For a small personal/team app, total realistic volume (even with every table
  in this spec instrumented) stays a small fraction of PostHog Cloud's free
  1M events/month.

## Implementation notes for the plan

- ~90 call sites across 8 files (7 pages + `AuthContext.tsx`) plus 2 new helper
  files (`frontend/lib/analytics.ts`, `server/lib/posthog.ts`) plus the 4
  backend route call sites in `server/index.ts`.
- Mechanical, repetitive, low-risk-per-site work — well suited to splitting
  by file across parallel subagents once a plan exists, since each file's
  edits are independent of the others.
- Testing: no automated test suite currently asserts on analytics calls in
  this repo; verification is manual — trigger a sample action per page in
  the browser preview and confirm the expected event lands in PostHog via
  the PostHog MCP's `execute-sql`, the same way the initial `posthog.init()`
  wiring was verified.
