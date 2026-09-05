# Critical Security Fixes (Audit Follow-up)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four Critical-severity issues found by a read-only multi-agent
audit of this repo (security, database, and testing passes, run
2026-09-05): a cross-tenant IDOR in the MCP gateway's game-event tools, CI
that can execute against the production database, publicly-readable photo
storage buckets, and an unscoped-read `standings` table. No feature work,
no refactors beyond what each fix requires — this plan closes the four
Critical items only. High/Medium findings from the same audit are tracked
separately and are explicitly out of scope here.

**Spec:** none — this plan is its own authority; each task's fix is fully
specified below and was derived directly from reading the current code
(see file:line references per task).

## Global Constraints

- No task may run `npm test` (root) — it targets the PRODUCTION Supabase
  database per this repo's CLAUDE.md and must never run, including by an
  implementer "just to check." Use `npm run test:gateway:offline` and, where
  a local Supabase stack is up, `npm run db:test` (pgTAP) instead.
- New SQL migrations go in `supabase/migrations/` with a timestamp after
  the current latest (`20260903001500_my_teams.sql`) — use
  `20260905NNNNNN_<name>.sql`. Never add files under the frozen
  `supabase-migrations/` (hyphenated) directory.
- Never edit an already-applied migration file. Every fix that needs a
  schema/policy change is a new migration, additive only.
- Commit after every task. Never push to `main` or any shared branch —
  this work stays on the current worktree branch
  (`worktree-security-critical-fixes`) until the user decides how to land it.
- Tasks 1, 3, and 4 touch production security surface (auth bypass, public
  data exposure, RLS). Each implementer must state in its report exactly
  what changed and why it closes the specific exploit described in the
  task — not just "tests pass."
- Task 2 edits `.github/workflows/ci.yml`. Do not touch any other CI/CD
  config, secrets, or workflow in the same task.

---

### Task 1: Fix cross-tenant IDOR in MCP game-event tools

**Files:**
- Modify: `gateway/mcpTools.ts` (the `update_game_event` and
  `delete_game_event` tool handlers, currently around lines 223-258)
- Modify: `mcp-server/index.ts` (the `update_game_event` and
  `delete_game_event` tool handlers, currently around lines 300-335)
- Create or extend a test file covering both fixes (colocate with existing
  gateway tests, e.g. `gateway/gameActions.test.mjs` pattern, or a new
  `gateway/mcpTools.test.mjs` if no existing file fits — implementer's
  judgment on the best home given what's there)

**The bug:** `game_events` has an `organization_id` column (FK to
`organizations`, set at insert time — see `create_game_event` in the same
files for the established pattern of scoping by org). The `update_game_event`
and `delete_game_event` handlers in both files build their PATCH/DELETE
query filtering ONLY by `id`, using a service-role connection that bypasses
RLS entirely:

- `gateway/mcpTools.ts`: `sbWrite(config, 'PATCH', \`/game_events?id=eq.${eventId}\`, body)` and `sbWrite(config, 'DELETE', \`/game_events?id=eq.${eventId}\`)`
- `mcp-server/index.ts`: `supabase.from('game_events').update(body).eq('id', eventId)` and `supabase.from('game_events').delete().eq('id', eventId)`

Because there is no `organization_id` filter, any authenticated MCP client —
regardless of which team/org they belong to — can edit or delete any other
team's game events by supplying any valid event id (ids are sequential
integers, trivially guessable/enumerable).

**The fix:**
- In `gateway/mcpTools.ts`: add `&organization_id=eq.${orgId}` to both the
  PATCH and DELETE query strings (the handler already has `orgId` in scope
  — check the enclosing function signature/closure for how other tools in
  this file access it, e.g. `resolveGame(config, orgId, ...)` nearby).
- In `mcp-server/index.ts`: add `.eq('organization_id', orgId)` (or the
  module's equivalent org-id constant/variable — see how other tools in
  this file scope their queries, e.g. `resolveGame(gameId)`'s internal
  implementation) to both the `.update(...)` and `.delete(...)` chains,
  before `.select()`.
- In both files, when the row is not found (0 rows returned — which now
  also covers "found, but belongs to a different org"), the existing
  `if (!updated[0]) throw ...` / `if (!deleted[0]) throw ...` (or
  equivalent error-checked pattern) must still fire. Do not distinguish
  "wrong org" from "doesn't exist" in the error message — both should look
  identical to the caller (this project's RLS/RPC layer already follows an
  anti-enumeration convention of not leaking existence across tenants; the
  code-quality/security audits called this out as a strength elsewhere in
  the codebase — match it here).

**Tests required:** for each file, a test that:
1. Creates (or uses a fixture for) a game event belonging to org A.
2. Attempts `update_game_event` / `delete_game_event` as if scoped to org B
   (i.e. calling the handler/helper with org B's id).
3. Asserts the call fails with a not-found-style error, AND that the event
   row in org A is unchanged (for update) or still present (for delete).
4. Also asserts the same-org case still succeeds (regression guard against
   over-scoping the fix and breaking legitimate same-org edits).

If the existing test setup for this repo requires a live local Supabase
stack for these specific tests (because they need real rows with real
`organization_id`s), that's fine — follow whatever pattern
`gateway/jamSync.test.mjs` or `gateway/membership.test.mjs` uses for
fixtures/mocking rather than inventing a new approach. Run with
`npm run test:gateway` (NOT `npm run test:gateway:offline`, since this needs
whichever fixture/mock setup is chosen — implementer's judgment on which
existing npm script covers it, or add one) and confirm the new tests are
included and passing before reporting DONE.

---

### Task 2: Remove production-hitting integration test step from CI

**Files:**
- Modify: `.github/workflows/ci.yml`

**The bug:** the `test-and-build` job includes a step:

```yaml
- name: Run integration tests
  if: ${{ env.SUPABASE_URL != '' }}
  run: npm test
```

`npm test` runs `server.test.mjs`, which (per this repo's CLAUDE.md) builds
its Supabase client from the root `.env` and — in this repo — that always
points at the PRODUCTION database. This step is conditioned on repo secrets
`SUPABASE_URL`/`SUPABASE_SECRET_KEY` being configured; if anyone adds those
secrets (e.g. to "finally turn on the integration tests"), every future
push/PR to `main` starts silently exercising production data through
`npm test`'s side effects. A CI pipeline should never have a path — even a
conditional, currently-inactive one — that can reach production.

**The fix:**
- Delete the `Run integration tests` step (and its `SUPABASE_URL`/
  `SUPABASE_SECRET_KEY` job-level `env:` entries, if they exist ONLY to
  serve this step — check the rest of the file before removing job-level
  env vars, in case anything else in the job also reads them).
- Leave the `Run gateway authorization tests` step (`test:gateway:offline`)
  untouched — it's genuinely safe (stubs fetch / pure functions, no live
  stack).
- Add a one-line comment where the step used to be (or at the top of the
  job) noting that integration-style tests against the local pgTAP suite
  (`npm run db:test`) are the intended replacement, and that a future CI
  step wiring up the LOCAL Supabase stack (not production) is out of scope
  for this fix.
- Do not add a new CI job to stand up the local stack in this task — that's
  a separate, larger piece of work (Docker-in-CI, `supabase start`, seed
  data) explicitly out of scope here. This task only removes the
  prod-reaching path.

**Verification:** there is no automated test for a CI workflow file itself.
Verify by: (1) diffing the file to confirm only the intended lines changed,
(2) confirming valid YAML (`python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"` or equivalent), (3) re-reading the
remaining steps to confirm `test:gateway:offline` and the build step are
still intact and correctly ordered.

---

### Task 3: Lock down public photo storage buckets

**Files:**
- Create: `supabase/migrations/20260905000100_private_photo_buckets.sql`
- Extend or create a pgTAP test file under `supabase/tests/` covering the
  new policies (follow the existing pgTAP test file naming/style already in
  that directory — do not invent a different test framework)

**The bug:** `supabase/migrations/20260903001300_storage_policies.sql`
creates the `player-photos` and `team-photos` storage buckets with
`public: true`. Combined with the buckets' path convention (first path
segment is the numeric team id, easily enumerable) this means any object in
either bucket is fetchable by anyone on the internet with no authentication
at all, via Supabase's standard public-object URL — regardless of whether
any app code currently constructs or displays those URLs (none does yet,
confirmed by repo-wide grep, but the exposure exists at the storage-API
level independent of app code).

That same migration's own comments defer a bigger decision ("Plan 3") about
whether photo listing needs a SELECT policy at all, and note storage.objects
currently has zero SELECT policies, which makes the existing team-scoped
UPDATE/DELETE policies inert (they never get a row to evaluate). This task
does NOT attempt to resolve that deferred design — it only removes the
"world-readable regardless of auth" exposure by flipping the buckets private
and adding the minimum SELECT policy needed to make the UPDATE/DELETE
policies functional again (mirroring the access tiers already used by the
INSERT/UPDATE/DELETE policies in that same migration: member-tier for
`player-photos`, manage-tier for `team-photos`).

**The fix — new migration:**
1. `update storage.buckets set public = false where id in ('player-photos', 'team-photos');`
2. Add a SELECT policy for `player-photos`, authenticated, scoped by
   `public.storage_path_team_id(name) = any ((select public.my_member_team_ids())::bigint[])`
   — same predicate shape as the existing member-tier INSERT/UPDATE/DELETE
   policies for this bucket in `20260903001300_storage_policies.sql`.
3. Add a SELECT policy for `team-photos`, authenticated, scoped by
   `public.storage_path_team_id(name) = any ((select public.my_manage_team_ids())::bigint[])`
   — same predicate shape as the existing manage-tier policies for this
   bucket.
4. Name the new policies distinctly from the existing ones (e.g.
   `"team member read player photos"` / `"manager read team photos"`) —
   do not reuse or collide with existing policy names.

**Do not:** change the INSERT/UPDATE/DELETE policies from the prior
migration, change the `storage_path_team_id` function, or attempt to design
a signed-URL flow — all out of scope (that's "Plan 3," not this task).

**Tests required:** pgTAP tests asserting: (a) a team-A member can SELECT a
`player-photos` object whose path is team-A-scoped; (b) a team-A member
CANNOT SELECT a `player-photos` object path-scoped to team B; (c) same two
assertions for `team-photos` using manage-tier membership; (d) an
unauthenticated/anon role can SELECT nothing in either bucket. Run via
`npm run db:test` against the local stack (the controller will confirm the
local stack is up before dispatching this task; if it is not yet up when
you start, say so in your report as DONE_WITH_CONCERNS rather than skipping
the test run).

---

### Task 4: Lock down the unscoped `standings` table

**Files:**
- Create: `supabase/migrations/20260905000200_lockdown_standings.sql`
- Extend the pgTAP suite if a natural home exists (e.g. wherever other
  table-level RLS tests live under `supabase/tests/`); if the table is
  genuinely dead, a minimal "no role can read it" pgTAP assertion is enough
  — do not invent broader coverage for an unused table.

**The bug:** `public.standings` (baseline migration,
`00000000000000_baseline.sql`) has RLS enabled but its only policy is
`CREATE POLICY "authenticated read" ON "public"."standings" FOR SELECT TO "authenticated" USING (true);` — any authenticated user, on any team, can
read every row, including every other team's standings. The table has no
`organization_id` (only `season_id`, with no tenant-scoping join available
in a simple predicate) and — confirmed by a repo-wide grep across
`server/`, `gateway/`, `mcp-server/`, and `frontend/src` — is referenced by
zero application code. It appears to be dead.

**The fix:** a new migration that drops the permissive policy:
`drop policy if exists "authenticated read" on public.standings;`

Leave RLS enabled with no replacement policy (default-deny — no role except
`service_role`/table owner can read it). Do NOT drop the table itself: it
may still hold historical data worth keeping, and dropping a table is a
separate, harder-to-reverse decision than removing an overly broad policy —
out of scope for this fix. If, while implementing, you find live code that
*does* reference `standings` (the repo-wide grep above should be re-run as
your own verification step, not taken on faith), STOP and report
DONE_WITH_CONCERNS rather than locking out a table something depends on —
the controller will re-scope this task with a properly tenant-scoped policy
instead of a blanket lockdown.

**Tests required:** a pgTAP assertion that an authenticated user (any role)
querying `standings` gets zero rows / a permission-denied result, run via
`npm run db:test`.
