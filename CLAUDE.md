# Ultimate Frisbee Warrior Tracker

## New-environment setup (do this in order)
1. `npm install` — root deps (Express server, gateway).
2. `cd frontend && npm install` — frontend has its **own** package.json/node_modules, separate from root. Both are required; root install alone leaves Vite unable to start.
3. Create `.env` in repo root (gitignored, not checked in) with:
   `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_JWKS_URL`, `GEMINI_API_KEY`, `SENTRY_DSN`.
   No `.env.example` exists — get real Supabase values from the Supabase dashboard (project `ultimate-frisbee-warrior-tracker`, ref `pyqngqyqwevfpaxcmfnd`, org `caypalgdyzpvqqecqhfd`, region `ca-central-1`) → Project Settings → API for the URL/keys, → Database for `DATABASE_URL`. `server/index.ts` throws at import time (crashes the whole process) if `SUPABASE_URL`/`SUPABASE_SECRET_KEY` are blank — there's no graceful fallback. `SENTRY_DSN` is different: it's optional and safe to leave blank (`server/instrument.ts` only calls `Sentry.init` when it's set) — get the real value from the Sentry org `eric-4a`'s `ufwt-backend` project (Settings → Client Keys (DSN)) if you want backend error reporting locally.
   Also create `frontend/.env` (separate file, same gitignore treatment) with `VITE_SENTRY_DSN` — same optional/blank-is-fine rule, value comes from the `ufwt-frontend` Sentry project instead. The Cloudflare Worker's DSN (`SENTRY_DSN_WORKER`) needs no local setup — it's already committed as a plain `vars` entry in `wrangler.jsonc` since Sentry DSNs are public client keys, not secrets.
4. Start both dev servers from `.claude/launch.json`: "Express API Server" (port 3001) and "Vite Frontend" (port 5199, cwd `frontend`). The frontend alone will run but backend-dependent features (chat, uploads) need the Express server too.

## References
- Bugs and feature requests are tracked as GitHub issues in this repo (`gh issue list`), not in a separate tracker.
- Project notes/planning doc in Notion: https://app.notion.com/p/e2e903a5dd4347c7be8fe9a0ab39b4f1?v=3d08e4449db2814b9332000c33d32b8b

## Gotchas
- Windows: `node node_modules/.bin/tsx <file>` fails with a syntax error — `.bin/tsx` is a POSIX shell shim, not a Node script. Use `node node_modules/tsx/dist/cli.mjs <file>` (or `npx tsx <file>`) instead. `.claude/launch.json`'s "Express API Server" config already uses the fixed form, but `package.json`'s own `server`/`dev` npm scripts still use the broken one and will fail the same way if run directly.
- Vercel CLI (`vercel env pull`) cannot reveal env vars marked "Sensitive" in any environment — it always returns `[SENSITIVE]` placeholders. Don't rely on it to recover secrets; get them from the Supabase dashboard instead.
