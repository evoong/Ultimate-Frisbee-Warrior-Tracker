# QA Environment Design

## Summary

This design establishes a **local-first, free, production-safe QA environment** using the Supabase CLI's Docker stack. No second hosted project, no production data access in QA commands, no Pro plan required.

## Goals

- QA database is always a local Docker container started by `supabase start`
- Migrations + tracked seed (`supabase/seed.sql`) are the only source of QA data
- Test identities are created locally only (already implemented in `seed-local-users.mjs`)
- One explicit, manual script can import a scrubbed production snapshot when needed
- CI uses the same local stack — no separate test infra
- Production credentials are never read by QA commands

## Non-Goals

- Shareable staging URL (requires hosted project)
- Automated production sync (too risky without Pro branching)
- Ephemeral per-PR preview databases (Docker startup too slow for CI)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     QA Environment                          │
├─────────────────────────────────────────────────────────────┤
│  supabase start          supabase db reset                  │
│  ┌──────────────┐      ┌──────────────┐                    │
│  │  Docker:     │      │  Migrations  │                    │
│  │  Postgres    │ ───▶ │  + seed.sql  │                    │
│  │  Auth        │      │  (tracked)   │                    │
│  │  Studio      │      └──────┬───────┘                    │
│  └──────────────┘             │                            │
│                               ▼                            │
│                    ┌────────────────────┐                   │
│                    │ seed-local-users   │                   │
│                    │ (test identities)  │                   │
│                    └────────────────────┘                   │
└─────────────────────────────────────────────────────────────┘
```

## Data Model

No new tables. QA uses existing `supabase/seed.sql` for base data and `scripts/seed-local-users.mjs` for auth test identities.

## Commands Added

| Command | Purpose | Safety |
|---------|---------|--------|
| `npm run qa:reset` | `supabase db reset` + seed test users | Local only, refuses prod URL |
| `npm run qa:import-prod` | Manual: dump prod → scrub → restore to local | Manual-only, gitignored output |
| `npm run qa:verify` | Run migrations, RLS tests, gateway tests, typecheck, build | Local only |

## Safety Guards

1. **URL validation**: Every QA script asserts `SUPABASE_URL` matches `127.0.0.1` or `localhost`. Refuses prod URL.
2. **Environment separation**: `.env.local` (QA) and `.env` (prod) are distinct; scripts explicitly source `.env.local`.
3. **No prod keys in QA**: `SUPABASE_SECRET_KEY` for QA comes from `supabase status`, never from `.env`.
4. **Gitignored artifacts**: Production dump and scrubbed output never committed.

## CI Integration

Existing `ci.yml` already:
- Starts local Supabase (`supabase start`)
- Runs `supabase db reset` (migrations + `seed.sql`)
- Runs `npm run db:seed:users` (test identities)
- Runs pgTAP + gateway tests

New: `qa:verify` runs the same test matrix locally before push.

## Prod Import Procedure (Manual)

```bash
# 1. Dump production (run once, output to gitignored file)
pg_dump "$DATABASE_URL" --no-owner --no-privileges --schema=public \
  --exclude-table=auth.* --exclude-table=storage.* \
  --exclude-table=team_members --exclude-table=player_private \
  > .qa/prod-dump-$(date +%F).sql

# 2. Scrub (manual review step)
#    - Remove INSERTs for users/teams not in seed
#    - Keep only: seasons, games, game_events, game_lineups, players (public cols)
#    - Write to .qa/prod-scrubbed.sql

# 3. Restore to local QA
supabase db reset
psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -f .qa/prod-scrubbed.sql
npm run db:seed:users
```

Output directory `.qa/` is gitignored.

## Implementation Files

- `package.json`: add `qa:reset`, `qa:import-prod`, `qa:verify` scripts
- `scripts/qa-reset.mjs`: wrapper around `supabase db reset` + seed users, with URL guard
- `scripts/qa-import-prod.mjs`: interactive guided import (prompts, validates, restores)
- `scripts/qa-verify.mjs`: runs full local test suite
- `.gitignore`: add `.qa/` directory

## Verification

```bash
# From clean state:
npm run qa:reset
npm run qa:verify    # all tests pass

# With prod data:
npm run qa:import-prod
npm run qa:verify    # all tests pass

# CI parity:
git push              # CI runs same supabase stack + tests
```

## Rollback

No migration changes. Scripts are additive. Remove scripts and `.qa/` from gitignore to revert.