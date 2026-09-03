# PostHog Everywhere Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend PostHog tracking to every persisted CRUD action across the app, identify real users, and give the Express backend the same event/error visibility `mcp-server/index.ts` already has — without risking the PostHog free tier.

**Architecture:** Two new thin wrapper modules (`frontend/lib/analytics.ts`, `server/lib/posthog.ts`) sit in front of the already-installed `posthog-js`/`posthog-node` clients. Every mutating handler across 7 page components + `AuthContext.tsx` + 4 Express routes gets one `track()`/`trackError()` call inserted immediately after its mutation succeeds, using event names and properties fixed by the spec's taxonomy tables.

**Tech Stack:** React + TypeScript (Vite) frontend, Express + TypeScript backend, `posthog-js` (already installed), `posthog-node` (already installed at the repo root, shared with `mcp-server/index.ts`). No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-03-posthog-everywhere-design.md`

## Global Constraints

- No new npm dependencies — `posthog-js` (frontend) and `posthog-node` (root) are already installed.
- Naming: `<entity>_<verb_past_tense>` for every event; properties are IDs/counts/enums, never free text (chat content, notes, player names).
- A `track()`/`trackError()` call fires exactly once, immediately after its mutation succeeds — never before, never per-frame, never per-item in a multi-select.
- Frontend dev traffic must never reach PostHog (already enforced by `frontend/lib/posthog.ts`'s existing `opt_out_capturing()` in dev — no extra gating needed per call site).
- Backend traffic must never reach PostHog outside `NODE_ENV === 'production'` (new gate, built into `server/lib/posthog.ts`).
- Reuse an existing event name whenever two call sites perform the same underlying mutation (e.g. `player_created` is used by both Roster.tsx and Strategy.tsx/Schedule.tsx quick-add flows) — never invent a second name for the same mutation.

---

## Verification Recipe

There is no automated test suite covering analytics calls in this repo (confirmed: no frontend test framework is installed, and the one existing test file, `server.test.mjs`, is a live Supabase integration test with no PostHog assertions). Verification for every task below is manual, using this recipe:

### Frontend event verification

1. Make sure both dev servers are running (`.claude/launch.json`'s "Express API Server" and "Vite Frontend" configs, via `preview_start`).
2. In the browser tab, temporarily bypass the dev-mode opt-out so the event actually reaches PostHog:
   ```js
   (await import('/lib/posthog.ts')).posthog.opt_in_capturing()
   ```
3. Perform the UI action under test (click the button / submit the form / drag-and-drop-and-release the item).
4. Restore the dev-safe default:
   ```js
   (await import('/lib/posthog.ts')).posthog.opt_out_capturing()
   ```
5. Confirm the event landed, using the PostHog MCP (`posthog:exec`, run `info execute-sql` once per session if its schema isn't already in context):
   ```
   call execute-sql {"query": "SELECT event, timestamp, properties.<key> FROM events WHERE event = '<event_name>' AND timestamp >= now() - INTERVAL 10 MINUTE ORDER BY timestamp DESC LIMIT 5"}
   ```
   Replace `<event_name>` and `properties.<key>` with the specific event/property being verified.

### Backend event verification

1. Run the server once with the production gate open: `NODE_ENV=production node --dns-result-order=ipv4first node_modules/.bin/tsx server/index.ts` (in the background; note the assigned port from its startup log if 3001 is already taken).
2. Trigger the route under test (`curl`, or through the frontend UI pointed at that server).
3. Confirm via the same `execute-sql` query pattern as above.
4. Kill the one-off server process.

---

### Task 1: Frontend analytics helper

**Files:**
- Create: `frontend/lib/analytics.ts`

**Interfaces:**
- Consumes: `posthog` export from `frontend/lib/posthog.ts` (already exists).
- Produces: `track(event: string, properties?: Record<string, unknown>): void` and `trackError(error: unknown, properties?: Record<string, unknown>): void`, imported as `import { track, trackError } from '../lib/analytics'` by every page/context file touched in later tasks.

- [ ] **Step 1: Create the helper module**

```ts
// frontend/lib/analytics.ts
import { posthog } from './posthog'

export function track(event: string, properties?: Record<string, unknown>) {
  posthog.capture(event, properties)
}

export function trackError(error: unknown, properties?: Record<string, unknown>) {
  posthog.captureException(error, properties)
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && node_modules/.bin/tsc -p tsconfig.json`
Expected: no new errors (the file only uses the existing `posthog` export).

- [ ] **Step 3: Commit**

```bash
git add frontend/lib/analytics.ts
git commit -m "Add frontend analytics helper wrapping posthog capture/captureException"
```

---

### Task 2: Backend analytics helper

**Files:**
- Create: `server/lib/posthog.ts`
- Modify: `server/index.ts` (add `SIGTERM` shutdown handler)

**Interfaces:**
- Consumes: `posthog-node`'s `PostHog` class (already an installed root dependency), `process.env.POSTHOG_PROJECT_TOKEN` / `POSTHOG_HOST` (already set in `.env`).
- Produces: `track(distinctId: string, event: string, properties?: Record<string, unknown>): Promise<void>`, `trackError(distinctId: string, error: unknown, properties?: Record<string, unknown>): Promise<void>`, `shutdown(): Promise<void>` — imported by `server/index.ts` in Task 4 as `import { track, trackError, shutdown } from "./lib/posthog.js"`.

Uses `posthog-node`'s `captureImmediate`/`captureExceptionImmediate` (not the batched `capture`/`captureException`) so events are actually sent before the function returns — this Express app also runs as a Vercel serverless function (`if (!process.env.VERCEL) { app.listen(...) }` in `server/index.ts`), where a suspended/frozen function after `res.json()` returns cannot rely on a background batch flush.

- [ ] **Step 1: Create the helper module**

```ts
// server/lib/posthog.ts
import { PostHog } from "posthog-node";

const posthog = process.env.POSTHOG_PROJECT_TOKEN
  ? new PostHog(process.env.POSTHOG_PROJECT_TOKEN, { host: process.env.POSTHOG_HOST })
  : null;

// Local/dev runs never send real events, matching the free-tier safeguard
// already in place for the frontend (see frontend/lib/posthog.ts).
const enabled = process.env.NODE_ENV === "production";

export async function track(distinctId: string, event: string, properties?: Record<string, unknown>) {
  if (!enabled || !posthog) return;
  await posthog.captureImmediate({ distinctId, event, properties });
}

export async function trackError(distinctId: string, error: unknown, properties?: Record<string, unknown>) {
  if (!enabled || !posthog) return;
  await posthog.captureExceptionImmediate(error, distinctId, properties);
}

export async function shutdown() {
  await posthog?.shutdown();
}
```

- [ ] **Step 2: Wire the shutdown handler into `server/index.ts`**

Add the import near the top, alongside the other `gateway/*` imports:

```ts
import { track, trackError, shutdown } from "./lib/posthog.js";
```

(`track`/`trackError` aren't used yet in this task — that's Task 4 — but importing them here now avoids an unused-import lint warning being introduced and then immediately removed between tasks.)

Find this block at the end of `server/index.ts`:

```ts
// Only bind a port when running directly (not as a Vercel serverless function)
if (!process.env.VERCEL) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`API server running on http://0.0.0.0:${PORT}`);
  });
}
```

Replace it with:

```ts
// Only bind a port when running directly (not as a Vercel serverless function)
if (!process.env.VERCEL) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`API server running on http://0.0.0.0:${PORT}`);
  });
  process.on("SIGTERM", async () => {
    await shutdown();
    process.exit(0);
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `node_modules/.bin/tsc -p server/tsconfig.json --noEmit`
Expected: no new errors. (`track`/`trackError` will show as unused-but-imported — that's fine, TypeScript's default settings in `server/tsconfig.json` don't enable `noUnusedLocals`, so this isn't an error; confirm by checking the command's exit code is 0.)

- [ ] **Step 4: Verify the process starts and shuts down cleanly**

Run in the background: `node --dns-result-order=ipv4first node_modules/.bin/tsx server/index.ts`
Confirm the startup log line appears, then send it `SIGTERM` (e.g. `kill <pid>`) and confirm the process exits without an error/stack trace.

- [ ] **Step 5: Commit**

```bash
git add server/lib/posthog.ts server/index.ts
git commit -m "Add backend analytics helper and wire SIGTERM shutdown flush"
```

---

### Task 3: User identification and auth funnel events

**Files:**
- Modify: `frontend/contexts/AuthContext.tsx`

**Interfaces:**
- Consumes: `track` from `frontend/lib/analytics.ts` (Task 1), `posthog` from `frontend/lib/posthog.ts` (existing).
- Produces: every subsequent frontend event (Tasks 5-9) is attributed to a real identified user once this task lands.

- [ ] **Step 1: Add imports**

At the top of `frontend/contexts/AuthContext.tsx`, add two imports after the existing `import { supabase } from '../lib/supabase'` line:

```ts
import { posthog } from '../lib/posthog'
import { track } from '../lib/analytics'
```

- [ ] **Step 2: Identify the user on every session refresh**

Find:

```ts
  const refreshSessionState = useCallback(async () => {
    const session = await authClient.getSession()
    setUser(session.user)
    setOrganizations(session.organizations)
```

Replace with:

```ts
  const refreshSessionState = useCallback(async () => {
    const session = await authClient.getSession()
    setUser(session.user)
    if (session.user) posthog.identify(session.user.id, { email: session.user.email })
    setOrganizations(session.organizations)
```

- [ ] **Step 3: Track login**

Find:

```ts
  const login = useCallback(
    async (email: string, password: string) => {
      await authClient.login(email, password)
      await refreshSessionState()
    },
    [refreshSessionState]
  )
```

Replace with:

```ts
  const login = useCallback(
    async (email: string, password: string) => {
      await authClient.login(email, password)
      await refreshSessionState()
      track('user_logged_in')
    },
    [refreshSessionState]
  )
```

- [ ] **Step 4: Track signup**

Find:

```ts
  const signup = useCallback(
    async (email: string, password: string) => {
      const result = await authClient.signup(email, password)
      if (!result.confirmationRequired) await refreshSessionState()
      return { confirmationRequired: result.confirmationRequired }
    },
    [refreshSessionState]
  )
```

Replace with:

```ts
  const signup = useCallback(
    async (email: string, password: string) => {
      const result = await authClient.signup(email, password)
      track('user_signed_up')
      if (!result.confirmationRequired) await refreshSessionState()
      return { confirmationRequired: result.confirmationRequired }
    },
    [refreshSessionState]
  )
```

(`user_signed_up` fires right after the Supabase Auth user is created, regardless of whether email confirmation is still pending — the row already exists at that point.)

- [ ] **Step 5: Track passkey login**

Find:

```ts
  const loginWithPasskey = useCallback(async () => {
    await authClient.signInWithPasskey()
    await refreshSessionState()
  }, [refreshSessionState])
```

Replace with:

```ts
  const loginWithPasskey = useCallback(async () => {
    await authClient.signInWithPasskey()
    await refreshSessionState()
    track('user_logged_in', { via: 'passkey' })
  }, [refreshSessionState])
```

- [ ] **Step 6: Track logout and reset identity**

Find:

```ts
  const logout = useCallback(async () => {
    await authClient.logout()
    setUser(null)
    setOrganizations([])
    setCurrentOrgId(null)
  }, [])
```

Replace with:

```ts
  const logout = useCallback(async () => {
    await authClient.logout()
    track('user_logged_out')
    posthog.reset()
    setUser(null)
    setOrganizations([])
    setCurrentOrgId(null)
  }, [])
```

(`track` fires before `posthog.reset()` so the event is still attributed to the departing user, not a fresh anonymous id.)

- [ ] **Step 7: Track organization creation**

Find:

```ts
  const createOrganization = useCallback(
    async (name: string) => {
      if (!user) throw new Error('not signed in')
      const { data: org, error: orgError } = await supabase
        .from('organizations')
        .insert({ name })
        .select()
        .single()
      if (orgError) throw new Error(orgError.message)
      const { error: memberError } = await supabase
        .from('organization_members')
        .insert({ organization_id: org.id, email: user.email, role: 'owner' })
      if (memberError) throw new Error(memberError.message)
      await refreshSessionState()
      setCurrentOrgId(org.id)
    },
    [user, refreshSessionState]
  )
```

Replace with:

```ts
  const createOrganization = useCallback(
    async (name: string) => {
      if (!user) throw new Error('not signed in')
      const { data: org, error: orgError } = await supabase
        .from('organizations')
        .insert({ name })
        .select()
        .single()
      if (orgError) throw new Error(orgError.message)
      const { error: memberError } = await supabase
        .from('organization_members')
        .insert({ organization_id: org.id, email: user.email, role: 'owner' })
      if (memberError) throw new Error(memberError.message)
      await refreshSessionState()
      setCurrentOrgId(org.id)
      track('organization_created', { organization_id: org.id })
    },
    [user, refreshSessionState]
  )
```

- [ ] **Step 8: Track organization join**

Find:

```ts
  const joinOrganization = useCallback(
    async (organizationId: number) => {
      if (!user) throw new Error('not signed in')
      const { error } = await supabase
        .from('organization_members')
        .insert({ organization_id: organizationId, email: user.email, role: 'member' })
      if (error) throw new Error(error.message)
      await refreshSessionState()
      setCurrentOrgId(organizationId)
    },
    [user, refreshSessionState]
  )
```

Replace with:

```ts
  const joinOrganization = useCallback(
    async (organizationId: number) => {
      if (!user) throw new Error('not signed in')
      const { error } = await supabase
        .from('organization_members')
        .insert({ organization_id: organizationId, email: user.email, role: 'member' })
      if (error) throw new Error(error.message)
      await refreshSessionState()
      setCurrentOrgId(organizationId)
      track('organization_joined', { organization_id: organizationId })
    },
    [user, refreshSessionState]
  )
```

- [ ] **Step 9: Wrap `forgotPassword` so it can be tracked**

`forgotPassword` is currently passed straight through in the returned context value (`forgotPassword: authClient.forgotPassword`), with no local wrapper function. Add one so it can track.

Find the `logout` callback (now ending after Step 6's edit) and add a new callback right after it:

```ts
  const forgotPassword = useCallback(async (email: string) => {
    await authClient.forgotPassword(email)
    track('password_reset_requested')
  }, [])
```

Then find, in the returned context value:

```ts
        forgotPassword: authClient.forgotPassword,
```

Replace with:

```ts
        forgotPassword,
```

- [ ] **Step 10: Typecheck**

Run: `cd frontend && node_modules/.bin/tsc -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 11: Verify — signup, login, logout**

Using the Verification Recipe: sign up a throwaway test account (or log in/out with an existing one) in the browser preview, opting in around each action, and confirm `user_signed_up` and/or `user_logged_in` / `user_logged_out` land via `execute-sql`. Also confirm via `SELECT distinct_id, properties.email FROM events WHERE event = 'user_logged_in' ORDER BY timestamp DESC LIMIT 1` that the `distinct_id` is the real Supabase user id, not an anonymous one — this is the identification wiring, worth checking explicitly since every later task's event attribution depends on it.

- [ ] **Step 12: Commit**

```bash
git add frontend/contexts/AuthContext.tsx
git commit -m "Identify users in PostHog and track the auth/org funnel"
```

---

### Task 4: Backend route tracking and error capture

**Files:**
- Modify: `server/index.ts`

**Interfaces:**
- Consumes: `track`, `trackError` from `server/lib/posthog.ts` (Task 2, already imported in Task 2 Step 2).

- [ ] **Step 1: Track `POST /api/chat`**

Find:

```ts
app.post("/api/chat", async (req, res) => {
  try {
    const { message, session_id, history = [], organization_id } = req.body as {
      message: string; session_id: string; history: { role: string; content: string }[]; organization_id: number
    };
    if (!message || !session_id) return res.status(400).json({ error: "message and session_id required" });
    if (!organization_id) return res.status(400).json({ error: "organization_id required" });

    const webRequest = new Request(`${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`, {
      headers: { cookie: req.headers.cookie ?? "" },
    });
    const user = await requireAllowedUser(webRequest);
    if (!user || !(await isOrgMember(user.email.toLowerCase(), organization_id))) {
      return res.status(401).json({ error: "not authenticated" });
    }
```

Replace with:

```ts
app.post("/api/chat", async (req, res) => {
  const startedAt = Date.now();
  let usedToolCall = false;
  let distinctId = "unknown";
  try {
    const { message, session_id, history = [], organization_id } = req.body as {
      message: string; session_id: string; history: { role: string; content: string }[]; organization_id: number
    };
    if (!message || !session_id) return res.status(400).json({ error: "message and session_id required" });
    if (!organization_id) return res.status(400).json({ error: "organization_id required" });

    const webRequest = new Request(`${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`, {
      headers: { cookie: req.headers.cookie ?? "" },
    });
    const user = await requireAllowedUser(webRequest);
    if (!user || !(await isOrgMember(user.email.toLowerCase(), organization_id))) {
      return res.status(401).json({ error: "not authenticated" });
    }
    distinctId = user.email;
```

Find, a bit further down in the same route:

```ts
    const MAX_FUNCTION_ROUNDS = 4;
    for (let round = 0; round < MAX_FUNCTION_ROUNDS; round++) {
      const calls = response.functionCalls;
      if (!calls || calls.length === 0) break;
      const parts = await Promise.all(calls.map(async (call) => {
```

Replace with:

```ts
    const MAX_FUNCTION_ROUNDS = 4;
    for (let round = 0; round < MAX_FUNCTION_ROUNDS; round++) {
      const calls = response.functionCalls;
      if (!calls || calls.length === 0) break;
      usedToolCall = true;
      const parts = await Promise.all(calls.map(async (call) => {
```

Find the end of the same route:

```ts
    // Save both turns to chat_logs
    await supabase.from("chat_logs").insert([
      { session_id, role: "user", content: message, organization_id },
      { session_id, role: "assistant", content: reply, organization_id },
    ]);

    res.json({ reply });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/chat/history", async (req, res) => {
```

Replace with:

```ts
    // Save both turns to chat_logs
    await supabase.from("chat_logs").insert([
      { session_id, role: "user", content: message, organization_id },
      { session_id, role: "assistant", content: reply, organization_id },
    ]);

    await track(distinctId, "chat_message_sent", {
      organization_id,
      session_id,
      model: geminiModel,
      duration_ms: Date.now() - startedAt,
      used_tool_call: usedToolCall,
    });
    res.json({ reply });
  } catch (err: unknown) {
    await trackError(distinctId, err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/chat/history", async (req, res) => {
```

- [ ] **Step 2: Track `DELETE /api/chat/history`**

`GET /api/chat/history` is a read and stays untouched. Find the `DELETE` route:

```ts
app.delete("/api/chat/history", async (req, res) => {
  try {
    const { session_id, organization_id } = req.query as { session_id: string; organization_id: string };
    if (!session_id) return res.status(400).json({ error: "session_id required" });
    if (!organization_id) return res.status(400).json({ error: "organization_id required" });

    const webRequest = new Request(`${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`, {
      headers: { cookie: req.headers.cookie ?? "" },
    });
    const user = await requireAllowedUser(webRequest);
    if (!user || !(await isOrgMember(user.email.toLowerCase(), Number(organization_id)))) {
      return res.status(401).json({ error: "not authenticated" });
    }

    const { error } = await supabase.from("chat_logs").delete().eq("session_id", session_id).eq("organization_id", organization_id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
```

Replace with:

```ts
app.delete("/api/chat/history", async (req, res) => {
  let distinctId = "unknown";
  try {
    const { session_id, organization_id } = req.query as { session_id: string; organization_id: string };
    if (!session_id) return res.status(400).json({ error: "session_id required" });
    if (!organization_id) return res.status(400).json({ error: "organization_id required" });

    const webRequest = new Request(`${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`, {
      headers: { cookie: req.headers.cookie ?? "" },
    });
    const user = await requireAllowedUser(webRequest);
    if (!user || !(await isOrgMember(user.email.toLowerCase(), Number(organization_id)))) {
      return res.status(401).json({ error: "not authenticated" });
    }
    distinctId = user.email;

    const { error } = await supabase.from("chat_logs").delete().eq("session_id", session_id).eq("organization_id", organization_id);
    if (error) throw error;
    await track(distinctId, "chat_history_cleared", { organization_id, session_id });
    res.json({ ok: true });
  } catch (err: unknown) {
    await trackError(distinctId, err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
```

- [ ] **Step 3: Track `POST /api/schedule/sync-jam`**

Find:

```ts
app.post("/api/schedule/sync-jam", requireAuth, async (_req, res) => {
  try {
    const result = await runJamSync(jamSyncConfig());
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
```

Replace with:

```ts
app.post("/api/schedule/sync-jam", requireAuth, async (req, res) => {
  const webRequest = new Request(`${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`, {
    headers: { cookie: req.headers.cookie ?? "" },
  });
  const user = await requireAllowedUser(webRequest);
  const distinctId = user?.email ?? "unknown";
  try {
    const result = await runJamSync(jamSyncConfig());
    await track(distinctId, "jam_sync_triggered", {});
    res.json(result);
  } catch (err: unknown) {
    await trackError(distinctId, err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
```

(`requireAuth` already guarantees a valid session reached this handler, but doesn't attach the resolved user to `req` — so this re-derives it the same way every other route in this file already does.)

- [ ] **Step 4: Track `GET /api/cron/sync-jam`**

Find:

```ts
app.get("/api/cron/sync-jam", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "not authenticated" });
  }
  try {
    const result = await runJamSync(jamSyncConfig());
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
```

Replace with:

```ts
app.get("/api/cron/sync-jam", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "not authenticated" });
  }
  try {
    const result = await runJamSync(jamSyncConfig());
    await track("cron", "jam_sync_triggered", { via: "cron" });
    res.json(result);
  } catch (err: unknown) {
    await trackError("cron", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
```

- [ ] **Step 5: Typecheck**

Run: `node_modules/.bin/tsc -p server/tsconfig.json --noEmit`
Expected: no new errors.

- [ ] **Step 6: Verify — chat message and jam sync**

Using the backend half of the Verification Recipe, run the server with `NODE_ENV=production`, then:
- Send a chat message through the frontend (pointed at that server) or via `curl -X POST http://localhost:<port>/api/chat -H 'Content-Type: application/json' -H 'Cookie: <a valid session cookie>' -d '{"message":"hi","session_id":"test-verify","organization_id":1}'`, and confirm `chat_message_sent` lands with a `duration_ms` property.
- Trigger `/api/schedule/sync-jam` (via the frontend's "Sync now" button, pointed at that server) and confirm `jam_sync_triggered` lands.

- [ ] **Step 7: Commit**

```bash
git add server/index.ts
git commit -m "Track backend chat and jam-sync routes, capture route exceptions"
```

---

### Task 5: Schedule.tsx event instrumentation

**Files:**
- Modify: `frontend/pages/Schedule.tsx`

**Interfaces:**
- Consumes: `track` from `frontend/lib/analytics.ts` (Task 1).

- [ ] **Step 1: Add the import**

Add near the top of `frontend/pages/Schedule.tsx`, alongside the other `../lib/*` imports:

```ts
import { track } from '../lib/analytics'
```

- [ ] **Step 2: Apply the following edits, in order**

Each block names the handler(s), the anchor to find, and the exact replacement. Apply them top-to-bottom in the file using the Edit tool, one at a time. Some blocks cover more than one handler at once where they sit adjacent in the file.

**`handleCreateGameFromConflict`** — insert after `await createGameFromConflict({ conflict, seasonId: chosen ? parseInt(chosen) : null })`:
```ts
    track('game_created', { source: 'jam_sync', season_id: chosen ? parseInt(chosen) : null, conflict_id: conflict.id })
```

**`handleLinkJamConflict`** — insert after `await linkConflictToGame({ conflict, gameId: conflict.existing_game_id })`:
```ts
    track('jam_sync_conflict_linked', { conflict_id: conflict.id, game_id: conflict.existing_game_id })
```

**`handleDismissJamConflict`** — insert after `await dismissConflict({ conflictId })`:
```ts
    track('jam_sync_conflict_dismissed', { conflict_id: conflictId })
```

**`handleOpenCopyLineupDialog`** (no-season branch) — this branch creates two empty lineup groups directly, functionally the same as `handleStartFreshLineup`; find:
```ts
        fetchLineupGroups({ gameId: game.id })
      } finally {
        setCopyingLineup(false)
      }
      return
    }
    setSelectedCopyGameId(null)
```
Replace with:
```ts
        fetchLineupGroups({ gameId: game.id })
        track('lineup_reset', { game_id: game.id })
      } finally {
        setCopyingLineup(false)
      }
      return
    }
    setSelectedCopyGameId(null)
```

**`handleCopySelectedLineup`** — insert after `await applyLineupGroupsAndAssignment(game, groupNames, assignment)` (inside the `try`, before `setShowCopyLineupDialog(false)`):
```ts
      track('lineup_copied', { game_id: game.id })
```

**`handleStartFreshLineup`** — insert after its own `await applyLineupGroupsAndAssignment(game, groupNames, assignment)` (inside the `try`, before `setShowCopyLineupDialog(false)`):
```ts
      track('lineup_reset', { game_id: game.id })
```

**`handleSaveLineupTemplate`** — insert after `await saveLineupTemplate({ organizationId: currentOrgId, seasonId: game.season_id, name, groups, players })` (the hook call doesn't return the new template's id, so no `template_id` property is available here):
```ts
      track('lineup_template_saved', { game_id: game.id, season_id: game.season_id })
```

**`handleApplyLineupTemplate`** — insert after the `Promise.all(detail.players.map(...))` call, before `setSelectedTemplateId('')`:
```ts
      track('lineup_template_applied', { game_id: game.id, template_id: parseInt(selectedTemplateId) })
```

**`handleDeleteLineupTemplate`** — insert after `await deleteLineupTemplate({ templateId })`:
```ts
    track('lineup_template_deleted', { template_id: templateId })
```

**`handleCreateNewSeason`** — find:
```ts
    if (created) {
      await fetchSeasons({ organizationId: currentOrgId })
      await fetchSeasonsMeta({ organizationId: currentOrgId })
```
Replace with:
```ts
    if (created) {
      track('season_created', { season_id: created.id })
      await fetchSeasons({ organizationId: currentOrgId })
      await fetchSeasonsMeta({ organizationId: currentOrgId })
```

**`handleSubmit`** (new game) — insert after the `await createGame({...})` call, before `setIsDialogOpen(false)`:
```ts
    track('game_created', { season_id: formData.season_id ? parseInt(formData.season_id) : null })
```

**`handleDeleteGame`** — insert after `await deleteGame({ gameId })`:
```ts
    track('game_deleted', { game_id: gameId })
```

**`handleSaveEditGame`** — find:
```ts
      if (updated) {
        setSelectedGame(updated)
        setActiveTab(defaultTabForGame(updated))
      }
      setShowEditGame(false)
```
Replace with:
```ts
      if (updated) {
        setSelectedGame(updated)
        setActiveTab(defaultTabForGame(updated))
        track('game_updated', { game_id: selectedGame.id })
      }
      setShowEditGame(false)
```

**`handleSaveEditSeason`** — insert after the `await updateSeason({...})` call, before `setShowEditSeason(false)`:
```ts
      track('season_updated', { season_id: editSeasonId })
```

**`handleSaveNotes`** — find:
```ts
    const updated = await updateGame({ gameId: selectedGame.id, notes: notesValue }) as Game | undefined
    if (updated) setSelectedGame(updated)
    setEditingNotes(false)
```
Replace with:
```ts
    const updated = await updateGame({ gameId: selectedGame.id, notes: notesValue }) as Game | undefined
    if (updated) { setSelectedGame(updated); track('game_notes_updated', { game_id: selectedGame.id }) }
    setEditingNotes(false)
```

**`handleSaveOutcome`** — find:
```ts
    const updated = await updateGame({ gameId: selectedGame.id, outcome_override: override }) as Game | undefined
    if (updated) setSelectedGame(updated)
    setEditingOutcome(false)
```
Replace with:
```ts
    const updated = await updateGame({ gameId: selectedGame.id, outcome_override: override }) as Game | undefined
    if (updated) { setSelectedGame(updated); track('game_outcome_updated', { game_id: selectedGame.id }) }
    setEditingOutcome(false)
```

**`handleDeleteEvent`** — find:
```ts
  const handleDeleteEvent = async (eventId: number) => {
    if (!selectedGame) return
    await deleteEvent({ eventId })
    fetchEvents({ gameId: selectedGame.id })
  }
```
Replace with:
```ts
  const handleDeleteEvent = async (eventId: number) => {
    if (!selectedGame) return
    await deleteEvent({ eventId })
    track('game_event_deleted', { game_id: selectedGame.id, event_id: eventId })
    fetchEvents({ gameId: selectedGame.id })
  }
```

**`handleEventDragStart`'s `onUp`** — find:
```ts
      if (changes.length > 0 && selectedGame) {
        await Promise.all(changes.map(c => updateEventTimestamp({ eventId: c.id, timestamp: c.timestamp })))
        fetchEvents({ gameId: selectedGame.id })
      }
```
Replace with:
```ts
      if (changes.length > 0 && selectedGame) {
        await Promise.all(changes.map(c => updateEventTimestamp({ eventId: c.id, timestamp: c.timestamp })))
        track('game_event_reordered', { game_id: selectedGame.id })
        fetchEvents({ gameId: selectedGame.id })
      }
```

**`handleSaveEventEdit`** — find:
```ts
  const handleSaveEventEdit = async () => {
    if (!editingEventId || !selectedGame) return
    await updateEvent({
      eventId: editingEventId,
      playerId: editScorerId && editScorerId !== '__none__' ? parseInt(editScorerId) : null,
      relatedPlayerId: editAssisterId && editAssisterId !== '__none__' ? parseInt(editAssisterId) : null,
    })
    setEditingEventId(null)
    fetchEvents({ gameId: selectedGame.id })
  }
```
Replace with:
```ts
  const handleSaveEventEdit = async () => {
    if (!editingEventId || !selectedGame) return
    await updateEvent({
      eventId: editingEventId,
      playerId: editScorerId && editScorerId !== '__none__' ? parseInt(editScorerId) : null,
      relatedPlayerId: editAssisterId && editAssisterId !== '__none__' ? parseInt(editAssisterId) : null,
    })
    track('game_event_updated', { game_id: selectedGame.id, event_id: editingEventId })
    setEditingEventId(null)
    fetchEvents({ gameId: selectedGame.id })
  }
```

**`handleAddEvent`** — find:
```ts
  const handleAddEvent = async () => {
    if (!selectedGame) return
    // Picking "— Opponent —" as scorer on a goal means the other team scored
    if (newEventType === 'Goal' && newScorerId === '__opponent__') {
      await createOpponentGoal({ gameId: selectedGame.id, organizationId: currentOrgId })
    } else {
      await createGoal({
        gameId: selectedGame.id,
        playerId: resolveNewPlayerId(newScorerId),
        relatedPlayerId: resolveNewPlayerId(newAssisterId),
        eventType: newEventType,
        organizationId: currentOrgId,
      })
    }
    fetchEvents({ gameId: selectedGame.id })
  }

  const handleAddOpponentGoal = async () => {
    if (!selectedGame) return
    await createOpponentGoal({ gameId: selectedGame.id, organizationId: currentOrgId })
    fetchEvents({ gameId: selectedGame.id })
  }

  const handleUndo = async () => {
    const gameEvents = events as GameEvent[] | undefined
    if (!selectedGame || !gameEvents || gameEvents.length === 0) return
    await deleteEvent({ eventId: gameEvents[0]!.id })
    fetchEvents({ gameId: selectedGame.id })
  }
```
Replace with:
```ts
  const handleAddEvent = async () => {
    if (!selectedGame) return
    // Picking "— Opponent —" as scorer on a goal means the other team scored
    const isOpponentGoal = newEventType === 'Goal' && newScorerId === '__opponent__'
    if (isOpponentGoal) {
      await createOpponentGoal({ gameId: selectedGame.id, organizationId: currentOrgId })
    } else {
      await createGoal({
        gameId: selectedGame.id,
        playerId: resolveNewPlayerId(newScorerId),
        relatedPlayerId: resolveNewPlayerId(newAssisterId),
        eventType: newEventType,
        organizationId: currentOrgId,
      })
    }
    track('game_event_added', { game_id: selectedGame.id, event_type: isOpponentGoal ? 'opponent_goal' : newEventType, is_opponent: isOpponentGoal })
    fetchEvents({ gameId: selectedGame.id })
  }

  const handleAddOpponentGoal = async () => {
    if (!selectedGame) return
    await createOpponentGoal({ gameId: selectedGame.id, organizationId: currentOrgId })
    track('game_event_added', { game_id: selectedGame.id, event_type: 'opponent_goal', is_opponent: true })
    fetchEvents({ gameId: selectedGame.id })
  }

  const handleUndo = async () => {
    const gameEvents = events as GameEvent[] | undefined
    if (!selectedGame || !gameEvents || gameEvents.length === 0) return
    await deleteEvent({ eventId: gameEvents[0]!.id })
    track('game_event_deleted', { game_id: selectedGame.id, event_id: gameEvents[0]!.id, via: 'undo' })
    fetchEvents({ gameId: selectedGame.id })
  }
```

**`handleAddPlayer` / `handleAddAssister`** — find:
```ts
  const handleAddPlayer = async (name: string) => {
    if (!selectedGame) return
    const result = await createPlayerForGame({ display_name: name, gameId: selectedGame.id, seasonId: selectedGameSeasonId, organizationId: currentOrgId, lineupName: defaultLineupName })
    if (result) {
      await refreshRoster()
      fetchAttendance({ gameId: selectedGame.id })
      fetchLineups({ gameId: selectedGame.id })
      setNewScorerId((result as { id: number }).id.toString())
    }
  }

  const handleAddAssister = async (name: string) => {
    if (!selectedGame) return
    const result = await createPlayerForGame({ display_name: name, gameId: selectedGame.id, seasonId: selectedGameSeasonId, organizationId: currentOrgId, lineupName: defaultLineupName })
    if (result) {
      await refreshRoster()
      fetchAttendance({ gameId: selectedGame.id })
      fetchLineups({ gameId: selectedGame.id })
      setNewAssisterId((result as { id: number }).id.toString())
    }
```
Replace with:
```ts
  const handleAddPlayer = async (name: string) => {
    if (!selectedGame) return
    const result = await createPlayerForGame({ display_name: name, gameId: selectedGame.id, seasonId: selectedGameSeasonId, organizationId: currentOrgId, lineupName: defaultLineupName })
    if (result) {
      track('player_created', { game_id: selectedGame.id, source: 'quick_add' })
      await refreshRoster()
      fetchAttendance({ gameId: selectedGame.id })
      fetchLineups({ gameId: selectedGame.id })
      setNewScorerId((result as { id: number }).id.toString())
    }
  }

  const handleAddAssister = async (name: string) => {
    if (!selectedGame) return
    const result = await createPlayerForGame({ display_name: name, gameId: selectedGame.id, seasonId: selectedGameSeasonId, organizationId: currentOrgId, lineupName: defaultLineupName })
    if (result) {
      track('player_created', { game_id: selectedGame.id, source: 'quick_add' })
      await refreshRoster()
      fetchAttendance({ gameId: selectedGame.id })
      fetchLineups({ gameId: selectedGame.id })
      setNewAssisterId((result as { id: number }).id.toString())
    }
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && node_modules/.bin/tsc -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 4: Verify a representative sample**

Using the Verification Recipe: record a goal (confirm `game_event_added`), edit the game's notes (confirm `game_notes_updated`), and delete a game event (confirm `game_event_deleted`). These three cover the create/update/delete pattern; the remaining 17 sites follow the identical `track()`-after-mutation shape.

- [ ] **Step 5: Commit**

```bash
git add frontend/pages/Schedule.tsx
git commit -m "Instrument Schedule.tsx CRUD actions with PostHog events"
```

---

### Task 6: Roster.tsx event instrumentation

**Files:**
- Modify: `frontend/pages/Roster.tsx`

**Interfaces:**
- Consumes: `track` from `frontend/lib/analytics.ts` (Task 1).

- [ ] **Step 1: Add the import**

```ts
import { track } from '../lib/analytics'
```

- [ ] **Step 2: Apply the following 8 edits**

**`handleSaveEdit`** — find:
```ts
  const handleSaveEdit = async () => {
    if (!selectedPlayer) return
    const updated = await updatePlayer({
      playerId: selectedPlayer.id,
      display_name: editFields.display_name || undefined,
      gender_match: editFields.gender_match || undefined,
      phone: editFields.phone || undefined,
      number: editFields.number ? parseInt(editFields.number) : null,
      position: editFields.position || null,
    }) as Player | undefined
    if (updated) {
      setSelectedPlayer(updated)
      fetchPlayers({ seasonIds: rosterSeasonIds.length > 0 ? rosterSeasonIds : undefined, organizationId: currentOrgId })
    }
    setEditing(false)
  }
```
Replace with:
```ts
  const handleSaveEdit = async () => {
    if (!selectedPlayer) return
    const updated = await updatePlayer({
      playerId: selectedPlayer.id,
      display_name: editFields.display_name || undefined,
      gender_match: editFields.gender_match || undefined,
      phone: editFields.phone || undefined,
      number: editFields.number ? parseInt(editFields.number) : null,
      position: editFields.position || null,
    }) as Player | undefined
    if (updated) {
      setSelectedPlayer(updated)
      track('player_updated', { player_id: selectedPlayer.id })
      fetchPlayers({ seasonIds: rosterSeasonIds.length > 0 ? rosterSeasonIds : undefined, organizationId: currentOrgId })
    }
    setEditing(false)
  }
```

**`handleSaveSeasons`** — find:
```ts
  const handleSaveSeasons = async () => {
    if (!selectedPlayer) return
    await updatePlayerSeasons({ playerId: selectedPlayer.id, seasonIds: selectedSeasonIds, subsBySeasonId: selectedSeasonSubs, organizationId: currentOrgId })
    await fetchPlayerSeasons({ playerId: selectedPlayer.id })
```
Replace with:
```ts
  const handleSaveSeasons = async () => {
    if (!selectedPlayer) return
    await updatePlayerSeasons({ playerId: selectedPlayer.id, seasonIds: selectedSeasonIds, subsBySeasonId: selectedSeasonSubs, organizationId: currentOrgId })
    track('player_seasons_updated', { player_id: selectedPlayer.id, season_count: selectedSeasonIds.length })
    await fetchPlayerSeasons({ playerId: selectedPlayer.id })
```

**`handleDeletePlayer`** — find:
```ts
  const handleDeletePlayer = async () => {
    if (!selectedPlayer) return
    await deletePlayer({ playerId: selectedPlayer.id })
    setDeleteConfirm(false)
```
Replace with:
```ts
  const handleDeletePlayer = async () => {
    if (!selectedPlayer) return
    await deletePlayer({ playerId: selectedPlayer.id })
    track('player_deleted', { player_id: selectedPlayer.id })
    setDeleteConfirm(false)
```

**`handlePositionChange`** — find:
```ts
  const handlePositionChange = async (player: Player, position: string) => {
    const newPos = position === '__none__' ? null : position
    setSelectedPlayer({ ...player, position: newPos })
    await updatePosition({ playerId: player.id, position: newPos })
    fetchPlayers({ seasonIds: rosterSeasonIds.length > 0 ? rosterSeasonIds : undefined, organizationId: currentOrgId })
  }
```
Replace with:
```ts
  const handlePositionChange = async (player: Player, position: string) => {
    const newPos = position === '__none__' ? null : position
    setSelectedPlayer({ ...player, position: newPos })
    await updatePosition({ playerId: player.id, position: newPos })
    track('player_role_updated', { player_id: player.id, position: newPos })
    fetchPlayers({ seasonIds: rosterSeasonIds.length > 0 ? rosterSeasonIds : undefined, organizationId: currentOrgId })
  }
```

(Named `player_role_updated`, not `player_position_updated`, to avoid colliding with Strategy.tsx's unrelated on-field x/y "positions" — see Task 8.)

**`handleFileChange`** — find:
```ts
    const result = await uploadPhoto({ playerId: selectedPlayer.id, file })
    if (result?.photo_url) {
      const updated = { ...selectedPlayer, photo_url: result.photo_url }
      setSelectedPlayer(updated)
      fetchPlayers({ seasonIds: rosterSeasonIds.length > 0 ? rosterSeasonIds : undefined, organizationId: currentOrgId })
    } else setUploadError('Upload failed. Please try again.')
```
Replace with:
```ts
    const result = await uploadPhoto({ playerId: selectedPlayer.id, file })
    if (result?.photo_url) {
      const updated = { ...selectedPlayer, photo_url: result.photo_url }
      setSelectedPlayer(updated)
      track('player_photo_uploaded', { player_id: selectedPlayer.id })
      fetchPlayers({ seasonIds: rosterSeasonIds.length > 0 ? rosterSeasonIds : undefined, organizationId: currentOrgId })
    } else setUploadError('Upload failed. Please try again.')
```

**`handleCreatePlayer`** — find:
```ts
    setCreatingPlayer(false)
    if (!created) {
      alert('Failed to create player. Please try again.')
      return
    }
```
Replace with:
```ts
    setCreatingPlayer(false)
    if (!created) {
      alert('Failed to create player. Please try again.')
      return
    }
    track('player_created', { player_id: created.id, season_count: newPlayerData.season_ids.length })
```

**`handleCreateSeason`** — find:
```ts
    setCreatingSeason(false)
    if (!created) {
      alert('Failed to create season. Please try again.')
      return
    }
    await fetchAllSeasons({ organizationId: currentOrgId })
```
Replace with:
```ts
    setCreatingSeason(false)
    if (!created) {
      alert('Failed to create season. Please try again.')
      return
    }
    track('season_created', { season_id: created.id })
    await fetchAllSeasons({ organizationId: currentOrgId })
```

**`handleSaveManageRoster`** — find:
```ts
    setManageSaving(true)
    await Promise.all([
      toAdd.length > 0 ? copyPlayersToSeason({ organizationId: currentOrgId, playerIds: toAdd, targetSeasonId: manageSeasonId, isSub: false }) : Promise.resolve(),
      toRemove.length > 0 ? removePlayersFromSeason({ seasonId: manageSeasonId, playerIds: toRemove }) : Promise.resolve(),
    ])
    setManageSaving(false)
```
Replace with:
```ts
    setManageSaving(true)
    await Promise.all([
      toAdd.length > 0 ? copyPlayersToSeason({ organizationId: currentOrgId, playerIds: toAdd, targetSeasonId: manageSeasonId, isSub: false }) : Promise.resolve(),
      toRemove.length > 0 ? removePlayersFromSeason({ seasonId: manageSeasonId, playerIds: toRemove }) : Promise.resolve(),
    ])
    track('season_roster_updated', { season_id: manageSeasonId, added_count: toAdd.length, removed_count: toRemove.length })
    setManageSaving(false)
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && node_modules/.bin/tsc -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 4: Verify a representative sample**

Using the Verification Recipe: create a player (confirm `player_created`), edit their role/position (confirm `player_role_updated`), and delete a player (confirm `player_deleted`).

- [ ] **Step 5: Commit**

```bash
git add frontend/pages/Roster.tsx
git commit -m "Instrument Roster.tsx CRUD actions with PostHog events"
```

---

### Task 7: Stats.tsx event instrumentation

**Files:**
- Modify: `frontend/pages/Stats.tsx`

**Interfaces:**
- Consumes: `track` from `frontend/lib/analytics.ts` (Task 1).

- [ ] **Step 1: Add the import**

```ts
import { track } from '../lib/analytics'
```

- [ ] **Step 2: Apply the following edit**

Find:
```ts
  const handleAddTeam = async () => {
    if (!newTeamName.trim() || selectedSeasonId == null || currentOrgId == null) return
    await createTeam({ seasonId: selectedSeasonId, name: newTeamName, organizationId: currentOrgId })
    setNewTeamName('')
    refresh()
  }

  const handleRenameTeam = async () => {
    if (renamingTeamId == null || !renameValue.trim()) return
    await updateTeam({ id: renamingTeamId, name: renameValue.trim() })
    setRenamingTeamId(null)
    refresh()
  }

  const handleDeleteTeam = async (id: number) => {
    await deleteTeam({ id })
    refresh()
  }

  const handleSavePoints = async () => {
    if (selectedSeasonId == null) return
    const win = parseInt(pointsDraft.win, 10)
    const tie = parseInt(pointsDraft.tie, 10)
    const loss = parseInt(pointsDraft.loss, 10)
    if ([win, tie, loss].some(isNaN)) return
    await updateSeasonPoints({ seasonId: selectedSeasonId, win_points: win, tie_points: tie, loss_points: loss })
    refresh()
  }

  const handleSaveNotes = async () => {
    if (!detailTeam) return
    await updateTeam({ id: detailTeam.id, notes: notesValue.trim() || null })
    setDetailTeam({ ...detailTeam, notes: notesValue.trim() || null })
    setEditingNotes(false)
    refresh()
  }
```

Replace with:
```ts
  const handleAddTeam = async () => {
    if (!newTeamName.trim() || selectedSeasonId == null || currentOrgId == null) return
    await createTeam({ seasonId: selectedSeasonId, name: newTeamName, organizationId: currentOrgId })
    track('league_team_created', { season_id: selectedSeasonId })
    setNewTeamName('')
    refresh()
  }

  const handleRenameTeam = async () => {
    if (renamingTeamId == null || !renameValue.trim()) return
    await updateTeam({ id: renamingTeamId, name: renameValue.trim() })
    track('league_team_renamed', { team_id: renamingTeamId })
    setRenamingTeamId(null)
    refresh()
  }

  const handleDeleteTeam = async (id: number) => {
    await deleteTeam({ id })
    track('league_team_deleted', { team_id: id })
    refresh()
  }

  const handleSavePoints = async () => {
    if (selectedSeasonId == null) return
    const win = parseInt(pointsDraft.win, 10)
    const tie = parseInt(pointsDraft.tie, 10)
    const loss = parseInt(pointsDraft.loss, 10)
    if ([win, tie, loss].some(isNaN)) return
    await updateSeasonPoints({ seasonId: selectedSeasonId, win_points: win, tie_points: tie, loss_points: loss })
    track('season_points_updated', { season_id: selectedSeasonId })
    refresh()
  }

  const handleSaveNotes = async () => {
    if (!detailTeam) return
    await updateTeam({ id: detailTeam.id, notes: notesValue.trim() || null })
    track('league_team_notes_updated', { team_id: detailTeam.id })
    setDetailTeam({ ...detailTeam, notes: notesValue.trim() || null })
    setEditingNotes(false)
    refresh()
  }
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && node_modules/.bin/tsc -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 4: Verify a representative sample**

Using the Verification Recipe: add a league team (confirm `league_team_created`) and rename it (confirm `league_team_renamed`).

- [ ] **Step 5: Commit**

```bash
git add frontend/pages/Stats.tsx
git commit -m "Instrument Stats.tsx CRUD actions with PostHog events"
```

---

### Task 8: Strategy.tsx board-item event instrumentation

**Files:**
- Modify: `frontend/pages/Strategy.tsx`

**Interfaces:**
- Consumes: `track` from `frontend/lib/analytics.ts` (Task 1). Uses the file's existing `playIdParam` (string, the play id from the URL) and `selectedStepId` (number | null) as the `play_id`/`step_id` properties throughout.

- [ ] **Step 1: Add the import**

```ts
import { track } from '../lib/analytics'
```

- [ ] **Step 2: Apply the following edits, in order**

Some blocks cover more than one handler at once where they sit adjacent in the file.

**`handlePlace`** — find:
```ts
  const handlePlace = async (playerId: number, x: number, y: number) => {
    if (selectedStepId === null) return
    pushHistory()
    setPositions(prev => new Map(prev).set(playerId, { x, y }))
    const ok = await upsertPosition({ stepId: selectedStepId, playerId, x, y, organizationId: currentOrgId })
    if (!ok) loadStepData(selectedStepId)
  }
```
Replace with:
```ts
  const handlePlace = async (playerId: number, x: number, y: number) => {
    if (selectedStepId === null) return
    pushHistory()
    setPositions(prev => new Map(prev).set(playerId, { x, y }))
    const ok = await upsertPosition({ stepId: selectedStepId, playerId, x, y, organizationId: currentOrgId })
    if (!ok) loadStepData(selectedStepId)
    else track('play_player_moved', { play_id: playIdParam, step_id: selectedStepId, player_id: playerId })
  }
```

**`handleRemove`** — find:
```ts
  const handleRemove = async (playerId: number) => {
    if (selectedStepId === null) return
    pushHistory()
    setPositions(prev => {
      const next = new Map(prev)
      next.delete(playerId)
      return next
    })
    const ok = await deletePosition({ stepId: selectedStepId, playerId })
    if (!ok) loadStepData(selectedStepId)
  }
```
Replace with:
```ts
  const handleRemove = async (playerId: number) => {
    if (selectedStepId === null) return
    pushHistory()
    setPositions(prev => {
      const next = new Map(prev)
      next.delete(playerId)
      return next
    })
    const ok = await deletePosition({ stepId: selectedStepId, playerId })
    if (!ok) loadStepData(selectedStepId)
    else track('play_player_removed', { play_id: playIdParam, step_id: selectedStepId, player_id: playerId })
  }
```

**`handleAddOpponent`** — find:
```ts
    const created = await trackCreate(createOpponent({ stepId: selectedStepId, label, x, y, organizationId: currentOrgId }))
    if (created) {
      const settled = withNew.map(o => (o.id === tempId ? created : o))
      setOpponents(settled)
      await applyOpponentRenumber(settled)
    } else {
      loadStepData(selectedStepId)
    }
  }

  const handleMoveOpponent = async (id: number, x: number, y: number) => {
    pushHistory()
    setOpponents(prev => prev.map(o => (o.id === id ? { ...o, x, y } : o)))
    const ok = await updateOpponent({ id, x, y })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  const handleRenameOpponent = async (id: number, label: string) => {
    pushHistory()
    setOpponents(prev => prev.map(o => (o.id === id ? { ...o, label } : o)))
    const ok = await updateOpponent({ id, label })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  const handleRemoveOpponent = async (id: number) => {
    pushHistory()
    const remaining = opponents.filter(o => o.id !== id)
    setOpponents(remaining)
    const ok = await removeOpponent({ id })
    if (!ok && selectedStepId !== null) { loadStepData(selectedStepId); return }
    await applyOpponentRenumber(remaining)
  }
```
Replace with:
```ts
    const created = await trackCreate(createOpponent({ stepId: selectedStepId, label, x, y, organizationId: currentOrgId }))
    if (created) {
      const settled = withNew.map(o => (o.id === tempId ? created : o))
      setOpponents(settled)
      track('opponent_marker_created', { play_id: playIdParam, step_id: selectedStepId })
      await applyOpponentRenumber(settled)
    } else {
      loadStepData(selectedStepId)
    }
  }

  const handleMoveOpponent = async (id: number, x: number, y: number) => {
    pushHistory()
    setOpponents(prev => prev.map(o => (o.id === id ? { ...o, x, y } : o)))
    const ok = await updateOpponent({ id, x, y })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
    else track('opponent_marker_moved', { play_id: playIdParam, step_id: selectedStepId, opponent_marker_id: id })
  }

  const handleRenameOpponent = async (id: number, label: string) => {
    pushHistory()
    setOpponents(prev => prev.map(o => (o.id === id ? { ...o, label } : o)))
    const ok = await updateOpponent({ id, label })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
    else track('opponent_marker_renamed', { play_id: playIdParam, step_id: selectedStepId, opponent_marker_id: id })
  }

  const handleRemoveOpponent = async (id: number) => {
    pushHistory()
    const remaining = opponents.filter(o => o.id !== id)
    setOpponents(remaining)
    const ok = await removeOpponent({ id })
    if (!ok && selectedStepId !== null) { loadStepData(selectedStepId); return }
    track('opponent_marker_removed', { play_id: playIdParam, step_id: selectedStepId, opponent_marker_id: id })
    await applyOpponentRenumber(remaining)
  }
```

**`handleAddTextBox` / `handleMoveTextBox` / `handleEditTextBox` / `handleRemoveTextBox` / `handleUpdateTextBoxStyle`** — find:
```ts
    const created = await trackCreate(createTextBox({ stepId: selectedStepId, text, x, y, organizationId: currentOrgId }))
    if (created) {
      setTextBoxes(withNew.map(t => (t.id === tempId ? created : t)))
    } else {
      loadStepData(selectedStepId)
    }
  }

  const handleMoveTextBox = async (id: number, x: number, y: number) => {
    pushHistory()
    setTextBoxes(prev => prev.map(t => (t.id === id ? { ...t, x, y } : t)))
    const ok = await updateTextBox({ id, x, y })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  const handleEditTextBox = async (id: number, text: string) => {
    pushHistory()
    setTextBoxes(prev => prev.map(t => (t.id === id ? { ...t, text } : t)))
    const ok = await updateTextBox({ id, text })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  const handleRemoveTextBox = async (id: number) => {
    pushHistory()
    setTextBoxes(prev => prev.filter(t => t.id !== id))
    const ok = await removeTextBox({ id })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }
```
Replace with:
```ts
    const created = await trackCreate(createTextBox({ stepId: selectedStepId, text, x, y, organizationId: currentOrgId }))
    if (created) {
      setTextBoxes(withNew.map(t => (t.id === tempId ? created : t)))
      track('text_box_created', { play_id: playIdParam, step_id: selectedStepId })
    } else {
      loadStepData(selectedStepId)
    }
  }

  const handleMoveTextBox = async (id: number, x: number, y: number) => {
    pushHistory()
    setTextBoxes(prev => prev.map(t => (t.id === id ? { ...t, x, y } : t)))
    const ok = await updateTextBox({ id, x, y })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
    else track('text_box_moved', { play_id: playIdParam, step_id: selectedStepId, text_box_id: id })
  }

  const handleEditTextBox = async (id: number, text: string) => {
    pushHistory()
    setTextBoxes(prev => prev.map(t => (t.id === id ? { ...t, text } : t)))
    const ok = await updateTextBox({ id, text })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
    else track('text_box_text_edited', { play_id: playIdParam, step_id: selectedStepId, text_box_id: id })
  }

  const handleRemoveTextBox = async (id: number) => {
    pushHistory()
    setTextBoxes(prev => prev.filter(t => t.id !== id))
    const ok = await removeTextBox({ id })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
    else track('text_box_removed', { play_id: playIdParam, step_id: selectedStepId, text_box_id: id })
  }
```

**`handleUpdateTextBoxStyle`** — find:
```ts
  const handleUpdateTextBoxStyle = async (id: number, patch: { color?: string | null; filled?: boolean; width?: number }) => {
    pushHistory()
    setTextBoxes(prev => prev.map(t => (t.id === id ? { ...t, ...patch } : t)))
    const ok = await updateTextBox({ id, ...patch })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }
```
Replace with:
```ts
  const handleUpdateTextBoxStyle = async (id: number, patch: { color?: string | null; filled?: boolean; width?: number }) => {
    pushHistory()
    setTextBoxes(prev => prev.map(t => (t.id === id ? { ...t, ...patch } : t)))
    const ok = await updateTextBox({ id, ...patch })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
    else track('text_box_style_updated', { play_id: playIdParam, step_id: selectedStepId, text_box_id: id })
  }
```

**`handleCreateArrow` / `handleUpdateArrow` / `handleDeleteArrow`** — find:
```ts
  const handleCreateArrow = async (arrow: { x1: number; y1: number; x2: number; y2: number; cx: number; cy: number; arrow_type: 'run' | 'throw'; start_player_id: number | null; start_opponent_id: number | null }) => {
    if (selectedStepId === null) return
    pushHistory()
    const tempId = -Date.now()
    setArrows(prev => [...prev, { id: tempId, ...arrow }])
    const created = await trackCreate(createArrow({ stepId: selectedStepId, ...arrow, organizationId: currentOrgId }))
    if (created) {
      setArrows(prev => prev.map(a => (a.id === tempId ? created : a)))
      await propagateRunArrowToNextStep(created)
    } else {
      loadStepData(selectedStepId)
    }
  }

  const handleUpdateArrow = async (arrow: { id: number; x1: number; y1: number; x2: number; y2: number; cx: number; cy: number; start_player_id?: number | null; start_opponent_id?: number | null }) => {
    pushHistory()
    setArrows(prev => prev.map(a => (a.id === arrow.id ? { ...a, ...arrow } : a)))
    const ok = await updateArrow(arrow)
    if (!ok && selectedStepId !== null) {
      loadStepData(selectedStepId)
      return
    }
    const updated = arrows.find(a => a.id === arrow.id)
    if (updated) {
      const startPlayerId = arrow.start_player_id !== undefined ? arrow.start_player_id : updated.start_player_id
      const startOpponentId = arrow.start_opponent_id !== undefined ? arrow.start_opponent_id : updated.start_opponent_id
      await propagateRunArrowToNextStep({ arrow_type: updated.arrow_type, start_player_id: startPlayerId, start_opponent_id: startOpponentId, x2: arrow.x2, y2: arrow.y2 })
    }
  }

  const handleDeleteArrow = async (id: number) => {
    pushHistory()
    setArrows(prev => prev.filter(a => a.id !== id))
    const ok = await removeArrow({ id })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }
```
Replace with:
```ts
  const handleCreateArrow = async (arrow: { x1: number; y1: number; x2: number; y2: number; cx: number; cy: number; arrow_type: 'run' | 'throw'; start_player_id: number | null; start_opponent_id: number | null }) => {
    if (selectedStepId === null) return
    pushHistory()
    const tempId = -Date.now()
    setArrows(prev => [...prev, { id: tempId, ...arrow }])
    const created = await trackCreate(createArrow({ stepId: selectedStepId, ...arrow, organizationId: currentOrgId }))
    if (created) {
      setArrows(prev => prev.map(a => (a.id === tempId ? created : a)))
      track('arrow_created', { play_id: playIdParam, step_id: selectedStepId, arrow_id: created.id, arrow_type: arrow.arrow_type })
      await propagateRunArrowToNextStep(created)
    } else {
      loadStepData(selectedStepId)
    }
  }

  const handleUpdateArrow = async (arrow: { id: number; x1: number; y1: number; x2: number; y2: number; cx: number; cy: number; start_player_id?: number | null; start_opponent_id?: number | null }) => {
    pushHistory()
    setArrows(prev => prev.map(a => (a.id === arrow.id ? { ...a, ...arrow } : a)))
    const ok = await updateArrow(arrow)
    if (!ok && selectedStepId !== null) {
      loadStepData(selectedStepId)
      return
    }
    track('arrow_moved', { play_id: playIdParam, step_id: selectedStepId, arrow_id: arrow.id })
    const updated = arrows.find(a => a.id === arrow.id)
    if (updated) {
      const startPlayerId = arrow.start_player_id !== undefined ? arrow.start_player_id : updated.start_player_id
      const startOpponentId = arrow.start_opponent_id !== undefined ? arrow.start_opponent_id : updated.start_opponent_id
      await propagateRunArrowToNextStep({ arrow_type: updated.arrow_type, start_player_id: startPlayerId, start_opponent_id: startOpponentId, x2: arrow.x2, y2: arrow.y2 })
    }
  }

  const handleDeleteArrow = async (id: number) => {
    pushHistory()
    setArrows(prev => prev.filter(a => a.id !== id))
    const ok = await removeArrow({ id })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
    else track('arrow_deleted', { play_id: playIdParam, step_id: selectedStepId, arrow_id: id })
  }
```

**`handleCreateHighlight` / `handleUpdateHighlightColor` / `handleUpdateHighlightPoints` / `handleUpdateHighlightLocked` / `handleDeleteHighlight`** — find:
```ts
  const handleCreateHighlight = async (points: { x: number; y: number }[], color: string, isStraight: boolean) => {
    if (selectedStepId === null) return
    pushHistory()
    const tempId = -Date.now()
    setHighlights(prev => [...prev, { id: tempId, points, color, is_straight: isStraight, locked: false }])
    const created = await trackCreate(createHighlight({ stepId: selectedStepId, points, color, organizationId: currentOrgId, isStraight }))
    if (created) setHighlights(prev => prev.map(h => (h.id === tempId ? created : h)))
    else loadStepData(selectedStepId)
  }

  const handleUpdateHighlightColor = async (id: number, color: string) => {
    pushHistory()
    setHighlights(prev => prev.map(h => (h.id === id ? { ...h, color } : h)))
    const ok = await updateHighlight({ id, color })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  const handleUpdateHighlightPoints = async (id: number, points: { x: number; y: number }[]) => {
    pushHistory()
    setHighlights(prev => prev.map(h => (h.id === id ? { ...h, points } : h)))
    const ok = await updateHighlight({ id, points })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  const handleUpdateHighlightLocked = async (id: number, locked: boolean) => {
    pushHistory()
    setHighlights(prev => prev.map(h => (h.id === id ? { ...h, locked } : h)))
    const ok = await updateHighlight({ id, locked })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  const handleDeleteHighlight = async (id: number) => {
    pushHistory()
    setHighlights(prev => prev.filter(h => h.id !== id))
    const ok = await removeHighlight({ id })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }
```
Replace with:
```ts
  const handleCreateHighlight = async (points: { x: number; y: number }[], color: string, isStraight: boolean) => {
    if (selectedStepId === null) return
    pushHistory()
    const tempId = -Date.now()
    setHighlights(prev => [...prev, { id: tempId, points, color, is_straight: isStraight, locked: false }])
    const created = await trackCreate(createHighlight({ stepId: selectedStepId, points, color, organizationId: currentOrgId, isStraight }))
    if (created) {
      setHighlights(prev => prev.map(h => (h.id === tempId ? created : h)))
      track('highlight_created', { play_id: playIdParam, step_id: selectedStepId, highlight_id: created.id })
    } else loadStepData(selectedStepId)
  }

  const handleUpdateHighlightColor = async (id: number, color: string) => {
    pushHistory()
    setHighlights(prev => prev.map(h => (h.id === id ? { ...h, color } : h)))
    const ok = await updateHighlight({ id, color })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
    else track('highlight_color_updated', { play_id: playIdParam, step_id: selectedStepId, highlight_id: id })
  }

  const handleUpdateHighlightPoints = async (id: number, points: { x: number; y: number }[]) => {
    pushHistory()
    setHighlights(prev => prev.map(h => (h.id === id ? { ...h, points } : h)))
    const ok = await updateHighlight({ id, points })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
    else track('highlight_reshaped', { play_id: playIdParam, step_id: selectedStepId, highlight_id: id })
  }

  const handleUpdateHighlightLocked = async (id: number, locked: boolean) => {
    pushHistory()
    setHighlights(prev => prev.map(h => (h.id === id ? { ...h, locked } : h)))
    const ok = await updateHighlight({ id, locked })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
    else track('highlight_lock_toggled', { play_id: playIdParam, step_id: selectedStepId, highlight_id: id, locked })
  }

  const handleDeleteHighlight = async (id: number) => {
    pushHistory()
    setHighlights(prev => prev.filter(h => h.id !== id))
    const ok = await removeHighlight({ id })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
    else track('highlight_deleted', { play_id: playIdParam, step_id: selectedStepId, highlight_id: id })
  }
```

**`handleCreateLine` / `handleUpdateLineColor` / `handleUpdateLinePoints` / `handleUpdateLineLocked` / `handleDeleteLine`** — find:
```ts
  const handleCreateLine = async (points: { x: number; y: number }[], color: string, isStraight: boolean) => {
    if (selectedStepId === null) return
    pushHistory()
    const tempId = -Date.now()
    setLines(prev => [...prev, { id: tempId, points, color, is_straight: isStraight, locked: false }])
    const created = await trackCreate(createLine({ stepId: selectedStepId, points, color, organizationId: currentOrgId, isStraight }))
    if (created) setLines(prev => prev.map(l => (l.id === tempId ? created : l)))
    else loadStepData(selectedStepId)
  }

  const handleUpdateLineColor = async (id: number, color: string) => {
    pushHistory()
    setLines(prev => prev.map(l => (l.id === id ? { ...l, color } : l)))
    const ok = await updateLine({ id, color })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  const handleUpdateLinePoints = async (id: number, points: { x: number; y: number }[]) => {
    pushHistory()
    setLines(prev => prev.map(l => (l.id === id ? { ...l, points } : l)))
    const ok = await updateLine({ id, points })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  const handleUpdateLineLocked = async (id: number, locked: boolean) => {
    pushHistory()
    setLines(prev => prev.map(l => (l.id === id ? { ...l, locked } : l)))
    const ok = await updateLine({ id, locked })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  const handleDeleteLine = async (id: number) => {
    pushHistory()
    setLines(prev => prev.filter(l => l.id !== id))
    const ok = await removeLine({ id })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }
```
Replace with:
```ts
  const handleCreateLine = async (points: { x: number; y: number }[], color: string, isStraight: boolean) => {
    if (selectedStepId === null) return
    pushHistory()
    const tempId = -Date.now()
    setLines(prev => [...prev, { id: tempId, points, color, is_straight: isStraight, locked: false }])
    const created = await trackCreate(createLine({ stepId: selectedStepId, points, color, organizationId: currentOrgId, isStraight }))
    if (created) {
      setLines(prev => prev.map(l => (l.id === tempId ? created : l)))
      track('line_created', { play_id: playIdParam, step_id: selectedStepId, line_id: created.id })
    } else loadStepData(selectedStepId)
  }

  const handleUpdateLineColor = async (id: number, color: string) => {
    pushHistory()
    setLines(prev => prev.map(l => (l.id === id ? { ...l, color } : l)))
    const ok = await updateLine({ id, color })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
    else track('line_color_updated', { play_id: playIdParam, step_id: selectedStepId, line_id: id })
  }

  const handleUpdateLinePoints = async (id: number, points: { x: number; y: number }[]) => {
    pushHistory()
    setLines(prev => prev.map(l => (l.id === id ? { ...l, points } : l)))
    const ok = await updateLine({ id, points })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
    else track('line_reshaped', { play_id: playIdParam, step_id: selectedStepId, line_id: id })
  }

  const handleUpdateLineLocked = async (id: number, locked: boolean) => {
    pushHistory()
    setLines(prev => prev.map(l => (l.id === id ? { ...l, locked } : l)))
    const ok = await updateLine({ id, locked })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
    else track('line_lock_toggled', { play_id: playIdParam, step_id: selectedStepId, line_id: id, locked })
  }

  const handleDeleteLine = async (id: number) => {
    pushHistory()
    setLines(prev => prev.filter(l => l.id !== id))
    const ok = await removeLine({ id })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
    else track('line_deleted', { play_id: playIdParam, step_id: selectedStepId, line_id: id })
  }
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && node_modules/.bin/tsc -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 4: Verify a representative sample**

Using the Verification Recipe: place a player on the board (confirm `play_player_moved`), draw an arrow (confirm `arrow_created`), and delete a text box (confirm `text_box_removed`).

- [ ] **Step 5: Commit**

```bash
git add frontend/pages/Strategy.tsx
git commit -m "Instrument Strategy.tsx board-item CRUD actions with PostHog events"
```

---

### Task 9: Strategy.tsx play/step CRUD and batch selection events

**Files:**
- Modify: `frontend/pages/Strategy.tsx`

**Interfaces:**
- Consumes: `track` from `frontend/lib/analytics.ts` (Task 1, already imported by Task 8 — this task continues in the same file).

- [ ] **Step 1: Track batch delete (`handleDeleteMany`)**

Find:
```ts
  const handleDeleteMany = async (items: BoardItem[]) => {
    if (selectedStepId === null || items.length === 0) return
    pushHistory()
    const stepId = selectedStepId
    const playerIds = items.filter(i => i.kind === 'player').map(i => i.id)
    const oppIds = items.filter(i => i.kind === 'opponent').map(i => i.id)
    const textIds = items.filter(i => i.kind === 'textbox').map(i => i.id)
    const arrowIds = items.filter(i => i.kind === 'arrow').map(i => i.id)
    const remainingOpponents = opponents.filter(o => !oppIds.includes(o.id))
    if (playerIds.length) setPositions(prev => { const m = new Map(prev); playerIds.forEach(id => m.delete(id)); return m })
    if (oppIds.length) setOpponents(remainingOpponents)
    if (textIds.length) setTextBoxes(prev => prev.filter(t => !textIds.includes(t.id)))
    if (arrowIds.length) setArrows(prev => prev.filter(a => !arrowIds.includes(a.id)))
    const results = await Promise.all([
      ...playerIds.map(id => deletePosition({ stepId, playerId: id })),
      ...oppIds.map(id => removeOpponent({ id })),
      ...textIds.map(id => removeTextBox({ id })),
      ...arrowIds.map(id => removeArrow({ id })),
    ])
    if (results.some(r => !r)) loadStepData(stepId)
    else if (oppIds.length) await applyOpponentRenumber(remainingOpponents)
  }
```
Replace with:
```ts
  const handleDeleteMany = async (items: BoardItem[]) => {
    if (selectedStepId === null || items.length === 0) return
    pushHistory()
    const stepId = selectedStepId
    const playerIds = items.filter(i => i.kind === 'player').map(i => i.id)
    const oppIds = items.filter(i => i.kind === 'opponent').map(i => i.id)
    const textIds = items.filter(i => i.kind === 'textbox').map(i => i.id)
    const arrowIds = items.filter(i => i.kind === 'arrow').map(i => i.id)
    const remainingOpponents = opponents.filter(o => !oppIds.includes(o.id))
    if (playerIds.length) setPositions(prev => { const m = new Map(prev); playerIds.forEach(id => m.delete(id)); return m })
    if (oppIds.length) setOpponents(remainingOpponents)
    if (textIds.length) setTextBoxes(prev => prev.filter(t => !textIds.includes(t.id)))
    if (arrowIds.length) setArrows(prev => prev.filter(a => !arrowIds.includes(a.id)))
    const results = await Promise.all([
      ...playerIds.map(id => deletePosition({ stepId, playerId: id })),
      ...oppIds.map(id => removeOpponent({ id })),
      ...textIds.map(id => removeTextBox({ id })),
      ...arrowIds.map(id => removeArrow({ id })),
    ])
    if (results.some(r => !r)) {
      loadStepData(stepId)
    } else {
      if (oppIds.length) await applyOpponentRenumber(remainingOpponents)
      track('play_selection_deleted', {
        play_id: playIdParam, step_id: stepId,
        player_count: playerIds.length, opponent_count: oppIds.length,
        text_box_count: textIds.length, arrow_count: arrowIds.length,
      })
    }
  }
```

- [ ] **Step 2: Track batch move (`handleGroupMove`, commit phase only)**

Find:
```ts
    if (phase === 'commit') {
      const before = groupBeforeRef.current
      groupBeforeRef.current = null
      if (before) pushHistory(before)
      // Group-moved arrows detach (start_player_id/start_opponent_id: null),
      // so there is no anchored run arrow left to propagate into the next step.
      Promise.all([
        ...playerMoves.map(mv => upsertPosition({ stepId, playerId: mv.id, x: mv.x, y: mv.y, organizationId: currentOrgId })),
        ...oppMoves.map(mv => updateOpponent({ id: mv.id, x: mv.x, y: mv.y })),
        ...textMoves.map(mv => updateTextBox({ id: mv.id, x: mv.x, y: mv.y })),
        ...arrowMoves.map(mv => updateArrow({ id: mv.id, x1: mv.x1, y1: mv.y1, x2: mv.x2, y2: mv.y2, cx: mv.cx, cy: mv.cy, start_player_id: mv.start_player_id, start_opponent_id: mv.start_opponent_id })),
      ]).then(results => { if (results.some(r => !r)) loadStepData(stepId) })
    }
```
Replace with:
```ts
    if (phase === 'commit') {
      const before = groupBeforeRef.current
      groupBeforeRef.current = null
      if (before) pushHistory(before)
      // Group-moved arrows detach (start_player_id/start_opponent_id: null),
      // so there is no anchored run arrow left to propagate into the next step.
      Promise.all([
        ...playerMoves.map(mv => upsertPosition({ stepId, playerId: mv.id, x: mv.x, y: mv.y, organizationId: currentOrgId })),
        ...oppMoves.map(mv => updateOpponent({ id: mv.id, x: mv.x, y: mv.y })),
        ...textMoves.map(mv => updateTextBox({ id: mv.id, x: mv.x, y: mv.y })),
        ...arrowMoves.map(mv => updateArrow({ id: mv.id, x1: mv.x1, y1: mv.y1, x2: mv.x2, y2: mv.y2, cx: mv.cx, cy: mv.cy, start_player_id: mv.start_player_id, start_opponent_id: mv.start_opponent_id })),
      ]).then(results => {
        if (results.some(r => !r)) {
          loadStepData(stepId)
        } else {
          track('play_selection_moved', {
            play_id: playIdParam, step_id: stepId,
            player_count: playerMoves.length, opponent_count: oppMoves.length,
            text_box_count: textMoves.length, arrow_count: arrowMoves.length,
          })
        }
      })
    }
```

- [ ] **Step 3: Track play CRUD (`handleCreate` / `handleRename` / `handleAssignGame` / `handleDelete`)**

Find:
```ts
  const handleCreate = async () => {
    const name = nameInput.trim()
    if (!name) return
    const play = await createPlay({ name, game_id: gameInput === NO_GAME ? null : parseInt(gameInput), organizationId: currentOrgId })
    if (play) {
      setShowCreate(false)
      setNameInput('')
      setGameInput(NO_GAME)
      await fetchPlays({ organizationId: currentOrgId })
      navigate(`/plays/${play.id}`)
    }
  }

  const handleRename = async () => {
    const name = nameInput.trim()
    if (!name || selectedPlayId === null) return
    await updatePlay({ id: selectedPlayId, name })
    setShowRename(false)
    setNameInput('')
    fetchPlays({ organizationId: currentOrgId })
  }

  const handleAssignGame = async (value: string) => {
    if (selectedPlayId === null) return
    await updatePlay({ id: selectedPlayId, game_id: value === NO_GAME ? null : parseInt(value) })
    fetchPlays({ organizationId: currentOrgId })
  }

  const handleDelete = async () => {
    if (selectedPlayId === null) return
    await deletePlay({ id: selectedPlayId })
    setDeleteConfirm(false)
    fetchPlays({ organizationId: currentOrgId })
  }
```
Replace with:
```ts
  const handleCreate = async () => {
    const name = nameInput.trim()
    if (!name) return
    const play = await createPlay({ name, game_id: gameInput === NO_GAME ? null : parseInt(gameInput), organizationId: currentOrgId })
    if (play) {
      track('play_created', { play_id: play.id, game_id: play.game_id })
      setShowCreate(false)
      setNameInput('')
      setGameInput(NO_GAME)
      await fetchPlays({ organizationId: currentOrgId })
      navigate(`/plays/${play.id}`)
    }
  }

  const handleRename = async () => {
    const name = nameInput.trim()
    if (!name || selectedPlayId === null) return
    await updatePlay({ id: selectedPlayId, name })
    track('play_renamed', { play_id: selectedPlayId })
    setShowRename(false)
    setNameInput('')
    fetchPlays({ organizationId: currentOrgId })
  }

  const handleAssignGame = async (value: string) => {
    if (selectedPlayId === null) return
    await updatePlay({ id: selectedPlayId, game_id: value === NO_GAME ? null : parseInt(value) })
    track('play_game_assigned', { play_id: selectedPlayId, game_id: value === NO_GAME ? null : parseInt(value) })
    fetchPlays({ organizationId: currentOrgId })
  }

  const handleDelete = async () => {
    if (selectedPlayId === null) return
    await deletePlay({ id: selectedPlayId })
    track('play_deleted', { play_id: selectedPlayId })
    setDeleteConfirm(false)
    fetchPlays({ organizationId: currentOrgId })
  }
```

- [ ] **Step 4: Track quick-add player flows (`handleAddNewSub` / `handleAddExistingPlayer`)**

Find:
```ts
  const handleAddNewSub = async (name: string) => {
    if (selectedPlay?.game_id) {
      await createPlayerForGame({ display_name: name, gameId: selectedPlay.game_id, seasonId: selectedGame?.season_id, organizationId: currentOrgId })
    } else {
      await createPlayer({ display_name: name, is_sub: true, organizationId: currentOrgId })
    }
    await refreshPlayerLists()
  }

  // Adds an existing player (e.g. from another season) onto this game's
  // roster, same hook Schedule uses for the equivalent flow.
  const handleAddExistingPlayer = async (playerId: string) => {
    if (!selectedPlay?.game_id) return
    await addPlayerToGame({ playerId: parseInt(playerId), gameId: selectedPlay.game_id, seasonId: selectedGame?.season_id, organizationId: currentOrgId })
    await refreshPlayerLists()
  }
```
Replace with:
```ts
  const handleAddNewSub = async (name: string) => {
    if (selectedPlay?.game_id) {
      await createPlayerForGame({ display_name: name, gameId: selectedPlay.game_id, seasonId: selectedGame?.season_id, organizationId: currentOrgId })
    } else {
      await createPlayer({ display_name: name, is_sub: true, organizationId: currentOrgId })
    }
    track('player_created', { game_id: selectedPlay?.game_id ?? null, is_sub: true, source: 'strategy_add_sub' })
    await refreshPlayerLists()
  }

  // Adds an existing player (e.g. from another season) onto this game's
  // roster, same hook Schedule uses for the equivalent flow.
  const handleAddExistingPlayer = async (playerId: string) => {
    if (!selectedPlay?.game_id) return
    await addPlayerToGame({ playerId: parseInt(playerId), gameId: selectedPlay.game_id, seasonId: selectedGame?.season_id, organizationId: currentOrgId })
    track('game_player_added', { player_id: parseInt(playerId), game_id: selectedPlay.game_id })
    await refreshPlayerLists()
  }
```

- [ ] **Step 5: Track step CRUD (`handleAddStep` / `handleDeleteStep`)**

Find:
```ts
  const handleAddStep = async () => {
    if (selectedPlayId === null) return
    const step = await addStep({ playId: selectedPlayId, organizationId: currentOrgId })
    if (step) {
      // Seed the new step from the current one instead of starting empty: a
      // placed player or opponent keeps their position unless they have an
      // outgoing 'run' arrow anchored to them, in which case the arrow's
      // head becomes their starting position here.
      const seeds: Promise<unknown>[] = []
      for (const [playerId, pos] of positions.entries()) {
        const runArrow = arrows.find(a => a.arrow_type === 'run' && a.start_player_id === playerId)
        const target = runArrow ? { x: runArrow.x2, y: runArrow.y2 } : pos
        seeds.push(upsertPosition({ stepId: step.id, playerId, x: target.x, y: target.y, organizationId: currentOrgId }))
      }
      for (const opp of opponents) {
        const runArrow = arrows.find(a => a.arrow_type === 'run' && a.start_opponent_id === opp.id)
        const target = runArrow ? { x: runArrow.x2, y: runArrow.y2 } : opp
        seeds.push(createOpponent({ stepId: step.id, label: opp.label, x: target.x, y: target.y, organizationId: currentOrgId }))
      }
      // Text boxes carry their text and position forward unchanged (they
      // don't anchor arrows, so there's no head-position case to handle).
      for (const box of textBoxes) {
        seeds.push(createTextBox({ stepId: step.id, text: box.text, x: box.x, y: box.y, organizationId: currentOrgId }))
      }
      await Promise.all(seeds)
      await fetchSteps({ playId: selectedPlayId })
      setSelectedStepId(step.id)
    }
  }

  const handleDeleteStep = async () => {
    if (selectedStepId === null || stepList.length <= 1) return
    const deletedIndex = stepIndex
    await removeStep({ stepId: selectedStepId })
    const remaining = await fetchSteps({ playId: selectedPlayId! })
    if (remaining && remaining.length > 0) {
      setSelectedStepId(remaining[Math.max(0, deletedIndex - 1)]!.id)
    }
  }
```
Replace with:
```ts
  const handleAddStep = async () => {
    if (selectedPlayId === null) return
    const step = await addStep({ playId: selectedPlayId, organizationId: currentOrgId })
    if (step) {
      // Seed the new step from the current one instead of starting empty: a
      // placed player or opponent keeps their position unless they have an
      // outgoing 'run' arrow anchored to them, in which case the arrow's
      // head becomes their starting position here. These seed calls are an
      // implementation detail of step creation, not user-initiated edits of
      // those items, so they intentionally don't fire their own
      // play_player_moved/opponent_marker_created/text_box_created events —
      // only play_step_added below does.
      const seeds: Promise<unknown>[] = []
      for (const [playerId, pos] of positions.entries()) {
        const runArrow = arrows.find(a => a.arrow_type === 'run' && a.start_player_id === playerId)
        const target = runArrow ? { x: runArrow.x2, y: runArrow.y2 } : pos
        seeds.push(upsertPosition({ stepId: step.id, playerId, x: target.x, y: target.y, organizationId: currentOrgId }))
      }
      for (const opp of opponents) {
        const runArrow = arrows.find(a => a.arrow_type === 'run' && a.start_opponent_id === opp.id)
        const target = runArrow ? { x: runArrow.x2, y: runArrow.y2 } : opp
        seeds.push(createOpponent({ stepId: step.id, label: opp.label, x: target.x, y: target.y, organizationId: currentOrgId }))
      }
      // Text boxes carry their text and position forward unchanged (they
      // don't anchor arrows, so there's no head-position case to handle).
      for (const box of textBoxes) {
        seeds.push(createTextBox({ stepId: step.id, text: box.text, x: box.x, y: box.y, organizationId: currentOrgId }))
      }
      await Promise.all(seeds)
      track('play_step_added', { play_id: playIdParam, step_id: step.id })
      await fetchSteps({ playId: selectedPlayId })
      setSelectedStepId(step.id)
    }
  }

  const handleDeleteStep = async () => {
    if (selectedStepId === null || stepList.length <= 1) return
    const deletedIndex = stepIndex
    const deletedStepId = selectedStepId
    await removeStep({ stepId: selectedStepId })
    track('play_step_deleted', { play_id: playIdParam, step_id: deletedStepId })
    const remaining = await fetchSteps({ playId: selectedPlayId! })
    if (remaining && remaining.length > 0) {
      setSelectedStepId(remaining[Math.max(0, deletedIndex - 1)]!.id)
    }
  }
```

- [ ] **Step 6: Typecheck**

Run: `cd frontend && node_modules/.bin/tsc -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 7: Verify a representative sample**

Using the Verification Recipe: create a new play (confirm `play_created`), add a step (confirm `play_step_added`), and multi-select-delete a couple of board items (confirm `play_selection_deleted` with correct counts).

- [ ] **Step 8: Commit**

```bash
git add frontend/pages/Strategy.tsx
git commit -m "Instrument Strategy.tsx play/step CRUD and batch selection events"
```

---

## Non-goals (already covered, no task needed)

- `frontend/pages/Chat.tsx` — no changes; `chat_message_sent`/`chat_history_cleared` are already emitted server-side (Task 4), and duplicating them client-side would double-count.
- `frontend/pages/Login.tsx`, `frontend/pages/CreateOrganization.tsx` — no changes; they only call the `AuthContext` functions instrumented in Task 3, which is where the actual mutations happen.
- `mcp-server/index.ts` — already instrumented in a prior session; out of scope here.
