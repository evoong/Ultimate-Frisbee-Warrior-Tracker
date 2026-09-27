# Admin Org Profile & Feature Flags — Design Spec

Date: 2026-09-23
Status: approved in chat; implementation plan to follow
Branch target: work stacked on main, not on feat/billing-lifecycle

## Purpose

Admin console gains two things:

1. **Org usage metrics** — a profile view showing how an organization uses
   the product: members, teams, players, seasons, games, game events, AI
   chat messages, strategy plays, attendance rows, and last activity date.
2. **Runtime feature flags** — global defaults plus per-org overrides,
   viewable and toggleable from the admin console. The existing hardcoded
   `SHOW_TURNOVERS` constant in `frontend/lib/features.ts` is migrated to
   this system so flags affect the product end-to-end, not just a table in
   the admin UI.

## Data model

```sql
-- Global flag registry. Seeded with 'show_turnovers' (default off, matching
-- today's hardcoded false).
create table public.feature_flags (
  key          text primary key,
  description  text not null,
  default_on   boolean not null default false,
  updated_at   timestamptz not null default now()
);

-- Per-org overrides. Absent row = use the registry default.
create table public.org_feature_flags (
  org_id     bigint not null references public.organizations(id) on delete cascade,
  flag_key   text   not null references public.feature_flags(key) on delete cascade,
  enabled    boolean not null,
  updated_by uuid,  -- admin's auth.users id, null if set by migration/seed
  updated_at timestamptz not null default now(),
  primary key (org_id, flag_key)
);
```

- Both tables RLS-enabled with **zero policies** and no grants to
  `anon`/`authenticated` — service-role only, identical to `platform_admins`
  and `admin_audit_log`.
- Both added to the allowlist in `supabase/tests/00_meta.test.sql` (the
  "every table in public has at least one policy" test fails otherwise).
- Effective value for org O, flag K:
  `org_feature_flags(O,K).enabled` if the row exists, else
  `feature_flags(K).default_on`.

## RPCs

All service-role only (`revoke ... from public, anon, authenticated`),
`security definer`, `set search_path = ''`, added as a new migration.

### `admin_org_detail(bigint)` — extended

Existing payload keeps its shape and gains:

```jsonc
{
  "metrics": {
    "chat_messages":    <count of chat_logs rows for the org>,
    "game_events":     <count of game_events rows for the org>,
    "strategy_plays":  <count of strategy_plays rows for the org>,
    "attendance":      <count of game_attendance rows for the org>,
    "last_activity":   <max updated/created timestamp across those tables, null if none>
  },
  "feature_flags": [
    { "key": "...", "description": "...", "default_on": bool,
      "override": bool | null,      // org override value, null if none
      "effective": bool }
  ]
}
```

Existing `counts` (players/seasons/games) is retained; the new `metrics`
object holds the additions. `last_activity` is the max of the created/updated
timestamps across chat_logs, game_events, strategy_plays, game_attendance —
an approximation of "when did this org last do anything", good enough for a
support console.

### `admin_set_flag(p_key text, p_org_id bigint | null, p_enabled boolean)`

- `p_org_id is null` → set `feature_flags.default_on`.
- else → upsert/delete the `org_feature_flags` row. Setting an override
  equal to the current default **deletes** the override row instead of
  storing a redundant one, so "no override" keeps meaning "uses default".
- Validates the flag key exists.
- Called only from `gateway/admin/ops.ts` as a **superadmin** operation
  (readonly/support may view flags but not change them), audited by
  `dispatchOperation` like every other mutation.

### `admin_flags()` — new

Returns the full registry plus every org override (org id, org name,
enabled, updated_by, updated_at) for the Flags page. Readonly role.

## Routes

### Admin gateway

- `POST /api/admin/flags` (read, readonly+): `admin_flags()`.
- `admin_set_flag` in `ADMIN_OPERATIONS` (`gateway/admin/ops.ts`), reached
  via the existing operation dispatcher; preview shows old → new value.

### Runtime client resolution

- `GET /api/flags` — **not** under `/api/admin/*`. Resolves the caller's orgs
  from their authenticated `team_members` memberships, never from a
  caller-supplied org id, then returns the effective value of every registry
  flag **per org**, keyed by org id:

  ```jsonc
  { "flags": { "3": { "show_turnovers": true }, "7": { "show_turnovers": false } } }
  ```

  A user in multiple orgs is unambiguous this way: the frontend picks its
  active org's entry (falling back to the global default when it has none).
  Signed-in users only. This keeps `isGatewayPath` intact (no SPA-fallback
  collision) and keeps one org from reading another's overrides.

## Frontend

### OrgDetail (`frontend/pages/admin/OrgDetail.tsx`)

- Metrics strip: cards or a compact stat row for the new `metrics` values
  beside the existing counts — members, teams, players, seasons, games,
  game events, AI messages, strategy plays, attendance, last activity.
- Feature flags card: one row per registry flag showing description, global
  default, effective state for this org, and a toggle. Toggle opens
  OperationDialog (preview → apply) with `admin_set_flag`; disabling an
  override reverts to default (the delete-on-equal rule above).
- Follows existing page conventions (global shadcn tokens, lucide icons —
  admin pages are not in the Phosphor scopes).

### Flags page (`frontend/pages/admin/Flags.tsx`, new)

- Global registry table: key, description, default_on toggle.
- Overrides table: org, flag, enabled, updated_at, updated_by.
- Toggles go through OperationDialog like every admin mutation.
- New tab in `AdminLayout.tsx` ("Flags"), visible to all admin roles;
  controls disabled for readonly.

### Runtime consumption (`frontend/lib/features.ts`)

- `SHOW_TURNOVERS` const replaced by a flags object fetched once from
  `GET /api/flags` (with a sane local default of `false` on failure or
  before load). Call sites keep reading `SHOW_TURNOVERS`-style booleans via
  the flags object.
- `SHOW_TURNOVERS` display gates (ledger series, rankings column,
  progression stat, box score, Roster breakdowns — see CLAUDE.md) switch to
  the resolved flag. The `lib/features.ts` comment explaining *why* the
  flag exists moves with it.

## Testing

- pgTAP suite (new): tables exist, RLS on with no policies, allowlist
  satisfied, `admin_set_flag` global/override/delete-on-equal/validation
  paths, `admin_flags` shape.
- Gateway offline tests: `adminSetFlag` op validation, role gate
  (superadmin), audit row written.
- Frontend vitest: Flags page renders registry, OrgDetail metrics strip +
  flags card render, toggle opens OperationDialog, runtime flags hook
  falls back to defaults on fetch failure.

## Out of scope

- No new usage data collection (metrics read existing tables).
- No time-series/audit of flag flips beyond the existing audit log.
- No per-user or per-team flags — org scope only.
- The admin organizations/users list tables (separate in-flight work) are
  untouched by this spec.
