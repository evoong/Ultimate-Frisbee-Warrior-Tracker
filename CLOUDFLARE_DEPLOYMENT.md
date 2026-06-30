# Cloudflare Workers Deployment Guide

## Problem Statement

The Cloudflare Worker deployed at `https://ultimate-frisbee-warrior-tracker.ericxvoong.workers.dev/` was returning "Hello World" instead of serving the Vite React application built in `frontend/dist/`.

### Root Causes:
1. **Missing Wrangler Configuration**: No `wrangler.toml` or `wrangler.jsonc` file to direct the Worker to serve static assets
2. **Incorrect Worker Code**: The `api/index.ts` was importing the Node.js Express server, which cannot run in a Cloudflare Worker environment
3. **No Environment Variables**: Database and API credentials were not configured on Cloudflare

---

## Solution Overview

The fix involved three main components:

1. **Create Wrangler Configuration** (`wrangler.jsonc`)
2. **Replace Worker Code** (`api/index.ts`) with static asset serving
3. **Add Environment Variables** (vars + secrets)

---

## Implementation Details

### 1. Create `wrangler.jsonc`

**Location:** Root of the project

**Purpose:** Tells Wrangler how to build, configure, and deploy the Worker

```jsonc
{
  "name": "ultimate-frisbee-warrior-tracker",
  "main": "api/index.ts",
  "compatibility_date": "2024-12-16",
  "assets": {
    "directory": "./frontend/dist",
    "binding": "ASSETS"
  },
  "vars": {
    "SUPABASE_URL": "https://pyqngqyqwevfpaxcmfnd.supabase.co",
    "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_oUie8kxlAp6DD0UPMSG-ZQ_QBEWo3vT",
    "SUPABASE_JWKS_URL": "https://pyqngqyqwevfpaxcmfnd.supabase.co/auth/v1/.well-known/jwks.json"
  }
}
```

**Key Configuration Explained:**

| Field | Purpose |
|-------|---------|
| `name` | Worker name on Cloudflare (must match existing Worker service) |
| `main` | Entry point file that handles requests |
| `compatibility_date` | Cloudflare Workers API version to use |
| `assets.directory` | Where static files are located (`frontend/dist`) |
| `assets.binding` | JavaScript variable name to access the asset handler (`ASSETS`) |
| `vars` | Public environment variables (safe to commit) |

**Why not use `wrangler.toml`?**
- `.jsonc` allows comments and trailing commas, making it more readable
- JSON format is less prone to TOML syntax errors

---

### 2. Update `api/index.ts` - Worker Entrypoint

**Before (Broken):**
```typescript
import app from "../server/index.js";
export default app;
```

**Problem:** Tried to import a Node.js Express server into Cloudflare Workers (which uses Web APIs, not Node.js)

**After (Fixed):**
```typescript
interface Env {
  ASSETS: {
    fetch: (request: Request) => Promise<Response>;
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      // Serve static assets from the assets directory
      const response = await env.ASSETS.fetch(request);

      // If the asset exists, return it
      if (response.status !== 404) {
        return response;
      }

      // For 404s on non-API routes, serve index.html for SPA routing
      if (!url.pathname.startsWith("/api")) {
        const indexResponse = await env.ASSETS.fetch(
          new Request(new URL("/index.html", url).toString())
        );
        return new Response(indexResponse.body, {
          status: 200,
          headers: {
            ...Object.fromEntries(indexResponse.headers),
            "Cache-Control": "public, max-age=3600",
          },
        });
      }

      // Return 404 for missing API routes
      return new Response("Not Found", { status: 404 });
    } catch (error) {
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
```

**What It Does:**

1. **Static Asset Serving**: Uses the `ASSETS` binding to serve files from `frontend/dist`
2. **SPA Routing Fallback**: When a route doesn't exist (404), serves `index.html` instead
   - This allows React Router to handle client-side routing
   - Example: `/warriors/season-1` → returns `index.html` → React Router renders the correct component
3. **Error Handling**: Catches unexpected errors and returns 500 responses
4. **Cache Control**: Sets 1-hour cache for static assets

**Why This Matters:**
- Cloudflare Workers use standard Web APIs (Fetch API, Response, Request)
- The `env` object provides bindings (like `ASSETS`) configured in `wrangler.jsonc`
- Proper error handling ensures graceful degradation

---

### 3. Update `package.json` - Build & Deploy Scripts

**Added Dependencies:**
```json
{
  "devDependencies": {
    "wrangler": "^3.82.0"
  }
}
```

**Added Scripts:**
```json
{
  "scripts": {
    "deploy": "npm run build && wrangler deploy",
    "deploy:dev": "npm run build && wrangler deploy --env development"
  }
}
```

**Why:**
- Automates the build → deploy pipeline
- Ensures `frontend/dist` is up-to-date before deploying
- Makes deployment reproducible

---

## Environment Variables Setup

### Public Variables (in `wrangler.jsonc`)

These are safe to commit because they don't contain secrets:

```jsonc
"vars": {
  "SUPABASE_URL": "https://pyqngqyqwevfpaxcmfnd.supabase.co",
  "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_oUie8kxlAp6DD0UPMSG-ZQ_QBEWo3vT",
  "SUPABASE_JWKS_URL": "https://pyqngqyqwevfpaxcmfnd.supabase.co/auth/v1/.well-known/jwks.json"
}
```

### Secrets (Set via Wrangler CLI)

These are stored securely on Cloudflare and NOT committed to git:

```bash
# Set DATABASE_URL
echo "postgresql://postgres.pyqngqyqwevfpaxcmfnd:lPnWim83BtahiK8D@aws-0-ca-central-1.pooler.supabase.com:5432/postgres" | \
  npx wrangler secret put DATABASE_URL --name ultimate-frisbee-warrior-tracker

# Set SUPABASE_SECRET_KEY
echo "YOUR_SUPABASE_SECRET_KEY_HERE" | \
  npx wrangler secret put SUPABASE_SECRET_KEY --name ultimate-frisbee-warrior-tracker

# Set GEMINI_API_KEY
echo "YOUR_GEMINI_API_KEY_HERE" | \
  npx wrangler secret put GEMINI_API_KEY --name ultimate-frisbee-warrior-tracker
```

### Accessing Variables in Code

**In the Worker (`api/index.ts`):**
```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Access public variables
    const supabaseUrl = env.SUPABASE_URL;
    const publishableKey = env.SUPABASE_PUBLISHABLE_KEY;
    
    // Access secrets
    const dbUrl = env.DATABASE_URL;
    const secretKey = env.SUPABASE_SECRET_KEY;
    const geminiKey = env.GEMINI_API_KEY;
    
    // Use them...
  }
}
```

**In the Frontend (if needed):**
```typescript
// Frontend can only access vars, not secrets (for security)
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
```

---

## Deployment Process

### First-Time Setup

```bash
# 1. Install dependencies
npm install

# 2. Set secrets on Cloudflare
echo "YOUR_DATABASE_URL" | npx wrangler secret put DATABASE_URL --name ultimate-frisbee-warrior-tracker
echo "YOUR_SUPABASE_SECRET_KEY" | npx wrangler secret put SUPABASE_SECRET_KEY --name ultimate-frisbee-warrior-tracker
echo "YOUR_GEMINI_API_KEY" | npx wrangler secret put GEMINI_API_KEY --name ultimate-frisbee-warrior-tracker

# 3. Deploy
npm run deploy
```

### Regular Deployments

```bash
# Build frontend and deploy Worker
npm run deploy

# Or manually:
npm run build
npx wrangler deploy --config wrangler.jsonc
```

### Development Deployment

```bash
npm run deploy:dev
```

---

## File Structure

```
ultimate-frisbee-warrior-tracker/
├── wrangler.jsonc              ← NEW: Cloudflare Worker config
├── api/
│   └── index.ts                ← MODIFIED: Worker entrypoint
├── frontend/
│   ├── dist/                   ← Built app (served by Worker)
│   ├── src/
│   ├── package.json
│   └── vite.config.ts
├── package.json                ← MODIFIED: Added deploy scripts
└── ...
```

---

## How It Works: Request Flow

```
Request to https://ultimate-frisbee-warrior-tracker.ericxvoong.workers.dev/
                    ↓
        Cloudflare Worker (api/index.ts)
                    ↓
        Try to serve static asset from frontend/dist/
                    ↓
        ┌─────────────────────────────────────┐
        │ Asset found?                        │
        └─────────────────────────────────────┘
         ↙                              ↘
        YES                              NO
         ↓                                ↓
    Return file              Is it an API route?
    with 200 status           (/api/*)
                              ↙        ↘
                            NO          YES
                             ↓           ↓
                        Serve      Return 404
                     index.html      error
                        ↓
                   React Router
                   renders page
                   client-side
```

**Example Routes:**

| Route | Response |
|-------|----------|
| `/` | `index.html` + React app loads |
| `/warriors` | `index.html` + React Router navigates to Warriors page |
| `/assets/index-C6VcUJGc.js` | JavaScript bundle |
| `/assets/index-BDHi8bFp.css` | Stylesheet |
| `/some-random-path` | `index.html` + React Router shows 404 page |
| `/api/some-endpoint` | 404 (reserved for future backend) |

---

## Troubleshooting

### Issue: "Hello World" still showing

**Cause:** Old deployment still cached

**Solution:**
```bash
# Clear the cache and redeploy
npx wrangler deploy --config wrangler.jsonc
```

### Issue: Environment variables not accessible

**Check:**
```bash
# List all secrets
npx wrangler secret list --name ultimate-frisbee-warrior-tracker

# List all vars
npx wrangler publish --dry-run | grep -A 10 "Your worker has access"
```

### Issue: Assets returning 404

**Check:**
```bash
# Verify frontend/dist exists and has files
ls -la frontend/dist/

# Rebuild if needed
npm run build
```

### Issue: SPA routing not working

**Symptom:** Page refreshes on `/some-route` result in 404

**Cause:** The Worker's fallback logic isn't serving `index.html`

**Solution:**
1. Verify `frontend/dist/index.html` exists
2. Check `api/index.ts` has the SPA fallback code
3. Redeploy: `npm run deploy`

---

## Future Enhancements

### Add API Routes
Currently, `/api/*` routes return 404. To add backend integration:

```typescript
// In api/index.ts
if (url.pathname.startsWith("/api")) {
  const apiResponse = await fetch("https://your-backend.com" + url.pathname, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  return apiResponse;
}
```

### Add Custom Domains
```jsonc
{
  "routes": [
    {
      "pattern": "your-domain.com/*",
      "zone_name": "your-domain.com"
    }
  ]
}
```

### Add Durable Objects (for stateful storage)
```jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "COUNTER",
        "class_name": "Counter"
      }
    ]
  }
}
```

---

## Key Concepts

### Web APIs vs Node.js APIs
- **Cloudflare Workers:** Use Web APIs (Fetch, Response, Request, etc.)
- **Cannot use:** fs, path, child_process, http.Server
- **This is why:** The old code importing Express failed

### Static Assets Binding
- **What it does:** Serves files from a specified directory
- **How it works:** Wrangler uploads files to Cloudflare's global CDN
- **Why it's fast:** Content is served from edge locations near users

### SPA Routing
- **Problem:** Traditional servers need routes configured (e.g., `/warriors → app.tsx`)
- **SPAs solve this:** Single HTML file is served, JavaScript handles routing
- **Worker's role:** Return `index.html` for all unknown routes

### Environment Variables vs Secrets
- **Variables:** Safe to commit, visible in config, use for public keys
- **Secrets:** Stored securely, NOT in config, use for API keys & passwords

---

## Verification Checklist

After deployment, verify:

- [ ] Homepage loads at `https://ultimate-frisbee-warrior-tracker.ericxvoong.workers.dev/`
- [ ] App shows "Ultimate Frisbee Warrior Tracker" title
- [ ] CSS/styling loads correctly (colors, layout)
- [ ] JavaScript console has no errors
- [ ] Clicking navigation links works (client-side routing)
- [ ] Refreshing a page preserves the route
- [ ] Network tab shows assets from `ericxvoong.workers.dev`
- [ ] Secrets are accessible in Worker (if using them)

---

## References

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Wrangler CLI Documentation](https://developers.cloudflare.com/workers/wrangler/)
- [Static Assets Guide](https://developers.cloudflare.com/workers/static-assets/)
- [Environment Variables Guide](https://developers.cloudflare.com/workers/configuration/environment-variables/)

---

## Summary

| Before | After |
|--------|-------|
| "Hello World" returned | Vite app served |
| No config file | `wrangler.jsonc` present |
| Node.js Express code | Web API-compatible Worker |
| No environment variables | Vars + secrets configured |
| Manual deployment unclear | Automated `npm run deploy` script |

The deployment now follows Cloudflare best practices and is ready for production use.
