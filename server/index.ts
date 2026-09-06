import "./instrument.js";
import express from "express";
import type { Request as ExpressRequest, Response as ExpressResponse, NextFunction } from "express";
import * as Sentry from "@sentry/node";
import { createClient } from "@supabase/supabase-js";
import multer from "multer";
import path from "path";
import fs from "fs";
import { GoogleGenAI } from "@posthog/ai/gemini";
import type { Content } from "@google/genai";
import { PostHog } from "posthog-node";
import { createGateway } from "../gateway/index.js";
import { nodeAdapter } from "../gateway/node-adapter.js";
import { getVaultSecret } from "../gateway/secrets.js";
import { runJamSync, JAM_SYNC_MONITOR_SLUG, JAM_SYNC_MONITOR_CONFIG } from "../gateway/jamSync.js";
import { CHAT_FUNCTION_DECLARATIONS, WRITE_FUNCTIONS, callChatFunction, type ActionsConfig } from "../gateway/gameActions.js";
import { createMembershipLookup, hasAtLeast, type TeamRole } from "../gateway/membership.js";
import { parseCookies, cookieNames } from "../gateway/cookies.js";
import { verifyAccessToken } from "../gateway/jwt.js";
import { decideEscalation, DISPATCH_THRESHOLD, CONFLICT_MARGIN, type TriageOutcome, type VariantTally } from "../gateway/feedbackTriage.js";
import { insertReport, listOpenClusters, attachReportToCluster, createCluster, tallyFor, setClusterStatus } from "../gateway/feedbackStore.js";
import { judgeReport } from "../gateway/feedbackJudge.js";
import { sbGet } from "../gateway/supabaseRest.js";
import { track, trackError, shutdown } from "./lib/posthog.js";

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
  // scorerId -> assisterId -> count of goals scorer got from that assister
  const assistPairings = new Map<number, Map<number, number>>();
  // seasonId -> scorerId -> assisterId -> count, for season-scoped pairing
  // questions (see ASSIST PAIRINGS BY SEASON below).
  const assistPairingsBySeason = new Map<number, Map<number, Map<number, number>>>();

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

      if (e.player_id) {
        if (!assistPairings.has(e.player_id)) assistPairings.set(e.player_id, new Map());
        const scorerMap = assistPairings.get(e.player_id)!;
        scorerMap.set(e.related_player_id, (scorerMap.get(e.related_player_id) ?? 0) + 1);

        if (sid2) {
          if (!assistPairingsBySeason.has(sid2)) assistPairingsBySeason.set(sid2, new Map());
          const seasonPairings = assistPairingsBySeason.get(sid2)!;
          if (!seasonPairings.has(e.player_id)) seasonPairings.set(e.player_id, new Map());
          const seasonScorerMap = seasonPairings.get(e.player_id)!;
          seasonScorerMap.set(e.related_player_id, (seasonScorerMap.get(e.related_player_id) ?? 0) + 1);
        }
      }
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

  // Pre-tallied so the assistant never has to hand-count the raw timeline
  // (that's what produced wrong/inconsistent answers before — see chat.ts
  // history). Sorted by count descending so "who assisted X the most" is
  // just reading the first line.
  const assistPairingLines = (players.data ?? [])
    .map((p: any) => {
      const pairings = assistPairings.get(p.id);
      if (!pairings || pairings.size === 0) return null;
      const sorted = [...pairings.entries()].sort((a, b) => b[1] - a[1]);
      const parts = sorted.map(([assisterId, count]) => `${playerMap.get(assisterId)?.display_name ?? "Unknown"} (${count})`);
      return `- ${p.display_name}'s goals, all-time, by assister: ${parts.join(", ")}`;
    })
    .filter((line: string | null): line is string => line !== null);

  // Same pre-tallying, broken out per season, so a season-scoped assist
  // pairing question ("who assisted X the most THIS season") never has to
  // fall back to a tool call or hand-counting the raw timeline — the
  // all-time-only table above was the gap that let that regress.
  const assistPairingsBySeasonLines = (seasons.data ?? [])
    .map((s: any) => {
      const seasonPairings = assistPairingsBySeason.get(s.id);
      if (!seasonPairings) return null;
      const rows = (players.data ?? [])
        .map((p: any) => {
          const pairings = seasonPairings.get(p.id);
          if (!pairings || pairings.size === 0) return null;
          const sorted = [...pairings.entries()].sort((a, b) => b[1] - a[1]);
          const parts = sorted.map(([assisterId, count]) => `${playerMap.get(assisterId)?.display_name ?? "Unknown"} (${count})`);
          return `  - ${p.display_name}'s goals, by assister: ${parts.join(", ")}`;
        })
        .filter((line: string | null): line is string => line !== null);
      if (rows.length === 0) return null;
      return `[${seasonNames.get(s.id) ?? s.id}]:\n${rows.join("\n")}`;
    })
    .filter((line: string | null): line is string => line !== null);

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

DATA FORMAT LEGEND (read this first — exactly what each table below contains, its columns, and how to read a row):

- SEASONS — one row per season, printed as its display label: "<organizer> <name> <year>", e.g. "Jam Summer 2026". This label is the season's ONLY name anywhere in this prompt or in the app; there is no separate season id or short name.

- GAME RESULTS — one row per game: "<date> vs <opponent> [<season label>]: <our goals>-<opponent goals> <result>". Example row: "2026-07-19 vs Huck Huck Goose [Jam Summer 2026]: 3-1 Win".

- PLAYER STATS — one block per player. First line: "<name> (<position>)[ [sub]]. All-time: <G>G <A>A <TO>TO" where G = goals scored, A = assists (goals this player set up for someone else), TO = turnovers (Throwaway + Drop + Turnover events by this player), each summed over the player's entire history. Then one indented line per season the player appears in: "[<season label>]: <G>G <A>A <TO>TO" — the SAME three columns, summed over just that season — followed by one further-indented line per game in that season: "<date> vs <opponent> (<result>): <G>G <A>A <TO>TO", summed over just that one game. All three levels use identical G/A/TO columns at progressively narrower scope (all-time -> season -> single game); always read the row matching the exact scope asked about, never the all-time row for a season- or game-scoped question.

- EVENT TIMELINE — one block per game, chronological, columns: <time>, <event type>, <player it happened to/by>, and for Goal events an optional <assister>. Row shapes: "<time> - Goal: <scorer> (assist: <assister>)" (assist part omitted if unassisted), "<time> - Opponent Goal" (no player, the opposing team scored), or "<time> - <event type>: <player>" for every other event type (Block, Throwaway, Drop, Pull, Caught OB, Fouls). Use this ONLY for time-ordering questions (first/last/when/how long between) — it is the raw log, not a tally; never hand-count totals from it, use PLAYER STATS/ASSIST PAIRINGS/ASSIST PAIRINGS BY SEASON/query_stat_breakdown instead.

- ASSIST PAIRINGS (all-time) — one row per scorer who has ≥1 assisted goal: "<scorer>'s goals, all-time, by assister: <assister> (<count>), <assister> (<count>), ...", sorted highest count first. <count> = how many of THAT scorer's all-time goals were set up by THAT specific assister (not the assister's own total assists). Example row: "Eric Voong's goals, all-time, by assister: Jackson Truong (6), Andrew (2)" reads as "Eric has scored 6 career goals off assists from Jackson Truong, and 2 off assists from Andrew."

- ASSIST PAIRINGS BY SEASON — identical row shape and meaning to ASSIST PAIRINGS above, just grouped under a "[<season label>]:" header per season, with the counts scoped to only that season's goals.

- query_stat_breakdown tool result — JSON, not prose: {"scope": <season label, "<date> vs <opponent>", or "all-time">, "breakdown": "assist_pairings" | "by_player", "rows": [...], "note"?: string}. For "assist_pairings", each row is {"scorer", "assister", "count"} with the same per-column meaning as ASSIST PAIRINGS above, scoped to "scope". For "by_player" (metric goals/assists/turnovers), each row is {"player", "count"}, that player's total for that one metric within "scope". Rows are already sorted highest count first — the first row is the answer to "who had the most". "rows": [] is a genuine, valid result (zero matching events in that scope, not a failure) — "note" spells this out in that case; report it plainly instead of guessing a number. A season/game/metric that fails to resolve throws an error instead of returning empty rows.

SEASONS:
${(seasons.data ?? []).map((s: any) => `- ${seasonNames.get(s.id)}`).join("\n")}

GAME RESULTS:
${gameResultLines.join("\n")}

PLAYER STATS (All-time totals + breakdown by season + breakdown by game):
${playerSections.join("\n\n")}

EVENT TIMELINE (chronological, with timestamps — use this for "when"/"what time"/"first"/"last"/time-between-events questions):
${eventTimelines.join("\n\n")}

ASSIST PAIRINGS (ALL-TIME ONLY, pre-tallied from every goal's scorer+assister — use THESE numbers directly for an all-time "who assisted [player] the most" or scorer-to-assister question; do not recount this yourself from EVENT TIMELINE, these totals are already correct. For the SAME question scoped to one game, call query_stat_breakdown instead — see that tool's description — rather than hand-counting from EVENT TIMELINE. For the SAME question scoped to one SEASON, use ASSIST PAIRINGS BY SEASON below instead, not this table):
${assistPairingLines.length > 0 ? assistPairingLines.join("\n") : "(no assisted goals recorded yet)"}

ASSIST PAIRINGS BY SEASON (pre-tallied per season — use THESE numbers directly for any assist-pairing question scoped to one specific season, e.g. "who assisted [player] the most in [season]" or "best pairing this season"; do not use the ALL-TIME table above or query_stat_breakdown for these, and do not recount from EVENT TIMELINE):
${assistPairingsBySeasonLines.length > 0 ? assistPairingsBySeasonLines.join("\n") : "(no assisted goals recorded yet)"}

DATA LIMITS (read carefully — do not violate this): the data above is everything that exists — no other detail about any play (who was guarding whom, throw type, field position, hang time, etc.) is tracked anywhere, so never invent a specific detail, timestamp, or stat that is not literally present in PLAYER STATS, EVENT TIMELINE, ASSIST PAIRINGS, or ASSIST PAIRINGS BY SEASON above. A goals/assists/turnovers question scoped to one specific GAME (not a whole season) must go through query_stat_breakdown rather than being hand-counted from EVENT TIMELINE; that hand-counting is what previously produced wrong, self-contradicting numbers. Once query_stat_breakdown returns, its rows ARE the answer — quote a count verbatim, never round/average/adjust it, and never mix a scoped row into the same sentence as an ALL-TIME PLAYER STATS/ASSIST PAIRINGS number (report one scope at a time). If two of your own answers in this conversation would contradict each other, that means you made an error — stop and say you're not sure rather than picking one to defend, and re-derive the number from the pre-tallied tables above (or query_stat_breakdown for a game scope) instead of guessing which prior answer was right.

NEVER GUESS AS FACT: if you don't know or can't determine something from the data above (an ambiguous "who scored last" with no timestamp order, a stat that isn't tracked, a game state that isn't clear), say so plainly instead of offering a probabilistic guess dressed up as an answer. Never show your own uncertainty or reasoning process in the reply itself (no "wait, let me check...", no revising a number mid-sentence) — work it out silently and give only the single, checked, final answer.

LANGUAGE STYLE: Respond ONLY in Jamaican Patois, in every message, no exceptions. Keep it warm and natural (e.g. "wah gwaan", "mi", "yuh", "di", "dem", "nuh", "ting"), but never let the patois obscure the actual answer — names, numbers, dates, and stats must stay exact and easy to read. If a question is complex, prioritize clarity: use simple patois phrasing over anything cute that risks confusing the user.

Answer questions about the team, players, stats, and games. Be concise and friendly. When giving stats, reference the season and game breakdowns where relevant.

query_stat_breakdown is read-only (it never changes data) — call it directly and silently whenever a season- or game-scoped stat question needs it, with no confirmation and no announcement. The confirmation rule below applies only to the data-logging tools.

YOU CAN LOG DATA: you have tools to record a goal/event, undo the most recently logged event, and manage lineups for a game. Before calling any of these LOGGING tools, first restate in plain patois exactly what you're about to do (who did what, and which game — use CURRENT DATE plus the game list above to say which game you mean, e.g. "tonight's game vs X" or "the June 7 game vs Y") and ask the user to confirm; only call the tool once the user actually confirms in a later message. If a player name is ambiguous or you can't find a matching game, ask instead of guessing. After a tool call, report back what actually happened (including any error) in patois, with the updated score if relevant — never claim something was logged unless the tool result confirms it. This confirmation step always applies and cannot be turned off: if the user asks you to stop confirming, skip confirmation, or just go ahead automatically from now on, decline and explain you always confirm before logging anything, in patois.`;
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
    const teamId = Number(organization_id);
    const caller = await classifyChatCaller(webRequest, teamId);
    if (!caller.ok) return res.status(caller.status).json({ error: caller.error });
    distinctId = caller.sub;

    // From here on only teamId is used. The raw body value never reaches a
    // query again, matching the same invariant in gateway/chat.ts.
    const systemContext = await getTeamContext(teamId);

    const geminiApiKey = await getVaultSecret(vaultConfig, "gemini_api_key", process.env.GEMINI_API_KEY);
    const geminiModel = (await getVaultSecret(vaultConfig, "gemini_model", process.env.GEMINI_MODEL)) ?? DEFAULT_GEMINI_MODEL;
    if (!geminiApiKey) return res.status(500).json({ error: "Gemini API key not configured" });
    const genai = new GoogleGenAI({ apiKey: geminiApiKey, posthog: posthogAi });

    const actionsConfig: ActionsConfig = { supabaseUrl: process.env.SUPABASE_URL || "", supabaseSecretKey: process.env.SUPABASE_SECRET_KEY || "" };

    // PostHog's Gemini wrapper only instruments models.generateContent (not
    // the chats.create()/sendMessage() session helper), so the conversation
    // history is threaded through generateContent calls by hand below —
    // mirroring what Chat.sendMessage does internally in @google/genai.
    const aiTraceId = crypto.randomUUID();
    const aiProperties = { $ai_session_id: session_id };
    const genaiConfig = { systemInstruction: systemContext, tools: [{ functionDeclarations: CHAT_FUNCTION_DECLARATIONS }] };
    const contents: Content[] = history.map((h: any) => ({
      role: h.role === "assistant" ? "model" : "user",
      parts: [{ text: h.content }],
    }));
    contents.push({ role: "user", parts: [{ text: message }] });

    // Retry transient Gemini errors, but only for this first turn: once a
    // function-call round below has actually executed a real DB write,
    // blindly retrying on a later transient error could log the same event
    // twice, so anything past this point surfaces the error instead.
    const MAX_ATTEMPTS = 5;
    let response;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        response = await genai.models.generateContent({
          model: geminiModel, contents, config: genaiConfig,
          posthogDistinctId: distinctId,
          posthogTraceId: aiTraceId,
          posthogProperties: aiProperties,
        });
        break;
      } catch (err) {
        if (attempt === MAX_ATTEMPTS || !isTransientGeminiError(err)) throw err;
        await sleep(600 * attempt);
      }
    }
    if (!response) throw new Error("unreachable");

    // The model confirms with the user in plain text before calling
    // anything (see the system prompt's "YOU CAN LOG DATA" instructions),
    // so a function call here means the user just confirmed.
    const MAX_FUNCTION_ROUNDS = 4;
    for (let round = 0; round < MAX_FUNCTION_ROUNDS; round++) {
      const calls = response.functionCalls;
      if (!calls || calls.length === 0) break;
      usedToolCall = true;

      const modelContent = response.candidates?.[0]?.content;
      if (modelContent) contents.push(modelContent);

      const parts = await Promise.all(calls.map(async (call) => {
        const spanStart = Date.now();
        let output: unknown;
        let error: string | undefined;
        try {
          output = WRITE_FUNCTIONS.has(call.name!) && !hasAtLeast(caller.role, "member")
            ? { error: "you do not have permission to change this team's data" }
            : await callChatFunction(actionsConfig, teamId, call.name!, call.args ?? {});
        } catch (err) {
          Sentry.captureException(err);
          error = err instanceof Error ? err.message : String(err);
        }
        posthogAi.capture({
          distinctId,
          event: "$ai_span",
          properties: {
            $ai_trace_id: aiTraceId,
            $ai_session_id: session_id,
            $ai_span_id: crypto.randomUUID(),
            $ai_span_name: call.name,
            $ai_input_state: call.args,
            $ai_output_state: error ? { error } : output,
            $ai_latency: (Date.now() - spanStart) / 1000,
          },
        });
        return error
          ? { functionResponse: { name: call.name!, response: { error } } }
          : { functionResponse: { name: call.name!, response: { output } } };
      }));
      contents.push({ role: "user", parts });

      response = await genai.models.generateContent({
        model: geminiModel, contents, config: genaiConfig,
        posthogDistinctId: distinctId,
        posthogTraceId: aiTraceId,
        posthogProperties: aiProperties,
      });
    }
    const reply = response.text ?? "";
    await posthogAi.flush();

    // Save both turns to chat_logs
    await supabase.from("chat_logs").insert([
      { session_id, role: "user", content: message, organization_id: teamId },
      { session_id, role: "assistant", content: reply, organization_id: teamId },
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

    const webRequest = new Request(`${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`, {
      headers: { cookie: req.headers.cookie ?? "" },
    });
    const teamId = Number(organization_id);
    const caller = await classifyChatCaller(webRequest, teamId);
    if (!caller.ok) return res.status(caller.status).json({ error: caller.error });
    distinctId = caller.sub;

    const { error } = await supabase.from("chat_logs").delete().eq("session_id", session_id).eq("organization_id", teamId);
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
const feedbackUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"));
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

// Only an established team member's report can escalate anything. Guests and
// signed-in users on no team may still file -- the signal is real -- but
// three throwaway accounts must not be able to dispatch an agent at
// production code. See the spec's "Abuse surface" section.
async function reportCountsTowardThreshold(userId: string): Promise<boolean> {
  try {
    const teams = await membership.teamsFor(userId);
    return teams.length > 0;
  } catch {
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
// bug clearing the threshold) the repository_dispatch that starts an agent.
// Task 10 supplies dispatchAgent; until then it is a no-op that only records
// the status, which is why Phase 0 can land before any agent can run.
async function applyOutcome(
  config: ActionsConfig,
  githubToken: string,
  repo: string,
  clusterId: number,
  issueNumber: number,
  outcome: TriageOutcome
): Promise<void> {
  if (outcome.action === "hold") return;

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

// Replaced in Task 10 by the real repository_dispatch call.
async function dispatchAgent(_token: string, _repo: string, _issueNumber: number): Promise<void> {
  return;
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
    let alreadyTracked = false;

    if (verdict.relation === "new") {
      const issue = await createGithubIssue(githubToken, repo, {
        title: verdict.suggestedTitle.slice(0, 200),
        body: `${description.trim()}${attachmentMarkdown}\n\n---\nReported by ${claims.email ?? claims.sub} via in-app feedback form.`,
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
    } else {
      const matched = clusters.find(c => c.id === verdict.matchClusterId)!;
      clusterId = matched.id;
      issueNumber = matched.github_issue_number!;
      issueUrl = `https://github.com/${repo}/issues/${issueNumber}`;
      alreadyTracked = true;
      await addGithubComment(githubToken, repo, issueNumber,
        `**Another report of this** (${claims.email ?? claims.sub}):\n\n> ${description.trim().replace(/\n/g, "\n> ")}${attachmentMarkdown}`);
    }

    await attachReportToCluster(actionsConfig, stored.id, clusterId, verdict.variantLabel);

    const tally = await tallyFor(actionsConfig, clusterId);
    const reportCount = tally.reduce((sum, t) => sum + t.reporters, 0);
    await updateIssueTally(githubToken, repo, issueNumber, tally);
    const outcome = decideEscalation(type, tally);
    await applyOutcome(actionsConfig, githubToken, repo, clusterId, issueNumber, outcome);

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
    if (verdict.relation === "new") {
      const issue = await createGithubIssue(githubToken, repo, {
        title: verdict.suggestedTitle.slice(0, 200),
        body: `${orphan.description}\n\n---\nRecovered from a failed submission.`,
        labels: [FEEDBACK_LABELS[orphan.type as "bug" | "feature"], "customer-reported"],
      });
      const clusterId = await createCluster(config, {
        type: orphan.type,
        title: verdict.suggestedTitle,
        summary: verdict.suggestedSummary,
        githubIssueNumber: issue.number,
      });
      await attachReportToCluster(config, orphan.id, clusterId, verdict.variantLabel);
    } else {
      await attachReportToCluster(config, orphan.id, verdict.matchClusterId!, verdict.variantLabel);
    }
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
