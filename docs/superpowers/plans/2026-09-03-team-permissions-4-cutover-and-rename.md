# Team Permissions — Plan 4: Production Cutover and Rename

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the permission model to production without anyone losing
access, then rename `organizations` → `teams` and `teams` → `squads` as a
separate, purely mechanical change.

**Architecture:** Cutover first, rename second. The rename touches 426
references across 26 files and would otherwise bury the security review in
churn — and a rename shipped on top of a *verified* production state is a
much smaller risk than one shipped alongside an unverified one.

**Tech Stack:** Supabase CLI, Cloudflare Workers (`wrangler`), Vercel.

**Spec:** `docs/superpowers/specs/2026-09-03-team-permissions-design.md`
**Depends on:** Plans 1, 2 and 3 complete, all suites green locally.

## Global Constraints

- **Production data is irreplaceable.** Task 1's backup is not optional.
- The cutover script (`scripts/cutover-production.mjs`, from Plan 1 Task 17)
  is idempotent — safe to re-run after a partial failure.
- Migrations reach production only via `supabase db push`, never by pasting
  into the SQL editor. The whole point of Plan 1's baseline was to end that.
- The rename is **mechanical only**. No behavior change, no policy change,
  no opportunistic cleanup. If a rename step tempts you into a fix, note it
  and do it separately.
- Never push to `main`; this is a branch and a PR.
- Per the repo's memory rules, no AI attribution in any commit or PR.

---

### Task 1: Pre-flight and backup

**Files:** none (operational)

- [ ] **Step 1: Confirm every suite is green locally**

```bash
npm run db:reset && npm run db:test
npm test
npm run test:authz
cd frontend && npx tsc --noEmit && npm run build
```

Expected: everything passes. **Do not proceed on a red suite.**

- [ ] **Step 2: Take a full production backup**

```bash
set -a; . ./.env; set +a
mkdir -p data   # gitignored
supabase db dump --db-url "$DATABASE_URL" -f data/pre-cutover-schema.sql
supabase db dump --db-url "$DATABASE_URL" --data-only -f data/pre-cutover-data.sql
ls -la data/pre-cutover-*.sql
```

Expected: two non-empty files. `data/` is gitignored precisely because these
contain real phone numbers — never commit them, and delete them once the
cutover is confirmed good.

- [ ] **Step 3: Re-audit production membership**

The spec's audit is dated 2026-09-03. Confirm it still holds before acting
on it:

```bash
set -a; . ./.env; set +a
curl -s "$SUPABASE_URL/rest/v1/organizations?select=id,name,is_public&order=id" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY"
curl -s "$SUPABASE_URL/rest/v1/organization_members?select=organization_id,email,role" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY"
```

Expected: one organization (`id 1`, "My Team"), 11 memberships. **If the
numbers differ, stop and re-read the spec's cutover decisions** — new
members or a second organization change what the backfill will produce, and
the decisions were made against the old picture.

- [ ] **Step 4: Confirm the deployment target**

```bash
cat wrangler.jsonc | head -30
npx wrangler whoami
```

Note which environment you are about to touch. `wrangler.jsonc` has a
`development` env; confirm with the user whether this is prod or dev if
there is any doubt.

- [ ] **Step 5: Record the pre-flight result**

Write what you found — org count, membership count, backup file sizes — into
the PR description. If the cutover goes wrong, this is what tells you what
"before" looked like.

---

### Task 2: Apply migrations and run the cutover

**Files:** none (operational)

- [ ] **Step 1: Dry-run the migration list**

```bash
set -a; . ./.env; set +a
supabase migration list --db-url "$DATABASE_URL"
```

Expected: every `2026090300xxxx_*` migration shows as local-only (not yet
applied). The baseline should show as already applied, since it was dumped
*from* this database.

- [ ] **Step 2: Push the migrations**

```bash
supabase db push --db-url "$DATABASE_URL"
```

Expected: each migration applies in order. If one fails, the rest do not
run — fix it locally, `npm run db:reset` to prove the fix, and push again.

- [ ] **Step 3: Verify the backfill landed**

```bash
curl -s "$SUPABASE_URL/rest/v1/team_members?select=role" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY"
curl -s "$SUPABASE_URL/rest/v1/team_invites?select=email,role&accepted_at=is.null" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY"
```

Expected: 9 members (the accounts that already existed) and 1 pending invite
(`errriccccccccc@gmail.com`). The captain and the two extra invites come
from the next step.

- [ ] **Step 4: Run the cutover script**

```bash
node --env-file=.env scripts/cutover-production.mjs
```

Expected output: creates the `eric@venn.ca` account, assigns the captain row,
renames team 1 to "Disc-iples", creates pending invites for
`scruffy.selling@gmail.com` and `riceboxrandompurchases@gmail.com`, and
prints `final state: 10 members, 3 pending invites`.

**If the final line does not read 10 and 3, stop.** Re-run the script (it is
idempotent) and if the numbers still differ, compare against the Task 1
audit before changing anything by hand.

- [ ] **Step 5: Enable anonymous sign-ins in production**

In the Supabase dashboard: Authentication → Providers → Anonymous sign-ins →
enable. Or via the management API if the CLI token is available. Guest login
returns a 422 until this is on.

- [ ] **Step 6: Add the anonymous-user cleanup job**

```sql
-- Run in the production SQL editor (pg_cron is a project-level extension).
create extension if not exists pg_cron;

select cron.schedule(
  'purge-stale-anonymous-users',
  '0 4 * * *',
  $$ delete from auth.users
      where is_anonymous
        and created_at < now() - interval '30 days' $$
);
```

Without this, every guest visit leaves a permanent row in `auth.users`.

- [ ] **Step 7: Spot-check RLS from an unprivileged session**

Sign in to production as your own account and, in the browser console on the
deployed app, confirm a cross-team read returns nothing rather than data.
With one production team this is a weak test — the stronger evidence is the
pgTAP suite that ran against an identical schema locally.

---

### Task 3: Deploy the application

**Files:** none (operational)

- [ ] **Step 1: Confirm the tree is clean and on a branch**

```bash
git status
git branch --show-current
```

Expected: clean, and not `main`.

- [ ] **Step 2: Build and deploy**

Follow the repo's existing deploy skill rather than improvising — it encodes
the white-screen and multi-deployment incidents:

```bash
npm run build
npm run deploy
```

- [ ] **Step 3: Verify the environment secrets**

Confirm `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`
and `SUPABASE_JWKS_URL` are set for the deployed environment. A stale secret
here is the documented root cause in `SUPABASE_MULTI_DEPLOYMENT_FIX.md`.

- [ ] **Step 4: Smoke-test the deployed app**

| Check | Expected |
|---|---|
| Load the app signed out | Login page renders, no white screen |
| "Continue as a guest" | Session created; no Plays or AI tab |
| Guest sees Disc-iples | **No** — team 1 is private, so the guest sees an empty public list |
| Sign in as an existing member | Team loads, games and stats render |
| Team settings as a member | Read-only summary, no invite form |
| `/api/chat` with another team id | 403 |

- [ ] **Step 5: Tail the logs for errors**

```bash
npx wrangler tail
```

Watch a few real requests. A burst of 403s from legitimate users means the
backfill missed someone — check `team_members` against the Task 1 audit
before rolling back.

- [ ] **Step 6: Open the PR**

```bash
gh pr create --title "Team permissions: roles, personal stats, and guest access" --body "..."
```

The body should summarize the model, link the spec, and state the cutover
result (10 members, 3 pending invites). No AI attribution.

---

### Task 4: Rename the database objects

**Files:**
- Create: `supabase/migrations/20260904000100_rename_to_teams.sql`

**Interfaces:**
- Produces: `organizations` → `teams`, old `teams` → `squads`,
  `organization_id` → `team_id` on every table.

Ordering matters: the old `teams` must vacate the name before
`organizations` can take it.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260904000100_rename_to_teams.sql`:

```sql
-- Mechanical rename. No policy, function or behavior change: Postgres
-- rewrites policy and function bodies that reference a renamed table
-- automatically, because they are stored as parsed dependencies rather
-- than as text.
--
-- Order matters -- the old `teams` (a season's squad name) must vacate the
-- name before `organizations` (the group of people) can take it.

alter table public.teams rename to squads;
alter table public.organizations rename to teams;

-- Rename the tenant column everywhere it appears.
do $$
declare t record;
begin
  for t in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id'
     where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('alter table public.%I rename column organization_id to team_id', t.relname);
  end loop;
end
$$;

-- Indexes carry the old name in their own names; rename for legibility.
do $$
declare i record;
begin
  for i in
    select indexname from pg_indexes
     where schemaname = 'public' and indexname like '%organization_id%'
  loop
    execute format('alter index public.%I rename to %I',
                   i.indexname, replace(i.indexname, 'organization_id', 'team_id'));
  end loop;
end
$$;

-- my_teams() named the old column in its output; keep the output shape
-- stable for the frontend by aliasing.
create or replace function public.my_teams()
returns table (team_id bigint, name text, role text, is_public boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.name, m.role, t.is_public
    from public.team_members m
    join public.teams t on t.id = m.team_id
   where m.user_id = (select auth.uid())
   order by t.id;
$$;

revoke all on function public.my_teams() from public, anon;
grant execute on function public.my_teams() to authenticated;
```

- [ ] **Step 2: Update the test suites for the new names**

```bash
grep -rln "organization_id\|organizations" supabase/tests/
```

Replace `organization_id` with `team_id` and `public.organizations` with
`public.teams` in every test file. The old `teams` references in the seed
(`public.teams` meaning squads) become `public.squads`.

- [ ] **Step 3: Update the seed**

In `supabase/seed.sql`, rename `public.organizations` → `public.teams`,
the squad inserts `public.teams` → `public.squads`, and every
`organization_id` column → `team_id`.

- [ ] **Step 4: Prove it locally**

```bash
npm run db:reset && npm run db:test
```

Expected: **every assertion still passes, unchanged in count.** A rename
that changes a test outcome is not a rename — find what actually moved.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260904000100_rename_to_teams.sql supabase/tests supabase/seed.sql
git commit -m "Rename organizations to teams and teams to squads in the database"
```

---

### Task 5: Rename the application code

**Files:**
- Modify: ~26 files across `frontend/`, `gateway/`, `server/`,
  `mcp-server/`, `worker.ts`

- [ ] **Step 1: Inventory before touching anything**

```bash
grep -rl "organization" frontend gateway server mcp-server worker.ts \
  --include=*.ts --include=*.tsx | tee /tmp/rename-files.txt
grep -ro "organization" frontend gateway server mcp-server worker.ts \
  --include=*.ts --include=*.tsx | wc -l
```

Record both numbers. The second is your completion check.

- [ ] **Step 2: Apply the mechanical replacements**

Order matters — longest and most specific first, so a shorter pattern does
not corrupt a longer one:

```bash
FILES=$(cat /tmp/rename-files.txt)
for f in $FILES; do
  sed -i '' \
    -e 's/organization_id/team_id/g' \
    -e 's/organizationId/teamId/g' \
    -e 's/OrganizationMember/TeamMember/g' \
    -e 's/OrgMembership/TeamMembership/g' \
    -e "s/from('organizations')/from('teams')/g" \
    -e 's/currentOrgId/currentTeamId/g' \
    -e 's/switchOrg/switchTeam/g' \
    -e 's/isOrgMember/isTeamMember/g' \
    -e 's/orgId/teamId/g' \
    "$f"
done
```

`sed -i ''` is the macOS form; on Linux use `sed -i`.

- [ ] **Step 3: Handle the squad references by hand**

The frontend's `from('teams')` calls that mean *squads* now point at the
wrong table. Find them:

```bash
grep -rn "from('teams')" frontend gateway server mcp-server --include=*.ts --include=*.tsx
```

For each hit, read the surrounding code. If it selects `name` for a season's
squad label, change it to `from('squads')`. If it is the tenant, leave it.
**This is the one step the codemod cannot do**, because both concepts were
spelled the same way before the rename — which is exactly why the rename is
worth doing.

- [ ] **Step 4: Rename the files and components**

```bash
git mv frontend/pages/CreateOrganization.tsx frontend/pages/CreateTeam.tsx
git mv frontend/components/OrganizationSettingsDialog.tsx frontend/components/TeamSettingsDialog.tsx
grep -rn "CreateOrganization\|OrganizationSettingsDialog" frontend --include=*.tsx
```

Update every import and component identifier the grep finds.

- [ ] **Step 5: Typecheck and build**

```bash
cd frontend && npx tsc --noEmit && npm run build
cd .. && npx tsc --noEmit -p server/tsconfig.json
```

Expected: clean. Type errors here are the codemod's mistakes surfacing — fix
them, do not suppress them.

- [ ] **Step 6: Confirm the inventory reached zero**

```bash
grep -ro "organization" frontend gateway server mcp-server worker.ts \
  --include=*.ts --include=*.tsx | wc -l
```

Expected: `0`, or only historical references inside comments that describe
migration 016 by name. Anything else is an incomplete rename.

- [ ] **Step 7: Run everything**

```bash
npm run db:reset && npm run db:test
npm test && npm run test:authz
```

Expected: all green, with the same assertion counts as before the rename.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Rename organizations to teams throughout the application code"
```

---

### Task 6: Ship the rename and update the documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `.claude/skills/supabase-migration/SKILL.md`
- Modify: `~/.claude/projects/.../memory/auth-system.md`

- [ ] **Step 1: Push the rename migration**

```bash
set -a; . ./.env; set +a
supabase db push --db-url "$DATABASE_URL"
```

- [ ] **Step 2: Deploy**

```bash
npm run build && npm run deploy
```

- [ ] **Step 3: Smoke-test again**

Re-run the Task 3 Step 4 table in full. A rename that breaks a query breaks
it at runtime, not at build time, so clicking through is the test.

- [ ] **Step 4: Update the terminology in CLAUDE.md**

Migration 016's naming note in `CLAUDE.md` (and anywhere else describing
`organizations` as the tenant) now describes the opposite of reality.
Rewrite it:

```markdown
- `teams` is the tenant: a group of people with captains, editors and
  members. Every domain row carries `team_id`.
- `squads` is a season's squad name ("Disc-iples", "Jogging Dead"). The same
  group plays under several squad names across leagues and seasons.
```

- [ ] **Step 5: Update the auth-system memory**

The `auth-system` memory describes the allowlist and open-access model this
work replaced. Rewrite its body to describe: uid-keyed `team_members` with
three roles, invite-only membership, anonymous guests limited to public
teams, RLS as the single boundary, and service-key routes checking
membership explicitly. Keep the file name and its links.

- [ ] **Step 6: Delete the backup dumps**

```bash
rm -f data/pre-cutover-schema.sql data/pre-cutover-data.sql
```

They contain real phone numbers. Once the cutover is confirmed good, they
are a liability sitting on a laptop.

- [ ] **Step 7: Commit and merge**

```bash
git add CLAUDE.md .claude/skills/supabase-migration/SKILL.md
git commit -m "Update terminology and documentation for the teams rename"
git push
gh pr view --web
```

Merge once CI is green.

---

## Done when

- Production runs strict RLS, with 10 members and 3 pending invites on
  team 1, now named "Disc-iples" and captained by `eric@venn.ca`.
- Anonymous sign-ins are enabled and stale guests are purged nightly.
- `grep -ro "organization" --include=*.ts --include=*.tsx` returns 0 outside
  historical comments.
- Every suite passes with the same assertion counts as before the rename.
- `CLAUDE.md` and the `auth-system` memory describe the model that actually
  exists.

## Rollback

If the cutover goes wrong before the app deploy, the database is the only
thing changed and `data/pre-cutover-*.sql` restores it. After the app
deploy, roll back the Worker to the previous deployment first (the old code
expects `using (true)` policies and will 403 everywhere against strict RLS),
then restore the database. Do not attempt to run the old frontend against
the new schema — `players.phone` no longer exists, and the roster page will
error rather than degrade.
