# Top Pairings (assist-chemistry Stats card) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Top Pairings" card to the Stats page's Overview tab that ranks the top 10 scorer/assister pairs by assist count, scoped by the tab's existing all-time/season/games filter.

**Architecture:** A new client-side aggregation hook (`useGetAssistPairings`) added to `frontend/hooks/backend/stats.ts`, following the exact game-scoping and Supabase-query pattern already used by `useGetPlayerStats` in the same file. The Stats page (`frontend/pages/Stats.tsx`) wires the hook into `PlayerStatsView`'s existing filter effect and renders a new Recharts horizontal bar chart card, styled like the existing "Performance Chart" card.

**Tech Stack:** React + TypeScript (Vite), Supabase JS client (`frontend/lib/supabase.ts`), Recharts (already a dependency).

**Spec:** `docs/superpowers/specs/2026-09-02-top-pairings-design.md`

## Global Constraints

- Scorer = `game_events.player_id`, assister = `game_events.related_player_id`, on a `Goal` event; unassisted goals (`related_player_id` null) are excluded — this is the same rule used throughout the codebase (`useGetPlayerStats`, `gateway/gameActions.ts`'s `queryStatBreakdown`). Do not invent a different counting rule.
- No new backend endpoint, table, or migration. All aggregation is client-side, matching every other Stats aggregate.
- Reuse the Overview tab's existing filter state (`filterType`, `selectedSeasonIds`, `selectedGameIds`) — do not add a separate filter control for this card.
- This frontend project has no automated test runner (no Jest/Vitest configured; `frontend/package.json` only has `dev`/`build`/`preview` scripts). The verification loop for both tasks is: `cd frontend && npx tsc --noEmit` for type-correctness, plus manual verification in the running dev server — matching the "Testing" convention already used by this codebase's other specs (e.g. `docs/superpowers/specs/2026-07-04-strategy-board-arrows-design.md`). Do not attempt to introduce a new test framework as part of this plan.

---

### Task 1: Add `useGetAssistPairings` hook

**Files:**
- Modify: `frontend/hooks/backend/stats.ts` (add new exported hook after `useGetPlayerStats`, i.e. after line 254)

**Interfaces:**
- Consumes: nothing new — uses the existing `supabase` client import (`frontend/lib/supabase.ts`) and the existing `useApiCall`/`HookResult` helpers already defined at the top of this file.
- Produces: `useGetAssistPairings()`, returning `HookResult<PairingRow[], { organizationId: number | null; seasonIds?: number[]; gameIds?: number[] }>` where:
  ```ts
  type PairingRow = {
    scorerId: number
    assisterId: number
    scorerName: string
    assisterName: string
    count: number
  }
  ```
  Later tasks (Task 2) consume this as `const { data: pairings, loading: pairingsLoading, error: pairingsError, trigger: fetchPairings } = useGetAssistPairings()`.

- [ ] **Step 1: Add the `PairingRow` type and the hook**

Insert the following directly after the closing of `useGetPlayerStats` (after line 254, i.e. after the `return useApiCall<any[], ...>(fn)` line and its closing `}`), in `frontend/hooks/backend/stats.ts`:

```ts
export type PairingRow = {
  scorerId: number
  assisterId: number
  scorerName: string
  assisterName: string
  count: number
}

export function useGetAssistPairings() {
  const fn = useCallback(async (params: { organizationId: number | null; seasonIds?: number[]; gameIds?: number[] }) => {
    // Resolve the games in scope first, same three-way logic as useGetPlayerStats:
    // explicit gameIds wins, else games in seasonIds, else null (all-time).
    let gamesQuery = supabase.from('games').select('id, season_id').eq('organization_id', params.organizationId)
    if (params?.seasonIds && params.seasonIds.length > 0) {
      gamesQuery = gamesQuery.in('season_id', params.seasonIds)
    }
    const { data: games, error: gamesError } = await gamesQuery
    if (gamesError) throw new Error(gamesError.message)

    const scopedGameIds = params?.gameIds && params.gameIds.length > 0
      ? params.gameIds
      : params?.seasonIds && params.seasonIds.length > 0
        ? (games ?? []).map((g: any) => g.id)
        : null

    let eventsQuery = supabase
      .from('game_events')
      .select('player_id, related_player_id, event_type')
    if (scopedGameIds) eventsQuery = eventsQuery.in('game_id', scopedGameIds)
    const { data: events, error: eventsError } = await eventsQuery
    if (eventsError) throw new Error(eventsError.message)

    const { data: players, error: playersError } = await supabase
      .from('players')
      .select('id, display_name')
      .eq('organization_id', params.organizationId)
    if (playersError) throw new Error(playersError.message)

    const playersMap = new Map(players?.map((p: any) => [p.id, p.display_name as string]) ?? [])

    const tally = new Map<string, { scorerId: number; assisterId: number; count: number }>()
    ;(events ?? []).forEach((e: any) => {
      if (e.event_type !== 'Goal' || !e.player_id || !e.related_player_id) return
      const key = `${e.player_id}:${e.related_player_id}`
      const row = tally.get(key) ?? { scorerId: e.player_id, assisterId: e.related_player_id, count: 0 }
      row.count++
      tally.set(key, row)
    })

    const rows: PairingRow[] = [...tally.values()]
      .filter(r => playersMap.has(r.scorerId) && playersMap.has(r.assisterId))
      .map(r => ({
        scorerId: r.scorerId,
        assisterId: r.assisterId,
        scorerName: playersMap.get(r.scorerId)!,
        assisterName: playersMap.get(r.assisterId)!,
        count: r.count,
      }))

    rows.sort((a, b) => b.count - a.count || a.scorerName.localeCompare(b.scorerName))

    return rows.slice(0, 10)
  }, [])
  return useApiCall<PairingRow[], { organizationId: number | null; seasonIds?: number[]; gameIds?: number[] }>(fn)
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors attributable to `stats.ts` (pre-existing unrelated errors elsewhere, if any, are not this task's concern — compare the error list to a run from before this change if unsure).

- [ ] **Step 3: Commit**

```bash
git add frontend/hooks/backend/stats.ts
git commit -m "Add useGetAssistPairings hook for top scorer/assister pairings"
```

---

### Task 2: Wire the "Top Pairings" card into the Stats Overview tab

**Files:**
- Modify: `frontend/pages/Stats.tsx`

**Interfaces:**
- Consumes: `useGetAssistPairings` and `PairingRow` from `frontend/hooks/backend/stats.ts` (Task 1). Existing `PlayerStatsView` state: `filterType`, `selectedSeasonIds`, `selectedGameIds`, `currentOrgId`, `tab`.
- Produces: nothing consumed by other tasks — this is the final task.

- [ ] **Step 1: Import the hook and type**

In `frontend/pages/Stats.tsx`, find the existing import (line 6):

```ts
import { useGetPlayerStats, useGetSeasons, useGetCumulativeStats, useGetAllSeasons } from '../hooks/backend/stats'
```

Replace it with:

```ts
import { useGetPlayerStats, useGetSeasons, useGetCumulativeStats, useGetAllSeasons, useGetAssistPairings, type PairingRow } from '../hooks/backend/stats'
```

- [ ] **Step 2: Call the hook in `PlayerStatsView`**

In `PlayerStatsView` (around line 221-223), find:

```ts
  const { data: stats, loading, error, trigger: fetchStats } = useGetPlayerStats()
  const { data: cumulativeRaw, loading: cumulativeLoading, trigger: fetchCumulative } = useGetCumulativeStats()
  const { data: progressionRoster, trigger: fetchProgressionRoster } = useGetPlayers()
```

Add a line right after it:

```ts
  const { data: pairings, loading: pairingsLoading, error: pairingsError, trigger: fetchPairings } = useGetAssistPairings()
```

- [ ] **Step 3: Trigger the fetch alongside the existing stats fetch**

Find the effect at lines 355-363:

```ts
  useEffect(() => {
    if (currentOrgId == null) return
    if (filterType === 'all') fetchStats({ organizationId: currentOrgId })
    else if (filterType === 'season') {
      if (selectedSeasonIds.length > 0) fetchStats({ seasonIds: selectedSeasonIds, organizationId: currentOrgId })
      else fetchStats({ organizationId: currentOrgId })
    }
    else if (filterType === 'games' && selectedGameIds.length > 0) fetchStats({ gameIds: selectedGameIds, organizationId: currentOrgId })
  }, [filterType, selectedSeasonIds, selectedGameIds, currentOrgId])
```

Replace it with (mirroring each branch's args into `fetchPairings` too):

```ts
  useEffect(() => {
    if (currentOrgId == null) return
    if (filterType === 'all') {
      fetchStats({ organizationId: currentOrgId })
      fetchPairings({ organizationId: currentOrgId })
    } else if (filterType === 'season') {
      if (selectedSeasonIds.length > 0) {
        fetchStats({ seasonIds: selectedSeasonIds, organizationId: currentOrgId })
        fetchPairings({ seasonIds: selectedSeasonIds, organizationId: currentOrgId })
      } else {
        fetchStats({ organizationId: currentOrgId })
        fetchPairings({ organizationId: currentOrgId })
      }
    } else if (filterType === 'games' && selectedGameIds.length > 0) {
      fetchStats({ gameIds: selectedGameIds, organizationId: currentOrgId })
      fetchPairings({ gameIds: selectedGameIds, organizationId: currentOrgId })
    }
  }, [filterType, selectedSeasonIds, selectedGameIds, currentOrgId])
```

- [ ] **Step 4: Build the chart data and render the card**

Find the "Bar chart" card block, which starts at line 652 (`{/* Bar chart */}`) and ends at line 704 (its closing `</Card>`). Immediately after that closing `</Card>` (and before the `{/* Cumulative Progression Chart */}` comment at line 706), insert a new card. First, add a small derived-data line near the top of the JSX return — immediately before the `return (` statement at line 540, add:

```ts
  const pairingRows = (pairings as PairingRow[] | undefined) ?? []
```

Then insert the new card:

```tsx
          {/* Top Pairings */}
          <Card className="bg-card text-card-foreground border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Target className="w-4 h-4" />Top Pairings
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-2">
              {pairingsLoading ? (
                <div className="space-y-4 py-2">
                  {[0.9, 0.75, 0.6, 0.5, 0.4].map((w, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <Skeleton className="h-3 w-24 shrink-0" />
                      <Skeleton className="h-3.5" style={{ width: `${w * 100}%` }} />
                    </div>
                  ))}
                </div>
              ) : pairingsError ? (
                <div className="flex items-center justify-center h-48 text-destructive text-sm">Error: {pairingsError}</div>
              ) : pairingRows.length > 0 ? (
                <FadeIn className="w-full" style={{ height: Math.max(160, pairingRows.length * 32) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={pairingRows.map(r => ({ pairLabel: `${r.scorerName} ← ${r.assisterName}`, Assists: r.count }))}
                      layout="vertical"
                      margin={{ top: 0, right: 16, left: 0, bottom: 0 }}
                      barCategoryGap="20%"
                    >
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                      <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                      <YAxis type="category" dataKey="pairLabel" width={140} tick={{ fontSize: 11, fill: 'hsl(var(--foreground))' }} axisLine={false} tickLine={false} />
                      <Tooltip cursor={{ fill: 'hsl(var(--accent))' }} />
                      <Bar dataKey="Assists" fill="#2563eb" radius={[0, 3, 3, 0]} maxBarSize={14} />
                    </BarChart>
                  </ResponsiveContainer>
                </FadeIn>
              ) : (
                <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
                  <Target className="w-12 h-12 mb-3 opacity-40" />
                  <p className="text-sm">{filterType === 'games' && selectedGameIds.length === 0 ? 'Select games to view stats' : 'No assisted goals in this range yet'}</p>
                </div>
              )}
            </CardContent>
          </Card>
```

Note: this card must be inside the same `{tab === 'overview' && (<> ... </>)}` block that the Performance Chart card is in (it already is, since you're inserting right after that card and before the fragment's other children) — do not render it for `tab === 'table'`.

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors attributable to `Stats.tsx`.

- [ ] **Step 6: Manual verification in the dev server**

Start the frontend dev server (per `.claude/launch.json`'s "Vite Frontend" config, port 5199) and the Express API server (port 3001) per `CLAUDE.md`'s setup instructions. Then, on the Stats page's Overview tab:

1. Confirm a "Top Pairings" card appears below "Performance Chart" and above "Season Progression", showing up to 10 bars labeled like "Alice ← Bob", sorted descending by count.
2. Switch the Filters card between "All Games", "By Season" (pick a season), and "Specific Games" (pick a subset) — confirm the Top Pairings card's bars update to match each scope, and that switching to a scope with no assisted goals shows "No assisted goals in this range yet" rather than an empty chart or a crash.
3. Switch to the "Player Rankings" tab and confirm the Top Pairings card does not render there.
4. Pick the top pairing shown and cross-check its count against the same scope's answer from the AI chat (ask it something like "who has assisted \<top scorer\> the most this season/game" for the matching scope) to confirm the two independent tallies agree.

- [ ] **Step 7: Commit**

```bash
git add frontend/pages/Stats.tsx
git commit -m "Add Top Pairings card to Stats Overview tab"
```
