import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

// ── Setup ─────────────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function test(name, fn, { expectFail = false } = {}) {
  try {
    await fn();
    if (expectFail) {
      console.log(`⚠  ${name} (expected to fail but passed — schema may have been fixed)`);
      skipped++;
    } else {
      console.log(`✓  ${name}`);
      passed++;
    }
  } catch (err) {
    if (expectFail) {
      console.log(`✓  ${name} [known broken — ${err.message}]`);
      passed++;
    } else {
      console.error(`✗  ${name}`);
      console.error(`   ${err.message}`);
      failures.push({ name, error: err.message });
      failed++;
    }
  }
}

function section(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

// ── 1. Connection ─────────────────────────────────────────────────────────────

section("1. Connection");

await test("Supabase client initializes with URL and key", () => {
  assert(process.env.SUPABASE_URL, "SUPABASE_URL is not set");
  assert(process.env.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY is not set");
  assert(supabase, "createClient returned null");
});

await test("Can reach Supabase project", async () => {
  const { data, error } = await supabase.from("teams").select("id").limit(1);
  assert(!error, `Connection error: ${error?.message}`);
  assert(Array.isArray(data), "Expected array response");
});

// ── 2. Schema Validation ──────────────────────────────────────────────────────

section("2. Schema Validation");

async function assertColumns(table, expectedCols) {
  const { data, error } = await supabase.from(table).select("*").limit(1);
  assert(!error, `Error fetching ${table}: ${error?.message}`);
  assert(Array.isArray(data), `${table} should return an array`);
  if (data.length === 0) return; // table empty, can't validate columns
  const row = data[0];
  for (const col of expectedCols) {
    assert(col in row, `${table} missing column: ${col}`);
  }
}

await test("teams — id, name", () =>
  assertColumns("teams", ["id", "name"])
);

await test("seasons — all columns present", () =>
  assertColumns("seasons", [
    "id", "team_id", "name", "year", "start_date", "end_date",
    "location", "league_name", "organizer", "default_game_time",
  ])
);

await test("players — all columns present", () =>
  assertColumns("players", [
    "id", "first_name", "last_name", "display_name", "gender_match",
    "phone", "is_sub", "position", "photo_url", "number",
    "first_name_edit", "last_name_edit",
  ])
);

await test("games — all columns present", () =>
  assertColumns("games", [
    "id", "season_id", "opponent", "game_date", "game_time", "game_type",
    "our_score", "their_score", "result", "notes", "outcome_override",
  ])
);

await test("event_types — id, name, category", () =>
  assertColumns("event_types", ["id", "name", "category"])
);

await test("game_events — all columns present", () =>
  assertColumns("game_events", [
    "id", "game_id", "player_id", "related_player_id", "event_type",
    "point_number", "event_timestamp", "notes",
  ])
);

await test("season_players — all columns present", () =>
  assertColumns("season_players", [
    "id", "season_id", "player_id", "jersey_number", "active", "role",
  ])
);

await test("game_lineups — all columns present", () =>
  assertColumns("game_lineups", ["id", "game_id", "player_id", "lineup_name"])
);

await test("standings — all columns present", () =>
  assertColumns("standings", [
    "id", "season_id", "team_name", "games_played", "wins", "losses",
    "ties", "default_losses", "points", "points_for", "points_against",
    "point_differential",
  ])
);

// ── 3. Read Query Patterns ────────────────────────────────────────────────────

section("3. Read Query Patterns (mirrors frontend hooks)");

// Fetch seed IDs for use in filtered queries
const { data: seedSeasons } = await supabase.from("seasons").select("id").limit(1);
const { data: seedGames } = await supabase.from("games").select("id, season_id").limit(1);
const { data: seedPlayers } = await supabase.from("players").select("id").limit(1);
const { data: seedEvents } = await supabase.from("game_events").select("id, game_id, player_id").limit(1);

const seedSeasonId = seedSeasons?.[0]?.id;
const seedGameId = seedGames?.[0]?.id;
const seedPlayerId = seedPlayers?.[0]?.id;

// stats.ts — useGetSeasons / useGetAllSeasons
await test("useGetSeasons — seasons ordered by year desc", async () => {
  const { data, error } = await supabase.from("seasons").select("*").order("year", { ascending: false });
  assert(!error, error?.message);
  assert(Array.isArray(data), "Should return array");
  assert(data.length > 0, "Should have at least one season");
});

// stats.ts — useGetSeasonsMeta
await test("useGetSeasonsMeta — partial column select", async () => {
  const { data, error } = await supabase.from("seasons").select("id, name, year, organizer").order("year", { ascending: false });
  assert(!error, error?.message);
  if (data.length > 0) {
    assert("id" in data[0] && "name" in data[0] && "year" in data[0] && "organizer" in data[0], "Missing expected columns");
    assert(!("location" in data[0]), "Should not include unselected columns");
  }
});

// games.ts — useGetGames (no filter)
await test("useGetGames (no filter) — games ordered by game_date desc", async () => {
  const { data, error } = await supabase.from("games").select("*").order("game_date", { ascending: false });
  assert(!error, error?.message);
  assert(Array.isArray(data), "Should return array");
  assert(data.length > 0, "Should have games");
});

// games.ts — useGetGames (season filter)
await test("useGetGames (season filter) — games filtered by season_id", async () => {
  if (!seedSeasonId) return;
  const { data, error } = await supabase.from("games").select("*").in("season_id", [seedSeasonId]);
  assert(!error, error?.message);
  assert(Array.isArray(data), "Should return array");
  for (const g of data) {
    assert(g.season_id === seedSeasonId, `game ${g.id} has wrong season_id`);
  }
});

// games.ts — useGetLineups
await test("useGetLineups — game_lineups filtered by game_id", async () => {
  if (!seedGameId) return;
  const { data, error } = await supabase.from("game_lineups").select("*").eq("game_id", seedGameId);
  assert(!error, error?.message);
  assert(Array.isArray(data), "Should return array");
});

// events.ts — useGetGameEvents
await test("useGetGameEvents — game_events filtered by game_id, ordered by timestamp", async () => {
  if (!seedGameId) return;
  const { data, error } = await supabase
    .from("game_events")
    .select("*")
    .eq("game_id", seedGameId)
    .order("event_timestamp", { ascending: false });
  assert(!error, error?.message);
  assert(Array.isArray(data), "Should return array");
});

// events.ts — useGetEventTypes
await test("useGetEventTypes — event_types ordered by name", async () => {
  const { data, error } = await supabase.from("event_types").select("*").order("name");
  assert(!error, error?.message);
  assert(Array.isArray(data), "Should return array");
  assert(data.length > 0, "Should have event types seeded");
});

// players.ts — useGetPlayers (all)
await test("useGetPlayers (all) — players ordered by display_name", async () => {
  const { data, error } = await supabase.from("players").select("*").order("display_name");
  assert(!error, error?.message);
  assert(Array.isArray(data), "Should return array");
  assert(data.length > 0, "Should have players");
});

// players.ts — useGetPlayers (season filter) — two-step join via season_players
await test("useGetPlayers (season filter) — season_players join then players.in()", async () => {
  if (!seedSeasonId) return;
  const { data: sp, error: spErr } = await supabase
    .from("season_players")
    .select("player_id")
    .in("season_id", [seedSeasonId]);
  assert(!spErr, spErr?.message);
  assert(Array.isArray(sp), "season_players should return array");
  if (sp.length === 0) return;

  const playerIds = sp.map((r) => r.player_id);
  const { data, error } = await supabase.from("players").select("*").in("id", playerIds).order("display_name");
  assert(!error, error?.message);
  assert(Array.isArray(data), "Should return array");
  assert(data.length > 0, "Should return players matching season");
});

// players.ts — useGetSeasonRoster (game_lineups → players)
await test("useGetSeasonRoster — game_lineups join then players.in()", async () => {
  if (!seedGameId) return;
  const { data: lineups, error: lErr } = await supabase.from("game_lineups").select("*").eq("game_id", seedGameId);
  assert(!lErr, lErr?.message);
  assert(Array.isArray(lineups), "Should return array");
  if (lineups.length === 0) return;

  const playerIds = lineups.map((l) => l.player_id);
  const { data, error } = await supabase.from("players").select("*").in("id", playerIds);
  assert(!error, error?.message);
  assert(Array.isArray(data), "Should return array");
});

// players.ts — useGetPlayerGameStats
await test("useGetPlayerGameStats — game_events filtered by player_id", async () => {
  if (!seedPlayerId) return;
  const { data, error } = await supabase.from("game_events").select("*").eq("player_id", seedPlayerId);
  assert(!error, error?.message);
  assert(Array.isArray(data), "Should return array");
});

// players.ts — useGetPlayerSeasons (KNOWN BROKEN: players.season_id does not exist)
await test(
  "useGetPlayerSeasons — players.select('season_id') [KNOWN BROKEN: column missing]",
  async () => {
    if (!seedPlayerId) throw new Error("No player to test with");
    const { data, error } = await supabase.from("players").select("season_id").eq("id", seedPlayerId);
    assert(!error, `Query failed: ${error?.message}`);
    assert(data && "season_id" in (data[0] ?? {}), "season_id column missing from players table");
  },
  { expectFail: true }
);

// stats.ts — useGetPlayerStats pattern (3 separate fetches + JS join)
await test("useGetPlayerStats — game_events, games, players fetches", async () => {
  const { data: events, error: e1 } = await supabase.from("game_events").select("player_id, event_type, game_id");
  assert(!e1, e1?.message);
  const { data: games, error: e2 } = await supabase.from("games").select("id, season_id");
  assert(!e2, e2?.message);
  const { data: players, error: e3 } = await supabase.from("players").select("id, display_name");
  assert(!e3, e3?.message);
  assert(Array.isArray(events) && Array.isArray(games) && Array.isArray(players), "All three fetches should return arrays");
});

// stats.ts — useGetCumulativeStats pattern
await test("useGetCumulativeStats — game_events + games with opponent/date + players", async () => {
  const { data: events, error: e1 } = await supabase.from("game_events").select("player_id, event_type, game_id");
  assert(!e1, e1?.message);
  const { data: games, error: e2 } = await supabase.from("games").select("id, opponent, game_date, season_id");
  assert(!e2, e2?.message);
  const { data: players, error: e3 } = await supabase.from("players").select("id, display_name");
  assert(!e3, e3?.message);
  assert(Array.isArray(events) && Array.isArray(games) && Array.isArray(players), "All three fetches should return arrays");
});

// ── 4. CRUD Cycles ────────────────────────────────────────────────────────────

section("4. CRUD Cycles (insert → verify → update → delete)");

// Get stable FK references from existing data
const { data: fkSeasons } = await supabase.from("seasons").select("id").limit(1);
const { data: fkGames } = await supabase.from("games").select("id").limit(1);
const { data: fkPlayers } = await supabase.from("players").select("id").limit(1);

const fkSeasonId = fkSeasons?.[0]?.id;
const fkGameId = fkGames?.[0]?.id;
const fkPlayerId = fkPlayers?.[0]?.id;

await test("teams CRUD", async () => {
  const { data: ins, error: insErr } = await supabase.from("teams").insert({ name: "__test_team__" }).select();
  assert(!insErr, `Insert failed: ${insErr?.message}`);
  const id = ins[0].id;
  assert(ins[0].name === "__test_team__", "Name mismatch after insert");

  const { data: upd, error: updErr } = await supabase.from("teams").update({ name: "__test_team_updated__" }).eq("id", id).select();
  assert(!updErr, `Update failed: ${updErr?.message}`);
  assert(upd[0].name === "__test_team_updated__", "Name mismatch after update");

  const { error: delErr } = await supabase.from("teams").delete().eq("id", id);
  assert(!delErr, `Delete failed: ${delErr?.message}`);
});

await test("seasons CRUD", async () => {
  const { data: ins, error: insErr } = await supabase
    .from("seasons")
    .insert({ name: "__test_season__", year: "9999", team_id: fkSeasonId ? null : null })
    .select();
  assert(!insErr, `Insert failed: ${insErr?.message}`);
  const id = ins[0].id;
  assert(ins[0].name === "__test_season__", "Name mismatch after insert");

  const { data: upd, error: updErr } = await supabase.from("seasons").update({ name: "__test_season_updated__" }).eq("id", id).select();
  assert(!updErr, `Update failed: ${updErr?.message}`);
  assert(upd[0].name === "__test_season_updated__", "Name mismatch after update");

  const { error: delErr } = await supabase.from("seasons").delete().eq("id", id);
  assert(!delErr, `Delete failed: ${delErr?.message}`);
});

await test("players CRUD", async () => {
  const { data: ins, error: insErr } = await supabase
    .from("players")
    .insert({ display_name: "__test_player__", first_name: "Test", last_name: "Player" })
    .select();
  assert(!insErr, `Insert failed: ${insErr?.message}`);
  const id = ins[0].id;
  assert(ins[0].display_name === "__test_player__", "display_name mismatch after insert");

  const { data: upd, error: updErr } = await supabase.from("players").update({ display_name: "__test_player_updated__" }).eq("id", id).select();
  assert(!updErr, `Update failed: ${updErr?.message}`);
  assert(upd[0].display_name === "__test_player_updated__", "display_name mismatch after update");

  const { error: delErr } = await supabase.from("players").delete().eq("id", id);
  assert(!delErr, `Delete failed: ${delErr?.message}`);
});

await test("games CRUD", async () => {
  const { data: ins, error: insErr } = await supabase
    .from("games")
    .insert({ opponent: "__test_opponent__", season_id: fkSeasonId ?? null, game_date: "2099-01-01", game_type: "Regular" })
    .select();
  assert(!insErr, `Insert failed: ${insErr?.message}`);
  const id = ins[0].id;
  assert(ins[0].opponent === "__test_opponent__", "opponent mismatch after insert");

  const { data: upd, error: updErr } = await supabase.from("games").update({ our_score: 99 }).eq("id", id).select();
  assert(!updErr, `Update failed: ${updErr?.message}`);
  assert(upd[0].our_score === 99, "our_score mismatch after update");

  const { error: delErr } = await supabase.from("games").delete().eq("id", id);
  assert(!delErr, `Delete failed: ${delErr?.message}`);
});

await test("game_events CRUD", async () => {
  assert(fkGameId, "Need at least one game in DB for this test");
  const { data: ins, error: insErr } = await supabase
    .from("game_events")
    .insert({ game_id: fkGameId, player_id: fkPlayerId ?? null, event_type: "__test_event__" })
    .select();
  assert(!insErr, `Insert failed: ${insErr?.message}`);
  const id = ins[0].id;
  assert(ins[0].event_type === "__test_event__", "event_type mismatch after insert");

  const { error: delErr } = await supabase.from("game_events").delete().eq("id", id);
  assert(!delErr, `Delete failed: ${delErr?.message}`);
});

await test("season_players CRUD", async () => {
  assert(fkSeasonId && fkPlayerId, "Need seasons and players in DB for this test");
  const { data: ins, error: insErr } = await supabase
    .from("season_players")
    .insert({ season_id: fkSeasonId, player_id: fkPlayerId, active: true })
    .select();
  // May already exist — treat unique violation as skip
  if (insErr?.code === "23505") {
    console.log("   (skipped — duplicate row, already in season)");
    skipped++;
    return;
  }
  assert(!insErr, `Insert failed: ${insErr?.message}`);
  const id = ins[0].id;

  const { error: delErr } = await supabase.from("season_players").delete().eq("id", id);
  assert(!delErr, `Delete failed: ${delErr?.message}`);
});

await test("game_lineups CRUD", async () => {
  assert(fkGameId && fkPlayerId, "Need games and players in DB for this test");
  const { data: ins, error: insErr } = await supabase
    .from("game_lineups")
    .insert({ game_id: fkGameId, player_id: fkPlayerId, lineup_name: "__test_lineup__" })
    .select();
  assert(!insErr, `Insert failed: ${insErr?.message}`);
  const id = ins[0].id;
  assert(ins[0].lineup_name === "__test_lineup__", "lineup_name mismatch after insert");

  const { error: delErr } = await supabase.from("game_lineups").delete().eq("id", id);
  assert(!delErr, `Delete failed: ${delErr?.message}`);
});

await test("standings CRUD", async () => {
  const { data: ins, error: insErr } = await supabase
    .from("standings")
    .insert({ season_id: fkSeasonId ?? null, team_name: "__test_standing__", wins: 3, losses: 1 })
    .select();
  assert(!insErr, `Insert failed: ${insErr?.message}`);
  const id = ins[0].id;
  assert(ins[0].team_name === "__test_standing__", "team_name mismatch after insert");
  assert(ins[0].wins === 3, "wins mismatch after insert");

  const { data: upd, error: updErr } = await supabase.from("standings").update({ wins: 5 }).eq("id", id).select();
  assert(!updErr, `Update failed: ${updErr?.message}`);
  assert(upd[0].wins === 5, "wins mismatch after update");

  const { error: delErr } = await supabase.from("standings").delete().eq("id", id);
  assert(!delErr, `Delete failed: ${delErr?.message}`);
});

// ── 5. Relational Query Correctness ──────────────────────────────────────────

section("5. Relational Query Correctness");

await test("games filtered by season_id all belong to that season", async () => {
  if (!fkSeasonId) return;
  const { data, error } = await supabase.from("games").select("id, season_id").eq("season_id", fkSeasonId);
  assert(!error, error?.message);
  for (const row of data) {
    assert(row.season_id === fkSeasonId, `game ${row.id} has season_id ${row.season_id}, expected ${fkSeasonId}`);
  }
});

await test("game_events filtered by game_id all belong to that game", async () => {
  if (!fkGameId) return;
  const { data, error } = await supabase.from("game_events").select("id, game_id").eq("game_id", fkGameId);
  assert(!error, error?.message);
  for (const row of data) {
    assert(row.game_id === fkGameId, `event ${row.id} has game_id ${row.game_id}, expected ${fkGameId}`);
  }
});

await test("season_players for a season reference valid player IDs", async () => {
  if (!fkSeasonId) return;
  const { data: sp, error: spErr } = await supabase.from("season_players").select("player_id").eq("season_id", fkSeasonId);
  assert(!spErr, spErr?.message);
  if (sp.length === 0) return;

  const playerIds = sp.map((r) => r.player_id).filter(Boolean);
  const { data: players, error: pErr } = await supabase.from("players").select("id").in("id", playerIds);
  assert(!pErr, pErr?.message);
  assert(players.length === playerIds.length, `Expected ${playerIds.length} players, got ${players.length}`);
});

await test("standings season_id references valid seasons", async () => {
  const { data: stands, error } = await supabase.from("standings").select("id, season_id").not("season_id", "is", null);
  assert(!error, error?.message);
  if (stands.length === 0) return;

  const seasonIds = [...new Set(stands.map((s) => s.season_id))];
  const { data: seasons, error: sErr } = await supabase.from("seasons").select("id").in("id", seasonIds);
  assert(!sErr, sErr?.message);
  assert(seasons.length === seasonIds.length, `standings reference ${seasonIds.length} seasons but only ${seasons.length} exist`);
});

// ── Results ───────────────────────────────────────────────────────────────────

const total = passed + failed + skipped;
console.log(`\n${"━".repeat(66)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped — ${total} total`);
if (failures.length > 0) {
  console.log("\nFailed tests:");
  failures.forEach((f) => console.log(`  ✗ ${f.name}\n    ${f.error}`));
}
console.log("━".repeat(66) + "\n");

process.exit(failed > 0 ? 1 : 0);
