# Admin Organizations Table & Internal Dashboard — Design Spec

Date: 2026-09-25
Status: design approved in chat; implementation plan to follow
Branch target: fresh branch off main

## Purpose

The admin console gains:

1. **Organizations table** — a paginated, sortable, searchable list of every
   organization, with the core columns (id, name, public/private, tier,
   member count, created, last activity), each row clicking through to the
   existing Org Detail page.
2. **Internal dashboard** — a multi-tab landing view with the app's important
   metrics across four groups (product usage, billing & AI, engagement &
   retention, ops & support signals), over a customizable date range and
   grouping grain.

Access: all admin roles (readonly included — everything here is read-only).
The dashboard replaces Search as the `/admin` default landing tab.

## Data model

No new tables. Everything is computed on demand from existing production
tables (all present on prod as of 2026-09-25: billing lifecycle, AI usage
logs, stripe webhook tables are applied).

## RPCs

New migration `supabase/migrations/20260926000000_admin_dashboard.sql`.
Service-role only, `security definer`, `set search_path = ''`, revoked from
public/anon/authenticated — identical conventions to
`20260924000000_admin_org_profile_flags.sql`.

### `admin_list_organizations(p_q text, p_sort text, p_dir text, p_limit int, p_offset int)`

Returns `{ rows: [...], total: bigint }`.

Row shape:

```jsonc
{ "id": 3, "name": "JAM", "is_public": true, "tier": "pro",
  "members": 11, "created_at": "2026-06-29…", "last_activity": "2026-09-20…" }
```

- `members` = count of `team_members` rows (captain+editor+member).
- `last_activity` = max created_at across `chat_logs`, `game_events`,
  `game_attendance`, `strategy_plays` for that org — same recipe as
  `admin_org_detail.metrics.last_activity`; null when the org has none.
- `p_sort` whitelist: `name | members | created_at | last_activity | tier`.
  Anything else raises. `p_dir` whitelist: `asc | desc`.
- `p_q` = ILIKE '%q%' on name; null/empty = no filter.
- `p_limit` default 50, max 200; `p_offset` >= 0.
- `last_activity`/`members` sort orders fall back sensibly: nulls last on
  desc, first on asc (explicit `nulls last`/`nulls first` — never implicit).

### `admin_dashboard(p_from date, p_grain_* …)`

Signature: `admin_dashboard(p_from date, p_to date, p_grain text)`.

Validation:
- `p_grain` whitelist: `day | week | month`. Anything else raises.
- `p_to` null → `current_date`. `p_from` null → `p_to - 29`.
- Range cap: `p_to - p_from` may not exceed 370 days; raises beyond.
- `p_from > p_to` raises.

Returns one JSON object; every series is bucketed at `p_grain` over
`[p_from, p_to]`:

```jsonc
{
  "range": { "from": "…", "to": "…", "grain": "day" },
  "usage": {
    "totals": { "orgs": 1, "members": 11, "players": 25, "games": 34, "game_events": 512 },
    "series": {
      "new_orgs":      [{ "bucket": "2026-09-01", "count": 0 }],
      "new_games":     [{ "bucket": "…", "count": 2 }],
      "new_events":    [{ "bucket": "…", "count": 40 }]
    }
  },
  "billing": {
    "tier_mix":   { "free": 1, "pro": 0, "employee": 0 },
    "active_trials": 0,
    "ai_messages_in_range": 166,
    "ai_cap_by_tier": { "free": "…cap value…", "pro": "…" }
  },
  "engagement": {
    "sign_ins":  [{ "bucket": "…", "count": 3 }],
    "active_orgs_in_range": 1,
    "dormant_orgs": 0
  },
  "ops": {
    "top_orgs_by_events": [{ "id": 3, "name": "JAM", "game_events": 512 }],
    "pending_invites": 0,
    "unclaimed_player_links": 0,
    "audit_events_in_range": 0
  }
}
```

Bucketing details and honest limitations:
- Series buckets are `date_trunc(grain, created_at)` for all of new_orgs,
  new_games, new_events; empty buckets must appear as 0 (generate_series
  over the range, left-joined) so charts don't drop gaps.
- `sign_ins` uses `auth.users.last_sign_in_at` — a single "last" timestamp,
  not an event log. The series counts users whose *most recent* sign-in
  falls in the bucket. Documented here as a limitation; it undercounts
  infrequent users and cannot show repeat activity. It is the best available
  without new instrumentation.
- `active_orgs_in_range` = orgs with any row in the four activity tables in
  range; `dormant_orgs` = all orgs minus that (dormant is relative to the
  selected range).
- `ai_messages_in_range` counts `chat_logs` rows in range (that is the AI
  chat table; `ai_usage_logs` only keeps monthly counters, not dates).
- `ai_cap_by_tier` mirrors the enforced caps in
  `consume_ai_message` (`20260923140114_cap_premium_ai_usage.sql`):
  `{"free": 5, "plus": 100, "premium": 500}`. Hardcoded in the spec because
  it is hardcoded in the function; if the function's case statement changes,
  this RPC's constant must change with it.
- `tier_mix` counts by `organizations.tier` — enum `org_tier` is
  `free | plus | premium`; `is_employee_granted` orgs report via their tier
  value, with an `employee_granted` count surfaced separately inside
  `tier_mix`; `active_trials` = `trial_ends_at > now()`. Tier resolution for
  counts uses the raw `organizations.tier` column; `effective_tier()` is
  per-org resolution and not needed for aggregate counts.
- `ops.top_orgs_by_events` = top 5 orgs by game_events in range.
- `pending_invites` = unaccepted `team_invites` total;
  `unclaimed_player_links` = pending `player_links`;
  `audit_events_in_range` = `admin_audit_log` rows in range.

## Routes (`gateway/admin/reads.ts`)

Both readonly+ (every admin role), both through the existing
`handleAdminRead` dispatch:

- `GET /api/admin/orgs?q&sort&dir&limit&offset` →
  `admin_list_organizations` RPC. Handler clamps: limit 1..200 (default 50),
  offset >= 0.
- `GET /api/admin/dashboard?from&to&grain` → `admin_dashboard` RPC.
  Handler validates `from`/`to` as ISO dates (YYYY-MM-DD) before passing
  through; grain passed through (RPC whitelist raises on bad values).

No new auth surface, no writes anywhere.

## Frontend

All under the existing admin console (global shadcn tokens, lucide icons,
never Phosphor — admin is outside the scoped systems).

### `AdminTable` (`frontend/components/admin/AdminTable.tsx`, new)

Reusable server-paginated sortable table:

- Props: columns (key, header, sortable, align, render fn), rows, total,
  page/pageSize state controlled by caller, sort key/dir, onSortChange,
  onPageChange, loading, rowAction (optional onRowClick).
- Header sort buttons emit `aria-sort`; clicking a sorted column toggles dir.
- Pagination footer: "x–y of z" + prev/next, page size fixed 50 (matches RPC
  default; no size picker — YAGNI).
- One component, reused by Organizations now; the users list reuses it later.

### `Organizations.tsx` (`frontend/pages/admin/Organizations.tsx`, new)

- `AdminTable` with columns: Name, Tier, Members, Public/Private (badge),
  Created, Last activity.
- Search input (debounced ~300ms) driving `q`.
- Sort/dir/page state in URL search params (deep-linkable, back-button safe).
- Row click → `navigate(/admin/org/${id})` (existing OrgDetail page).

### `Dashboard.tsx` (`frontend/pages/admin/Dashboard.tsx`, new)

- Four tabs: Usage / Billing & AI / Engagement / Ops. Tab state in the
  component (not URL) — a dashboard is glanceable, not deep-linkable.
- Range controls above the tabs: from/to date inputs + grain segmented
  control (day/week/month). Defaults: last 30 days, grain day. Persisted per
  device in localStorage (same pattern as Stats' view prefs). Range cap 370
  days enforced client-side with a validation message before the RPC fires.
- Charts: Recharts (existing dep) line/bar series per metric; numbers in
  Geist Mono (`nav-mono` class) consistent with the rest of the app.
- One fetch per range change; loading = skeleton cards; error = alert with
  retry (same pattern as Flags page).
- The four groups render the exact payload sections — no client-side
  recomputation.

### Navigation wiring

- `AdminLayout.tsx` TABS: Search, Dashboard, Organizations, Audit log,
  Feature flags. Dashboard first.
- `/admin` index route now renders Dashboard (was Search). Search remains at
  `/admin/search` (update its path + nav entry; Search page itself unchanged).
- `App.tsx`: lazy routes for `/admin/dashboard` and `/admin/orgs`; `/admin`
  element switches to Dashboard; keep `/admin` landing behavior intact.
- Audit log stays `/admin/audit`, flags `/admin/flags`, org detail
  `/admin/org/:id`, user detail `/admin/user/:id`, view-as `/admin/view-as/:id`
  — all unchanged.

## Testing

- pgTAP suite `supabase/tests/22_admin_dashboard.test.sql`:
  - list RPC: shape, sort whitelist rejection, dir whitelist rejection,
    limit clamp behavior, q filter, total correctness, null last_activity
    sort placement.
  - dashboard RPC: grain whitelist rejection, range cap (370d) rejection,
    from>to rejection, defaults (null from/to), zero-bucket fill
    (generate_series), empty-range (no orgs) shape.
- Gateway offline tests: read route param passthrough + ISO date validation
  rejection for dashboard; limit/offset clamping for orgs.
- Frontend vitest:
  - AdminTable: sort header click toggles dir, aria-sort set, pagination
    bounds (no prev on page 1).
  - Organizations: search debounce calls fetch with q, row click navigates,
    URL params restore state.
  - Dashboard: renders four tabs' content from mock payload, range change
    refetches, invalid range shows validation message, localStorage
    persistence of grain.

## Out of scope

- Users list table (reuses AdminTable when built — separate work).
- Per-user or per-org drill-down charts from the dashboard (OrgDetail
  already covers per-org).
- New sign-in instrumentation (real login event log) — engagement metrics
  use last_sign_in_at with its documented limitation.
- CSV export of any table.
