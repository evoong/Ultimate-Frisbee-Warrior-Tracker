import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://example.test';
process.env.SUPABASE_SECRET_KEY = 'service-role-key';

const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  const path = new URL(String(url)).pathname;
  if (path.endsWith('/effective_tier')) return Response.json('plus');
  if (path.endsWith('/team_members')) return new Response('', { headers: { 'content-range': '0-34/34' } });
  if (path.endsWith('/ai_usage_logs')) return Response.json([{ message_count: 99 }]);
  if (path.endsWith('/increment_ai_usage')) return Response.json(null);
  throw new Error(`Unexpected URL: ${url}`);
};

const { checkAiMessageLimit, checkMemberLimit, getOrgEffectiveTier, incrementAiUsage } = await import('../lib/tierLimits.ts');

assert.equal(await getOrgEffectiveTier(7), 'plus');
assert.equal(await checkMemberLimit(7), true);
assert.equal(await checkAiMessageLimit(7), true);
await incrementAiUsage(7);
assert(calls.some(({ url }) => url.endsWith('/rest/v1/rpc/increment_ai_usage')));
console.log('✓ tier limit checks use effective tier, direct team_members count, and atomic usage RPC');
