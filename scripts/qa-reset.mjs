#!/usr/bin/env node
// qa-reset.mjs — Reset local QA database to clean migrations + seed + test users.
// Refuses to run against non-local Supabase URL.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

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

assertLocal();

console.log("🔄  Resetting local QA database...");

run("supabase db reset");

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