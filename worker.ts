import { createGateway, createRequireAllowedUser } from './gateway/index.js'
import { handleChatRequest, handleChatHistoryRequest, handleChatHistoryDeleteRequest, type ChatConfig } from './gateway/chat.js'
import { runJamSync } from './gateway/jamSync.js'

interface Env {
  ASSETS: {
    fetch: (request: Request) => Promise<Response>;
  };
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_JWKS_URL: string;
  SUPABASE_SECRET_KEY: string;
  // Optional: Supabase Vault (see gateway/secrets.ts) is the primary source
  // for these now. Only needed as a fallback/override.
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
}

// Minimal local aliases so this file doesn't need @cloudflare/workers-types
// as a dependency just for the scheduled() export's parameter types.
type ScheduledEvent = { cron: string; scheduledTime: number };
type ExecutionContext = { waitUntil: (promise: Promise<unknown>) => void };

// Allowlist membership, cached per-isolate for a minute (mirrors the Express
// server's cache) so repeated chat calls don't hit Postgres every time.
const allowlistCache = new Map<string, { allowed: boolean; expires: number }>()

function createIsEmailAllowed(env: Env) {
  return async (email: string): Promise<boolean> => {
    const cached = allowlistCache.get(email)
    if (cached && cached.expires > Date.now()) return cached.allowed
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/allowed_users?select=email&email=eq.${encodeURIComponent(email)}`,
      { headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}` } }
    )
    const data: any = res.ok ? await res.json() : []
    const allowed = Array.isArray(data) && data.length > 0
    allowlistCache.set(email, { allowed, expires: Date.now() + 60_000 })
    return allowed
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      const gateway = createGateway({
        supabaseUrl: env.SUPABASE_URL,
        publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
        jwksUrl: env.SUPABASE_JWKS_URL,
      });

      const gatewayResponse = await gateway(request);
      if (gatewayResponse) return gatewayResponse;

      // AI chat: needs the service-role key and Gemini, so it lives outside
      // the gateway (which only ever proxies as the caller's own token).
      if (url.pathname === "/api/chat" || url.pathname === "/api/chat/history") {
        const chatConfig: ChatConfig = {
          supabaseUrl: env.SUPABASE_URL,
          publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
          jwksUrl: env.SUPABASE_JWKS_URL,
          supabaseSecretKey: env.SUPABASE_SECRET_KEY,
          geminiApiKey: env.GEMINI_API_KEY,
          geminiModel: env.GEMINI_MODEL,
          isEmailAllowed: createIsEmailAllowed(env),
        };
        if (url.pathname === "/api/chat" && request.method === "POST") {
          return handleChatRequest(chatConfig, request);
        }
        if (url.pathname === "/api/chat/history" && request.method === "GET") {
          return handleChatHistoryRequest(chatConfig, request);
        }
        if (url.pathname === "/api/chat/history" && request.method === "DELETE") {
          return handleChatHistoryDeleteRequest(chatConfig, request);
        }
      }

      // Manual "sync now" trigger for the JAM calendar importer (also runs
      // automatically once a day at 6am Eastern via the scheduled() export below).
      if (url.pathname === "/api/schedule/sync-jam" && request.method === "POST") {
        const gatewayConfig = {
          supabaseUrl: env.SUPABASE_URL,
          publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
          jwksUrl: env.SUPABASE_JWKS_URL,
        };
        const user = await createRequireAllowedUser(gatewayConfig, createIsEmailAllowed(env))(request);
        if (!user) return new Response(JSON.stringify({ error: "not authenticated" }), { status: 401, headers: { "Content-Type": "application/json" } });
        try {
          const result = await runJamSync({
            supabaseUrl: env.SUPABASE_URL,
            supabaseSecretKey: env.SUPABASE_SECRET_KEY,
          });
          return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
        } catch (err) {
          return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
      }

      const response = await env.ASSETS.fetch(request);

      if (response.status !== 404) {
        return response;
      }

      const isGatewayPath =
        url.pathname.startsWith("/api") ||
        url.pathname.startsWith("/auth") ||
        url.pathname.startsWith("/db");

      // SPA fallback: only for navigation requests. A missing hashed asset
      // (e.g. /assets/index-OLD.js after a redeploy) must 404 so the browser
      // reloads instead of executing index.html as JS (white screen).
      const isNavigation =
        !/\.[a-zA-Z0-9]+$/.test(url.pathname) ||
        (request.headers.get("Accept") ?? "").includes("text/html");

      if (!isGatewayPath && isNavigation) {
        const indexResponse = await env.ASSETS.fetch(
          new Request(new URL("/index.html", url).toString())
        );
        return new Response(indexResponse.body, {
          status: 200,
          headers: {
            ...Object.fromEntries(indexResponse.headers),
            "Cache-Control": "no-cache",
          },
        });
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error("Worker error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
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
