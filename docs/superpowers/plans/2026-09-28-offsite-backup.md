# Free Off-site Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Daily encrypted off-site recovery points for repository state, Supabase database, Storage objects, and local recovery configuration, using existing free Google Drive space.

**Architecture:** One operator-owned backup script stages a read-only export, verifies captured files, uploads into a uniquely dated encrypted rclone destination, then records successful completion. A systemd user timer invokes it; restore stays manual and targets an isolated environment. Encryption key custody remains separate from this device.

**Tech Stack:** Node.js 22 stdlib, installed Supabase CLI 2.117.0, installed rclone 1.75.1, Git, systemd user timer, existing Google Drive remote.

**Spec:** `docs/superpowers/specs/2026-09-28-offsite-backup-design.md`

## Global Constraints

- Destination: `gdrive-ericvoong0309`, currently ~15.98 GB free; confirm ownership, auth, quota, and target folder before writing.
- Production access read-only. Never invoke `db push`, `db reset`, Storage delete/sync-delete, or restore on production.
- Upload only through encrypted rclone crypt remote; password and salt must exist off-machine before baseline or scheduling.
- Local QA Docker disabled by default; do not start without separate approval.
- Do not commit credentials, plaintext data, generated backups, or expose secrets in arguments, logs, tests, or plan.
- No new runtime dependencies. Test script behavior without touching production before first run.
- Do not commit changes unless user explicitly requests a commit (repo-level instruction takes precedence over plan skill's suggested commit steps).

## Review Focus

- Missing or invalid database credential: fail without logging URL, uploading partial snapshot, or altering last-success marker (Task 2 test).
- Untracked and ignored files: preserve untracked project files, include only allowlisted local secrets, exclude caches, generated data, and QA dumps (Task 1 test).
- Empty Storage bucket or inaccessible object: accept legitimately empty bucket, fail on inaccessible file and preserve prior snapshot (Task 3 test).
- Rclone quota, interrupted transfer, or expired token: fail without pruning or updating last-success marker (Task 4 test).
- Scheduler runs without interactive login or machine is powered off: report actual persistence guarantee; avoid claiming daily coverage when host absent (Task 5 check).

## File map

- Create `scripts/backup-offsite.mjs`: orchestration, staging, export, manifest, verification, upload, success marker, pruning controls.
- Create `scripts/backup-offsite.test.mjs`: stdlib assert-based dry-run/failure checks using fake command adapters and temporary fixtures.
- Create `scripts/backup-offsite.service` and `scripts/backup-offsite.timer`: user-level scheduled invocation, no embedded secrets.
- Modify `.gitignore`: exclude any local backup runtime config or status file kept in repo; preferably keep both outside repo and avoid change.
- Create `docs/backup-restore.md` only if user specifically requests documentation; otherwise put concise recovery instructions in the implementation plan and operator output.

### Task 1: Source selection and repository snapshot

**Files:** Create `scripts/backup-offsite.mjs`, `scripts/backup-offsite.test.mjs`.

**Interfaces:** `selectRepoFiles(repoRoot, allowlistedIgnoredPaths)` returns relative file list; `stageRepo(repoRoot, stageRoot)` creates `repo.bundle` and copies selected working-tree files. Later tasks call `stageRepo` only after preflight.

- [ ] **Step 1: Write failing tests** using `node:test` and `node:assert/strict`: temporary git fixture with committed file, changed tracked file, untracked file, `.env`, `node_modules`, and `.qa`; assert bundle exists, changed/untracked content copied, ignored non-allowlisted files omitted, and allowlisted `.env` included only when it exists. Check path traversal/symlink escapes fail.
- [ ] **Step 2: Run** `node --test scripts/backup-offsite.test.mjs`; expect source-selection tests to fail before implementation.
- [ ] **Step 3: Implement** exact allowlist for `.env`, `.env.local`, `frontend/.env`, `frontend/.env.local`, `.dev.vars`, and other verified recovery files. Use Git tracked/untracked enumeration plus a `git bundle create` covering all refs; stage copied files at permissions 0700/0600. Exclude generated and unrelated ignored files. Capture HEAD and status without leaking file content to logs.
- [ ] **Step 4: Rerun** `node --test scripts/backup-offsite.test.mjs`; expect pass.

### Task 2: Safe database export

**Files:** Modify `scripts/backup-offsite.mjs`; extend `scripts/backup-offsite.test.mjs`.

**Interfaces:** `exportDatabase(stageRoot, config, runner)` produces roles, schema, data SQL files and an inventory of checked dump files; runner injectable for tests.

- [ ] **Step 1: Test** missing/invalid DB URL, failed CLI command, empty dump, and output containing expected `auth.users` and `storage.objects` data sections in fake fixtures. Assert failure leaves no completion marker and never formats credentials into an error.
- [ ] **Step 2: Run** `node --test scripts/backup-offsite.test.mjs`; expect new tests fail.
- [ ] **Step 3: Implement** read-only export using confirmed `npx supabase db dump --help` flags: separate `--role-only`, default schema, and `--data-only --use-copy` dumps; confirm documented schema scope for auth/storage before selecting CLI flags. Do not pass credential URL on command line if process listing can reveal it; use a protected connection mechanism or stop and ask user if CLI requires unsafe argv. Use production URL only, reject localhost and absent values. Verify exported sections rather than assuming CLI defaults include auth/storage.
- [ ] **Step 4: Rerun** test; inspect one redacted dry-run invocation and inspect dump structure during baseline without printing row data.

### Task 3: Storage inventory and object bytes

**Files:** Modify `scripts/backup-offsite.mjs`; extend `scripts/backup-offsite.test.mjs`.

**Interfaces:** `exportStorage(stageRoot, config, runner)` produces copied object bytes and a manifest of bucket, key, byte length, SHA-256. Do not mutate remote Storage.

- [ ] **Step 1: Test** nested keys, special characters, empty buckets, inaccessible objects, and count/hash mismatch; assert partial copy fails closed without success marker.
- [ ] **Step 2: Run** test, expect failures.
- [ ] **Step 3: Confirm** live bucket inventory via read-only Supabase CLI, Storage API, or verified S3 endpoint. CLI supports `storage ls --recursive --project-ref` and `storage cp --recursive --project-ref`; verify output and directory semantics on a safe fixture before relying on them. Download every bucket; hash local bytes, compare actual inventory and record non-atomic capture interval. Avoid direct writes to `storage.objects` on restore.
- [ ] **Step 4: Rerun** tests; expect pass.

### Task 4: Encrypted upload, verification, retention

**Files:** Modify `scripts/backup-offsite.mjs`; extend `scripts/backup-offsite.test.mjs`.

**Interfaces:** `uploadSnapshot(stageRoot, timestamp, config, runner)` uploads encrypted unique path, reads back manifest and selected data, writes success marker only after checks. `pruneSnapshots` retains seven daily and four weekly complete snapshots, never last good snapshot.

- [ ] **Step 1: Test** quota exhaustion, interrupted upload, crypt remote misconfiguration, remote readback mismatch, and failed prune. Assert no plaintext destination, no false success, no cleanup of last good backup.
- [ ] **Step 2: Run** test, expect failures.
- [ ] **Step 3: Configure** a dedicated crypt remote over existing Drive folder with encrypted filenames and content, key/salt stored off-device first; do not record passwords in repo or shell history. Use unique UTC run folders and encrypted manifest; upload with `rclone copy` (never `sync`). Check space and verify remote contents via crypt remote readback. Prune only completed snapshots after successful current run; fail conservatively if quota insufficient. Remove staged plaintext using `finally` and restrictive permissions.
- [ ] **Step 4: Rerun** tests; manually exercise an encrypted test fixture with no private data, read it back and compare hash.

### Task 5: Baseline, recovery rehearsal, scheduling

**Files:** Create `scripts/backup-offsite.service`, `scripts/backup-offsite.timer`; modify `scripts/backup-offsite.mjs` for CLI entrypoint.

**Interfaces:** `node scripts/backup-offsite.mjs --check` performs preflight without writing; normal invocation creates one backup. Timer starts only after successful baseline and recovery key custody confirmation.

- [ ] **Step 1: Test** CLI preflight with missing key/remote, no network, insufficient quota, and failed export; verify nonzero exit and no backup upload. Run `node --test scripts/backup-offsite.test.mjs`.
- [ ] **Step 2: Run** preflight and read-only inventory against actual project; verify DB connection path, Store buckets, Drive quota, hostname, and scheduler behavior. Stop and report blockers instead of guessing credentials or enabling incomplete coverage.
- [ ] **Step 3: Confirm** recovery password and salt stored off-machine with owner; create first baseline, inspect manifests and representative restored file from encrypted destination. Restore Git bundle and working-tree fixture locally; restore one object only to private temporary directory. Full database restore deferred until explicitly approved isolated target exists; state untested restore explicitly.
- [ ] **Step 4: Install** user service/timer with daily schedule, `Persistent=true`, locked single-instance execution, restrictive umask, and log status; check whether user lingering is enabled, and if not obtain approval before changing machine-level settings or state uptime limitation. Run `systemctl --user list-timers` and inspect unit status.
- [ ] **Step 5: Verify** `node --test scripts/backup-offsite.test.mjs`, `npm run typecheck:frontend`, and relevant repo lint command if defined. Do not run root `npm test` because it reads production. Verify no plaintext or credentials are staged in Git using `git status --short`, `git diff --check`, and inspection of intended files only.

## Self-review

Spec coverage: repository history/working state, allowlisted secrets, DB+auth+Storage metadata, object bytes, encryption, quota, retention, failure signals, scheduler, and isolated recovery checks map to Tasks 1-5. Full DB restore explicitly remains approval-gated; do not claim recovery proven until that rehearsal occurs. Confirm vendor CLI credential handling and Storage inventory semantics before coding final commands; fail closed where unavailable.
