# QA Environment

## Overview
A local, free, production-safe QA environment. It uses the Supabase CLI Docker stack, managed via npm scripts.

## Setup
1. `npm install` in repo root and `cd frontend && npm install` for frontend dependencies.
2. `npx supabase start` to start isolated local Docker stack.
3. `npm run qa:reset` to apply migrations, seed test identities, and write `.env.local` from local stack credentials.
4. `npm run qa:verify` to run full checks.

For guided setup, use `.claude/skills/repo-setup/SKILL.md`.

## Commands

| Command | Purpose | Safety |
|---------|---------|--------|
| `npm run qa:reset` | Reset DB + seed test users | Local-only guard |
| `npm run qa:verify` | Run full test suite | Local-only guard |
| `npm run qa:import-prod`| Guided safe-import from production | Requires QA_PROD_SOURCE_URL, manual-only |

## Production Import Procedure
1. Set `QA_PROD_SOURCE_URL=postgresql://...` to your production database URL.
2. Run `npm run qa:import-prod`.
3. The script will dump only approved tables (seasons, games, etc.), scrub sensitive schemas, and restore to local QA.
4. `.qa/` folder contains intermediate files; it is gitignored.

## Resource usage / stopping

The stack is 10 Docker containers holding ~1GB RAM. Stop it when QA is not in progress:

```bash
npx supabase stop             # stop, keep DB volume (data survives)
npx supabase stop --no-backup  # stop and wipe DB volume (full reset next start)
```

**This device (Ubuntu dev box): the QA stack is disabled by default and kept stopped.** Start it only when local QA is explicitly requested, and stop it again afterwards.

## Safety
- All scripts assert the target Supabase URL is local (`127.0.0.1` or `localhost`).
- Production credentials are never read by QA commands.
- `qa:import-prod` only imports tables explicitly defined in the script's `ALLOWED_TABLES` list.
