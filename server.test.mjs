import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ── TESTS ────────────────────────────────────────────────────────────────────

test("Supabase client initializes", () => {
  assert(supabase, "Supabase client should exist");
});

test("Can fetch seasons table", async () => {
  const { data, error } = await supabase
    .from("seasons")
    .select("*")
    .limit(1);
  assert(!error, `Error fetching seasons: ${error?.message}`);
  assert(data, "Should return data");
  assert(Array.isArray(data), "Data should be an array");
});

test("Can fetch games table", async () => {
  const { data, error } = await supabase
    .from("games")
    .select("*")
    .limit(1);
  assert(!error, `Error fetching games: ${error?.message}`);
  assert(data, "Should return data");
});

test("Can fetch players table", async () => {
  const { data, error } = await supabase
    .from("players")
    .select("*")
    .limit(1);
  assert(!error, `Error fetching players: ${error?.message}`);
  assert(data, "Should return data");
});

test("Can fetch game_events table", async () => {
  const { data, error } = await supabase
    .from("game_events")
    .select("*")
    .limit(1);
  assert(!error, `Error fetching game_events: ${error?.message}`);
  assert(Array.isArray(data), "Data should be an array");
});

test("Can fetch season_players table", async () => {
  const { data, error } = await supabase
    .from("season_players")
    .select("*")
    .limit(1);
  assert(!error, `Error fetching season_players: ${error?.message}`);
  assert(Array.isArray(data), "Data should be an array");
});

test("season_players has required columns", async () => {
  const { data, error } = await supabase
    .from("season_players")
    .select("*")
    .limit(1);
  assert(!error, `Error: ${error?.message}`);
  if (data && data.length > 0) {
    const record = data[0];
    assert(
      "season_id" in record,
      "season_players should have season_id column"
    );
    assert(
      "player_id" in record,
      "season_players should have player_id column"
    );
    assert(
      "active" in record,
      "season_players should have active boolean column"
    );
  }
});

test("games table has season_id foreign key", async () => {
  const { data, error } = await supabase
    .from("games")
    .select("*")
    .limit(1);
  assert(!error, `Error: ${error?.message}`);
  if (data && data.length > 0) {
    assert(
      "season_id" in data[0],
      "games should have season_id column for junction"
    );
  }
});

test("Can filter seasons by year", async () => {
  const { data, error } = await supabase
    .from("seasons")
    .select("*")
    .eq("year", 2026);
  assert(!error, `Error filtering seasons: ${error?.message}`);
  assert(Array.isArray(data), "Data should be an array");
});

test("Can filter games by season_id", async () => {
  const { data: seasons, error: seasonError } = await supabase
    .from("seasons")
    .select("id")
    .limit(1);
  assert(!seasonError, `Error fetching season: ${seasonError?.message}`);

  if (seasons && seasons.length > 0) {
    const { data, error } = await supabase
      .from("games")
      .select("*")
      .eq("season_id", seasons[0].id);
    assert(!error, `Error filtering games: ${error?.message}`);
    assert(Array.isArray(data), "Data should be an array");
  }
});

// ── RUN TESTS ────────────────────────────────────────────────────────────────

async function runTests() {
  console.log(`\n▶ Running ${tests.length} tests...\n`);

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`✗ ${name}`);
      console.error(`  Error: ${err.message}\n`);
      failed++;
    }
  }

  console.log(
    `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
  );
  console.log(`Results: ${passed} passed, ${failed} failed out of ${tests.length}`);
  console.log(
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`
  );

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
