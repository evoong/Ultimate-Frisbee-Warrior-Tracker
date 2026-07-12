import "dotenv/config";
import express from "express";
import type { Request as ExpressRequest, Response as ExpressResponse, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";
import multer from "multer";
import path from "path";
import fs from "fs";
import { GoogleGenAI } from "@google/genai";
import { createGateway, createRequireAllowedUser } from "../gateway/index.js";
import { nodeAdapter } from "../gateway/node-adapter.js";
import { getVaultSecret } from "../gateway/secrets.js";
import { runJamSync } from "../gateway/jamSync.js";

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

// ── Auth guard for chat routes ───────────────────────────────────────────────
// The chat endpoints below query Supabase with the SERVICE ROLE, which
// bypasses RLS — so they must enforce auth themselves: JWKS-verified access
// token from the httpOnly cookie + allowlist membership (cached 60s).

const allowlistCache = new Map<string, { allowed: boolean; expires: number }>();

// "Allowed" means "belongs to at least one organization" (allowed_users
// was fully replaced by organization_members in 016_organizations.sql).
// Soft launch (app not released yet): always true, so any signed-in user
// passes; requireAllowedUser still verifies the session cookie itself.
// When isolation is wanted, restore the organization_members lookup:
//   const cached = allowlistCache.get(email);
//   if (cached && cached.expires > Date.now()) return cached.allowed;
//   const { data, error } = await supabase.from("organization_members")
//     .select("email").eq("email", email).limit(1).maybeSingle();
//   const allowed = !error && data !== null;
//   allowlistCache.set(email, { allowed, expires: Date.now() + 60_000 });
//   return allowed;
async function isEmailAllowed(_email: string): Promise<boolean> {
  return true;
}

// True only when the email is a member of this specific organization.
// Soft launch (app not released yet): always true, so any signed-in user
// may use chat against any organization, matching the any-authenticated
// RLS in 017_open_access_for_now.sql. When isolation is wanted, restore
// the organization_members lookup:
//   const { data, error } = await supabase.from("organization_members")
//     .select("email").eq("email", email)
//     .eq("organization_id", organizationId).limit(1).maybeSingle();
//   return !error && data !== null;
async function isOrgMember(_email: string, _organizationId: number): Promise<boolean> {
  return true;
}

const requireAllowedUser = createRequireAllowedUser(gatewayConfig, isEmailAllowed);

async function requireAuth(req: ExpressRequest, res: ExpressResponse, next: NextFunction) {
  try {
    const proto = req.protocol;
    const host = req.get("host") ?? "localhost";
    const webRequest = new Request(`${proto}://${host}${req.originalUrl}`, {
      headers: { cookie: req.headers.cookie ?? "" },
    });
    const user = await requireAllowedUser(webRequest);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    next();
  } catch (err) {
    next(err);
  }
}

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

async function getTeamContext(organizationId: number) {
  const [players, seasons, games, events, seasonPlayers] = await Promise.all([
    supabase.from("players").select("id, display_name, position, gender_match, is_sub").eq("organization_id", organizationId).order("display_name"),
    supabase.from("seasons").select("id, name, year, organizer").eq("organization_id", organizationId).order("id"),
    supabase.from("games").select("id, season_id, opponent, game_date, result, outcome_override").eq("organization_id", organizationId).order("game_date", { ascending: true }),
    supabase.from("game_events").select("player_id, related_player_id, event_type, game_id, event_timestamp").eq("organization_id", organizationId),
    supabase.from("season_players").select("player_id, season_id").eq("active", true).eq("organization_id", organizationId),
  ]);

  const seasonNames = new Map((seasons.data ?? []).map((s: any) => [s.id, `${s.organizer ?? ""} ${s.name} ${s.year}`.trim()]));
  const gameMap = new Map((games.data ?? []).map((g: any) => [g.id, g]));
  const playerMap = new Map((players.data ?? []).map((p: any) => [p.id, p]));

  type Stat = { goals: number; assists: number; turnovers: number };
  const allTime = new Map<number, Stat>();
  const bySeason = new Map<number, Map<number, Stat>>(); // playerId → seasonId → stat
  const byGame = new Map<number, Map<number, Stat>>();   // playerId → gameId → stat

  const ensure = (map: Map<number, Stat>, id: number) => {
    if (!map.has(id)) map.set(id, { goals: 0, assists: 0, turnovers: 0 });
    return map.get(id)!;
  };
  const ensureNested = (outer: Map<number, Map<number, Stat>>, pid: number, inner: number) => {
    if (!outer.has(pid)) outer.set(pid, new Map());
    return ensure(outer.get(pid)!, inner);
  };

  (events.data ?? []).forEach((e: any) => {
    const game = gameMap.get(e.game_id);
    const sid = game?.season_id;

    if (e.player_id) {
      ensure(allTime, e.player_id);
      if (sid) ensureNested(bySeason, e.player_id, sid);
      ensureNested(byGame, e.player_id, e.game_id);

      if (e.event_type === "Goal") {
        allTime.get(e.player_id)!.goals++;
        if (sid) bySeason.get(e.player_id)!.get(sid)!.goals++;
        byGame.get(e.player_id)!.get(e.game_id)!.goals++;
      } else if (["Turnover", "Throwaway", "Drop"].includes(e.event_type)) {
        allTime.get(e.player_id)!.turnovers++;
        if (sid) bySeason.get(e.player_id)!.get(sid)!.turnovers++;
        byGame.get(e.player_id)!.get(e.game_id)!.turnovers++;
      }
    }

    if (e.event_type === "Goal" && e.related_player_id) {
      const game2 = gameMap.get(e.game_id);
      const sid2 = game2?.season_id;
      ensure(allTime, e.related_player_id);
      if (sid2) ensureNested(bySeason, e.related_player_id, sid2);
      ensureNested(byGame, e.related_player_id, e.game_id);
      allTime.get(e.related_player_id)!.assists++;
      if (sid2) bySeason.get(e.related_player_id)!.get(sid2)!.assists++;
      byGame.get(e.related_player_id)!.get(e.game_id)!.assists++;
    }
  });

  // Build per-player section
  const playerSections = (players.data ?? []).map((p: any) => {
    const at = allTime.get(p.id) ?? { goals: 0, assists: 0, turnovers: 0 };
    const header = `${p.display_name}${p.position ? ` (${p.position})` : ""}${p.is_sub ? " [sub]" : ""}. All-time: ${at.goals}G ${at.assists}A ${at.turnovers}TO`;

    // Seasons this player is in
    const playerSeasonIds = (seasonPlayers.data ?? [])
      .filter((sp: any) => sp.player_id === p.id)
      .map((sp: any) => sp.season_id);

    const seasonLines = playerSeasonIds.map((sid: number) => {
      const st = bySeason.get(p.id)?.get(sid) ?? { goals: 0, assists: 0, turnovers: 0 };
      const seasonGames = (games.data ?? []).filter((g: any) => g.season_id === sid);
      const gameLine = seasonGames.map((g: any) => {
        const gs = byGame.get(p.id)?.get(g.id) ?? { goals: 0, assists: 0, turnovers: 0 };
        const res = g.outcome_override || g.result || "TBD";
        return `      - ${g.game_date} vs ${g.opponent} (${res}): ${gs.goals}G ${gs.assists}A ${gs.turnovers}TO`;
      }).join("\n");
      return `  [${seasonNames.get(sid) ?? sid}]: ${st.goals}G ${st.assists}A ${st.turnovers}TO\n${gameLine}`;
    });

    return `${header}\n${seasonLines.join("\n")}`;
  });

  // Game results summary
  const gameResultLines = (games.data ?? []).map((g: any) => {
    const res = g.outcome_override || g.result || "TBD";
    const goals = (events.data ?? []).filter((e: any) => e.game_id === g.id && e.event_type === "Goal").length;
    const opp  = (events.data ?? []).filter((e: any) => e.game_id === g.id && e.event_type === "Opponent Goal").length;
    return `- ${g.game_date} vs ${g.opponent} [${seasonNames.get(g.season_id) ?? "?"}]: ${goals}-${opp} ${res}`;
  });

  // Chronological, timestamped play-by-play per game — lets the assistant
  // answer "when"/"what time"/"first"/"last"/time-between-events questions.
  const eventsByGame = new Map<number, any[]>();
  (events.data ?? []).forEach((e: any) => {
    if (!eventsByGame.has(e.game_id)) eventsByGame.set(e.game_id, []);
    eventsByGame.get(e.game_id)!.push(e);
  });

  const formatEventTime = (ts: string | null) =>
    ts ? new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" }) : "?";

  const eventTimelines = (games.data ?? [])
    .map((g: any) => {
      const gameEvents = (eventsByGame.get(g.id) ?? [])
        .slice()
        .sort((a: any, b: any) => (a.event_timestamp ?? "").localeCompare(b.event_timestamp ?? ""));
      if (gameEvents.length === 0) return null;

      const lines = gameEvents.map((e: any) => {
        const time = formatEventTime(e.event_timestamp);
        const scorer = e.player_id ? playerMap.get(e.player_id)?.display_name ?? "Unknown" : null;
        const assister = e.related_player_id ? playerMap.get(e.related_player_id)?.display_name : null;
        if (e.event_type === "Goal") {
          return `    ${time} - Goal: ${scorer ?? "Unknown"}${assister ? ` (assist: ${assister})` : ""}`;
        }
        if (e.event_type === "Opponent Goal") {
          return `    ${time} - Opponent Goal`;
        }
        return `    ${time} - ${e.event_type}${scorer ? `: ${scorer}` : ""}`;
      });

      return `- ${g.game_date} vs ${g.opponent}:\n${lines.join("\n")}`;
    })
    .filter((line: string | null): line is string => line !== null);

  const currentDate = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  return `You are a helpful assistant for the Ultimate Frisbee Warriors team tracking app. You have access to the following live team data:

CURRENT DATE: ${currentDate} — use this to resolve relative date questions (today, this week, last game, upcoming, how long ago, etc).

SEASONS:
${(seasons.data ?? []).map((s: any) => `- ${seasonNames.get(s.id)}`).join("\n")}

GAME RESULTS:
${gameResultLines.join("\n")}

PLAYER STATS (All-time totals + breakdown by season + breakdown by game):
${playerSections.join("\n\n")}

EVENT TIMELINE (chronological, with timestamps — use this for "when"/"what time"/"first"/"last"/time-between-events questions):
${eventTimelines.join("\n\n")}

LANGUAGE STYLE: Respond ONLY in Jamaican Patois, in every message, no exceptions. Keep it warm and natural (e.g. "wah gwaan", "mi", "yuh", "di", "dem", "nuh", "ting"), but never let the patois obscure the actual answer — names, numbers, dates, and stats must stay exact and easy to read. If a question is complex, prioritize clarity: use simple patois phrasing over anything cute that risks confusing the user.

Answer questions about the team, players, stats, and games. Be concise and friendly. When giving stats, reference the season and game breakdowns where relevant. If asked to do something you can't (like edit data), explain that the app UI should be used for that — still in patois.`;
}

// Retry transient Gemini errors (was tuned against gemma-4-31b-it, which
// could fail its transient 500 several times in a row; kept as a general
// safety net now that the model has switched to gemini-flash-lite).
function isTransientGeminiError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return text.includes('"code":500') || text.includes("INTERNAL") || text.includes("UNAVAILABLE");
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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

    const systemContext = await getTeamContext(organization_id);

    const geminiApiKey = await getVaultSecret(vaultConfig, "gemini_api_key", process.env.GEMINI_API_KEY);
    const geminiModel = (await getVaultSecret(vaultConfig, "gemini_model", process.env.GEMINI_MODEL)) ?? DEFAULT_GEMINI_MODEL;
    if (!geminiApiKey) return res.status(500).json({ error: "Gemini API key not configured" });
    const genai = new GoogleGenAI({ apiKey: geminiApiKey });

    const chatHistory = history.map((h: any) => ({
      role: h.role === "assistant" ? "model" : "user",
      parts: [{ text: h.content }],
    }));

    const MAX_ATTEMPTS = 5;
    let reply = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const chat = genai.chats.create({
          model: geminiModel,
          history: chatHistory,
          config: { systemInstruction: systemContext },
        });
        const response = await chat.sendMessage({ message });
        reply = response.text ?? "";
        break;
      } catch (err) {
        if (attempt === MAX_ATTEMPTS || !isTransientGeminiError(err)) throw err;
        await sleep(600 * attempt);
      }
    }

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

    const { data, error } = await supabase
      .from("chat_logs")
      .select("role, content, created_at")
      .eq("session_id", session_id)
      .eq("organization_id", organization_id)
      .order("created_at", { ascending: true });

    if (error) throw error;
    res.json(data ?? []);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

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

app.post("/api/schedule/sync-jam", requireAuth, async (_req, res) => {
  try {
    const result = await runJamSync(jamSyncConfig());
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

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

// Only bind a port when running directly (not as a Vercel serverless function)
if (!process.env.VERCEL) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`API server running on http://0.0.0.0:${PORT}`);
  });
}

export default app;
