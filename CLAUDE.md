# Ultimate Frisbee Warrior Tracker

## New-environment setup (do this in order)
1. `npm install` — root deps (Express server, gateway).
2. `cd frontend && npm install` — frontend has its **own** package.json/node_modules, separate from root. Both are required; root install alone leaves Vite unable to start.
3. Create `.env` in repo root (gitignored, not checked in) with:
   `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_JWKS_URL`, `GEMINI_API_KEY`.
   No `.env.example` exists — get real values from the Supabase dashboard (project `ultimate-frisbee-warrior-tracker`, ref `pyqngqyqwevfpaxcmfnd`, org `caypalgdyzpvqqecqhfd`, region `ca-central-1`) → Project Settings → API for the URL/keys, → Database for `DATABASE_URL`. `server/index.ts` throws at import time (crashes the whole process) if `SUPABASE_URL`/`SUPABASE_SECRET_KEY` are blank — there's no graceful fallback.
4. Start both dev servers from `.claude/launch.json`: "Express API Server" (port 3001) and "Vite Frontend" (port 5199, cwd `frontend`). The frontend alone will run but backend-dependent features (chat, uploads) need the Express server too.
5. Local database: `npm run db:start` (needs Docker), then `npm run db:reset`
   to load the baseline plus seed data and test identities. `npm run db:test`
   runs the pgTAP permission suite. Copy `.env.local.example` to `.env.local`
   and fill in the keys printed by `supabase status`.

## Gotchas
- Windows: `node node_modules/.bin/tsx <file>` fails with a syntax error — `.bin/tsx` is a POSIX shell shim, not a Node script. Use `node node_modules/tsx/dist/cli.mjs <file>` (or `npx tsx <file>`) instead. `.claude/launch.json`'s "Express API Server" config already uses the fixed form, but `package.json`'s own `server`/`dev` npm scripts still use the broken one and will fail the same way if run directly.
- Vercel CLI (`vercel env pull`) cannot reveal env vars marked "Sensitive" in any environment — it always returns `[SENSITIVE]` placeholders. Don't rely on it to recover secrets; get them from the Supabase dashboard instead.
- `npm test` runs `node server.test.mjs`, which does `import "dotenv/config"` and builds its Supabase client from the root `.env` file, not `.env.local`. The root `.env` points at PRODUCTION. Running `npm test` therefore reads and asserts against the live production database, not the local Supabase stack. Never run it casually, and never run it at all while testing anything migration-related. Use `npm run db:test` for the local pgTAP suite instead.
- `server.test.mjs` asserts that `players` still has `phone`, `first_name_edit`, and `last_name_edit` columns. The team-permissions migrations move those columns to `player_private`. The assertion passes today only because `npm test` reads production, which these migrations have not been applied to yet. Once production is cut over, that assertion will fail. Whoever runs the production cutover must update `server.test.mjs` to match the new `players`/`player_private` split in the same change.
- Deleting a sole captain's `auth.users` row (Supabase dashboard "delete user", the admin API, or any GDPR deletion path) fails with a bare `team % must have at least one captain` error. This is `enforce_last_captain()` on `team_members` doing its job — the same trigger that blocks demoting or removing a team's last captain also fires when that captain's account is deleted, since `team_members.user_id` cascades from `auth.users`. Before deleting a sole captain's account, promote another member to captain (`set_member_role`) and, if appropriate, `remove_member` the original captain first.
