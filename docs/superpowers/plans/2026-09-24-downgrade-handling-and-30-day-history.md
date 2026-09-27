# Downgrade Handling and 30-Day History Enforcement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the "30-day stats history" limit for Free tier organizations while preserving all historical data for automatic restore upon re-upgrading.

**Architecture:** Drop and recreate the SELECT RLS policy on `public.game_events` to dynamically filter out events belonging to games older than 30 days for Free tier organizations. Add corresponding filters to the service-role chat context queries and MCP tool aggregations. Update the frontend UI to display informational banners when history is restricted.

**Tech Stack:** Supabase Postgres RLS, Express Node API, React + TypeScript Frontend, Vitest, pgTAP.

**Spec:** `docs/superpowers/specs/2026-09-24-downgrade-handling-design.md`

## Global Constraints
- **Free Cutoff**: Stats history older than 30 days from current date is hidden for Free organizations.
- **Data Integrity**: Past fixtures (`games` rows) and outcomes remain visible. Old events must not be deleted.
- **Automatic Restore**: Upgrading instantly reveals all historical event data.
- **Universal Enforcement**: Applies to direct Supabase RLS, server AI Chat context, and MCP tools.

## Review Focus
- **RLS Boundary**: Ensure a Free tier user can query `games` older than 30 days but gets zero rows from `game_events` for those same games.
- **Auto-Restore**: Confirm that changing organizations.tier to `plus` or `premium` instantly reveals old game events to users.
- **Service Role Bypass**: Confirm that the gateway chat context generator applies the 30-day filter for Free orgs even though it queries with the service role.
- **No deletion on downgrade**: Verify that no data is mutated or lost when an organization's tier is updated to `free`.
- **Stats banner**: Verify the Stats page renders a warning banner specifically for Free teams.

---

### Task 1: Database RLS update and pgTAP tests

**Files:**
- Create: `supabase/migrations/20260924150000_downgrade_history_limits.sql`
- Test: `supabase/tests/23_downgrade_history_limits.test.sql`

**Interfaces:**
- Consumes: `public.game_events`, `public.games`, `public.organizations`, `public.effective_tier`
- Produces: Tier-aware select RLS policy on `public.game_events`

- [ ] **Step 1: Write the failing pgTAP test**

```sql
-- supabase/tests/23_downgrade_history_limits.test.sql
begin;
select plan(5);

-- 1. Setup mock org and games
insert into public.organizations (id, name, tier, plan_source)
values (1001, 'Free Org', 'free'::public.org_tier, 'stripe'::public.plan_source_type);

insert into public.games (id, organization_id, opponent, game_date, game_time, game_type)
values 
  (101, 1001, 'Old Opponent', current_date - interval '31 days', '19:00', 'Regular'),
  (102, 1001, 'Recent Opponent', current_date - interval '15 days', '19:00', 'Regular');

insert into public.game_events (id, organization_id, game_id, event_type, event_timestamp)
values
  (1001, 1001, 101, 'Goal', now() - interval '31 days'),
  (1002, 1001, 102, 'Goal', now() - interval '15 days');

-- Mock auth session
select tests.login_as('member@local.test'); -- assuming user member setup or bypass RLS check

-- Verify existing behavior allows reading both (will fail after RLS update)
select results_eq(
  $$ select count(*)::int from public.game_events where organization_id = 1001 $$,
  $$ values (1) $$, -- Old behavior had 2; we assert the new 1-row cutoff directly to watch it fail
  'Free org select RLS should restrict game events to those within past 30 days'
);

select * from finish();
rollback;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx supabase test db --filter 23_downgrade_history_limits`
Expected: FAIL (returns 2 rows instead of 1).

- [ ] **Step 3: Write minimal migration**

Create `supabase/migrations/20260924150000_downgrade_history_limits.sql`:
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx supabase db reset && npx supabase test db --filter 23_downgrade_history_limits`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260924150000_downgrade_history_limits.sql supabase/tests/23_downgrade_history_limits.test.sql
git commit -m "feat(billing): tier-aware game_events select RLS policy"
```

---

### Task 2: Server-side and Gateway Query Filters

**Files:**
- Modify: `server/index.ts`
- Modify: `gateway/chat.ts`
- Modify: `mcp-server/index.ts`
- Modify: `gateway/mcpTools.ts`

**Interfaces:**
- Consumes: `getOrgEffectiveTier(orgId)`, raw Postgres/Supabase queries
- Produces: Service-role query results with 30-day stats window enforced for Free tier

- [ ] **Step 1: Write failing integration test**

Add to `server/test/billingWebhook.test.mjs` or separate test file:
```js
// Write check ensuring Chat/MCP queries enforce 30-day cutoff on Free orgs.
// Re-upgrading immediately restores them.
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node node_modules/tsx/dist/cli.mjs server/test/billingWebhook.test.mjs`
Expected: FAIL or incomplete checks.

- [ ] **Step 3: Write minimal implementation**

In `gateway/chat.ts` and `server/index.ts`'s `getTeamContext`:
```ts
const tier = await getOrgEffectiveTier(organizationId);
const eventsQuery = tier === 'free'
  ? `/game_events?select=player_id,related_player_id,event_type,game_id,event_timestamp&${orgFilter}&event_timestamp=gte.${new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()}`
  : `/game_events?select=player_id,related_player_id,event_type,game_id,event_timestamp&${orgFilter}`;
```

Apply similar filter to MCP server `get_player_stats` and `list_game_events` tool queries when effective tier is `'free'`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node node_modules/tsx/dist/cli.mjs server/test/billingWebhook.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/index.ts gateway/chat.ts mcp-server/index.ts gateway/mcpTools.ts
git commit -m "feat(billing): enforce 30-day history limit on Chat and MCP tools"
```

---

### Task 3: Frontend UI banners and box score archived warnings

**Files:**
- Modify: `frontend/pages/Stats.tsx`
- Modify: `frontend/pages/Schedule.tsx`
- Test: `frontend/components/TierDetails.test.tsx`

**Interfaces:**
- Consumes: `useEffectiveTier`
- Produces: Notice banners on Stats page and archived notice in box scores

- [ ] **Step 1: Write failing frontend test**

Add to `frontend/components/TierDetails.test.tsx`:
```tsx
it('renders stats history archive notice on Free tier', () => {
  // expect banner explaining 30-day limit to be in document
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:frontend`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

In `frontend/pages/Stats.tsx`:
```tsx
{tier === 'free' && (
  <div className="mb-4 p-3 border border-border bg-secondary/30 rounded-lg text-xs text-muted-foreground">
    Free tier: stats reflect the last 30 days. Upgrade for complete history.
  </div>
)}
```

In `frontend/pages/Schedule.tsx` game detail / box score pane, if the game is older than 30 days and org is Free:
```tsx
<div className="text-center p-6 text-xs text-muted-foreground border border-dashed border-border rounded-lg">
  Detailed stats for this game are archived on the Free plan. Upgrade to view box scores.
</div>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:frontend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/pages/Stats.tsx frontend/pages/Schedule.tsx
git commit -m "feat(billing): display stats history warning banners on Free tier"
```
