#!/usr/bin/env node
// qa-import-prod.mjs — SAFE import: only approved public tables to local QA.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, closeSync } from "node:fs";
import path from "node:path";

const DEST_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const SOURCE_URL = process.env.QA_PROD_SOURCE_URL;

if (!/127\.0\.0\.1|localhost/.test(DEST_URL)) {
  console.error(`Refusing: destination is not local (${DEST_URL})`);
  process.exit(1);
}
if (!SOURCE_URL) {
  console.error("QA_PROD_SOURCE_URL not set. Set it to the production database URL.");
  process.exit(1);
}

const ALLOWED_TABLES = [
  "seasons",
  "games",
  "game_events",
  "game_lineups",
  "players",
  "teams",
  "organizations",
];
const FORBIDDEN_REFERENCES = ["auth.", "storage.", "team_members", "player_private", "cron", "pipeline", "realtime"];

function run(command, args, options = {}) {
  try {
    execFileSync(command, args, { stdio: "inherit", ...options });
  } catch {
    console.error(`Command failed: ${command}`);
    process.exit(1);
  }
}

const qaDir = path.join(process.cwd(), ".qa");
if (!existsSync(qaDir)) mkdirSync(qaDir, { recursive: true });
const dumpFile = path.join(qaDir, `prod-dump-${Date.now()}.sql`);

console.log("QA Safe Import — approved tables only");
console.log("Allowed:", ALLOWED_TABLES.join(", "));
console.log("Dest:", DEST_URL);

const containerId = execFileSync("docker", ["ps", "-qf", "name=supabase_db"], { encoding: "utf8" }).trim();
if (!containerId) {
  console.error("No local Supabase database container found. Run npx supabase start first.");
  process.exit(1);
}

console.log("Dumping approved tables from source...");
const dumpFd = openSync(dumpFile, "w", 0o600);
try {
  execFileSync(
    "docker",
    [
      "exec",
      containerId,
      "pg_dump",
      SOURCE_URL,
      "--data-only",
      "--no-owner",
      "--no-privileges",
      "--schema=public",
      ...ALLOWED_TABLES.map((table) => `--table=public.${table}`),
    ],
    { stdio: ["ignore", dumpFd, "inherit"] }
  );
} catch {
  console.error("pg_dump failed. Check QA_PROD_SOURCE_URL and network access from Docker.");
  process.exit(1);
} finally {
  closeSync(dumpFd);
}

const dumpContent = readFileSync(dumpFile, "utf8");
for (const reference of FORBIDDEN_REFERENCES) {
  if (dumpContent.includes(reference)) {
    console.error(`Dump contains forbidden reference: ${reference}. Aborting.`);
    process.exit(1);
  }
}

console.log("Resetting local database...");
run("npm", ["run", "qa:reset"]);

const restoreContainerId = execFileSync("docker", ["ps", "-qf", "name=supabase_db"], { encoding: "utf8" }).trim();
if (!restoreContainerId) {
  console.error("No local Supabase database container found after reset.");
  process.exit(1);
}

console.log("Clearing approved local QA tables before restore...");
run("docker", [
  "exec",
  restoreContainerId,
  "psql",
  "-v",
  "ON_ERROR_STOP=1",
  "-U",
  "postgres",
  "-d",
  "postgres",
  "-c",
  `truncate table ${ALLOWED_TABLES.map((table) => `public.${table}`).join(", ")} cascade`,
]);

console.log("Restoring approved data into local QA...");
const restoreFd = openSync(dumpFile, "r");
try {
  execFileSync("docker", ["exec", "-i", restoreContainerId, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], {
    stdio: [restoreFd, "inherit", "inherit"],
  });
} catch {
  console.error("Restore failed. Local database stays isolated; run npm run qa:reset to recover.");
  process.exit(1);
} finally {
  closeSync(restoreFd);
}

console.log("Re-seeding local test identities and memberships...");
run("node", ["--env-file=.env.local", "scripts/seed-local-users.mjs"]);
const membershipFd = openSync("scripts/seed-local-memberships.sql", "r");
try {
  execFileSync("docker", ["exec", "-i", restoreContainerId, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], {
    stdio: [membershipFd, "inherit", "inherit"],
  });
} catch {
  console.error("Membership seed failed. Run npm run qa:reset to recover.");
  process.exit(1);
} finally {
  closeSync(membershipFd);
}

console.log("QA environment ready with approved production data.");
