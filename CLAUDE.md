# Ultimate Frisbee Warrior Tracker

## New-environment setup (do this in order)
1. `npm install` — root deps (Express server, gateway).
2. `cd frontend && npm install` — frontend has its **own** package.json/node_modules, separate from root. Both are required; root install alone leaves Vite unable to start.
3. Create `.env` in repo root (gitignored, not checked in) with:
   `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_JWKS_URL`, `GEMINI_API_KEY`.
   No `.env.example` exists — get real values from the Supabase dashboard (project `ultimate-frisbee-warrior-tracker`, ref `pyqngqyqwevfpaxcmfnd`, org `caypalgdyzpvqqecqhfd`, region `ca-central-1`) → Project Settings → API for the URL/keys, → Database for `DATABASE_URL`. `server/index.ts` throws at import time (crashes the whole process) if `SUPABASE_URL`/`SUPABASE_SECRET_KEY` are blank — there's no graceful fallback.
4. Start both dev servers from `.claude/launch.json`: "Express API Server" (port 3001) and "Vite Frontend" (port 5199, cwd `frontend`). The frontend alone will run but backend-dependent features (chat, uploads) need the Express server too.

## Gotchas
- Windows: `node node_modules/.bin/tsx <file>` fails with a syntax error — `.bin/tsx` is a POSIX shell shim, not a Node script. Use `node node_modules/tsx/dist/cli.mjs <file>` (or `npx tsx <file>`) instead. `.claude/launch.json`'s "Express API Server" config already uses the fixed form, but `package.json`'s own `server`/`dev` npm scripts still use the broken one and will fail the same way if run directly.
- Vercel CLI (`vercel env pull`) cannot reveal env vars marked "Sensitive" in any environment — it always returns `[SENSITIVE]` placeholders. Don't rely on it to recover secrets; get them from the Supabase dashboard instead.
