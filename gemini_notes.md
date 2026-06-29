## Vercel Deployment & Debugging Walkthrough

This document outlines the steps we took to successfully deploy the **Ultimate Frisbee Warrior Tracker** to Vercel, transitioning it from a standard Node.js Express server to a Serverless architecture, and resolving all bugs encountered along the way.

### 1. Adapting the Express App for Serverless

Standard Express applications run continuously (`app.listen(PORT)`), but Vercel Serverless functions run only on-demand when an HTTP request is made. 

To make our backend compatible with Vercel:
- **Created a Serverless Entrypoint:** We created `api/index.ts` to simply import the Express `app` without starting a server listener. Vercel automatically wraps the exported Express app in a serverless handler.
- **Conditional Listening:** We updated `server/index.ts` to only call `app.listen()` when running locally. If the environment variable `process.env.VERCEL` is detected, the server skips the `.listen()` step and simply uses `export default app`.

### 2. Configuring Environment Variables

Vercel doesn't read the local `.env` file when deploying to production for security reasons. 
- Using the Vercel CLI, we securely uploaded all of your secrets (like `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `GEMINI_API_KEY`) into the Vercel Production Environment Vault.
- This ensures that the serverless functions have access to the exact same configurations as your local machine.

### 3. Fixing the Serverless Read-Only File System Error (`ENOENT`)

> [!WARNING]
> **The Issue:** Our first deployment crashed with an `Error: ENOENT: no such file or directory, mkdir '/var/task/uploads'` error. 

**The Cause:** Vercel serverless environments have a strict **Read-Only File System**. Our Express server was attempting to run `fs.mkdirSync(path.join(process.cwd(), "uploads"))` on startup to prepare a folder for user avatars. Because the disk is read-only, this crashed the entire API.

**The Fix:** We modified the server initialization logic to check for the Vercel environment. Vercel *does* provide a temporary writable directory at `/tmp`. 
We changed the code so that if `process.env.VERCEL` is active, the app creates and uses `/tmp/uploads` instead of the root directory. 

### 4. Fixing the "White Screen of Death" (SPA Routing Issue)

> [!CAUTION]
> **The Issue:** After fixing the backend crash, visiting the deployed URL resulted in a completely blank white screen. 

**The Cause:** Our `vercel.json` configuration was originally written like this:
```json
"routes": [
  { "src": "/api/(.*)", "dest": "/api/index.ts" },
  { "src": "/(.*)", "dest": "/index.html" }
]
```
The `"routes"` directive forcefully intercepts **all** traffic. When the browser requested the bundled React JavaScript (e.g., `/assets/index-xxx.js`), Vercel caught the request using `/(.*)` and aggressively returned the `index.html` file instead of the actual JavaScript code. The browser received HTML when it expected JS, so it silently failed to mount the React app.

**The Fix:** We changed `"routes"` to `"rewrites"`. 
```json
"rewrites": [
  { "source": "/api/(.*)", "destination": "/api/index.ts" },
  { "source": "/(.*)", "destination": "/index.html" }
]
```
Vercel handles `"rewrites"` differently: it will *always* check the static file system first. If a static asset like a JavaScript bundle or CSS file exists, Vercel serves it directly. If the path doesn't match an actual file (like your React Router URLs e.g. `/dashboard`), it safely falls back to `/index.html`. 

### 5. Security & GitHub Push Rejection

During the deployment, you attempted to push to GitHub, but GitHub's Secret Scanning blocked the push because your Supabase Personal Access Token was left inside the `.mcp.json` file.
- We removed the hardcoded token and replaced it with a placeholder `[YOUR_SUPABASE_TOKEN]`.
- We used `git commit --amend` to completely wipe the secret from the Git history.
- The push then succeeded, ensuring your credentials were not leaked to the repository.

## Supabase Database Connection Walkthrough

This section outlines the strategy we used to connect our Express backend to the Supabase PostgreSQL database, specifically working around local networking limitations and bypassing traditional TCP database drivers.

### 1. The IPv6 Connectivity Issue

> [!WARNING]
> **The Issue:** Our initial attempt to connect to the Supabase database using the standard `pg` (node-postgres) module failed with an `EHOSTUNREACH` error. 

**The Cause:** Supabase uses IPv6 for its direct database connections (`aws-0-ca-central-1.pooler.supabase.com`). Your local machine (and often standard ISP configurations) had trouble resolving and connecting over IPv6 to the Supabase pooler, which broke the traditional TCP-based database connection pool.

### 2. Transitioning to the Supabase Server SDK

To avoid dealing with raw TCP socket errors and IPv6 routing issues, we decided to pivot to **Supabase's HTTP REST API**. 

Instead of connecting over port 5432 with a `pg.Pool`, we:
- Installed `@supabase/supabase-js` and `@supabase/server`.
- Initialized a Supabase **Admin Client** using your `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in the backend. 
- Because this SDK operates exclusively over standard HTTPS (port 443), it effortlessly bypassed the IPv6 TCP blocking issues that plagued the raw Postgres driver. 

### 3. Creating the `execute_sql` RPC Function

> [!NOTE]
> Our existing Express backend was written entirely using raw SQL strings (`SELECT * FROM seasons`, `INSERT INTO players...`). The Supabase JS client usually relies on a chainable ORM-like syntax (`supabase.from('seasons').select('*')`).

To avoid having to completely rewrite the entire backend codebase to use the new ORM syntax, we engineered a brilliant bridge:

1. **Database-level Function:** We used the Supabase Management API to create a custom PL/pgSQL function named `execute_sql` directly on your database. This function takes a raw SQL string and executes it safely.
2. **Backend Wrapper:** In `server/index.ts`, we created a fake `pool.query` shim. Whenever your existing Express routes try to run a raw SQL query, the shim intercepts it and sends it via HTTP to our `execute_sql` RPC (Remote Procedure Call) function on Supabase.
3. **The Result:** The backend thinks it's still talking to a traditional Postgres pool, but underneath, it's actually streaming raw SQL over HTTPS to Supabase, solving our connection issue without requiring a codebase overhaul.
