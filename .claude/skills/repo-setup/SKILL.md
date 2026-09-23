---
name: repo-setup
description: Setup the Ultimate Frisbee Warrior Tracker repo for development or QA. Use this skill whenever someone says "set up", "getting started", "install", "run locally", or "how do I start" on this repo.
---

# Repo Setup: Ultimate Frisbee Warrior Tracker

This skill covers **two distinct modes**: production development (connect to cloud Supabase) and local QA (isolated Docker stack).

---

## 1. Production Development (default)

Use this for feature work against the live Supabase project.

### Prerequisites
- Node.js 22+
- Docker Desktop (for `supabase start` if needed)
- Real Supabase credentials from the project dashboard

### Steps

```bash
# 1. Install all dependencies
npm install
cd frontend && npm install && cd ..

# 2. Create root .env (gitignored) with cloud credentials
# Get from Supabase Dashboard: https://supabase.com/dashboard/project/pyqngqyqwevfpaxcmfnd
cat > .env <<'EOF'
SUPABASE_URL=https://pyqngqyqwevfpaxcmfnd.supabase.co
SUPABASE_PUBLISHABLE_KEY=<anon key>
SUPABASE_SECRET_KEY=<service_role key>
SUPABASE_JWKS_URL=https://pyqngqyqwevfpaxcmfnd.supabase.co/auth/v1/.well-known/jwks.json
DATABASE_URL=postgresql://...
GEMINI_API_KEY=<from Google AI Studio>
SENTRY_DSN=<optional, from Sentry org eric-4a>
EOF

# 3. Create frontend/.env (gitignored)
cat > frontend/.env <<'EOF'
VITE_SENTRY_DSN=<optional, from Sentry project ufwt-frontend>
EOF

# 4. Start both dev servers
npm run dev
# Frontend: http://localhost:5199 (vite)
# Backend API: http://localhost:3001 (express)
```

---

## 2. Local QA Environment (isolated, free, safe)

Use this for migrations, RLS tests, gateway integration tests, destructive cases — **never touches production**.

### Prerequisites
- Docker Desktop running
- Supabase CLI available via `npx supabase`

### Quick Start

```bash
# Start local Supabase stack (takes ~60s first run)
npx supabase start

# One command: reset DB, seed test users, sync .env.local
npm run qa:reset
```

### Available Commands

| Command | Purpose | Safety |
|---------|---------|--------|
| `npm run qa:reset` | Reset DB + seed test users + sync `.env.local` | Local-only guard |
| `npm run qa:verify` | pgTAP + gateway + frontend tests + typecheck + build | Local-only guard |
| `npm run qa:import-prod` | Safe prod import (allowlisted tables only) | Requires `QA_PROD_SOURCE_URL` |

### Production Data Import (optional, manual)

```bash
# Set to your production DATABASE_URL
export QA_PROD_SOURCE_URL=postgresql://...

# Runs: reset -> dump approved tables -> truncate local -> restore -> re-seed identities
npm run qa:import-prod
```

**Approved tables only:** seasons, games, game_events, game_lineups, players, teams, organizations.
**Never imported:** auth, storage, team_members, player_private, cron, pipeline, realtime.

See `docs/QA_ENVIRONMENT.md` for details.

---

## 3. Key Files Reference

| File | Purpose |
|------|---------|
| `scripts/qa-reset.mjs` | Safe reset wrapper, auto-syncs credentials |
| `scripts/qa-verify.mjs` | Full verification suite |
| `scripts/qa-import-prod.mjs` | Safe prod import |
| `docs/QA_ENVIRONMENT.md` | QA docs |
| `CLAUDE.md` | Full repo conventions |
| `SUPABASE_MULTI_DEPLOYMENT_FIX.md` | Architecture notes |

---

## 4. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `supabase start` fails | `npx supabase stop --no-backup && npx supabase start` |
| `qa:reset` refuses non-local URL | Ensure `.env.local` points to `127.0.0.1:54321` |
| Frontend typecheck fails | `cd frontend && npm install` then retry |
| Local DB connection refused | Check Docker: `docker ps` should show `supabase_db_...` |
| QA import pg_dump missing | Uses Docker container's pg_dump; ensure stack running |

---

## 5. CI Parity

Local `npm run qa:verify` runs the same tests as GitHub Actions CI:
1. `supabase test db` (pgTAP)
2. `npm run test:gateway`
3. `npm run test:frontend`
4. `npm run typecheck:frontend`
5. `npm run build`