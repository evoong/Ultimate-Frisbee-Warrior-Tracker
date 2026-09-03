# Top Pairings (assist-pairing chemistry): design

## Summary

Add a "Top Pairings" card to the Stats page's Overview tab showing the
most-connected scorer/assister pairs (e.g. "Alice ← Bob: 6"), as a ranked
horizontal bar chart. It reuses the Overview tab's existing filter state
(all-time / season / specific games) and the same scorer=`player_id`,
assister=`related_player_id` convention already used everywhere else
(`useGetPlayerStats`, the AI chat's `queryStatBreakdown`).

## Goals

- Surface "who connects with whom" as a first-class, always-visible stat,
  not something only discoverable by asking the AI chat.
- Reuse the exact same counting rule the codebase already trusts: a `Goal`
  event with a non-null `related_player_id` credits `player_id` (scorer) and
  `related_player_id` (assister); unassisted goals are excluded.
- Respect the Overview tab's existing filter (all-time / season / games) —
  no separate filter UI.
- Match the page's existing chart look and loading/empty/error states.

## Non-goals (deliberately out of scope)

- Full player×player matrix/heatmap grid. A ranked top-N list is more
  legible for a roster-sized player count and avoids a mostly-empty grid;
  a matrix view can be added later as a toggle without changing the data
  shape below.
- New backend endpoint. Every other Stats aggregate is computed client-side
  via direct Supabase queries (`frontend/hooks/backend/stats.ts`); this
  follows the same pattern.
- Any change to how assists are recorded or displayed elsewhere.

## Data

New hook `useGetAssistPairings` in `frontend/hooks/backend/stats.ts`,
placed next to `useGetPlayerStats` and mirroring its game-scoping logic
(lines ~117-146 of that file) exactly:

1. Resolve `scopedGameIds`: same three-way logic as `useGetPlayerStats` —
   explicit `gameIds` param wins; else games in the given `seasonIds`; else
   `null` (all-time, unfiltered).
2. Fetch `game_events` (`player_id, related_player_id, event_type`),
   filtered to `scopedGameIds` when not null.
3. Fetch `players` (`id, display_name`) for the organization, into a
   `Map<id, display_name>`.
4. Tally: for each event where `event_type === 'Goal' && player_id &&
   related_player_id`, increment a count keyed by `` `${player_id}:${related_player_id}` ``.
5. Map tallied rows to
   `{ scorerId, assisterId, scorerName, assisterName, count }`, drop
   entries whose scorer or assister isn't in `playersMap` (deleted/foreign
   player), sort by `count` descending (ties broken alphabetically by
   `scorerName` for a stable order), and return the top 10.

Return type:

```ts
type PairingRow = {
  scorerId: number
  assisterId: number
  scorerName: string
  assisterName: string
  count: number
}
```

No new table, migration, or REST endpoint.

## Page wiring (`frontend/pages/Stats.tsx`)

In `PlayerStatsView`:

- Call `useGetAssistPairings()` alongside the existing `useGetPlayerStats`/
  `useGetCumulativeStats` calls (same destructuring pattern: `data`,
  `loading`, `error`, `trigger`).
- Extend the existing effect that calls `fetchStats` on
  `[filterType, selectedSeasonIds, selectedGameIds, currentOrgId]` (around
  line 357) to also call the pairings trigger with the same
  `{ organizationId, seasonIds | gameIds }` argument for each branch, so it
  always reflects the same scope as the Performance Chart above it — no
  separate filter UI or independent effect.
- Only render this section for `tab === 'overview'` (not `'table'`), placed
  as a new `Card` directly after the "Performance Chart" bar chart card and
  before "Season Progression" (which has its own independent season
  selector and shouldn't be confused with the shared-filter section above
  it).

## Rendering

A `Card` matching the Performance Chart card's structure:

- `CardHeader`: title "Top Pairings" with an icon (reuse `Target` or a
  similar existing lucide icon already imported), no sub-controls (filter
  is inherited from the Filters card above).
- `CardContent`:
  - Loading: skeleton rows matching the Performance Chart's skeleton
    pattern (label + bar placeholder per row).
  - Error: same `text-destructive` inline message pattern.
  - Data present: `ResponsiveContainer` + `BarChart` with
    `layout="vertical"`, one bar per pairing, `YAxis` category label
    `` `${scorerName} ← ${assisterName}` `` , `XAxis` numeric (assist count),
    single bar color (reuse the existing blue `#2563eb` used for assists
    elsewhere on this page for visual consistency), `Tooltip` showing the
    exact count. Height scales with row count like the Performance Chart
    (`Math.max(160, rows.length * 32)`).
  - Empty (`rows.length === 0`): centered icon + "No assisted goals in this
    range yet" message, matching the Performance Chart's empty-state
    pattern (including the games-filter-specific copy when
    `filterType === 'games' && selectedGameIds.length === 0`).

## Testing

- Typecheck: `cd frontend && npx tsc --noEmit`.
- Manual verification against the running dev server:
  - All-time view shows a non-empty ranked list (assuming seed data has
    assisted goals).
  - Switching to a specific season or a specific game subset updates the
    list to match that scope, including going empty when the scope has no
    assisted goals.
  - Cross-check the top pairing's count against what the AI chat reports
    for the same scope via `query_stat_breakdown`, to confirm the new
    hook's tally agrees with the already-trusted logic in
    `gateway/gameActions.ts`.
  - Confirm the card does not render on the "Player Rankings" (`table`)
    tab.

## Files touched

- `frontend/hooks/backend/stats.ts` (new `useGetAssistPairings` hook)
- `frontend/pages/Stats.tsx` (new card wiring in `PlayerStatsView`)
