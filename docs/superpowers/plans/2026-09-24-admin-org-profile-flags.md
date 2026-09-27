# Admin Org Profile & Feature Flags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add org usage metrics and runtime feature flags (global + per-org overrides) to the admin console, migrating `SHOW_TURNOVERS` to the system.

**Architecture:** Global flag registry + per-org override tables, service-role only. `admin_org_detail` gains `metrics` + `feature_flags`. Mutations via gateway ops writing tables directly (accurate `updated_by`). Runtime client resolution via authenticated `GET /api/flags` keyed by org id.

**Tech Stack:** PostgreSQL (Supabase), TypeScript (Gateway: worker.ts + server/index.ts), React (shadcn/lucide).

**Spec:** `docs/superpowers/specs/2026-09-23-admin-org-profile-flags-design.md`

## Global Constraints

- `feature_flags` + `org_feature_flags`: RLS enabled, zero policies, no anon/authenticated grants. Service-role only.
- Both new tables added to `00_meta.test.sql` zero-policy allowlist.
- `GET /api/flags` resolves orgs from authenticated memberships only — never caller-supplied org ids. Returns `{ "flags": { "<org_id>": { "<flag_key>": bool } } }`.
- Flag mutations are superadmin-only operations in `gateway/admin/ops.ts`, audited by `dispatchOperation`.
- `updated_by` set from `ctx.adminId` (gateway direct writes), NOT `auth.uid()` (null under service role).
- Effective value = `org_feature_flags` row if present, else `feature_flags.default_on`. Setting an override equal to the default DELETES the override.
- Frontend flag consumers default to `false` before resolution and on fetch failure.
- Admin UI uses global shadcn tokens + lucide icons (admin pages are not in Phosphor scopes).

## Review Focus

- SQL reserved keywords as aliases (`off` fails) — use `off_` or `o_flags`.
- `/api/flags` must not leak overrides for orgs the user is not a member of.
- `00_meta.test.sql` passes after adding the two zero-policy tables.
- Frontend defaults `false` pre-fetch/failure (turnover columns stay hidden).
- Every flag change writes an `admin_audit_log` row and sets `updated_by` to the admin's uuid.

---

### Task 1: Database Migration & Schema

**Files:**
- Create: `supabase/migrations/20260924000000_admin_org_profile_flags.sql` (replaces existing untested draft)
- Modify: `supabase/tests/00_meta.test.sql` (allowlist, lines ~55-57)
- Create: `supabase/tests/21_feature_flags.test.sql`

**Interfaces:**
- Produces: tables `feature_flags(key text pk, description text, default_on boolean, updated_at timestamptz)`, `org_feature_flags(org_id bigint, flag_key text, enabled boolean, updated_by uuid, updated_at timestamptz, pk(org_id, flag_key))`.
- Produces: RPC `admin_org_detail(bigint)` extended with `metrics {chat_messages, game_events, strategy_plays, attendance, last_activity}` and `feature_flags [{key, description, default_on, override, effective}]`.
- Produces: RPC `admin_flags()` returning `{registry: [{key, description, default_on}], overrides: [{org_id, org_name, flag_key, enabled, updated_by, updated_at}]}`.
- Does NOT produce: `admin_set_flag` RPC — mutation logic lives in gateway ops (direct writes). The RPC variant with `auth.uid()` is dead on arrival since service role has no auth context.

- [ ] **Step 1: Rewrite migration**
Tables with RLS + zero policies + revoked grants. Seed `show_turnovers` (default false). Extended `admin_org_detail` (keep all existing keys unchanged — existing callers in `gateway/admin/reads.ts` and `frontend/pages/admin/OrgDetail.tsx` depend on them). New `admin_flags()`. Revoke all from public/anon/authenticated on functions. Alias joins as `off_` (never `off`).
- [ ] **Step 2: Update 00_meta.test.sql**
Add `'feature_flags', 'org_feature_flags'` to the `relname not in (...)` zero-policy allowlist.
- [ ] **Step 3: Write pgTAP suite 21_feature_flags.test.sql**
Assert: tables exist, RLS on, no policies, anon holds no privileges, seed row `show_turnovers` exists with `default_on = false`, `admin_org_detail` returns `metrics` and `feature_flags` keys, `admin_flags` shape.
- [ ] **Step 4: Run**
`npm run db:test`
- [ ] **Step 5: Commit**
`git add supabase/migrations/20260924000000_admin_org_profile_flags.sql supabase/tests/`
`git commit -m "feat(db): feature flags tables, org metrics, admin read RPCs"`

### Task 2: Gateway Admin Operations & Read Routes

**Files:**
- Modify: `gateway/admin/ops.ts` (add `set_flag` operation to `ADMIN_OPERATIONS`)
- Modify: `gateway/admin/reads.ts` (add `flags` route)
- Test: `gateway/admin/adminOps.test.mjs`

**Interfaces:**
- Consumes: tables from Task 1.
- Produces: operation `set_flag` input `{ key: string, org_id: number | null, enabled: boolean }`, `minRole: 'superadmin'`, `target: {flag_key, org_id}`, preview shows current default/override + next value. Apply: `p_org_id null` → PATCH `feature_flags.default_on`; else upsert or delete-on-equal on `org_feature_flags`, writing `updated_by: ctx.adminId`.
- Produces: `GET /api/admin/flags` → `admin_flags()` RPC via `sbWrite(ctx.config, 'POST', '/rpc/admin_flags', {})` pattern used by existing read routes.

- [ ] **Step 1: Add offline tests for `set_flag`** (validation errors, role gate, delete-on-equal, audit)
- [ ] **Step 2: Run tests to verify failure**
`npm run test:gateway:offline`
- [ ] **Step 3: Implement `set_flag` op + flags read route**
- [ ] **Step 4: Run tests to verify pass**
`npm run test:gateway:offline`
- [ ] **Step 5: Commit**
`git add gateway/admin/ops.ts gateway/admin/reads.ts gateway/admin/adminOps.test.mjs`
`git commit -m "feat(gateway): set_flag admin op and flags read route"`

### Task 3: Client Flag Resolution Endpoint

**Files:**
- Create: `gateway/flags.ts`
- Modify: `worker.ts` (mount `GET /api/flags`)
- Modify: `server/index.ts` (mount same via the node adapter pattern used by admin routes)

**Interfaces:**
- Consumes: `feature_flags`, `org_feature_flags`, membership lookup pattern from existing gateway code (`createMembershipLookup` or equivalent in `gateway/mcpAgent.ts`/gateway core — inspect first).
- Produces: `GET /api/flags` → `200 { flags: { [orgId]: { [flagKey]: boolean } } }` for every org the JWT's user belongs to; `401` unsigned. Never accepts org params.

- [ ] **Step 1: Implement handler in `gateway/flags.ts`**
Verify JWT → memberships → fetch registry + overrides for those orgs only → compute effective map.
- [ ] **Step 2: Mount in worker.ts and server/index.ts** (before SPA fallback; outside `/api/admin/*` so `isGatewayPath` keeps working)
- [ ] **Step 3: Verify**
Curl with admin cookie against local dev server: expect per-org flag map; unsigned request: 401.
- [ ] **Step 4: Commit**
`git add gateway/flags.ts worker.ts server/index.ts`
`git commit -m "feat(gateway): runtime per-org flags endpoint"`

### Task 4: Frontend Runtime Integration

**Files:**
- Modify: `frontend/lib/features.ts`
- Create: `frontend/hooks/useFlags.ts`
- Modify: all `SHOW_TURNOVERS` call sites (search: `grep -rn "SHOW_TURNOVERS" frontend/`)

**Interfaces:**
- Consumes: `GET /api/flags`.
- Produces: `useFlags(): { flags: Record<string, boolean> | null, loading: boolean }` — flags for the *current* org (from `useAuth().currentTeamId`), defaulting to `false` for every known key pre-fetch and on error. Falls back to global default when current org absent from map.
- Produces: `features.ts` exports `FLAG_KEYS` (`['show_turnovers']`) and keeps the explanatory comment about why turnovers is off.

- [ ] **Step 1: Write `useFlags.ts` hook** (fetch once per signed-in identity + org change; abort stale; `false` fallback)
- [ ] **Step 2: Migrate `features.ts`** — remove hardcoded export; document runtime resolution
- [ ] **Step 3: Update every `SHOW_TURNOVERS` call site** to read from `useFlags()` (prop-drill or hook per component as existing patterns dictate)
- [ ] **Step 4: Run frontend tests + typecheck**
`cd frontend && npx tsc --noEmit && npm test`
- [ ] **Step 5: Commit**
`git add frontend/`
`git commit -m "feat(frontend): runtime feature flags replace SHOW_TURNOVERS"`

### Task 5: Admin UI — Org Profile Metrics + Flags Card

**Files:**
- Modify: `frontend/pages/admin/OrgDetail.tsx`
- Test: `frontend/pages/admin/OrgDetail.test.tsx` (create if pattern exists)

**Interfaces:**
- Consumes: extended `OrgDetailPayload` with `metrics` and `feature_flags` from Task 1 RPC via existing `adminGet`/`adminOp`.
- Produces: metrics strip (members, teams, players, seasons, games, game events, AI messages, strategy plays, attendance, last activity) + flags card with per-flag toggle showing global default + effective + override state. Toggles open `OperationDialog` with `set_flag` op (`org_id` set, or null to change global default from Flags page).

- [ ] **Step 1: Extend `OrgDetailPayload` type + render metrics strip**
- [ ] **Step 2: Flags card with OperationDialog toggles**
- [ ] **Step 3: Run tests + typecheck**
- [ ] **Step 4: Commit**
`git commit -m "feat(admin): org metrics strip and flags card"`

### Task 6: Admin UI — Flags Management Page

**Files:**
- Create: `frontend/pages/admin/Flags.tsx`
- Modify: `frontend/pages/admin/AdminLayout.tsx` (tab)
- Modify: `frontend/App.tsx` (lazy route `/admin/flags`)

**Interfaces:**
- Consumes: `GET /api/admin/flags`, `set_flag` op via OperationDialog.
- Produces: registry table (key, description, default toggle) + overrides table (org, flag, enabled, updated_at/by). Readonly role sees controls disabled; superadmin toggles.

- [ ] **Step 1: Build page** (registry + overrides tables, OperationDialog on toggle)
- [ ] **Step 2: Wire tab + route**
- [ ] **Step 3: Verify all roles' visibility + superadmin-only toggling**
- [ ] **Step 4: Run tests + typecheck**
- [ ] **Step 5: Commit**
`git commit -m "feat(admin): flags management page"`
