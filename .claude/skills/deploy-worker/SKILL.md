---
name: deploy-worker
description: Build the frontend and deploy the app to Cloudflare Workers, checking for the known white-screen and multi-deployment pitfalls documented in this repo before and after deploying
disable-model-invocation: true
---

# Deploy to Cloudflare Workers

Follow these steps in order. Do not skip the pre-flight checks — they exist
because of real incidents documented in this repo (`WHITE_SCREEN_FIX.md`,
`SUPABASE_MULTI_DEPLOYMENT_FIX.md`).

## 1. Pre-flight checks

- Read `CLOUDFLARE_DEPLOYMENT.md`, `WHITE_SCREEN_FIX.md`, and
  `SUPABASE_MULTI_DEPLOYMENT_FIX.md` if you have not already this session.
- Run `git status` — refuse to deploy with uncommitted changes unless the user
  explicitly confirms they want to deploy dirty.
- Confirm which environment is being targeted (`wrangler.jsonc` has a
  `development` env — ask the user if unclear whether this is prod or dev).
- Check `wrangler.jsonc` bindings (Durable Objects, `ASSETS`, secrets) haven't
  drifted from what `worker.ts` expects.

## 2. Build

```bash
npm run build
```

This runs `cd frontend && npm ci && npm run build`. Watch the output for
build errors — a broken build here is the most common cause of the white
screen issue.

## 3. Deploy

- Production: `npm run deploy` (`wrangler deploy --config wrangler.jsonc`)
- Development: `npm run deploy:dev`

## 4. Post-deploy verification

- Check the deploy output for the deployed URL and any binding warnings.
- If Cloudflare MCP tools are available, use them to tail logs
  (`wrangler tail` equivalent) and check the Worker is serving requests
  without errors.
- Confirm Supabase env vars (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
  `SUPABASE_JWKS_URL`, `SUPABASE_SECRET_KEY`) are set for the target
  environment — a stale or missing secret here is the root cause documented
  in `SUPABASE_MULTI_DEPLOYMENT_FIX.md`.
- Load the deployed URL and confirm the app renders (not a blank/white
  screen) before reporting success.

## 5. Report

Summarize what was deployed, to which environment, and the verification
steps taken. If anything in step 4 could not be verified, say so explicitly
rather than claiming success.
