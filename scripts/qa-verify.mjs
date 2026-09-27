#!/usr/bin/env node
// qa-verify.mjs — Verify local QA stack: runs migrations reset, seed, pgTAP tests, and gateway tests.
// Refuses to run against non-local Supabase URL.

import { execSync } from "node:child_process";

const URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";

if (!/127\.0\.0\.1|localhost/.test(URL)) {
  console.error(`❌  Refusing to verify QA against non-local URL: ${URL}`);
  process.exit(1);
}

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  try {
    execSync(cmd, { stdio: "inherit", ...opts });
  } catch (e) {
    console.error(`❌  Verification failed at command: ${cmd}`);
    process.exit(1);
  }
}

console.log("🔍  Running local QA verification suite...");

// 1. Reset database + seed test users
run("npm run qa:reset");

// 2. Run pgTAP database tests
console.log("\n🧪  Running pgTAP database tests...");
run("npx supabase test db");

// 3. Run gateway tests
console.log("\n🧪  Running gateway tests...");
run("npm run test:gateway");

// 4. Run frontend unit tests
console.log("\n🧪  Running frontend unit tests...");
run("npm run test:frontend");

// 5. Run frontend typecheck & build
console.log("\n📦  Verifying frontend build & typecheck...");
run("npm run typecheck:frontend");
run("npm run build");

console.log("\n✨  All QA verification checks passed successfully!");
