import "./instrument.js";
import express from "express";
import type { Request as ExpressRequest, Response as ExpressResponse, NextFunction } from "express";
import * as Sentry from "@sentry/node";
import { createClient } from "@supabase/supabase-js";
import multer from "multer";
import path from "path";
import fs from "fs";
import { PostHog } from "posthog-node";
import { createGateway } from "../gateway/index.js";
import { nodeAdapter } from "../gateway/node-adapter.js";
import { createAdminLookup } from "../gateway/admin/adminAuth.js";
import { handleAdminRequest, isAdminPath } from "../gateway/admin/index.js";
import { handleFlagsRequest } from "../gateway/flags.js";
import { createNodeAdapter } from "../gateway/node-adapter.js";
import { getVaultSecret } from "../gateway/secrets.js";
import { runJamSync, JAM_SYNC_MONITOR_SLUG, JAM_SYNC_MONITOR_CONFIG } from "../gateway/jamSync.js";
import { runChatAgent } from "../gateway/agent/agent.js";
import { makeChatTools } from "../gateway/agent/tools.js";
import { callChatFunction, type ActionsConfig } from "../gateway/gameActions.js";
import { getTeamContext as buildTeamContext, type ChatScope } from "../gateway/agent/context.js";
import { createMembershipLookup, hasAtLeast, type TeamRole } from "../gateway/membership.js";
import { isValidSessionId } from "../gateway/sessionId.js";
import { parseCookies, cookieNames } from "../gateway/cookies.js";
import { verifyAccessToken } from "../gateway/jwt.js";
import { decideEscalation, DISPATCH_THRESHOLD, CONFLICT_MARGIN, type TriageOutcome, type VariantTally } from "../gateway/feedbackTriage.js";
import { insertReport, listOpenClusters, attachReportToCluster, createCluster, tallyFor, setClusterStatus } from "../gateway/feedbackStore.js";
import { judgeReport } from "../gateway/feedbackJudge.js";
import { sbGet } from "../gateway/supabaseRest.js";
import { track, trackError, shutdown } from "./lib/posthog.js";
import { consumeAiMessage, refundAiMessage, getOrgEffectiveTier, gameDateWithinFreeWindow } from "./lib/tierLimits.js";
import { createCheckoutSession, createPortalSession, canStartTrial, verifyWebhook, processWebhook } from "./lib/billing.js";

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;

// Vercel/Cloudflare sit in front of this server; x-forwarded-proto decides
// whether cookies get the __Host-/Secure treatment.
app.set("trust proxy", 1);

const gatewayConfig = {
  supabaseUrl: process.env.SUPABASE_URL || "",
  publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || "",
  jwksUrl:
    process.env.SUPABASE_JWKS_URL ||
    `${process.env.SUPABASE_URL || ""}/auth/v1/.well-known/jwks.json`,
};

// Auth gateway (/auth/* + /db/*) mounts before any body parser so /db
// request bodies stream through to Supabase untouched. No CORS middleware:
// everything is same-origin (Vite proxy in dev, single host in prod).
app.use(nodeAdapter(createGateway(gatewayConfig)));

// Admin console, mounted before express.json() so the handler reads its own
// request body from the web Request it is handed. Module-scoped lookup for the
// same documented reason as `membership` below: Express has no per-request
// isolate boundary, so a module-scoped cache is bounded by distinct users
// rather than by request volume, with staleness capped by the 30s TTL.
const adminLookup = createAdminLookup({
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseSecretKey: process.env.SUPABASE_SECRET_KEY,
  onLookupError: (err) => Sentry.captureException(err),
});
app.use(
  createNodeAdapter(
    (request) =>
      handleAdminRequest(
        {
          supabaseUrl: process.env.SUPABASE_URL,
          supabaseSecretKey: process.env.SUPABASE_SECRET_KEY,
          jwksUrl: process.env.SUPABASE_JWKS_URL,
        },
        request,
        adminLookup
      ),
    isAdminPath
  )
);
app.use(
  createNodeAdapter(
    (request) => handleFlagsRequest(
      {
        supabaseUrl: gatewayConfig.supabaseUrl,
        supabaseSecretKey: process.env.SUPABASE_SECRET_KEY || "",
        jwksUrl: gatewayConfig.jwksUrl,
      },
      request
    ),
    (path) => path === "/api/flags"
  )
);

// Stripe webhook MUST be before express.json() to receive raw body for signature verification
app.post(
  "/api/billing/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;
    try {
      event = verifyWebhook(req.body, req.headers["stripe-signature"] as string | undefined);
    } catch (err) {
      // Unsigned/invalid request: reject, never grant anything (spec §4.4).
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
    try {
      const outcome = await processWebhook(event);
      return res.json({ received: true, outcome });
    } catch (err) {
      // Processing failure: 500 so Stripe retries; idempotency guard makes
      // the retry safe.
      Sentry.captureException(err);
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

app.use(express.json());

// Vercel serverless filesystem is read-only except /tmp; use /tmp/uploads there
const uploadsDir = process.env.VERCEL
  ? path.join("/tmp", "uploads")
  : path.join(process.cwd(), "uploads");
try {
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
} catch (_) { /* ignore if read-only */ }
app.use("/uploads", express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, `player-${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SECRET_KEY || ""
);

// Dedicated client for AI Observability — @posthog/ai's Gemini wrapper needs
// a raw PostHog instance to attach $ai_generation/$ai_span events to.
// flushAt/flushInterval kept low since /api/chat can run as a short-lived
// Vercel function.
const posthogAi = new PostHog(process.env.POSTHOG_PROJECT_TOKEN!, {
  host: process.env.POSTHOG_HOST,
  flushAt: 1,
  flushInterval: 0,
});

// ── Auth guard for chat routes ───────────────────────────────────────────────
// The chat endpoints below query Supabase with the SERVICE ROLE, which
// bypasses RLS — so they must enforce auth themselves: JWKS-verified access
// token from the httpOnly cookie + real membership lookups (cached 30s by
// gateway/membership.ts, not by anything in this file).
//
// This is a module-scoped lookup, not a per-request one. Per Task 2's
// gateway/membership.ts, the Worker builds a fresh lookup inside the
// per-request handler because a Worker isolate is long-lived and a chat
// turn is exactly one request there, so per-request scoping costs nothing
// and avoids any cross-request staleness. This Express process has no such
// per-request boundary — classifyChatCaller calls the lookup directly from
// route handlers — so the cache
// here is bounded by the number of distinct users rather than by request
// volume, and staleness across requests is capped at the lookup's 30s TTL,
// which the design's Global Constraint explicitly permits ("cached for at
// most 30 seconds. A revoked role must take effect promptly").
const membership = createMembershipLookup({
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseSecretKey: process.env.SUPABASE_SECRET_KEY || "",
  onLookupError: (err) => Sentry.captureException(err),
});

// "Allowed" means "belongs to at least one organization" (allowed_users
// was fully replaced by organization_members, then team_members, per Plan
// 1). PostgREST cannot express "team_members joined to auth.users by
// email" as a single subquery, so resolve the user id first via the GoTrue
// admin API, then check membership by id.

// True only when the user is a member of this specific organization/team.

// Mirrors the Worker's requireTeamMember (gateway/chat.ts): 401 means
// "authenticate", 403 means "authenticated, but not on this team". A guest
// holds a real, verified anonymous JWT, so it is the second case.
// A guard that returns a bare null cannot express that distinction, which is
// how an unauthenticated caller and a rejected member came to look identical.
// So the chat routes classify the caller themselves.
type ChatCaller =
  | { ok: true; sub: string; role: TeamRole }
  | { ok: false; status: 401 | 403; error: string }

async function classifyChatCaller(webRequest: Request, organizationId: number): Promise<ChatCaller> {
  const url = new URL(webRequest.url)
  const token = parseCookies(webRequest)[cookieNames(url).accessToken]
  if (!token) return { ok: false, status: 401, error: "not authenticated" }
  const claims = await verifyAccessToken(token, gatewayConfig.jwksUrl, gatewayConfig.supabaseUrl)
  if (!claims) return { ok: false, status: 401, error: "not authenticated" }
  if (claims.isAnonymous) return { ok: false, status: 403, error: "not a member of this team" }
  const role = await membership.roleFor(claims.sub, organizationId)
  if (!hasAtLeast(role, "member")) {
    return { ok: false, status: 403, error: "not a member of this team" }
  }
  return { ok: true, sub: claims.sub, role: role as TeamRole }
}


// ── Stripe Billing Routes ─────────────────────────────────────────────────────
app.post("/api/billing/create-portal-session", async (req, res) => {
  try {
    const organizationId = Number(req.body?.organization_id);
    if (!Number.isSafeInteger(organizationId) || organizationId <= 0) {
      return res.status(400).json({ error: "Invalid organization_id" });
    }
    const webRequest = new Request(`${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`, {
      headers: { cookie: req.headers.cookie ?? "" },
    });
    const caller = await classifyChatCaller(webRequest, organizationId);
    if (!caller.ok) return res.status(caller.status).json({ error: caller.error });
    if (!hasAtLeast(caller.role, "captain")) {
      return res.status(403).json({ error: "Only team captains or admins can manage billing" });
    }
    const { url } = await createPortalSession(organizationId);
    await track(caller.sub, "portal_opened", { organization_id: organizationId });
    return res.json({ url });
  } catch (err: unknown) {
    Sentry.captureException(err);
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
app.post("/api/billing/create-checkout-session", async (req, res) => {
  try {
    const organizationId = Number(req.body?.organization_id);
    const tier = req.body?.tier;
    const interval = req.body?.interval;
    const isTrial = req.body?.is_trial === true;
    const prices = {
      plus: { month: process.env.STRIPE_PRICE_PLUS_MONTHLY, year: process.env.STRIPE_PRICE_PLUS_YEARLY },
      premium: { month: process.env.STRIPE_PRICE_PREMIUM_MONTHLY, year: process.env.STRIPE_PRICE_PREMIUM_YEARLY },
    };
    if (!Number.isSafeInteger(organizationId) || organizationId <= 0 ||
      (tier !== "plus" && tier !== "premium") || (interval !== "month" && interval !== "year") ||
      typeof req.body?.is_trial !== "boolean" || (isTrial && tier !== "premium")) {
      return res.status(400).json({ error: "Invalid billing selection" });
    }
    const priceId = prices[tier as 'plus' | 'premium'][interval as 'month' | 'year'];
    if (!priceId) return res.status(503).json({ error: "Billing price not configured" });

    const webRequest = new Request(`${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`, {
      headers: { cookie: req.headers.cookie ?? "" },
    });
    const caller = await classifyChatCaller(webRequest, organizationId);
    if (!caller.ok) return res.status(caller.status).json({ error: caller.error });
    if (!hasAtLeast(caller.role, "captain")) {
      return res.status(403).json({ error: "Only team captains or admins can change subscription" });
    }

    if (isTrial) {
      if (!await canStartTrial(organizationId)) {
        return res.status(400).json({ error: "Trial already used for this organization" });
      }
    }

    const { url } = await createCheckoutSession(organizationId, priceId, isTrial);
    await track(caller.sub, "checkout_started", { organization_id: organizationId, price_id: priceId, is_trial: isTrial });
    return res.json({ url });
  } catch (err: unknown) {
    Sentry.captureException(err);
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── AI Chat ───────────────────────────────────────────────────────────────────

// Supabase Vault (see gateway/secrets.ts) is the primary source for these,
// so they only need to be configured in one place instead of separately
// across Vercel, Cloudflare, and local .env. GEMINI_API_KEY/GEMINI_MODEL env
// vars still work as a fallback/override, e.g. before Vault is populated.
const vaultConfig = {
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseSecretKey: process.env.SUPABASE_SECRET_KEY || "",
};

// Switched from gemma-4-31b-it: side-by-side timing showed gemini-flash-lite
// averaging ~0.6s per reply vs gemma's ~20s+ (and occasional transient 500s).
const DEFAULT_GEMINI_MODEL = "gemini-flash-lite-latest";

// Kept exported for server/test/freeTierHistory.test.mjs, which imports it
// off this module; thin wrapper so the signature matches the old local one.
export function getTeamContext(organizationId: number, scope?: ChatScope) {
  return buildTeamContext(
    { supabaseUrl: process.env.SUPABASE_URL || "", supabaseSecretKey: process.env.SUPABASE_SECRET_KEY || "" },
    organizationId,
    scope
  );
}

app.post("/api/chat", async (req, res) => {
  const startedAt = Date.now();
  let usedToolCall = false;
  let distinctId = "unknown";
  let quotaOrgId: number | null = null;
  let quotaConsumed = false;
  try {
    const { message, session_id, history = [], organization_id } = req.body as {
      message: string; session_id: string; history: { role: string; content: string }[]; organization_id: number
    };
    if (!message || !session_id) return res.status(400).json({ error: "message and session_id required" });
    if (!organization_id) return res.status(400).json({ error: "organization_id required" });
    if (!isValidSessionId(session_id)) return res.status(400).json({ error: "session_id must be a UUID" });

    const webRequest = new Request(`${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`, {
      headers: { cookie: req.headers.cookie ?? "" },
    });
    const teamId = Number(organization_id);
    const caller = await classifyChatCaller(webRequest, teamId);
    if (!caller.ok) return res.status(caller.status).json({ error: caller.error });
    distinctId = caller.sub;

    // From here on only teamId is used. The raw body value never reaches a
    // query again, matching the same invariant in gateway/chat.ts.

    // Player scope (spec: captain/editor = full team; member with an
    // approved link = their player only; member unlinked = full team).
    // playerLinkFor throws on outage so a broken lookup can never widen
    // the context (Task 3).
    let scope: ChatScope | undefined;
    if (caller.role === "member") {
      const linkedId = await membership.playerLinkFor(caller.sub, teamId);
      if (linkedId != null) {
        const { data: linkedPlayer } = await supabase
          .from("players")
          .select("display_name")
          .eq("id", linkedId)
          .limit(1)
          .single();
        if (linkedPlayer?.display_name) scope = { playerId: linkedId, playerName: linkedPlayer.display_name };
      }
    }

    const systemContext = await getTeamContext(teamId, scope);
    const geminiApiKey = await getVaultSecret(vaultConfig, "gemini_api_key", process.env.GEMINI_API_KEY);
    const geminiModel = (await getVaultSecret(vaultConfig, "gemini_model", process.env.GEMINI_MODEL)) ?? DEFAULT_GEMINI_MODEL;
    if (!geminiApiKey) return res.status(500).json({ error: "Gemini API key not configured" });
    const actionsConfig: ActionsConfig = { supabaseUrl: process.env.SUPABASE_URL || "", supabaseSecretKey: process.env.SUPABASE_SECRET_KEY || "" };

    if (!await consumeAiMessage(teamId)) {
      return res.status(429).json({ error: "Monthly AI chat limit reached for this team's plan. Upgrade to increase limits." });
    }
    quotaOrgId = teamId;
    quotaConsumed = true;

    const aiTraceId = crypto.randomUUID();
    const tools = makeChatTools({
      dispatch: (name, args) => callChatFunction(actionsConfig, teamId, name, args, scope),
      role: caller.role,
      onSpan: (name, args, result, latencyMs) => {
        usedToolCall = true;
        posthogAi.capture({
          distinctId,
          event: "$ai_span",
          properties: {
            $ai_trace_id: aiTraceId,
            $ai_session_id: session_id,
            $ai_span_id: crypto.randomUUID(),
            $ai_span_name: name,
            $ai_input_state: args,
            $ai_output_state: result.error ? { error: result.error } : result.output,
            $ai_latency: latencyMs / 1000,
          },
        });
      },
    });
    const agentStart = Date.now();
    const reply = await runChatAgent({
      apiKey: geminiApiKey,
      model: geminiModel,
      systemPrompt: systemContext,
      history,
      message,
      tools,
      langSmith: process.env.LANGSMITH_API_KEY
        ? { apiKey: process.env.LANGSMITH_API_KEY, project: process.env.LANGSMITH_PROJECT ?? "ufwt-chat" }
        : undefined,
    });
    posthogAi.capture({
      distinctId,
      event: "$ai_generation",
      properties: {
        $ai_trace_id: aiTraceId,
        $ai_session_id: session_id,
        $ai_model: geminiModel,
        $ai_latency: (Date.now() - agentStart) / 1000,
        $ai_output: reply,
        $ai_org_id: teamId,
      },
    });
    await posthogAi.flush();

    // Save both turns to chat_logs
    const { error: chatLogError } = await supabase.from("chat_logs").insert([
      { session_id, role: "user", content: message, organization_id: teamId, user_id: caller.sub },
      { session_id, role: "assistant", content: reply, organization_id: teamId, user_id: caller.sub },
    ]);
    if (chatLogError) throw chatLogError;

    await track(distinctId, "chat_message_sent", {
      organization_id,
      session_id,
      model: geminiModel,
      duration_ms: Date.now() - startedAt,
      used_tool_call: usedToolCall,
    });
    quotaConsumed = false;
    res.json({ reply });
  } catch (err: unknown) {
    if (quotaConsumed && quotaOrgId != null) {
      quotaConsumed = false;
      try {
        await refundAiMessage(quotaOrgId);
      } catch (refundError) {
        Sentry.captureException(refundError);
      }
    }
    await posthogAi.flush();
    await trackError(distinctId, err);
    Sentry.captureException(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/chat/history", async (req, res) => {
  try {
    const { session_id, organization_id } = req.query as { session_id: string; organization_id: string };
    if (!session_id) return res.status(400).json({ error: "session_id required" });
    if (!organization_id) return res.status(400).json({ error: "organization_id required" });
    if (!isValidSessionId(session_id)) return res.status(400).json({ error: "session_id must be a UUID" });

    const webRequest = new Request(`${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`, {
      headers: { cookie: req.headers.cookie ?? "" },
    });
    const teamId = Number(organization_id);
    const caller = await classifyChatCaller(webRequest, teamId);
    if (!caller.ok) return res.status(caller.status).json({ error: caller.error });

    const { data, error } = await supabase
      .from("chat_logs")
      .select("role, content, created_at")
      .eq("session_id", session_id)
      .eq("organization_id", teamId)
      .eq("user_id", caller.sub)
      .order("created_at", { ascending: true });

    if (error) throw error;
    res.json(data ?? []);
  } catch (err: unknown) {
    Sentry.captureException(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/chat/history", async (req, res) => {
  let distinctId = "unknown";
  try {
    const { session_id, organization_id } = req.query as { session_id: string; organization_id: string };
    if (!session_id) return res.status(400).json({ error: "session_id required" });
    if (!organization_id) return res.status(400).json({ error: "organization_id required" });
    if (!isValidSessionId(session_id)) return res.status(400).json({ error: "session_id must be a UUID" });

    const webRequest = new Request(`${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`, {
      headers: { cookie: req.headers.cookie ?? "" },
    });
    const teamId = Number(organization_id);
    const caller = await classifyChatCaller(webRequest, teamId);
    if (!caller.ok) return res.status(caller.status).json({ error: caller.error });
    distinctId = caller.sub;

    const { error } = await supabase.from("chat_logs").delete().eq("session_id", session_id).eq("organization_id", teamId).eq("user_id", caller.sub);
    if (error) throw error;
    await track(distinctId, "chat_history_cleared", { organization_id, session_id });
    res.json({ ok: true });
  } catch (err: unknown) {
    await trackError(distinctId, err);
    Sentry.captureException(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Calendar sync ─────────────────────────────────────────────────────────────
// Imports games from every enabled calendar_sources row (see gateway/jamSync.ts
// and supabase-migrations/005_calendar_sources.sql). Runs automatically:
// - Vercel: daily at 6am Eastern via the "crons" entry in vercel.json hitting
//   GET /api/cron/sync-jam, authenticated by Vercel's own CRON_SECRET
//   convention (a plain env var Vercel attaches as a bearer token; not
//   Vault, since Vault doesn't have anything to do with Vercel's own cron
//   auth mechanism).
// - Cloudflare Workers: daily at 6am Eastern via worker.ts's scheduled() export, which
//   calls runJamSync() in-process and never goes over this HTTP surface.
// Also exposed as a manual "sync now" trigger for allowlisted users.

function jamSyncConfig() {
  return {
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseSecretKey: process.env.SUPABASE_SECRET_KEY || "",
  };
}

// Scoped to the caller's own teams, matching worker.ts's copy of this route.
// The sync runs under the service-role key, so its authority comes from the
// caller's memberships and nothing else. This route previously asserted only
// "is a member of some team", which let any member trigger a sync across every
// team and read back per-source counts and errors naming other teams'
// organizers.
app.post("/api/schedule/sync-jam", async (req, res) => {
  let distinctId = "unknown";
  try {
    const proto = req.protocol;
    const host = req.get("host") ?? "localhost";
    const webRequest = new Request(`${proto}://${host}${req.originalUrl}`, {
      headers: { cookie: req.headers.cookie ?? "" },
    });
    const url = new URL(webRequest.url);
    const token = parseCookies(webRequest)[cookieNames(url).accessToken];
    const claims = token
      ? await verifyAccessToken(token, gatewayConfig.jwksUrl, gatewayConfig.supabaseUrl)
      : null;
    if (!claims) return res.status(401).json({ error: "not authenticated" });
    // A guest holds a real, verified anonymous JWT: authenticated, not
    // permitted. Same split the chat routes use in both runtimes.
    if (claims.isAnonymous) {
      return res.status(403).json({ error: "not a member of any team" });
    }
    // PostHog identity comes from the token this route already verified;
    // requireAllowedUser is gone and is not needed to resolve it.
    distinctId = claims.sub;
    const teams = await membership.teamsFor(claims.sub);
    if (teams.length === 0) {
      return res.status(403).json({ error: "not a member of any team" });
    }
    const result = await runJamSync(jamSyncConfig(), { teamIds: teams.map(t => t.team_id) });
    await track(distinctId, "jam_sync_triggered", {});
    res.json(result);
  } catch (err: unknown) {
    await trackError(distinctId, err);
    Sentry.captureException(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Feedback ─────────────────────────────────────────────────────────────────

const FEEDBACK_LABELS: Record<"bug" | "feature", string> = {
  bug: "bug",
  feature: "enhancement",
};

// Memory storage, not the disk-based `upload` above: this file never needs
// to be served from our own origin, only re-uploaded to Supabase Storage,
// and Vercel's /tmp doesn't survive past the request anyway.
// An explicit allowlist, not `startsWith("image/")` -- that would also
// accept image/svg+xml, which can embed script content. Confined to the
// Supabase storage origin either way (not this app's), but excluding it
// costs nothing.
const FEEDBACK_ATTACHMENT_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const feedbackUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (FEEDBACK_ATTACHMENT_MIME_TYPES.has(file.mimetype)) cb(null, true);
    else cb(new Error("Only PNG, JPEG, WebP, or GIF images are allowed"));
  },
});

// A signed URL, not a public one: feedback-attachments is a private bucket
// (see its migration), so this is the only way the screenshot embedded in
// the GitHub issue body is ever fetchable -- GitHub's own servers render
// that markdown with no session of ours to authenticate with. Expiry is
// long (5 years) because there's no later moment to refresh this URL from;
// once the issue is filed, this is the only copy of the link that will
// ever exist.
const FEEDBACK_ATTACHMENT_URL_TTL_SECONDS = 60 * 60 * 24 * 365 * 5;

// Only an established team member's report can escalate anything. Guests
// are already rejected with a 403 earlier in the /api/feedback handler
// (claims.isAnonymous), so this function is never reached for them -- its
// real job is excluding signed-in users who belong to no team, since three
// throwaway accounts on zero teams must not be able to dispatch an agent at
// production code. See the spec's "Abuse surface" section.
async function reportCountsTowardThreshold(userId: string): Promise<boolean> {
  try {
    const teams = await membership.teamsFor(userId);
    return teams.length > 0;
  } catch (err) {
    // Fail closed (a legitimate report just won't count toward escalation
    // this time), but don't fail silently -- without this, a transient
    // membership-lookup failure is invisible forever.
    Sentry.captureException(err);
    return false;
  }
}

async function createGithubIssue(token: string, repo: string, issue: {
  title: string; body: string; labels: string[];
}): Promise<{ number: number; html_url: string }> {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(issue),
  });
  if (!res.ok) throw new Error(`GitHub issue creation failed (${res.status}): ${await res.text().catch(() => "")}`);
  return res.json();
}

async function addGithubComment(token: string, repo: string, issueNumber: number, body: string): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`GitHub comment failed (${res.status}): ${await res.text().catch(() => "")}`);
}

// The spec requires the issue body to carry a live tally, not just a trail of
// comments -- "how many people hit this" must be readable at a glance from
// the issue itself. The line is delimited so it can be rewritten in place on
// every new report rather than appended to.
const TALLY_START = "<!-- triage-tally -->";
const TALLY_END = "<!-- /triage-tally -->";

// A description containing either marker verbatim would make the
// tally-rewrite regex in updateIssueTally match from the user's injected
// marker through to the real one, silently corrupting the issue body on the
// next rewrite. Strip both markers from any user-submitted text before it
// flows into an issue body or comment -- not a security issue, a
// content-integrity one.
function stripTallyMarkers(text: string): string {
  return text.split(TALLY_START).join("").split(TALLY_END).join("");
}

async function updateIssueTally(
  token: string,
  repo: string,
  issueNumber: number,
  tally: VariantTally[]
): Promise<void> {
  const total = tally.reduce((sum, t) => sum + t.reporters, 0);
  const perVariant = tally
    .filter(t => t.label !== null)
    .map(t => `\n  - \`${t.label}\`: ${t.reporters}`)
    .join("");
  const block = `${TALLY_START}\n**Distinct reporters: ${total}**${perVariant}\n${TALLY_END}`;

  const current = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!current.ok) return;
  const body: string = (await current.json()).body ?? "";
  const next = body.includes(TALLY_START)
    ? body.replace(new RegExp(`${TALLY_START}[\\s\\S]*?${TALLY_END}`), block)
    : `${body}\n\n${block}`;

  await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body: next }),
  });
}

async function addGithubLabel(token: string, repo: string, issueNumber: number, label: string): Promise<void> {
  await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/labels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ labels: [label] }),
  });
}

// Translates a TriageOutcome into cluster status, GitHub labels, and (for a
// bug clearing the threshold) the repository_dispatch that starts an agent
// (see dispatchAgent below, and .github/workflows/feedback-agent.yml).
//
// `currentStatus` is the idempotency guard. decideEscalation is a pure
// function of (type, tallies) with no status awareness -- by design, it
// stays that way -- so it recomputes the same non-hold outcome for every
// subsequent report once a cluster has crossed a threshold (e.g. a bug
// already at 3 reporters still evaluates to `dispatch` at 4, 5, 6...).
// Without this guard, applyOutcome would re-run its side effects (comment,
// label, dispatch/repository_dispatch) on every single one of those later
// reports: a dispatched bug cluster would fire ANOTHER agent run and
// another auto-merging PR attempt per new reporter, and a feature cluster
// sitting in awaiting_approval or decision_needed would get a duplicate
// "please approve" / "pick a variant" comment each time. Only a cluster
// still `open` should have this outcome's side effects applied -- once it
// has moved to any other status (awaiting_approval, decision_needed,
// dispatched, implemented), the escalation action for this cycle has
// already happened and must not fire again. New reporters are still
// recorded and tallied by the caller regardless; only the side-effecting
// action here is suppressed.
async function applyOutcome(
  config: ActionsConfig,
  githubToken: string,
  repo: string,
  clusterId: number,
  issueNumber: number,
  outcome: TriageOutcome,
  currentStatus: string
): Promise<void> {
  if (outcome.action === "hold") return;
  if (currentStatus !== "open") return;

  if (outcome.action === "await_approval") {
    await setClusterStatus(config, clusterId, "awaiting_approval", outcome.variantLabel);
    await addGithubLabel(githubToken, repo, issueNumber, "awaiting-approval");
    await addGithubComment(githubToken, repo, issueNumber,
      `This has reached ${DISPATCH_THRESHOLD} distinct reporters. It is a feature request, so no agent runs until a maintainer adds the \`agent-approved\` label.`);
    return;
  }

  if (outcome.action === "decision_needed") {
    await setClusterStatus(config, clusterId, "decision_needed");
    await addGithubLabel(githubToken, repo, issueNumber, "decision-needed");
    const lines = outcome.tally.map(t => `- \`${t.label}\`: ${t.reporters} reporter(s)`).join("\n");
    await addGithubComment(githubToken, repo, issueNumber,
      `Reports here want incompatible outcomes and no option has a decisive lead (a winner needs ${CONFLICT_MARGIN}x the runner-up):\n\n${lines}\n\nAdd \`agent-approved\` to build the leading option, or say which option to build in a comment first.`);
    return;
  }

  await setClusterStatus(config, clusterId, "dispatched", outcome.variantLabel);
  await dispatchAgent(githubToken, repo, issueNumber);
}

// Starts the feedback-agent workflow for a cluster that cleared the bug
// threshold (or, via the workflow's human path, was approved by a
// maintainer). This POSTs a repository_dispatch event; the event_type
// "feedback-agent" must match the `types` filter on the
// `repository_dispatch` trigger in .github/workflows/feedback-agent.yml, and
// client_payload.issue_number must match the field that workflow reads
// (`github.event.client_payload.issue_number`) -- a mismatch on either side
// means the dispatch silently does nothing.
//
// Failure here must not fail the request that triggered it -- applyOutcome
// has already marked the cluster "dispatched" by the time this is called, so
// on failure we report to Sentry (already imported in this file) rather than
// throw. That covers both failure modes: a non-ok HTTP response from GitHub,
// and the fetch() promise itself rejecting (DNS failure, network timeout,
// TLS error, connection abort) -- neither is allowed to propagate out of
// this function. A maintainer can always re-run the workflow from the issue
// by hand (adding agent-approved) if the automatic dispatch never landed.
async function dispatchAgent(token: string, repo: string, issueNumber: number): Promise<void> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event_type: "feedback-agent",
        client_payload: { issue_number: issueNumber },
      }),
    });
    if (!res.ok) {
      Sentry.captureException(
        new Error(`Agent dispatch failed (${res.status}): ${await res.text().catch(() => "")}`)
      );
    }
  } catch (err) {
    Sentry.captureException(err);
  }
}

app.post("/api/feedback", feedbackUpload.single("photo"), async (req, res) => {
  let distinctId = "unknown";
  try {
    const webRequest = new Request(`${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`, {
      headers: { cookie: req.headers.cookie ?? "" },
    });
    const url = new URL(webRequest.url);
    const token = parseCookies(webRequest)[cookieNames(url).accessToken];
    const claims = token
      ? await verifyAccessToken(token, gatewayConfig.jwksUrl, gatewayConfig.supabaseUrl)
      : null;
    if (!claims) return res.status(401).json({ error: "not authenticated" });
    if (claims.isAnonymous) return res.status(403).json({ error: "not a member of any team" });
    distinctId = claims.sub;

    const { type, title, description } = req.body as { type?: string; title?: string; description?: string };
    if (type !== "bug" && type !== "feature") return res.status(400).json({ error: "type must be 'bug' or 'feature'" });
    if (!title?.trim() || !description?.trim()) return res.status(400).json({ error: "title and description required" });

    const githubToken = await getVaultSecret(vaultConfig, "github_token", process.env.GITHUB_TOKEN);
    if (!githubToken) return res.status(500).json({ error: "GitHub integration not configured" });
    const repo = process.env.GITHUB_REPO || "evoong/Ultimate-Frisbee-Warrior-Tracker";

    let attachmentMarkdown = "";
    let attachmentPath: string | null = null;
    const photo = req.file;
    if (photo) {
      const ext = path.extname(photo.originalname).toLowerCase() || ".jpg";
      const objectPath = `${claims.sub}/${Date.now()}${ext}`;
      const { error: uploadError } = await supabase.storage
        .from("feedback-attachments")
        .upload(objectPath, photo.buffer, { contentType: photo.mimetype });
      if (uploadError) throw new Error(`Attachment upload failed: ${uploadError.message}`);
      const { data: signed, error: signError } = await supabase.storage
        .from("feedback-attachments")
        .createSignedUrl(objectPath, FEEDBACK_ATTACHMENT_URL_TTL_SECONDS);
      if (signError || !signed) throw new Error(`Attachment signing failed: ${signError?.message ?? "no URL returned"}`);
      attachmentMarkdown = `\n\n![screenshot](${signed.signedUrl})`;
      attachmentPath = objectPath;
    }

    const actionsConfig: ActionsConfig = {
      supabaseUrl: process.env.SUPABASE_URL || "",
      supabaseSecretKey: process.env.SUPABASE_SECRET_KEY || "",
    };

    // Persist first, decide second. If the judge or GitHub call fails below,
    // the report survives and the daily reconciliation pass picks it up --
    // losing a user's bug report to an LLM timeout is the worst outcome
    // available here.
    const stored = await insertReport(actionsConfig, {
      reporterUserId: claims.sub,
      type,
      title: title.trim(),
      description: description.trim(),
      photoPath: attachmentPath,
      countsTowardThreshold: await reportCountsTowardThreshold(claims.sub),
    });

    const geminiApiKey = await getVaultSecret(vaultConfig, "gemini_api_key", process.env.GEMINI_API_KEY);
    const geminiModel = (await getVaultSecret(vaultConfig, "gemini_model", process.env.GEMINI_MODEL)) ?? DEFAULT_GEMINI_MODEL;
    if (!geminiApiKey) return res.status(500).json({ error: "Gemini API key not configured" });

    const clusters = await listOpenClusters(actionsConfig);
    const verdict = await judgeReport(
      geminiApiKey,
      geminiModel,
      { type, title: title.trim(), description: description.trim() },
      clusters
    );

    let clusterId: number;
    let issueNumber: number;
    let issueUrl: string;
    let clusterStatus: string;
    let alreadyTracked = false;
    const cleanDescription = stripTallyMarkers(description.trim());

    if (verdict.relation === "new") {
      const issue = await createGithubIssue(githubToken, repo, {
        title: verdict.suggestedTitle.slice(0, 200),
        body: `${cleanDescription}${attachmentMarkdown}\n\n---\nReported by ${claims.email ?? claims.sub} via in-app feedback form.`,
        labels: [FEEDBACK_LABELS[type], "customer-reported"],
      });
      issueNumber = issue.number;
      issueUrl = issue.html_url;
      clusterId = await createCluster(actionsConfig, {
        type,
        title: verdict.suggestedTitle,
        summary: verdict.suggestedSummary,
        githubIssueNumber: issueNumber,
      });
      // A cluster is always 'open' the instant it's created, so the first
      // report's own escalation check below runs exactly as it always has.
      clusterStatus = "open";
    } else {
      const matched = clusters.find(c => c.id === verdict.matchClusterId)!;
      clusterId = matched.id;
      issueNumber = matched.github_issue_number!;
      issueUrl = `https://github.com/${repo}/issues/${issueNumber}`;
      clusterStatus = matched.status;
      alreadyTracked = true;
      await addGithubComment(githubToken, repo, issueNumber,
        `**Another report of this** (${claims.email ?? claims.sub}):\n\n> ${cleanDescription.replace(/\n/g, "\n> ")}${attachmentMarkdown}`);
    }

    await attachReportToCluster(actionsConfig, stored.id, clusterId, verdict.variantLabel);

    const tally = await tallyFor(actionsConfig, clusterId);
    const reportCount = tally.reduce((sum, t) => sum + t.reporters, 0);
    await updateIssueTally(githubToken, repo, issueNumber, tally);
    const outcome = decideEscalation(type, tally);
    await applyOutcome(actionsConfig, githubToken, repo, clusterId, issueNumber, outcome, clusterStatus);

    await track(distinctId, "feedback_submitted", { type, hasPhoto: !!photo, alreadyTracked });
    res.json({ url: issueUrl, alreadyTracked, reportCount });
  } catch (err: unknown) {
    await trackError(distinctId, err);
    Sentry.captureException(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Reports whose judge or GitHub call failed at submit time are stored with a
// null cluster_id. Nothing else would ever pick them up, so the daily cron
// retries them through the same path a live submission takes. Bounded at 50
// per run: this is a cleanup pass, not a batch importer, and an unbounded
// loop here would be an unbounded Gemini bill.
async function reconcileOrphanReports(
  config: ActionsConfig,
  githubToken: string,
  repo: string,
  geminiApiKey: string,
  geminiModel: string
): Promise<{ attached: number }> {
  // Mirror the /api/feedback guard: judgeReport falls back to relation:
  // 'new' for every orphan when the Gemini key is empty, and each fallback
  // files a real GitHub issue -- up to 50 duplicate issues in one cron run
  // if this ran unguarded. Bail out (and say so loudly, since a cron
  // failure here is otherwise invisible) rather than let that happen.
  if (!githubToken || !geminiApiKey) {
    Sentry.captureMessage("reconcileOrphanReports skipped: missing github_token or gemini_api_key", "warning");
    return { attached: 0 };
  }
  const orphans = await sbGet(
    config,
    "/feedback_reports?select=id,type,title,description&cluster_id=is.null&order=created_at.asc&limit=50"
  );
  let attached = 0;
  for (const orphan of orphans ?? []) {
    // Re-fetched every iteration (rather than once up front) so a cluster
    // created earlier in this same loop -- e.g. two orphans that both turn
    // out to be the same new bug -- is visible to the next orphan's judge
    // call instead of spawning a duplicate GitHub issue.
    const clusters = await listOpenClusters(config);
    const verdict = await judgeReport(geminiApiKey, geminiModel, orphan, clusters);
    const cleanDescription = stripTallyMarkers(String(orphan.description ?? ""));

    let clusterId: number;
    let issueNumber: number;
    let clusterStatus: string;

    if (verdict.relation === "new") {
      const issue = await createGithubIssue(githubToken, repo, {
        title: verdict.suggestedTitle.slice(0, 200),
        body: `${cleanDescription}\n\n---\nRecovered from a failed submission.`,
        labels: [FEEDBACK_LABELS[orphan.type as "bug" | "feature"], "customer-reported"],
      });
      issueNumber = issue.number;
      clusterId = await createCluster(config, {
        type: orphan.type,
        title: verdict.suggestedTitle,
        summary: verdict.suggestedSummary,
        githubIssueNumber: issue.number,
      });
      clusterStatus = "open";
      await attachReportToCluster(config, orphan.id, clusterId, verdict.variantLabel);
    } else {
      const matched = clusters.find(c => c.id === verdict.matchClusterId)!;
      clusterId = matched.id;
      issueNumber = matched.github_issue_number!;
      clusterStatus = matched.status;
      await attachReportToCluster(config, orphan.id, clusterId, verdict.variantLabel);
      // Mirrors the live-submission "same"/"conflicting_variant" branch: a
      // recovered report matched to an existing cluster otherwise leaves no
      // trace anywhere a maintainer or the dispatched agent would see it.
      // No attachmentMarkdown here -- orphan reconciliation has no photo
      // data to work with, just the description text.
      await addGithubComment(githubToken, repo, issueNumber,
        `**Another report of this** (recovered from a failed submission):\n\n> ${cleanDescription.replace(/\n/g, "\n> ")}`);
    }

    // Run the same tally/escalate sequence the live submission path runs --
    // otherwise a cluster that only reaches the dispatch threshold via a
    // recovered report never dispatches until some unrelated later live
    // submission happens to arrive.
    const tally = await tallyFor(config, clusterId);
    await updateIssueTally(githubToken, repo, issueNumber, tally);
    const outcome = decideEscalation(orphan.type as "bug" | "feature", tally);
    await applyOutcome(config, githubToken, repo, clusterId, issueNumber, outcome, clusterStatus);

    attached++;
  }
  return { attached };
}

app.get("/api/cron/sync-jam", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "not authenticated" });
  }
  try {
    const result = await Sentry.withMonitor(
      JAM_SYNC_MONITOR_SLUG,
      () => runJamSync(jamSyncConfig()),
      JAM_SYNC_MONITOR_CONFIG
    );
    // Rides along on the existing daily cron rather than introducing a
    // second schedule. A failure here must not fail the jam sync it rides
    // with -- the .catch keeps this isolated and just reports zero attached.
    const reconciled = await reconcileOrphanReports(
      { supabaseUrl: process.env.SUPABASE_URL || "", supabaseSecretKey: process.env.SUPABASE_SECRET_KEY || "" },
      (await getVaultSecret(vaultConfig, "github_token", process.env.GITHUB_TOKEN)) ?? "",
      process.env.GITHUB_REPO || "evoong/Ultimate-Frisbee-Warrior-Tracker",
      (await getVaultSecret(vaultConfig, "gemini_api_key", process.env.GEMINI_API_KEY)) ?? "",
      (await getVaultSecret(vaultConfig, "gemini_model", process.env.GEMINI_MODEL)) ?? DEFAULT_GEMINI_MODEL
    ).catch(err => {
      // A failed cleanup pass must not fail the jam sync it rides along with.
      Sentry.captureException(err);
      return { attached: 0 };
    });
    await track("cron", "jam_sync_triggered", { via: "cron" });
    res.json({ ...result, reconciled });
  } catch (err: unknown) {
    await trackError("cron", err);
    Sentry.captureException(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

Sentry.setupExpressErrorHandler(app);

// Only bind a port when running directly (not as a Vercel serverless function)
if (!process.env.VERCEL) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`API server running on http://0.0.0.0:${PORT}`);
  });
  process.on("SIGTERM", async () => {
    await shutdown();
    await posthogAi.shutdown();
    process.exit(0);
  });
}

export default app;
