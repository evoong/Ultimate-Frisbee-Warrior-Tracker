# QA Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a local-first, free, production-safe QA environment.

**Architecture:** Local Supabase (Docker) + clean reset wrapper + automated test suite runner + prod dump-and-scrub template.

**Tech Stack:** Node.js, Shell scripts, Supabase CLI, Docker, pgTAP.

**Spec:** `docs/superpowers/specs/2026-09-23-qa-environment-design.md`

## Global Constraints

- Never use production URL or service role key in QA scripts.
- Every QA script must assert `SUPABASE_URL` is local.
- No new external/hosted resources.

## Review Focus

- If database reset fails, correct docker error and retry.
- Verify `SUPABASE_URL` is checked before every destructive db command.

---

### Task 1: Add Package Scripts and Gitignore

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Edit .gitignore**
- [ ] **Step 2: Add scripts to package.json**
- [ ] **Step 3: Commit**

### Task 2: Create qa-reset.mjs Script

**Files:**
- Create: `scripts/qa-reset.mjs`

- [ ] **Step 1: Write `scripts/qa-reset.mjs`**
- [ ] **Step 2: Run `npm run qa:reset` and verify local database is clean, migrations run, users seeded**
- [ ] **Step 3: Commit**

### Task 3: Create qa-verify.mjs Script

**Files:**
- Create: `scripts/qa-verify.mjs`

- [ ] **Step 1: Write `scripts/qa-verify.mjs`**
- [ ] **Step 2: Run `npm run qa:verify` and ensure all tests pass locally**
- [ ] **Step 3: Commit**

### Task 4: Create qa-import-prod.mjs Guidance Script

**Files:**
- Create: `scripts/qa-import-prod.mjs`

- [ ] **Step 1: Write `scripts/qa-import-prod.mjs`**
- [ ] **Step 2: Run `npm run qa:import-prod` to verify safety assertion checks**
- [ ] **Step 3: Commit**

### Task 5: Update README and Documentation

**Files:**
- Modify: `README.md`
- Create: `docs/QA_ENVIRONMENT.md`

- [ ] **Step 1: Update README.md with QA section**
- [ ] **Step 2: Write docs/QA_ENVIRONMENT.md for detailed setup**
- [ ] **Step 3: Commit**
