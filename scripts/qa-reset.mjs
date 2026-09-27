#!/usr/bin/env node
// qa-reset.mjs — Reset local QA database to clean migrations + seed + test users.
// Refuses to run against non-local Supabase URL.
// Automatically syncs .env.local from the local running stack.

import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";

function assertLocal() {
  if (!/127\.0\.0\.1|localhost/.test(URL)) {
    console.error(`❌  Refusing to reset QA against non-local URL: ${URL}`);
    console.error("   QA commands only target the local Supabase stack (supabase start).");
    process.exit(1);
  }
}

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  try {
    execSync(cmd, { stdio: "inherit", ...opts });
  } catch (e) {
    console.error(`❌  Command failed: ${cmd}`);
    process.exit(1);
  }
}

function syncEnvLocal() {
  try {
    const raw = execSync("npx supabase status -o env", { stdio: ["pipe", "pipe", "ignore"] }).toString();
    const map = {};
    for (const line of raw.split("\n")) {
      const match = line.match(/^([A-Z_]+)="?(.*?)"?$/);
      if (match) map[match[1]] = match[2];
    }
    const apiUrl = map.API_URL || "http://127.0.0.1:54321";
    const jwks = `${apiUrl}/auth/v1/.well-known/jwks.json`;
    const env = [
      `SUPABASE_URL=${apiUrl}`,
      `SUPABASE_SECRET_KEY=${map.SERVICE_ROLE_KEY || ""}`,
      `SUPABASE_PUBLISHABLE_KEY=${map.ANON_KEY || ""}`,
      `SUPABASE_JWKS_URL=${jwks}`,
      `DATABASE_URL=${map.DB_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres"}`,
    ].join("\n");
    writeFileSync(".env.local", env + "\n");
    console.log("📝  Synced .env.local from running Supabase stack.");
  } catch (e) {
    console.warn("⚠️  Could not auto-sync .env.local from supabase status. Continuing.");
  }
}

assertLocal();

console.log("🔄  Resetting local QA database...");
run("npx supabase db reset");

syncEnvLocal();

console.log("👤  Seeding test identities...");
run("node --env-file=.env.local scripts/seed-local-users.mjs");

const membershipSql = "scripts/seed-local-memberships.sql";
if (existsSync(membershipSql)) {
  console.log("🔗  Seeding local memberships...");
  run(`docker exec -i $(docker ps -qf name=supabase_db) psql -v ON_ERROR_STOP=1 -U postgres -d postgres < ${membershipSql}`);
} else {
  console.warn("⚠️  seed-local-memberships.sql not found, skipping membership seed");
}

console.log("✅  QA database reset complete.");
console.log(`   URL:      ${URL}`);
console.log(`   Studio:   http://127.0.0.1:54323`);
