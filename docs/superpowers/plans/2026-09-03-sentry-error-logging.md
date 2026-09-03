# Sentry Error Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Sentry error tracking (crash/exception capture only — no performance tracing, no session replay) across all three runtimes the app ships to: the Express backend (shared by local dev and the Vercel deploy), the Cloudflare Worker (a separate edge-runtime codebase), and the React frontend.

**Architecture:** Three independent Sentry projects (already created — see Prerequisites below), one per runtime, each wired at that runtime's entry point. The backend gets an `instrument.ts` file imported first, plus explicit `Sentry.captureException` calls at the points where the existing code already swallows errors into JSON responses. The Worker wraps its existing default export and Durable Object class with `@sentry/cloudflare`'s wrapper functions. The frontend calls `Sentry.init` before render and wraps `<App />` in an error boundary.

**Tech Stack:** `@sentry/node` (backend), `@sentry/cloudflare` (Worker), `@sentry/react` (frontend). Current major version is 10.x (confirmed via Sentry's own docs during planning — the `withSentry`/`instrumentDurableObjectWithSentry` APIs below reflect the current, non-deprecated signatures, not the older generic-typed ones).

**Spec:** No separate spec doc — this plan was authorized via an in-chat "bounded" design (see conversation history: brainstorming session on 2026-09-03 that classified this as a bounded task touching existing entry points, not a new subsystem).

## Prerequisites (already done — do not redo)

Three Sentry projects were created via the Sentry MCP server under org `eric-4a`, team `eric`:

| Project | Slug | DSN |
|---|---|---|
| Frontend | `ufwt-frontend` | `https://2432a237987070b566f9d5609c822627@o4512018450415616.ingest.us.sentry.io/4512023589879808` |
| Backend | `ufwt-backend` | `https://38e254cd372bdd75a30ecd52ad6343ee@o4512018450415616.ingest.us.sentry.io/4512023590207488` |
| Worker | `ufwt-worker` | `https://14eff8ecb4c205456e5faa058f4e76d9@o4512018450415616.ingest.us.sentry.io/4512023591124992` |

Sentry DSNs are public-by-design client keys (not secrets) — safe to hardcode in config, commit to `wrangler.jsonc`, and write directly into `.env` files.

## Global Constraints

- **Never let Sentry become a hard dependency.** Every `Sentry.init` call must be guarded so a missing/empty DSN is a silent no-op, not a thrown error — this repo already has a documented anti-pattern (see CLAUDE.md's gotcha about `server/index.ts` throwing at import time if `SUPABASE_URL`/`SUPABASE_SECRET_KEY` are blank); do not replicate that for Sentry.
- **Always install new npm dependencies via `npm install <package>` (or `npm install <package> --prefix frontend` / `cd frontend && npm install <package>`), never by hand-editing `package.json`.** This repo's git history has two recent commits fixing CI breakage from inconsistent `package-lock.json` files (`5096f6b`, `0d5d9d3`) — always let `npm install` regenerate the lockfile.
- **Out of scope for this plan** (do not add tasks for these, do not gold-plate): source map upload / Sentry release tracking, performance tracing (`tracesSampleRate`, `BrowserTracing`), session replay, instrumenting `mcp-server/index.ts` (a separate local-only dev process, not deployed), instrumenting `gateway/*.ts` modules other than `gateway/mcpAgent.ts` (the `UfwtMcp` Durable Object, which must be touched to wrap it).
- **Backend type-check command:** `npx tsc --noEmit -p server/tsconfig.json` (this excludes `gateway/mcpAgent.ts` and `gateway/mcpOAuth.ts` — those are Workers-only and are checked separately, see below).
- **Frontend type-check command:** `npx tsc --noEmit -p frontend/tsconfig.json` (run from `frontend/`, or pass the full path from repo root).
- **Worker type-check/build command:** `npx wrangler deploy --dry-run` (from repo root) — this builds and validates `worker.ts` plus everything it imports, including `gateway/mcpAgent.ts`, without publishing anything.

---

### Task 1: Backend — Sentry error capture in the Express app

**Files:**
- Create: `server/instrument.ts`
- Modify: `server/index.ts:1` (add import as first line), `server/index.ts:440-442` (add captureException), `server/index.ts:455-457` (add captureException), `server/index.ts:483-485` (add captureException), `server/index.ts:505-507` (add captureException), `server/index.ts:533-535` (add captureException), `server/index.ts:546-548` (add captureException), `server/index.ts:551` (add setupExpressErrorHandler before the `app.listen` guard)
- Modify: `.env` (append `SENTRY_DSN` line — this file exists locally and is gitignored, not tracked in the repo)
- Modify: root `package.json` (via `npm install`, not by hand)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `server/instrument.ts` exports nothing (side-effect-only module: calling `Sentry.init()` at import time). Later tasks (Task 4, docs) reference the `SENTRY_DSN` env var name introduced here.

**Context — why this isn't a trivial "add setupExpressErrorHandler and done" task:** `server/index.ts` has 8 `catch` blocks. Two of them already propagate correctly and need no change:
- `server/index.ts:114` (`} catch (err) { next(err); }` inside `requireAuth`) — already calls `next(err)`, so Express's own error-handling chain (and thus `Sentry.setupExpressErrorHandler`) sees it. No change needed here.
- `server/index.ts:422-425` (inside the Gemini retry loop) — re-throws (`throw err`) rather than swallowing, so it propagates up to the outer `catch` at line 455, which *is* one of the six being fixed below. No change needed at line 422 itself.

The other six catch blocks swallow the error into a JSON response and never call `next(err)`, so `setupExpressErrorHandler` alone would never see them. Each needs an explicit `Sentry.captureException(err)` call added.

- [ ] **Step 1: Create the instrument file**

Create `server/instrument.ts`:

```typescript
import "dotenv/config";
import * as Sentry from "@sentry/node";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
  });
}
```

- [ ] **Step 2: Install `@sentry/node`**

Run from the repo root:

```bash
npm install @sentry/node
```

Expected: `package.json` and `package-lock.json` both change (the dependency is added and the lockfile is regenerated by npm itself — do not hand-edit either file).

- [ ] **Step 3: Import the instrument file first in `server/index.ts`**

Read the current top of `server/index.ts` — it starts with:

```typescript
import "dotenv/config";
import express from "express";
```

Change it to:

```typescript
import "./instrument.js";
import express from "express";
```

The existing `import "dotenv/config";` line is removed here because `server/instrument.ts` already loads dotenv itself (Step 1) before calling `Sentry.init`, and the Sentry Node SDK requires its `init()` call to run before any other module is imported — so `./instrument.js` must be the very first line, and there must not be a competing dotenv import ahead of it.

- [ ] **Step 4: Add `Sentry.captureException` to the six swallowing catch blocks**

First add the import near the top of `server/index.ts`, alongside the other imports (after the `import "./instrument.js";` line from Step 3):

```typescript
import * as Sentry from "@sentry/node";
```

Then, in each of the six locations below, add one line calling `Sentry.captureException(err)` as the first line inside the `catch` block, before the existing `res.status(...)` call. Match against the exact existing code so you edit the right block:

At `server/index.ts:440-442` (inside the `Promise.all` mapping over function calls in `POST /api/chat`):

```typescript
        } catch (err) {
          Sentry.captureException(err);
          return { functionResponse: { name: call.name!, response: { error: err instanceof Error ? err.message : String(err) } } };
        }
```

At `server/index.ts:455-457` (end of `POST /api/chat`):

```typescript
  } catch (err: unknown) {
    Sentry.captureException(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
```

At `server/index.ts:483-485` (end of `GET /api/chat/history`):

```typescript
  } catch (err: unknown) {
    Sentry.captureException(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
```

At `server/index.ts:505-507` (end of `DELETE /api/chat/history`):

```typescript
  } catch (err: unknown) {
    Sentry.captureException(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
```

At `server/index.ts:533-535` (end of `POST /api/schedule/sync-jam`):

```typescript
  } catch (err: unknown) {
    Sentry.captureException(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
```

At `server/index.ts:546-548` (end of `GET /api/cron/sync-jam`):

```typescript
  } catch (err: unknown) {
    Sentry.captureException(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
```

- [ ] **Step 5: Add the Express error handler as a safety net**

In `server/index.ts`, immediately before the `// Only bind a port when running directly` comment (currently at line 551, right before the `if (!process.env.VERCEL) { app.listen(...) }` block), add:

```typescript
Sentry.setupExpressErrorHandler(app);

// Only bind a port when running directly (not as a Vercel serverless function)
if (!process.env.VERCEL) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`API server running on http://0.0.0.0:${PORT}`);
  });
}

export default app;
```

This catches anything that reaches Express's own error-handling chain (e.g. `next(err)` from `requireAuth` at line 114, or a malformed-JSON-body error from `express.json()` itself) that the six explicit `captureException` calls above don't already cover.

- [ ] **Step 6: Add `SENTRY_DSN` to the local `.env` file**

Append this line to the repo root's `.env` file (it already exists locally and is gitignored — do not create a `.env.example`, consistent with this repo's existing convention of no example file):

```
SENTRY_DSN=https://38e254cd372bdd75a30ecd52ad6343ee@o4512018450415616.ingest.us.sentry.io/4512023590207488
```

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit -p server/tsconfig.json`
Expected: no errors.

- [ ] **Step 8: Run the existing test suite to confirm nothing broke**

Run: `npm test`
Expected: same pass/fail counts as before this task's changes (this suite hits real Supabase tables and is unrelated to Sentry; it should be unaffected — `Sentry.init` only runs because `SENTRY_DSN` is now set in `.env`, and initializing the SDK must not change any request behavior).

- [ ] **Step 9: Manual smoke test — confirm an error actually reaches Sentry**

`GET /api/cron/sync-jam` (line 538) is the easiest route to force a genuine server-side error through with `curl` alone, because it only requires a bearer token you control (`CRON_SECRET` from `.env`) rather than a real Supabase login session — and its `catch` block (line 546) is one of the six wrapped in Step 4.

The route 401s unless `CRON_SECRET` is already set in `.env` (`server/index.ts:539`) — if it isn't set yet, add a line like `CRON_SECRET=local-test-secret` first. Then temporarily set `SUPABASE_URL` in `.env` to an invalid value (e.g. `SUPABASE_URL=https://invalid.example.com`), and start the backend: `npm run server` (or the "Express API Server" launch config). With the server running:

```bash
curl -s http://localhost:3001/api/cron/sync-jam -H "Authorization: Bearer $CRON_SECRET"
```

(substitute the real value of `CRON_SECRET` from your `.env`)

Expected: a `500` JSON error response, because `runJamSync` fails to reach the now-invalid Supabase URL.

After triggering the error, confirm it landed in Sentry using the Sentry MCP tool (already connected in this session):

```
search_issues(organizationSlug="eric-4a", projectSlug="ufwt-backend")
```

Expected: a new issue appears for the `ufwt-backend` project. Revert any temporary env var change afterward and restart the server.

- [ ] **Step 10: Commit**

```bash
git add server/instrument.ts server/index.ts package.json package-lock.json
git commit -m "Add Sentry error tracking to the Express backend"
```

(`.env` is gitignored and will not be picked up by `git add` of these specific paths — no action needed there.)

---

### Task 2: Cloudflare Worker — Sentry error capture

**Files:**
- Modify: `worker.ts:10-29` (add `SENTRY_DSN_WORKER` to the `Env` interface), `worker.ts:172-188` (wrap the default export)
- Modify: `gateway/mcpAgent.ts:19-23` (add `SENTRY_DSN_WORKER` to the `Env` interface), `gateway/mcpAgent.ts:30-37` (wrap the `UfwtMcp` class export)
- Modify: `wrangler.jsonc` (add `SENTRY_DSN_WORKER` to the `vars` block)
- Modify: root `package.json` (via `npm install`, not by hand)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks depend on (frontend and backend Sentry setups are independent of this task).

**Context:** `worker.ts` is a separate Cloudflare Workers edge-runtime codebase (not Express) — it's the `main` entry point in `wrangler.jsonc`. It re-exports the `UfwtMcp` Durable Object class (defined in `gateway/mcpAgent.ts`) and exports a default object with `fetch`/`scheduled` handlers. Both the default export and the `UfwtMcp` class need independent Sentry wrapping — `@sentry/cloudflare` provides `withSentry` for the former and `instrumentDurableObjectWithSentry` for the latter. The wrapping for `UfwtMcp` happens inside `gateway/mcpAgent.ts` itself (where the class is defined) rather than in `worker.ts`, so `worker.ts`'s existing `export { UfwtMcp }` line does not need to change — it will simply re-export the now-wrapped class.

- [ ] **Step 1: Install `@sentry/cloudflare`**

Run from the repo root:

```bash
npm install @sentry/cloudflare
```

Expected: `package.json` and `package-lock.json` both change.

- [ ] **Step 2: Add `SENTRY_DSN_WORKER` to `gateway/mcpAgent.ts`'s `Env` interface**

In `gateway/mcpAgent.ts`, the current `Env` interface (lines 19-23) is:

```typescript
interface Env {
  SUPABASE_URL: string
  SUPABASE_SECRET_KEY: string
  MCP_ORGANIZATION_ID?: string
}
```

Change it to:

```typescript
interface Env {
  SUPABASE_URL: string
  SUPABASE_SECRET_KEY: string
  MCP_ORGANIZATION_ID?: string
  SENTRY_DSN_WORKER: string
}
```

- [ ] **Step 3: Wrap the `UfwtMcp` Durable Object with Sentry instrumentation**

In `gateway/mcpAgent.ts`, add the import near the top (after the existing imports, before the `interface Env` block):

```typescript
import * as Sentry from '@sentry/cloudflare'
```

Then change the class definition. Currently (lines 30-37):

```typescript
export class UfwtMcp extends McpAgent<Env, {}, McpAuthProps> {
  server = new McpServer({ name: 'ultimate-frisbee-warrior-tracker', version: '1.0.0' })

  async init() {
    const orgId = this.env.MCP_ORGANIZATION_ID ? parseInt(this.env.MCP_ORGANIZATION_ID) : 1
    registerUfwtMcpTools(this.server, { supabaseUrl: this.env.SUPABASE_URL, supabaseSecretKey: this.env.SUPABASE_SECRET_KEY }, orgId)
  }
}
```

Change to:

```typescript
class UfwtMcpBase extends McpAgent<Env, {}, McpAuthProps> {
  server = new McpServer({ name: 'ultimate-frisbee-warrior-tracker', version: '1.0.0' })

  async init() {
    const orgId = this.env.MCP_ORGANIZATION_ID ? parseInt(this.env.MCP_ORGANIZATION_ID) : 1
    registerUfwtMcpTools(this.server, { supabaseUrl: this.env.SUPABASE_URL, supabaseSecretKey: this.env.SUPABASE_SECRET_KEY }, orgId)
  }
}

export const UfwtMcp = Sentry.instrumentDurableObjectWithSentry(
  (env: Env) => ({ dsn: env.SENTRY_DSN_WORKER }),
  UfwtMcpBase,
)
```

- [ ] **Step 4: Add `SENTRY_DSN_WORKER` to `worker.ts`'s `Env` interface**

In `worker.ts`, the current `Env` interface (lines 10-29) ends with:

```typescript
  UFWT_MCP: DurableObjectNamespace;
  MCP_ORGANIZATION_ID?: string;
  OAUTH_PROVIDER: OAuthHelpers;
}
```

Change to:

```typescript
  UFWT_MCP: DurableObjectNamespace;
  MCP_ORGANIZATION_ID?: string;
  OAUTH_PROVIDER: OAuthHelpers;
  SENTRY_DSN_WORKER: string;
}
```

- [ ] **Step 5: Wrap the default export with `withSentry`**

In `worker.ts`, add the import near the top (after the existing imports):

```typescript
import * as Sentry from '@sentry/cloudflare'
```

Then change the default export. Currently (lines 172-188):

```typescript
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return oauthProvider.fetch(request, env as any, ctx as any);
  },

  // Daily JAM Sports calendar sync at 6am Eastern (see wrangler.jsonc's triggers.crons).
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runJamSync({
        supabaseUrl: env.SUPABASE_URL,
        supabaseSecretKey: env.SUPABASE_SECRET_KEY,
      })
        .then(result => console.log("JAM sync:", JSON.stringify(result)))
        .catch(err => console.error("JAM sync failed:", err instanceof Error ? err.message : String(err)))
    );
  },
};
```

Change to:

```typescript
export default Sentry.withSentry(
  (env: Env) => ({ dsn: env.SENTRY_DSN_WORKER }),
  {
    fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      return oauthProvider.fetch(request, env as any, ctx as any);
    },

    // Daily JAM Sports calendar sync at 6am Eastern (see wrangler.jsonc's triggers.crons).
    async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
      ctx.waitUntil(
        runJamSync({
          supabaseUrl: env.SUPABASE_URL,
          supabaseSecretKey: env.SUPABASE_SECRET_KEY,
        })
          .then(result => console.log("JAM sync:", JSON.stringify(result)))
          .catch(err => console.error("JAM sync failed:", err instanceof Error ? err.message : String(err)))
      );
    },
  },
);
```

- [ ] **Step 6: Add `SENTRY_DSN_WORKER` to `wrangler.jsonc`'s `vars` block**

In `wrangler.jsonc`, the current `vars` block is:

```jsonc
  "vars": {
    "SUPABASE_URL": "https://pyqngqyqwevfpaxcmfnd.supabase.co",
    "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_oUie8kxlAp6DD0UPMSG-ZQ_QBEWo3vT",
    "SUPABASE_JWKS_URL": "https://pyqngqyqwevfpaxcmfnd.supabase.co/auth/v1/.well-known/jwks.json",
    "MCP_ORGANIZATION_ID": "1"
  }
```

Change to:

```jsonc
  "vars": {
    "SUPABASE_URL": "https://pyqngqyqwevfpaxcmfnd.supabase.co",
    "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_oUie8kxlAp6DD0UPMSG-ZQ_QBEWo3vT",
    "SUPABASE_JWKS_URL": "https://pyqngqyqwevfpaxcmfnd.supabase.co/auth/v1/.well-known/jwks.json",
    "MCP_ORGANIZATION_ID": "1",
    "SENTRY_DSN_WORKER": "https://14eff8ecb4c205456e5faa058f4e76d9@o4512018450415616.ingest.us.sentry.io/4512023591124992"
  }
```

- [ ] **Step 7: Build-check the Worker**

Run: `npx wrangler deploy --dry-run`
Expected: build succeeds with no errors (this compiles and bundles `worker.ts` plus `gateway/mcpAgent.ts` via esbuild without publishing). If it fails with a type or bundling error referencing `UfwtMcp.serve`, check that `UfwtMcpBase`'s static members (inherited from `McpAgent`) are still reachable through `Sentry.instrumentDurableObjectWithSentry`'s returned class — standard JS class extension preserves static inheritance, so `UfwtMcp.serve(...)` in `worker.ts:168` should continue to resolve; if it doesn't, wrap `McpAgent`'s static `serve` call using `UfwtMcpBase` instead of the wrapped `UfwtMcp` for that one call site, but keep `export { UfwtMcp }` (the wrapped version) as what Cloudflare's runtime uses to instantiate the Durable Object.

- [ ] **Step 8: Commit**

```bash
git add worker.ts gateway/mcpAgent.ts wrangler.jsonc package.json package-lock.json
git commit -m "Add Sentry error tracking to the Cloudflare Worker"
```

---

### Task 3: Frontend — Sentry error capture in the React app

**Files:**
- Modify: `frontend/main.tsx` (all 16 lines — full rewrite, shown below)
- Create: `frontend/.env`
- Modify: `frontend/package.json` (via `npm install`, not by hand)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks depend on.

**Context:** The app uses React 19.2.7 (confirmed in `frontend/package.json`). React 19's recommended Sentry integration wires `Sentry.reactErrorHandler()` into `createRoot`'s `onCaughtError`/`onUncaughtError`/`onRecoverableError` options (this is the current, non-deprecated pattern for React 19, per Sentry's docs), in addition to wrapping the tree in `Sentry.ErrorBoundary` for a visible fallback UI when a render error is caught. No `frontend/.env` file exists yet, and no `import.meta.env` usage exists anywhere in the frontend currently — this task introduces both for the first time.

- [ ] **Step 1: Install `@sentry/react`**

Run from the repo root:

```bash
cd frontend && npm install @sentry/react
```

Expected: `frontend/package.json` and `frontend/package-lock.json` both change.

- [ ] **Step 2: Create `frontend/.env`**

Create `frontend/.env` (gitignored — the root `.gitignore`'s `.env*` pattern already covers this path, no `.gitignore` changes needed) with:

```
VITE_SENTRY_DSN=https://2432a237987070b566f9d5609c822627@o4512018450415616.ingest.us.sentry.io/4512023589879808
```

- [ ] **Step 3: Rewrite `frontend/main.tsx`**

Current content:

```typescript
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App'
import { AuthProvider } from './contexts/AuthContext'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
```

Replace with:

```typescript
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import * as Sentry from '@sentry/react'
import './index.css'
import App from './App'
import { AuthProvider } from './contexts/AuthContext'

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
  })
}

const container = document.getElementById('root')!
const root = createRoot(container, {
  onUncaughtError: Sentry.reactErrorHandler(),
  onCaughtError: Sentry.reactErrorHandler(),
  onRecoverableError: Sentry.reactErrorHandler(),
})

root.render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<p>Something went wrong. Please reload the page.</p>}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </Sentry.ErrorBoundary>
  </StrictMode>,
)
```

- [ ] **Step 4: Type-check**

Run (from `frontend/`): `npx tsc --noEmit -p tsconfig.json`
Expected: no errors. If `import.meta.env.VITE_SENTRY_DSN` produces a type error about `env` not having that property, this is expected — Vite's default `ImportMetaEnv` type is untyped/`any` for custom `VITE_`-prefixed keys unless a `vite-env.d.ts` declares them; check whether `frontend/` already has a `vite-env.d.ts` or similar ambient declaration file (search `find frontend -iname "vite-env*"`). If none exists and the type-check fails specifically on this line, that's a pre-existing gap in the frontend's Vite type setup unrelated to Sentry — add a minimal `frontend/vite-env.d.ts` with `/// <reference types="vite/client" />` to fix it, since that triple-slash reference is what supplies `ImportMetaEnv`/`ImportMeta` typing for `.env` vars in a standard Vite+TS project.

- [ ] **Step 5: Manual smoke test — confirm a render error reaches Sentry**

Start the frontend dev server (`.claude/launch.json`'s "Vite Frontend" config, or `cd frontend && npm run dev`). Temporarily add a component that throws during render to confirm the error boundary and Sentry capture both work — e.g., temporarily add `throw new Error("sentry smoke test")` as the first line inside `App`'s function body in `frontend/App.tsx`, reload the page in a browser, and confirm the fallback text "Something went wrong. Please reload the page." renders instead of a blank/crashed page.

Then confirm the error reached Sentry using the Sentry MCP tool:

```
search_issues(organizationSlug="eric-4a", projectSlug="ufwt-frontend")
```

Expected: a new issue appears for the `ufwt-frontend` project. Remove the temporary `throw` line from `App.tsx` afterward — it must not be committed.

- [ ] **Step 6: Commit**

```bash
git add frontend/main.tsx frontend/package.json frontend/package-lock.json
git commit -m "Add Sentry error tracking to the React frontend"
```

(`frontend/.env` is gitignored and will not be picked up.)

---

### Task 4: Documentation — record the new env vars in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (the "New-environment setup" numbered list, step 3)

**Interfaces:**
- Consumes: the env var names introduced in Tasks 1-3 (`SENTRY_DSN`, `VITE_SENTRY_DSN`) and the `wrangler.jsonc` change from Task 2 (`SENTRY_DSN_WORKER`, already committed to the repo so it needs no separate manual setup step — only `SENTRY_DSN` and `VITE_SENTRY_DSN` are per-developer secrets-that-aren't-secret needing documentation, since `SENTRY_DSN_WORKER` lives in the committed `wrangler.jsonc`).
- Produces: nothing — this is the terminal documentation task.

- [ ] **Step 1: Update CLAUDE.md's New-environment setup section**

Current step 3 in `CLAUDE.md`:

```markdown
3. Create `.env` in repo root (gitignored, not checked in) with:
   `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_JWKS_URL`, `GEMINI_API_KEY`.
   No `.env.example` exists — get real values from the Supabase dashboard (project `ultimate-frisbee-warrior-tracker`, ref `pyqngqyqwevfpaxcmfnd`, org `caypalgdyzpvqqecqhfd`, region `ca-central-1`) → Project Settings → API for the URL/keys, → Database for `DATABASE_URL`. `server/index.ts` throws at import time (crashes the whole process) if `SUPABASE_URL`/`SUPABASE_SECRET_KEY` are blank — there's no graceful fallback.
```

Change to:

```markdown
3. Create `.env` in repo root (gitignored, not checked in) with:
   `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_JWKS_URL`, `GEMINI_API_KEY`, `SENTRY_DSN`.
   No `.env.example` exists — get real Supabase values from the Supabase dashboard (project `ultimate-frisbee-warrior-tracker`, ref `pyqngqyqwevfpaxcmfnd`, org `caypalgdyzpvqqecqhfd`, region `ca-central-1`) → Project Settings → API for the URL/keys, → Database for `DATABASE_URL`. `server/index.ts` throws at import time (crashes the whole process) if `SUPABASE_URL`/`SUPABASE_SECRET_KEY` are blank — there's no graceful fallback. `SENTRY_DSN` is different: it's optional and safe to leave blank (`server/instrument.ts` only calls `Sentry.init` when it's set) — get the real value from the Sentry org `eric-4a`'s `ufwt-backend` project (Settings → Client Keys (DSN)) if you want backend error reporting locally.
   Also create `frontend/.env` (separate file, same gitignore treatment) with `VITE_SENTRY_DSN` — same optional/blank-is-fine rule, value comes from the `ufwt-frontend` Sentry project instead. The Cloudflare Worker's DSN (`SENTRY_DSN_WORKER`) needs no local setup — it's already committed as a plain `vars` entry in `wrangler.jsonc` since Sentry DSNs are public client keys, not secrets.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "Document Sentry env vars in CLAUDE.md"
```
