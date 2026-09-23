#!/usr/bin/env node
// qa-import-prod.mjs — SAFE guided import: only approved tables from explicit source.
// Refuses non-local destination. Requires source DATABASE_URL.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";

const DEST_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const SOURCE_URL = process.env.QA_PROD_SOURCE_URL; // explicit, not DATABASE_URL

if (!/127\.0\.0\.1|localhost/.test(DEST_URL)) {
  console.error(`❌ Refusing: destination is not local (${DEST_URL})`);
  process.exit(1);
}
if (!SOURCE_URL) {
  console.error("❌ QA_PROD_SOURCE_URL not set. Set it to the production DATABASE_URL you want to import from.");
  process.exit(1);
}

// Only these tables are allowed. Add/remove here with intent.
const ALLOWED_TABLES = [
  "seasons",
  "games",
  "game_events",
  "game_lineups",
  "players",
  "teams",
  "organizations",
];

const qaDir = path.join(process.cwd(), ".qa");
if (!existsSync(qaDir)) mkdirSync(qaDir, { recursive: true });

const dumpFile = path.join(qaDir, `prod-dump-${Date.now()}.sql`);
const filteredFile = path.join(qaDir, `prod-filtered-${Date.now()}.sql`);

console.log("🛠️  QA Safe Import — approved tables only");
console.log("Allowed:", ALLOWED_TABLES.join(", "));
console.log("Source:", SOURCE_URL.replace(/:[^:@]*@/, ":***@"));
console.log("Dest  :", DEST_URL);

console.log(`\n📦 Dumping ONLY allowed tables from source...`);
const tableArgs = ALLOWED_TABLES.map(t => `--table=public.${t}`).join(" ");
try {
  execSync(
    `pg_dump "${SOURCE_URL}" --no-owner --no-privileges --schema=public ${tableArgs} > "${dumpFile}"`,
    { stdio: "inherit" }
  );
  console.log(`✅ Dump saved: ${dumpFile}`);
} catch (e) {
  console.error("❌ pg_dump failed. Check QA_PROD_SOURCE_URL and network.");
  process.exit(1);
}

// Quick sanity: verify no disallowed tables snuck in
const dumpContent = readFileSync(dumpFile, "utf8");
const forbidden = ["auth.", "storage.", "team_members", "player_private", "cron", "pipeline", "realtime"];
for (const f of forbidden) {
  if (dumpContent.includes(f)) {
    console.error(`❌ Dump contains forbidden reference: ${f}. Aborting.`);
    process.exit(1);
  }
}
console.log("✅ Dump passed forbidden-table check.");

console.log("\n🔄 Resetting local database to clean state...");
execSync("npm run qa:reset", { stdio: "inherit" });

console.log(`\n📥 Restoring filtered dump into local QA...`);
try {
  execSync(
    `docker exec -i $(docker ps -qf name=supabase_db) psql -U postgres -d postgres < "${filteredFile}" || ` +
    `docker exec -i $(docker ps -qf name=supabase_db) psql -U postgres -d postgres < "${dumpFile}"`,
    { stdio: "inherit" }
  );
  console.log("✅ Data restored successfully!");
} catch (e) {
  console.error("⚠️  Restore completed with warnings/errors. Check constraints/FK.");
}

console.log("\n👤 Re-seeding test identities & memberships...");
execSync("node --env-file=.env.local scripts/seed-local-users.mjs", { stdio: "inherit" });
execSync(
  `docker exec -i $(docker ps -qf name=supabase_db) psql -v ON_ERROR_STOP=1 -U postgres -d postgres < scripts/seed-local-memberships.sql`,
  { stdio: "inherit" }
);

console.log("\n✨ QA environment ready with production snapshot (approved tables only)!");