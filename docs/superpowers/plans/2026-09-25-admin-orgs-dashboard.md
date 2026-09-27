# Admin Organizations Table & Internal Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A paginated/sortable all-organizations table and a four-group internal metrics dashboard (customizable range + grain) in the admin console.

**Architecture:** Two read-only service-role RPCs (`admin_list_organizations`, `admin_dashboard`) computed on demand; two new admin read routes; a reusable `AdminTable` component; two new admin pages with lazy routes; Dashboard becomes the `/admin` landing tab.

**Tech Stack:** Postgres (Supabase, plpgsql), TypeScript gateway reads, React + shadcn + Recharts + lucide (admin console scope).

**Spec:** `docs/superpowers/specs/2026-09-25-admin-orgs-dashboard-design.md`

## Global Constraints

- RPCs are service-role only: `security definer`, `set search_path = ''`, `revoke all on function … from public, anon, authenticated`.
- No new tables; metrics computed from existing tables only.
- `p_sort` whitelist: `name | members | created_at | last_activity | tier`. `p_dir` whitelist: `asc | desc`. `p_grain` whitelist: `day | week | month`. Whitelist violations RAISE.
- Range cap: `p_to - p_from` ≤ 370 days; `p_from > p_to` raises; `p_to` null → `current_date`; `p_from` null → `p_to - 29`.
- Limit clamp: default 50, max 200; `p_offset` ≥ 0.
- Series buckets fill empty buckets with 0 via `generate_series` left join; buckets are `date_trunc(grain, ts)::date`.
- `last_activity` = max created_at across `chat_logs`, `game_events`, `game_attendance`, `strategy_plays` (null if none). Null sort: nulls last on desc, first on asc.
- `ai_cap_by_tier` hardcoded `{"free": 5, "pro": 100, "premium": null}` mirroring `check_ai_usage` (null = unlimited).
- `sign_ins` series counts users by `auth.users.last_sign_in_at` falling in bucket (documented limitation).
- Admin UI: global shadcn tokens, lucide icons only (never Phosphor in admin), Geist Mono (`.nav-mono`) for numbers.
- Both routes readonly+ via existing `handleAdminRead`; no writes anywhere.
- Search page path moves to `/admin/search`; old paths keep working.
- Never run `npm test` at repo root (reads production). Local pgTAP: `npm run db:test`. Gateway: `npm run test:gateway:offline`. Frontend: `npm test` inside `frontend/`.

## Review Focus

- **Whitelist escapes:** `p_sort='members; drop table'` or `p_grain='week; select 1'` must raise, not interpolate — tests in Task 1 pin every whitelist raising.
- **Range cap bypass:** `p_from=1900-01-01, p_to=2026-09-25` must raise (generating 46k buckets would hang the RPC) — Task 1 pins 370d cap and from>to.
- **Empty-bucket gaps:** an org created mid-range must produce zero-filled earlier buckets in `new_orgs` series — Task 1 pins generate_series fill.
- **Null last_activity ordering:** org with no activity sorts last on desc, not first — Task 1 pins nulls placement.
- **Landing regression:** deep links to `/admin` (and bookmarks to `/admin/audit`, `/admin/flags`) must still work after the default-landing switch — Task 6 pins routes.

---

### Task 1: Dashboard + list RPCs (migration & pgTAP)

**Files:**
- Create: `supabase/migrations/20260926000000_admin_dashboard.sql`
- Create: `supabase/tests/22_admin_dashboard.test.sql`

**Interfaces:**
- Produces: `admin_list_organizations(p_q text, p_sort text, p_dir text, p_limit int, p_offset int) → jsonb` with `{rows: [{id, name, is_public, tier, members, created_at, last_activity}], total}`.
- Produces: `admin_dashboard(p_from date, p_to date, p_grain text) → jsonb` with `{range: {from, to, grain}, usage: {totals, series}, billing: {...}, engagement: {...}, ops: {...}}` — exact shapes in spec.

- [ ] **Step 1: Write the failing pgTAP suite**

```sql
-- supabase/tests/22_admin_dashboard.test.sql
begin;
select plan(12);

-- list RPC
select is(
  (select jsonb_array_length((public.admin_list_organizations(null,'name','asc',50,0))::jsonb->'rows')),
  (select count(*)::int from public.organizations),
  'list returns every org with no filter');

select throws_ok(
  $$ select public.admin_list_organizations(null,'bogus_sort; drop table','asc',50,0) $$,
  'invalid sort raises',
  'sort whitelist enforced');
select throws_ok(
  $$ select public.admin_list_organizations(null,'name','sideways',50,0) $$,
  'invalid dir raises',
  'dir whitelist enforced');

-- dashboard RPC
select throws_ok(
  $$ select public.admin_dashboard('1900-01-01'::date, '2026-09-25'::date, 'day') $$,
  'range cap raises',
  'range cap 370 days enforced');
select throws_ok(
  $$ select public.admin_dashboard('2026-09-25'::date, '2026-09-24'::date, 'day') $$,
  'from > to raises',
  'inverted range rejected');
select throws_ok(
  $$ select public.admin_dashboard('2026-09-01'::date, '2026-09-25'::date, 'fortnight') $$,
  'invalid grain raises',
  'grain whitelist enforced');

select has_key(public.admin_dashboard('2026-09-01'::date, '2026-09-25'::date, 'day')::jsonb, 'usage', 'payload has usage');
select has_key(public.admin_dashboard('2026-09-01'::date, '2026-09-25'::date, 'day')::jsonb, 'billing', 'payload has billing');
select has_key(public.admin_dashboard('2026-09-01'::date, '2026-09-25'::date, 'day')::jsonb, 'engagement', 'payload has engagement');
select has_key(public.admin_dashboard('2026-09-01'::date, '2026-09-25'::date, 'day')::jsonb, 'ops', 'payload has ops');

-- zero-fill: every bucket from from..to present in new_orgs series
select is(
  (select count(*)::int from jsonb_array_elements(
     public.admin_dashboard('2026-08-01'::date,'2026-08-31'::date,'day')::jsonb->'usage'->'series'->'new_orgs')),
  31,
  'new_orgs series fills every day in range');

-- null last_activity sorts last on desc (create/verify a no-activity org exists
-- in the QA seed; if the seed has none, insert one in this test and delete at end)
select is(
  (select (public.admin_list_organizations(null,'last_activity','desc',200,0))::jsonb->'rows'->0->>'last_activity'),
  null,
  'null last_activity rows sort last on desc');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run db:test`
Expected: FAIL — functions do not exist.

- [ ] **Step 3: Write the migration**

Two functions, conventions copied from `20260924000000_admin_org_profile_flags.sql`. Key SQL skeleton (complete all sections per spec):

```sql
create or replace function public.admin_list_organizations(
  p_q text, p_sort text, p_dir text, p_limit int, p_offset int
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_sort text := coalesce(p_sort, 'name');
  v_dir  text := coalesce(p_dir, 'asc');
  v_limit int := least(coalesce(p_limit, 50), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_ord text;
begin
  if v_sort not in ('name','members','created_at','last_activity','tier') then
    raise exception 'invalid sort column: %', v_sort;
  end if;
  if v_dir not in ('asc','desc') then
    raise exception 'invalid dir: %', v_dir;
  end if;
  -- whitelist-only interpolation: both operands checked above
  v_ord := format('order by %s %s nulls %s', v_sort, v_dir,
                  case when v_dir = 'desc' then 'last' else 'first' end);
  return jsonb_build_object(
    'total', (select count(*) from public.organizations o
               where p_q is null or o.name ilike '%' || p_q || '%'),
    'rows', coalesce((
      select jsonb_agg(row_to_json(t.*) order by t.ord) from (
        select o.id, o.name, o.is_public, o.tier, o.created_at,
               (select count(*) from public.team_members m where m.team_id = o.id) as members,
               (select max(u.dt) from (
                  select max(created_at) dt from public.chat_logs where organization_id = o.id
                  union all select max(created_at) from public.game_events where organization_id = o.id
                  union all select max(created_at) from public.game_attendance where organization_id = o.id
                  union all select max(created_at) from public.strategy_plays where organization_id = o.id) u) as last_activity,
               row_number() over () as ord
        from public.organizations o
       where p_q is null or o.name ilike '%' || p_q || '%'
        limit v_limit offset v_offset) t), '[]'::jsonb));
end; $$;
```

Dashboard function: validate grain (`day|week|month`), dates (null defaults, cap, order); build each series as `generate_series(date_trunc(grain, p_from), date_trunc(grain, p_to), grain_step)` left-joined to the count query; usage totals; billing (tier mix by `organizations.tier` + `is_employee_granted` count, `trial_ends_at > now()`, chat_logs in range, hardcoded `ai_cap_by_tier`); engagement (last_sign_in_at buckets, active orgs in range from the four activity tables, dormant = all − active); ops (top 5 by game_events, unaccepted team_invites, pending player_links, admin_audit_log in range). Full payload shape per spec §RPCs.

End with:
```sql
revoke all on function public.admin_list_organizations(text,text,text,int,int) from public, anon, authenticated;
revoke all on function public.admin_dashboard(date,date,text) from public, anon, authenticated;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run db:test`
Expected: PASS (all suites incl. new 22).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260926000000_admin_dashboard.sql supabase/tests/22_admin_dashboard.test.sql
git commit -m "feat(db): admin list organizations and dashboard RPCs"
```

### Task 2: Gateway read routes

**Files:**
- Modify: `gateway/admin/reads.ts`
- Test: `gateway/admin/adminReads.test.mjs` (create if none exists; else follow the existing offline test file conventions in `gateway/`)

**Interfaces:**
- Consumes: Task 1 RPCs.
- Produces: `GET /api/admin/orgs?q&sort&dir&limit&offset` → `{rows, total}`; `GET /api/admin/dashboard?from&to&grain` → dashboard payload. Invalid `from`/`to` (non-YYYY-MM-DD) → 400 `{error}`.

- [ ] **Step 1: Write failing offline tests** (route dispatch: orgs passthrough with clamped limit; dashboard rejects `from=not-a-date` with 400; both reachable via `handleAdminRead` with a stubbed `sbWrite`)
- [ ] **Step 2: Run to verify failure** — `npm run test:gateway:offline`
- [ ] **Step 3: Implement** — two `if (head === 'orgs')` / `if (head === 'dashboard')` blocks in `handleAdminRead`, following the existing `audit` block's URLSearchParams parsing; ISO date check `/^\d{4}-\d{2}-\d{2}$/` before calling `admin_dashboard`; grain passed through (RPC raises).
- [ ] **Step 4: Run to verify pass** — `npm run test:gateway:offline`
- [ ] **Step 5: Commit** — `git commit -m "feat(gateway): orgs list and dashboard read routes"`

### Task 3: AdminTable component

**Files:**
- Create: `frontend/components/admin/AdminTable.tsx`
- Test: `frontend/components/admin/AdminTable.test.tsx`

**Interfaces:**
- Produces:

```tsx
export type AdminTableColumn<T> = {
  key: string; header: string; sortable?: boolean;
  align?: 'left' | 'right'; render: (row: T) => React.ReactNode
}
export type AdminTableProps<T> = {
  columns: AdminTableColumn<T>[]; rows: T[]; total: number;
  page: number; pageSize: number; onPageChange: (p: number) => void;
  sortKey: string; sortDir: 'asc' | 'desc'; onSortChange: (key: string) => void;
  loading: boolean; onRowClick?: (row: T) => void; ariaLabel: string
}
export default function AdminTable<T extends { id: string | number }>(props: AdminTableProps<T>): JSX.Element
```

- Sort click: same column toggles dir, new column sets asc. Header emits `aria-sort="ascending|descending|none"`. Pagination footer "x–y of total" + prev/next (prev disabled page 1, next disabled on last). Loading → skeleton rows. Row click when `onRowClick` set; rows are `<tr tabIndex={0}>` keyboard-activatable.

- [ ] **Step 1: Failing vitest** — sort toggle, aria-sort values, pagination bounds, row click (mouse + Enter key).
- [ ] **Step 2: Run** — `cd frontend && npm test` → FAIL.
- [ ] **Step 3: Implement AdminTable** (shadcn `Table` primitives from `lib/shadcn/table` if present, else plain table markup matching admin pages' existing `<table>` style; `Button` for pager).
- [ ] **Step 4: Run** → PASS. `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(admin): reusable paginated AdminTable"`

### Task 4: Organizations page

**Files:**
- Create: `frontend/pages/admin/Organizations.tsx`
- Test: `frontend/pages/admin/Organizations.test.tsx`

**Interfaces:**
- Consumes: `adminGet<T>('/orgs?...')` (Task 2 route), `AdminTable` (Task 3).
- Produces: page component; `GET /api/admin/orgs` client typed `type OrgRow = { id: number; name: string; is_public: boolean; tier: string; members: number; created_at: string; last_activity: string | null }; type OrgsPayload = { rows: OrgRow[]; total: number }`.

- URL search params (`q`, `sort`, `dir`, `page`) are the single source of truth — read on mount, written on change; back button restores. Search input debounced 300ms. Row click → `navigate(\`/admin/org/${row.id}\`)`. Columns: Name, Tier, Members, Visibility (Public/Private badge), Created, Last activity — dates as `toLocaleDateString()`, numbers in `.nav-mono`.

- [ ] **Step 1: Failing vitest** — renders rows from mocked fetch; debounce fires fetch with `q`; row click navigates; sort change updates URL params.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (follow `Search.tsx` fetch/error/loading patterns; `Skeleton` while loading; error alert with retry).
- [ ] **Step 4: Run** → PASS; typecheck clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(admin): organizations list page"`

### Task 5: Dashboard page

**Files:**
- Create: `frontend/pages/admin/Dashboard.tsx`
- Test: `frontend/pages/admin/Dashboard.test.tsx`

**Interfaces:**
- Consumes: `adminGet<DashboardPayload>('/dashboard?from&to&grain')` where `DashboardPayload` mirrors spec §RPCs exactly (type it explicitly in the page file).
- Produces: page with four tabs (Usage / Billing & AI / Engagement / Ops), range controls (from/to `<Input type="date">` + grain segmented buttons day/week/month), one fetch per range change, localStorage-persisted grain + range (`ufwt_admin_dash_range`).

- [ ] **Step 1: Failing vitest** — four tab panels render mock payload sections; grain/range change refetches; range > 370 days shows validation message and does NOT fetch; localStorage persistence restores grain.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — Recharts `LineChart`/`BarChart` per series with bucket on x, count on y; number cells `.nav-mono`; loading skeleton cards; error alert + retry; tab state local (no URL).
- [ ] **Step 4: Run** → PASS; typecheck clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(admin): internal metrics dashboard"`

### Task 6: Navigation wiring + landing switch

**Files:**
- Modify: `frontend/pages/admin/AdminLayout.tsx` (TABS)
- Modify: `frontend/App.tsx` (routes)
- Test: `frontend/App.test.tsx` extend or `frontend/pages/admin/AdminLayout.test.tsx`

**Interfaces:**
- Consumes: pages from Tasks 4–5.
- Produces: TABS = `[Search (/admin/search), Dashboard (/admin/dashboard), Organizations (/admin/orgs), Audit log (/admin/audit), Feature flags (/admin/flags)]`; `/admin` index route element = Dashboard; lazy imports `AdminOrganizations`, `AdminDashboard`; `/admin` (exact, `end`) → Dashboard.

- [ ] **Step 1: Failing vitest** — `/admin` renders Dashboard content; `/admin/search` renders Search; `/admin/audit`, `/admin/flags` still resolve; nav shows five tabs.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (keep every existing admin route path unchanged; only the index element and Search's tab `to` change).
- [ ] **Step 4: Run full frontend suite** → PASS; typecheck clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(admin): dashboard landing and nav wiring"`
