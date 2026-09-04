import { createGateway } from './gateway/index.js'
import { parseCookies, cookieNames } from './gateway/cookies.js'
import { verifyAccessToken } from './gateway/jwt.js'
import { createMembershipLookup } from './gateway/membership.js'
import { handleChatRequest, handleChatHistoryRequest, handleChatHistoryDeleteRequest, type ChatConfig } from './gateway/chat.js'
import { runJamSync } from './gateway/jamSync.js'
import { UfwtMcp } from './gateway/mcpAgent.js'
import { createUfwtOAuthProvider } from './gateway/mcpOAuth.js'
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'

export { UfwtMcp }

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
  // MCP server (see gateway/mcpAgent.ts + gateway/mcpOAuth.ts + "MCP server"
  // in CLAUDE.md). OAUTH_PROVIDER isn't a real wrangler.jsonc binding — it's
  // injected into `env` at request time by createUfwtOAuthProvider's
  // OAuthProvider, per that library's own convention.
  UFWT_MCP: DurableObjectNamespace;
  MCP_ORGANIZATION_ID?: string;
  OAUTH_PROVIDER: OAuthHelpers;
}

// Minimal local alias so this file doesn't need @cloudflare/workers-types.
type DurableObjectNamespace = unknown;

// Minimal local aliases so this file doesn't need @cloudflare/workers-types
// as a dependency just for the scheduled() export's parameter types.
type ScheduledEvent = { cron: string; scheduledTime: number };
type ExecutionContext = { waitUntil: (promise: Promise<unknown>) => void };

// Everything the app serves besides /mcp, /authorize, /token, and /register
// (all four owned by the OAuthProvider wrapping this — see the default
// export below and gateway/mcpOAuth.ts). Split out so mcpOAuth.ts's
// `defaultHandler` can fall through to it for every request that isn't part
// of the OAuth/MCP flow.
async function handleAppRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
        // The sync runs under the service-role key, so its authority comes
        // from the caller's memberships and nothing else: it syncs the teams
        // this user belongs to, never every team that has a calendar source.
        const token = parseCookies(request)[cookieNames(url).accessToken];
        const claims = token
          ? await verifyAccessToken(token, env.SUPABASE_JWKS_URL, env.SUPABASE_URL)
          : null;
        if (!claims || claims.isAnonymous) {
          return new Response(JSON.stringify({ error: "not authenticated" }), { status: 401, headers: { "Content-Type": "application/json" } });
        }
        const lookup = createMembershipLookup({
          supabaseUrl: env.SUPABASE_URL,
          supabaseSecretKey: env.SUPABASE_SECRET_KEY,
        });
        const teams = await lookup.teamsFor(claims.sub);
        if (teams.length === 0) {
          return new Response(JSON.stringify({ error: "not a member of any team" }), { status: 403, headers: { "Content-Type": "application/json" } });
        }
        try {
          const result = await runJamSync(
            {
              supabaseUrl: env.SUPABASE_URL,
              supabaseSecretKey: env.SUPABASE_SECRET_KEY,
            },
            { teamIds: teams.map(t => t.team_id) }
          );
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
}

// OAuthProvider owns the top-level fetch dispatch: it validates /mcp's
// access token itself (issuing 401 + OAuth discovery metadata for a client
// that isn't authenticated yet, which is what makes `claude mcp add`
// automatically pop open the /authorize login page — see gateway/mcpOAuth.ts),
// handles /token and /register internally, and falls through to
// handleAppRequest for everything else (including /authorize itself, and
// the entire rest of the app).
const oauthProvider = createUfwtOAuthProvider<Env>(
  // `agents`' McpAgent.serve() types its fetch handler against the full
  // Cloudflare-provided ExecutionContext (this file only declares the
  // minimal `waitUntil`-only shape above so it doesn't need
  // @cloudflare/workers-types as a dependency); the cast just bridges the
  // two types — the object passed in at runtime is the real one.
  UfwtMcp.serve("/mcp", { binding: "UFWT_MCP" }) as any,
  handleAppRequest,
);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return oauthProvider.fetch(request, env as any, ctx as any);
  },

  // Daily JAM Sports calendar sync at 6am Eastern (see wrangler.jsonc's triggers.crons).
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // No teamIds: the nightly job legitimately syncs every team that has
    // configured a calendar source. There is no caller here whose memberships
    // could scope it, so leave this unfiltered.
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
