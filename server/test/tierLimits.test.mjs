import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://example.test';
process.env.SUPABASE_SECRET_KEY = 'service-role-key';

const scenarios = new Map([
  [1, { tier: 'free', members: 14, usage: 4 }],
  [2, { tier: 'free', members: 15, usage: 5 }],
  [3, { tier: 'plus', members: 34, usage: 99 }],
  [4, { tier: 'plus', members: 35, usage: 100 }],
  [5, { tier: 'premium', members: 1000, usage: 1000 }],
  [6, { tier: 'premium' }],
  [7, { tier: 'plus' }],
  [8, { rpcError: 'tier lookup failed' }],
  [9, { tier: 'free', usageError: 'usage lookup failed' }],
  [10, { tier: 'free', incrementError: 'increment failed' }],
]);

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  const path = new URL(String(url)).pathname;
  const body = init.body ? JSON.parse(init.body) : {};
  const searchParams = new URL(String(url)).searchParams;
  const eqNumber = (value) => Number(String(value ?? '').replace(/^eq\./, ''));
  const orgId = body.p_org_id ??
    (searchParams.get('organization_id') ? eqNumber(searchParams.get('organization_id')) : eqNumber(searchParams.get('team_id')));
  const scenario = scenarios.get(orgId);

  if (path.endsWith('/effective_tier')) {
    if (scenario?.rpcError) return Response.json({ message: scenario.rpcError }, { status: 400 });
    return Response.json(scenario?.tier);
  }
  if (path.endsWith('/team_members')) {
    return new Response('', { headers: { 'content-range': `0-${(scenario?.members ?? 0) - 1}/${scenario?.members ?? 0}` } });
  }
  if (path.endsWith('/ai_usage_logs')) {
    if (scenario?.usageError) return Response.json({ message: scenario.usageError }, { status: 500 });
    return Response.json(scenario?.usage == null ? null : { message_count: scenario.usage });
  }
  if (path.endsWith('/increment_ai_usage')) {
    if (scenario?.incrementError) return Response.json({ message: scenario.incrementError }, { status: 500 });
    return Response.json(null);
  }
  throw new Error(`Unexpected URL: ${url}`);
};

const { checkAiMessageLimit, checkMemberLimit, getOrgEffectiveTier, incrementAiUsage } = await import('../lib/tierLimits.ts');

assert.equal(await checkAiMessageLimit(1), true, 'Free permits first five messages');
assert.equal(await checkAiMessageLimit(2), false, 'Free blocks sixth message');
assert.equal(await checkAiMessageLimit(3), true, 'Plus permits first 100 messages');
assert.equal(await checkAiMessageLimit(4), false, 'Plus blocks 101st message');
assert.equal(await checkAiMessageLimit(5), true, 'Premium has no AI quota');

assert.equal(await checkMemberLimit(1), true, 'Free permits first 15 members');
assert.equal(await checkMemberLimit(2), false, 'Free blocks 16th member');
assert.equal(await checkMemberLimit(3), true, 'Plus permits first 35 members');
assert.equal(await checkMemberLimit(4), false, 'Plus blocks 36th member');
assert.equal(await checkMemberLimit(5), true, 'Premium has no member cap');

assert.equal(await getOrgEffectiveTier(6), 'premium', 'employee grant resolves to Premium');
assert.equal(await getOrgEffectiveTier(7), 'plus', 'active trial resolves to Plus');
await assert.rejects(() => getOrgEffectiveTier(8), { message: 'tier lookup failed' });
await assert.rejects(() => checkAiMessageLimit(9), { message: 'usage lookup failed' });
await assert.rejects(() => incrementAiUsage(10), { message: 'increment failed' });
await incrementAiUsage(1);
assert(calls.some(({ url }) => url.endsWith('/rest/v1/rpc/increment_ai_usage')));
console.log('✓ tier limits enforce Free, Plus, Premium, grants, trials, and RPC errors');
