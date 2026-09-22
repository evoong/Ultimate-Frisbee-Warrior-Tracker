import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://example.test';
process.env.SUPABASE_SECRET_KEY = 'service-role-key';

const scenarios = new Map([
  [1, { tier: 'premium', allowed: true }],
  [2, { tier: 'free', allowed: false }],
  [3, { tier: 'plus', allowed: true }],
  [4, { rpcError: 'tier lookup failed' }],
  [5, { tier: 'free', consumeError: 'consume failed' }],
]);

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  const path = new URL(String(url)).pathname;
  const body = init.body ? JSON.parse(init.body) : {};
  const scenario = scenarios.get(body.p_org_id);

  if (path.endsWith('/effective_tier')) {
    if (scenario?.rpcError) return Response.json({ message: scenario.rpcError }, { status: 400 });
    return Response.json(scenario?.tier);
  }
  if (path.endsWith('/consume_ai_message')) {
    if (scenario?.consumeError) return Response.json({ message: scenario.consumeError }, { status: 500 });
    return Response.json(scenario?.allowed);
  }
  throw new Error(`Unexpected URL: ${url}`);
};

const { consumeAiMessage, getOrgEffectiveTier } = await import('../lib/tierLimits.ts');

assert.equal(await consumeAiMessage(1), true, 'Premium consumption is allowed');
assert.equal(await consumeAiMessage(2), false, 'Free quota exhaustion is blocked');
assert.equal(await consumeAiMessage(3), true, 'Plus quota availability is allowed');
assert.equal(await getOrgEffectiveTier(1), 'premium', 'effective tier resolves through RPC');
await assert.rejects(() => getOrgEffectiveTier(4), { message: 'tier lookup failed' });
await assert.rejects(() => consumeAiMessage(5), { message: 'consume failed' });
assert(calls.some(({ url }) => url.endsWith('/rest/v1/rpc/consume_ai_message')));
assert(!calls.some(({ url }) => url.endsWith('/rest/v1/ai_usage_logs')));
console.log('✓ AI consumption delegates quota and increment atomically to the database');
