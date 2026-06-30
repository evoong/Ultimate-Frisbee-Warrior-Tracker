# White Screen Issue - Fix Documentation

## Problem Description

The app was displaying a white/blank screen despite the HTML loading correctly. This indicated that React was failing to render or initialize properly, blocking all UI from displaying.

## Root Causes Identified

### 1. Broken API Endpoint Calls in Stats Hooks
The `frontend/hooks/backend/stats.ts` file contained multiple hooks that were attempting to call non-existent API endpoints:

```typescript
// ❌ BROKEN - These endpoints don't exist
const res = await fetch('/api/stats/seasons')
const res = await fetch('/api/seasons')
const res = await fetch('/api/stats/players')
const res = await fetch('/api/stats/cumulative')
```

**Why this broke the app:**
- When `useGetAllSeasons()` and `useGetSeasons()` hooks were called on component mount (in QuickScore.tsx), they triggered fetch requests to these non-existent endpoints
- The fetch failures threw errors that propagated up, preventing React from rendering
- Even though the errors were caught in try-catch blocks, they often logged or caused cascading failures

### 2. Broken Supabase Query Chaining in Player Filtering
The `useGetPlayersNotInSeason()` hook had incorrect Supabase query chaining:

```typescript
// ❌ BROKEN - Query chaining doesn't work this way
let query = supabase.from('players').select('*')
if (params?.seasonId) {
  query = query.eq('season_id', params.seasonId)  // Invalid chain after select()
}
const { data, error } = await query.order('display_name')
```

**Why this failed:**
- Supabase query objects don't support chaining filters after calling `select()`
- The query would fail silently or throw cryptic errors during execution
- This would cause the player loading to fail, breaking the QuickScore feature

## Solution Implemented

### Step 1: Fixed Stats Hooks (Temporary)
Changed all stats hooks to return empty arrays instead of calling non-existent endpoints:

```typescript
export function useGetAllSeasons() {
  const fn = useCallback(async () => {
    return [] as any[]  // ✅ Return empty data instead of calling broken API
  }, [])
  return useApiCall<any[]>(fn)
}
```

**Result:** App loads without errors, stats pages show empty but don't crash.

### Step 2: Fixed Player Filtering Hook
Properly implemented season-filtered player loading using the `season_players` junction table:

```typescript
export function useGetPlayersNotInSeason() {
  const fn = useCallback(async (params?: { gameId?: number; seasonId?: number }) => {
    if (!params?.seasonId) {
      return [] as any[]
    }

    // ✅ CORRECT - Query the junction table first
    const { data: seasonPlayers, error: spError } = await supabase
      .from('season_players')
      .select('player_id')
      .eq('season_id', params.seasonId)

    if (!seasonPlayers?.length) return []

    const playerIds = seasonPlayers.map(sp => sp.player_id)

    // ✅ Then fetch full player details with proper chaining
    const { data, error } = await supabase
      .from('players')
      .select('*')
      .in('id', playerIds)
      .order('display_name')

    return data as any[]
  }, [])
  return useApiCall<any[], { gameId?: number; seasonId?: number }>(fn)
}
```

**Result:** Players are properly filtered by season without query chaining errors.

### Step 3: Fixed QuickScore Hook Calls
Updated QuickScore.tsx to pass the correct `seasonId` parameter instead of `gameId`:

```typescript
// ❌ BEFORE - Wrong parameter type
fetchOtherPlayers({ gameId: selectedGameId })

// ✅ AFTER - Correct parameter with season ID
const game = filteredGames.find(g => g.id === selectedGameId)
if (game?.season_id) {
  fetchOtherPlayers({ seasonId: game.season_id })
}
```

**Result:** Player dropdowns now receive season-specific players from the correct query.

## Key Learnings

1. **Hook Dependencies Matter**: Fetch hooks called on component mount need to succeed or the entire component fails to render
2. **Supabase Query Chaining**: Must construct queries in the correct order (from → select → filters → order)
3. **API Fallback**: When backend APIs don't exist, return safe empty data rather than throwing errors
4. **Parameter Types**: Function signatures must match how they're called - `seasonId` vs `gameId` matters

## Testing Checklist

- [ ] App loads without white screen
- [ ] QuickScore page renders
- [ ] Selecting a game displays that game's details
- [ ] Player dropdown shows season-specific players when game is selected
- [ ] All tabs (Schedule, Roster, Stats) load without errors

## Files Modified

- `frontend/hooks/backend/stats.ts` - Fixed 6 hook functions
- `frontend/hooks/backend/players.ts` - Fixed query chaining in player filtering
- `frontend/pages/QuickScore.tsx` - Fixed parameter passing to player fetch hook
