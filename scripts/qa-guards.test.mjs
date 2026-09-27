import assert from "node:assert";
import { execSync } from "node:child_process";

// Test that QA scripts refuse non-local URLs (safety guard)
const scripts = ["scripts/qa-reset.mjs", "scripts/qa-verify.mjs", "scripts/qa-import-prod.mjs"];

for (const script of scripts) {
  let threw = false;
  try {
    execSync(`node ${script}`, {
      env: { ...process.env, SUPABASE_URL: "https://pyqngqyqwevfpaxcmfnd.supabase.co" },
      stdio: "pipe",
    });
  } catch (e) {
    threw = true;
    assert.strictEqual(e.status, 1, `${script} should exit 1 on non-local URL`);
    const output = e.stderr?.toString() || e.stdout?.toString();
    assert.match(output, /Refusing/i, `${script} should print refusal error message`);
  }
  assert.ok(threw, `${script} did not reject non-local SUPABASE_URL`);
}

// Test qa-import-prod requires QA_PROD_SOURCE_URL even on local dest
let threwNoSource = false;
try {
  execSync("node scripts/qa-import-prod.mjs", {
    env: { ...process.env, SUPABASE_URL: "http://127.0.0.1:54321", QA_PROD_SOURCE_URL: "" },
    stdio: "pipe",
  });
} catch (e) {
  threwNoSource = true;
  assert.strictEqual(e.status, 1);
  const output = e.stderr?.toString() || e.stdout?.toString();
  assert.match(output, /QA_PROD_SOURCE_URL not set/i);
}
assert.ok(threwNoSource, "qa-import-prod did not reject missing QA_PROD_SOURCE_URL");

console.log("✅ All QA safety guard tests passed!");
