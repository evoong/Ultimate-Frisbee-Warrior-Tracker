# Downgrade Handling and 30-Day History Enforcement Design

## 1. Overview
This design defines how subscription downgrades (from Plus/Premium to Free) are enforced across the platform. While existing member, strategy, and AI message limits are already enforced at write time via triggers and RPCs, the **"30-day stats history" limit on the Free tier** requires read-time enforcement so that downgraded teams cannot access historical performance data beyond 30 days, while keeping all data safely stored in the database for automatic restoration upon re-upgrading.

## 2. Requirements & Scope
- **Free Tier Cutoff**: Detailed game events (goals, assists, turnovers, box score lines, event timelines) for games where `game_date < now() - interval '30 days'` are excluded for organizations on the Free tier.
- **Fixtures & Schedule Unaffected**: Past games, opponent names, dates, locations, and high-level results (`games.result`, `games.outcome_override`) remain visible.
- **Universal Enforcement**: Applies to all viewer contexts:
  1. Signed-in team members and public visitors querying Supabase directly via the frontend.
  2. AI Chat Context generator (`server/index.ts` and `gateway/chat.ts`).
  3. Model Context Protocol tools (`gateway/mcpTools.ts` and `mcp-server/index.ts`).
- **Data Integrity**: No data is deleted or permanently archived upon downgrade. Re-upgrading to Plus or Premium immediately restores full historical access with zero data loss.
- **Write Limits Unchanged**: Existing triggers on `team_members` (max 15 on Free) and `strategy_plays` (max 3 on Free) block new additions without deleting excess records.

---

## 3. Database Layer (RLS Enforcement)

### `public.game_events` Policy Update
`game_events` currently uses a single `"member read"` policy created in `20260903001200_strict_rls.sql` that permits reads for members or public teams.
We drop `"member read"` on `public.game_events` and replace it with a tier-aware policy:

```sql
drop policy if exists "member read" on public.game_events;

create policy "member read" on public.game_events
  for select to authenticated
  using (
    (
      organization_id = any ((select public.my_member_team_ids())::bigint[])
      or organization_id = any ((select public.public_team_ids())::bigint[])
    )
    and (
      public.effective_tier(organization_id) != 'free'
      or exists (
        select 1 from public.games g
        where g.id = game_events.game_id
          and g.game_date >= (current_date - interval '30 days')
      )
    )
  );
```

*Note:* `current_date - interval '30 days'` correctly aligns with calendar dates of `games.game_date`.

---

## 4. Server-Side & Gateway Query Adjustments

Service-role queries bypass RLS. Therefore, server-side data aggregation must include an explicit tier filter:

1. **AI Chat Context (`server/index.ts` & `gateway/chat.ts`)**:
   - Check `getOrgEffectiveTier(organizationId)`.
   - If `free`, add `.gte('event_timestamp', thirtyDaysAgo)` to the `game_events` query or exclude events belonging to games older than 30 days.
2. **MCP Tools (`gateway/mcpTools.ts` & `mcp-server/index.ts`)**:
   - When fetching game events or player stats for a Free organization, apply the 30-day cutoff to event queries.

---

## 5. Frontend UI & UX

1. **Stats Page (`frontend/pages/Stats.tsx`)**:
   - Display an informational banner when the current team is on Free:
     *"Free tier: stats reflect the last 30 days. Upgrade for complete all-time history."*
2. **Game Box Scores (`frontend/pages/Schedule.tsx`)**:
   - For games older than 30 days on Free tier, box scores will naturally have no events returned by RLS. Display a clean indicator:
     *"Detailed stats for this game are archived on the Free plan. Upgrade to view box scores."*
3. **Player Detail / Roster (`frontend/pages/Roster.tsx` / `PlayerDetail`)**:
   - Past game attendance remains visible (from `game_lineups`), but event totals (goals, assists, turnovers) reflect only the permitted window.

---

## 6. Testing & Verification

- **pgTAP Database Tests (`supabase/tests/23_downgrade_history_limits.test.sql`)**:
  - Insert old game (>30 days) and recent game (<30 days) with game events for a Free org.
  - Verify `select count(*) from game_events` as an authenticated user only returns events for the recent game.
  - Upgrade org to `plus` or `premium` via `organizations.tier`; verify all events immediately become readable.
  - Test downgrade via `effective_tier` reverting back to `free`; verify old events become inaccessible again.
- **Frontend / Integration Tests**:
  - Verify banner renders on Stats page for Free tier.
  - Verify box score displays the upgrade notice for older games.
