import "dotenv/config";
import express from "express";
import type { Request as ExpressRequest, Response as ExpressResponse, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";
import multer from "multer";
import path from "path";
import fs from "fs";
import { GoogleGenAI } from "@google/genai";
import { createGateway, createRequireAllowedUser } from "../gateway/index";
import { nodeAdapter } from "../gateway/node-adapter";

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

async function isEmailAllowed(email: string): Promise<boolean> {
  const cached = allowlistCache.get(email);
  if (cached && cached.expires > Date.now()) return cached.allowed;
  const { data, error } = await supabase
    .from("allowed_users")
    .select("email")
    .eq("email", email)
    .maybeSingle();
  const allowed = !error && data !== null;
  allowlistCache.set(email, { allowed, expires: Date.now() + 60_000 });
  return allowed;
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

const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

async function getTeamContext() {
  const [players, seasons, games, events, seasonPlayers] = await Promise.all([
    supabase.from("players").select("id, display_name, position, gender_match, is_sub").order("display_name"),
    supabase.from("seasons").select("id, name, year, organizer").order("id"),
    supabase.from("games").select("id, season_id, opponent, game_date, result, outcome_override").order("game_date", { ascending: true }),
    supabase.from("game_events").select("player_id, related_player_id, event_type, game_id"),
    supabase.from("season_players").select("player_id, season_id").eq("active", true),
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

  return `You are a helpful assistant for the Ultimate Frisbee Warriors team tracking app. You have access to the following live team data:

SEASONS:
${(seasons.data ?? []).map((s: any) => `- ${seasonNames.get(s.id)}`).join("\n")}

GAME RESULTS:
${gameResultLines.join("\n")}

PLAYER STATS (All-time totals + breakdown by season + breakdown by game):
${playerSections.join("\n\n")}

LANGUAGE STYLE: Respond ONLY in Jamaican Patois, in every message, no exceptions. Keep it warm and natural (e.g. "wah gwaan", "mi", "yuh", "di", "dem", "nuh", "ting"), but never let the patois obscure the actual answer — names, numbers, dates, and stats must stay exact and easy to read. If a question is complex, prioritize clarity: use simple patois phrasing over anything cute that risks confusing the user.

Answer questions about the team, players, stats, and games. Be concise and friendly. When giving stats, reference the season and game breakdowns where relevant. If asked to do something you can't (like edit data), explain that the app UI should be used for that — still in patois.`;
}

app.post("/api/chat", requireAuth, async (req, res) => {
  try {
    const { message, session_id, history = [] } = req.body as { message: string; session_id: string; history: { role: string; content: string }[] };
    if (!message || !session_id) return res.status(400).json({ error: "message and session_id required" });

    const systemContext = await getTeamContext();

    const chatHistory = history.map((h: any) => ({
      role: h.role === "assistant" ? "model" : "user",
      parts: [{ text: h.content }],
    }));

    const chat = genai.chats.create({
      model: "gemma-4-31b-it",
      history: chatHistory,
      config: { systemInstruction: systemContext },
    });

    const response = await chat.sendMessage({ message });
    const reply = response.text ?? "";

    // Save both turns to chat_logs
    await supabase.from("chat_logs").insert([
      { session_id, role: "user", content: message },
      { session_id, role: "assistant", content: reply },
    ]);

    res.json({ reply });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/chat/history", requireAuth, async (req, res) => {
  try {
    const { session_id } = req.query as { session_id: string };
    if (!session_id) return res.status(400).json({ error: "session_id required" });

    const { data, error } = await supabase
      .from("chat_logs")
      .select("role, content, created_at")
      .eq("session_id", session_id)
      .order("created_at", { ascending: true });

    if (error) throw error;
    res.json(data ?? []);
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
