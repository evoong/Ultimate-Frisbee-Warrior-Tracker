import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

process.env.VERCEL = '1';
process.env.SUPABASE_URL = 'https://example.test';
process.env.SUPABASE_SECRET_KEY = 'service-role-key';
process.env.SUPABASE_PUBLISHABLE_KEY = 'publishable-key';
process.env.SUPABASE_JWKS_URL = 'https://example.test/auth/v1/.well-known/jwks.json';
process.env.POSTHOG_PROJECT_TOKEN = 'posthog-token';

const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = await exportJWK(publicKey);
jwk.kid = 'test-key';

const dbUpdates = [];
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(String(url));
  if (target.hostname === '127.0.0.1' || target.hostname === 'localhost') {
    return realFetch(url, init);
  }
  if (target.pathname.endsWith('/.well-known/jwks.json')) {
    return Response.json({ keys: [jwk] });
  }
  if (target.pathname === '/rest/v1/team_members') {
    const userId = target.searchParams.get('user_id')?.replace('eq.', '');
    const role = userId === 'captain' ? 'captain' : userId === 'member' ? 'member' : null;
    return Response.json(role ? [{ team_id: 1, role }] : []);
  }
  if (target.pathname === '/rest/v1/organizations' && init.method === 'PATCH') {
    const update = JSON.parse(String(init.body));
    dbUpdates.push(update);
    // `.single()` requests PostgREST's object response media type.
    return Response.json({ id: 1, name: 'Test Org', tier: update.tier, plan_source: update.plan_source, trial_ends_at: update.trial_ends_at });
  }
  throw new Error(`Unexpected fetch: ${url}`);
};

const app = (await import('../index.ts')).default;
const server = createServer(app);
await new Promise(resolve => server.listen(0, resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function tokenFor(sub) {
  return new SignJWT({ email: `${sub}@example.test` })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer('https://example.test/auth/v1')
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

async function request(body, token) {
  const response = await fetch(`${origin}/api/org/plan`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { cookie: `ufwt_at=${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

try {
  let result = await request({ organization_id: 0, tier: 'plus' });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Invalid organization_id or tier');

  result = await request({ organization_id: 1, tier: 'enterprise' });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Invalid organization_id or tier');

  result = await request({ organization_id: 1, tier: 'plus' });
  assert.equal(result.status, 401);
  assert.equal(result.body.error, 'not authenticated');

  result = await request({ organization_id: 1, tier: 'plus' }, await tokenFor('member'));
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'Only team captains or admins can change subscription plans');

  result = await request({ organization_id: 1, tier: 'premium' }, await tokenFor('captain'));
  assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
  assert.equal(result.body.organization.id, 1);
  assert.equal(result.body.organization.tier, 'premium');
  assert.equal(result.body.organization.plan_source, 'stripe');
  assert.match(result.body.organization.trial_ends_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(dbUpdates.at(-1).tier, 'premium');
  assert.equal(dbUpdates.at(-1).plan_source, 'stripe');
  assert.match(dbUpdates.at(-1).trial_ends_at, /^\d{4}-\d{2}-\d{2}T/);

  console.log('✓ POST /api/org/plan validates, authorizes, and updates plan');
} finally {
  await new Promise(resolve => server.close(resolve));
}
