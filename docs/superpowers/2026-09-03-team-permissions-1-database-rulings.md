# Team permissions, Plan 1: decisions taken during execution

Branch: feature/personal-profiles. Plan:
docs/superpowers/plans/2026-09-03-team-permissions-1-database.md

This plan was executed task-by-task with a review after each. Where the plan
was wrong, ambiguous, or silent, a decision was taken rather than stopping to
ask. Every one of those decisions is recorded below so it can be reviewed and
reversed. Roughly 35 defects were found in the plan itself during execution;
the ones that changed the shipped code are the rulings marked FIX.

## Rulings, in the order they were made

- Ruling: no conflicts found that require changing the plan; execute as written.

- Ruling: add `!.env.local.example` to `.gitignore` immediately after the `.env*` line and include `.gitignore` in T1's commit. The file holds only placeholders, and the plan explicitly requires it tracked; a targeted un-ignore keeps every real `.env*` ignored. Cost if wrong: one extra line in `.gitignore`.

- Ruling: Task 1 builds its dump URL by substituting the `aws-1` host into `.env`'s DATABASE_URL. `.env` itself is NOT edited - it is the user's gitignored secret file and editing it is a side effect outside this task.

- Ruling: retry the plan's own `supabase db dump` with the corrected host first, so the toolchain stays uniform with later tasks; fall back to a containerized `pg_dump` only if it hangs again past 3 minutes. Cost if wrong: one wasted 3-minute retry.

- Ruling: keep `major_version = 17`; treat the plan's "15" as stale prose and do not "correct" the config down to 15. A PG15 local container cannot reliably restore a PG17 dump. Cost if wrong: none identified; version skew between local and production would be the alternative.

- Ruling: resume Task 1 with a fresh implementer covering Steps 5-9 only; Steps 1-4 are verified complete and must not be redone (a re-dump would re-touch production). Cost if wrong: a redundant step re-run.

- Ruling: the CONTROLLER runs `supabase start` itself as a backgrounded Bash command, and implementer dispatches cover only the fast file-edit and verification steps. `supabase start` is local-only, idempotent, produces no reviewable diff, and has now killed two subagents; keeping it out of agent hands costs nothing in review coverage. Cost if wrong: the controller holds a little infra state that the ledger has to carry, which it now does.

- Ruling: commit `supabase/.gitignore` as generated, unmodified. It is the Supabase CLI's own convention, it is output of a Step-1 command that was in Task 1's scope, and ignore rules that do not survive a clone are not ignore rules. Route it through the implementer in the fix round together with the reviewer's findings rather than fixing it in the controller session, so it gets a re-review like everything else. Cost if wrong: one 7-line generated file tracked that some future reader has to recognise as CLI boilerplate.

- Ruling: accept the findings as accurate-but-expected and do NOT act on them in Task 1. Fixing authorization inside the baseline would defeat its purpose - the baseline must reproduce production faithfully or the pgTAP suite proves nothing about the migration path. Task 14 is where this is fixed, Task 16 is where it is proven. Cost if wrong: the open policies live on in local dev only, for the duration of this plan; production is untouched either way.

- Ruling: fold organization_id into the INSERT column list (`(id, name, organization_id)` with values 1 and 2 respectively) and DELETE the now-redundant follow-up UPDATE. Cost if wrong: none; the end state is byte-identical to what the brief intended, reached in one statement.

- Ruling: drop `point_number` from the game_events INSERT column list and drop the corresponding value from each row. The seed's purpose is four goal events across two orgs; point ordering is not load-bearing for any test in this plan.

- Ruling: FIX IT in Task 2's seed.sql - add setval for organizations, teams and seasons following the existing players/games pattern. The spec is the binding authority and the spec needs create_team() to work. Cost if wrong: three extra setval lines; the alternative is Task 9 failing on its first RPC call.

- Ruling: do NOT block Task 3 on this - the harness is required and the plan mandates it as a migration. Fix the misleading header (above) so the tradeoff is stated honestly in the file, carry this to the final whole-branch review, and surface it to the human as a deployment decision for Plan 4 / Task 18 (which documents the migration flow). The live options are: ship it as-is, or gate the tests schema so it is created only outside production. That is a deployment-policy call, not a code call, and it is the human's. Cost if wrong: a test-only schema exists in production with a low-value grant on it.

- Ruling: run the membership seed through the db container instead, resolving the container id rather than hardcoding a name that is derived from the directory name: `docker exec -i $(docker ps -qf name=supabase_db) psql -U postgres -d postgres < scripts/seed-local-memberships.sql` Cost if wrong: a local-only dev script needs a different invocation; no production impact.

- Ruling: follow the step's FINAL instruction - create `scripts/seed-local-memberships.sql` and do NOT touch `supabase/seed.sql`. The reasoning given for the move is correct: team_members rows reference auth.users, which does not exist at seed.sql time. The Files header is stale.

- Ruling: FIX IT. The spec is the binding authority and this trigger IS the mechanism for the at-least-one-captain invariant that Tasks 8-14 and 16-18 all build on. Shipping a trigger that fails its one job, under a comment asserting it cannot, is worse than not having it.

- Ruling: dispatch Task 5 as written, no corrections.

- Ruling: seed.sql MUST change in this task. Remove `phone` from the players INSERT column list and values, and add a `player_private` seed block carrying the 555-01xx numbers for players 101-104 with team_id matching each player's organization_id. Include supabase/seed.sql in the commit. Cost if wrong: none identified; without it the branch cannot reset its own database.

- migration time. Ruling: reword the assertion message to say what it checks.

- Ruling: do NOT fix any of them here, per the brief - frontend is Plan 3. Record them in the commit message as the brief asks.

- Ruling: STRIP them. The user's persisted project memory (no-claude-attribution-in-commits) records a direct instruction from Luca: "Never add Co-Authored-By: Claude lines or any other AI attribution to commit messages in this project." A specific standing instruction from the repo owner beats a generic harness default. Corroborating evidence: all nine prior commits on this branch carry zero attribution lines, so honouring the reminder would have made exactly one commit inconsistent with the branch.

- Ruling: FIX NOW rather than defer. The reviewer suggested a follow-up, but this is a one-line assertion in a file already open, the asymmetry is arbitrary rather than designed, and a deferred test-coverage item is exactly the kind of thing that never gets done. Cost if wrong: one extra assertion.

- Ruling: dispatch as written, no corrections.

- Ruling: ACCEPT as-is, do not narrow the loop. Two reasons.

- Ruling: dispatch as written, no corrections.

- Ruling: insert `select tests.logout();` before each subsequent `tests.login_as(...)` / `tests.login_as_guest()` in 05_helpers.test.sql. Do NOT make tests.login_as SECURITY DEFINER to permit chaining - that would undo the Task 3 protection which I verified blocks a real impersonation path, and would trade a live security property for test convenience. Cost if wrong: three extra lines in a test file.

- Ruling: every remaining dispatch carries the corrected test file. Do not treat this as a per-task discovery - it is one plan-wide defect with eight instances, and Task 16 (the named escalation suite, 5 logins) is the one where silently aborting after two assertions would be most damaging, since that suite is the proof the whole permission model works.

- Ruling: log out BEFORE assertion 2 so it runs as postgres (table owner, bypasses RLS), and identify the user by email instead of auth.uid(), since logging out clears request.jwt.claims and auth.uid() would then be null: select is( (select m.role from public.team_members m join auth.users u on u.id = m.user_id where u.email = 'member@local.test' and m.team_id = (select max(id) from public.organizations)), 'captain', 'the creator is the new team''s captain'); This preserves exactly what the assertion is for - proving create_team makes the caller a captain of the new team - while reading through a role that can see the row. Cost if wrong: the assertion reads as postgres rather than as the user, which is correct here because it is asserting stored state, not policy behaviour. Policy behaviour is Task 13's and Task 16's job.

- Ruling: assertions 2 and 4 must run as postgres (logout first) and identify the subject by email rather than auth.uid(), which is null once logged out.

- Ruling: add `#variable_conflict use_column` as the first line of the function body, immediately before `declare`. Verified end to end with that one line added and nothing else changed: fix1_first_accept=1     (invite consumed) fix1_second_accept=0    (accepting twice is a no-op) fix1_granted_role=member Rejected alternative: `on conflict on constraint team_members_team_id_user_id_key` also works (constraint name confirmed to exist), but it hard-codes an auto-generated constraint name into a migration, which breaks if the table is ever recreated with different naming. The pragma addresses the actual root cause - RETURNS TABLE shadowing - and is the idiomatic fix.

- Ruling: capture the uuids ONCE at the top of the file, while still running as postgres, into a temp table, and grant it to authenticated: create temp table t_uids as select email, id from auth.users where email like '%@local.test'; grant select on t_uids to authenticated; then replace every `(select id from auth.users where email = X)` with `(select id from t_uids where email = X)`.

- Ruling: FIX IT, unlike the Task 9 revoke_invite oracle which I deferred as Minor. The two are not equivalent. revoke_invite leaks only whether a sequential invite id exists and is pending, identifying no person. This one takes an attacker-supplied (team, user) pair and answers "is this person on that team", which is a direct membership-privacy leak on a private team.

- Ruling: same fix - capture uuids into a temp table as postgres at the top, grant select to authenticated.

- Ruling: split the call from the read. Stash the returned link id while logged in, then log out and read the status as postgres: create temp table t_links(label text, link_id bigint); grant insert, select on t_links to authenticated; ...

- Ruling: DEFER, and I want the reasoning on record because it differs from what I decided in Task 11, where I DID fix the equivalent oracle.

- Ruling: replace the NULL message argument in assertions 1-4 with the exact privilege-denial message, which I captured after applying only the revokes: 'permission denied for table team_members'   (assertions 1 and 2) 'permission denied for table team_invites'   (assertion 3) 'permission denied for table player_links'   (assertion 4) This makes each assertion fail before the migration and pass after, and pins it to the privilege mechanism rather than to any 42501. Cost if wrong: the assertions become sensitive to Postgres's wording for privilege denial, which is stable and is exactly what we mean to assert.

- Ruling: `(select public.fn())::bigint[]` is the house form for every policy from here on. Tasks 14 and 15 must use it; their briefs will contain the non-compiling shape.

- Ruling: FIX IT, using `revoke all ... from authenticated` followed by `grant select`, rather than extending the explicit list. Reasons: it is symmetric with the `revoke all ... from anon` line two lines below; it catches TRUNCATE, REFERENCES and TRIGGER together; and it cannot drift again the next time Postgres or Supabase adds a privilege type. Verified: after the fix: sel=true, ins=false, trunc=false, refs=false on all three member truncate -> 42501 permission denied for table team_members member read     -> still 4 rows Cost if wrong: none identified; `grant select` restores the only privilege the design intends clients to hold.

- Ruling: lift player_private OUT of the tier_b array and give it its own explicit tier-B policy block keyed on team_id. Keeping it in the loop would require making the loop tenant-column-aware for a single exception, which is more machinery than the one special case is worth.

- Ruling: `(select public.fn())::bigint[]` everywhere, the house form established in Task 13 and verified there to preserve InitPlan.

- Ruling: revoke `truncate, references, trigger` from authenticated on every table this migration touches. NOT `revoke all` here - unlike the membership tables, domain tables MUST keep insert/update/delete for authenticated, because that is exactly what the new policies govern. Stripping them would break every legitimate write. This is the one place where the Task 13 fix shape must not be copied verbatim.

- Ruling: wrap as `(select array_length(public.my_member_team_ids(), 1)) > 0`.

- Ruling: add all five to the tier arrays, in TIER B.

- Ruling: `::bigint[]` house form, as in Tasks 13 and 14.

- Ruling: `%I`.

- Ruling: retarget assertion 6 at a TIER B table, where isolation is absolute and the claim is actually true: select is_empty($$ select id from public.strategy_plays where organization_id = 2 $$, 'ESCALATION: member cannot see another team''s strategy, even a public team''s'); Verified: that returns 0 rows for member@local.test.

- Ruling: fix the MAPPING, do not add a duplicate assertion. The privilege property is already covered, and covered precisely because of the correction I made in Task 13 - I required assertions 1-4 there to pin the exact message `permission denied for table X` rather than bare SQLSTATE 42501. Verified that this catches the regression: with the INSERT grant restored, the message becomes `new row violates row-level security policy for table "team_members"`, which no longer matches, so 10_membership_lockdown assertion 1 FAILS.

- Ruling: replace the invite upsert with an explicit select-then-insert-or-update through PostgREST, filtering on `accepted_at is null`. That expresses the partial-index semantics that PostgREST's onConflict cannot. Keep it idempotent.

- Ruling: require an explicit opt-in for a non-localhost target - print the resolved host and refuse unless `CUTOVER_CONFIRM=1` is set. Local rehearsal against 127.0.0.1 stays frictionless.

- Ruling: escalate to a FRESH implementer rather than resuming a third time. The process rule is not to force the same agent to retry unchanged, and this is a loop the agent cannot see - its own last message is the thing keeping it stuck.

- Ruling: the verification ORDER must be stated and followed - run the suite green FIRST, then rehearse twice to prove idempotence, then `npm run db:reset` to restore the fixture, then confirm the suite is green again. Record the order in the report so the next person rehearsing does not think they broke the suite.

- Ruling: document it in the SCRIPT'S HEADER, not only the report. An operator about to rehearse reads the script, not a task report in a git-ignored workspace. The report gets it too, with the correct order stated.

- Ruling: update the description too.

- Ruling: document it. This is squarely what a Gotchas section is for, and the knowledge otherwise dies with this session's ledger.

- Ruling: FIX. The guard is sound because in a cascade the parent row is already gone when the child trigger fires, while a direct delete still sees it. Add BOTH a positive test (a captain CAN delete a team) and keep the negative one - the suite only ever asserted the failure direction, which is exactly why this survived 18 task reviews.

- Ruling: FIX, and add the meta-test that would have caught it.

- Ruling: DOCUMENT in the migration and in CLAUDE.md. Do not silently leave an operator to guess at 2am.

- Ruling: DOCUMENT, do not add a SELECT policy. Whether members may LIST photo objects is a product decision that belongs in the spec and in Plan 3, not invented here at the end of Plan 1. Likely pre-existing - production has never had a storage SELECT policy either. Carry to Plan 3.

## Findings deferred rather than fixed

- 04_indexes.test.sql:14-16's condition
- 05_helpers never exercises outsider@local.test,
- `create trigger team_members_require_captain` has
- `docker ps -qf name=supabase_db` in package.json is
- `npm run db:reset` prints
- accept_invite matches on `lower(u.email)` without
- both unique constraints on player_links surface a
- game_events and strategy_plays inserts lack the
- is_guest() is stable, invoker, and keeps anon
- listUsers({ perPage: 1000 }) caps the captain
- redundant single-column index on
- revoke_invite leaks an existence oracle. A
- scripts/seed-local-users.mjs:33 logs a failed user
- set_player_link's `on conflict (player_id) do
- storage_path_team_id's regex checks digit SHAPE but
- tests.* helpers do not pin search_path. Justified
- the commit body's reader list is not reproducible by
- the committed test file covers INSERT only. The
- the email regex is deliberately lenient - input
- the plan document at line 430 still says standings
