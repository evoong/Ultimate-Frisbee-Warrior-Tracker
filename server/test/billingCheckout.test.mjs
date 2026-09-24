import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

process.env.VERCEL = '1';
process.env.SUPABASE_URL = 'https://example.test';
process.env.SUPABASE_SECRET_KEY = 'service-role-key';
process.env.SUPABASE_PUBLISHABLE_KEY = 'publishable-key';
process.env.SUPABASE_JWKS_URL = 'https://example.test/auth/v1/.well-known/jwks.json';
process.env.POSTHOG_PROJECT_TOKEN = 'posthog-token';
process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
process.env.STRIPE_PRICE_PLUS_MONTHLY = 'price_plus_monthly';
process.env.STRIPE_PRICE_PLUS_YEARLY = 'price_plus_yearly';
process.env.STRIPE_PRICE_PREMIUM_MONTHLY = 'price_premium_monthly';
process.env.STRIPE_PRICE_PREMIUM_YEARLY = 'price_premium_yearly';
process.env.APP_URL = 'http://localhost:5199';

const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = await exportJWK(publicKey);
jwk.kid = 'test-key';

const dbQueries = [];
const dbUpdates = [];
const stripeRequests = [];
let canStartTrialResult = true;

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
  if (target.pathname === '/rest/v1/rpc/can_start_trial') {
    dbQueries.push({ rpc: 'can_start_trial', args: JSON.parse(String(init.body)) });
    return Response.json(canStartTrialResult);
  }
  if (target.pathname === '/rest/v1/organizations' && (init.method ?? 'GET') === 'GET') {
    console.log('[MOCK] GET organizations', target.search);
    // getOrCreateStripeCustomer lookup
    return Response.json([{ id: 1, name: 'Test Org', stripe_customer_id: 'cus_test123' }]);
  }
  if (target.pathname === '/rest/v1/organizations' && init.method === 'PATCH') {
    const update = JSON.parse(String(init.body));
    dbUpdates.push(update);
    return Response.json({ id: 1, name: 'Test Org', stripe_customer_id: 'cus_test123', ...update });
  }
  // Stripe API mocks
  if (target.hostname === 'api.stripe.com' && target.pathname === '/v1/checkout/sessions') {
    stripeRequests.push({ body: Object.fromEntries(new URLSearchParams(String(init.body))) });
    return Response.json({
      id: 'cs_test_123',
      url: 'https://checkout.stripe.com/pay/cs_test_123',
      mode: 'subscription',
    });
  }
  if (target.hostname === 'api.stripe.com' && target.pathname === '/v1/billing_portal/sessions') {
    return Response.json({ id: 'bps_test_123', url: 'https://billing.stripe.com/p/session/test_123' });
  }
  if (target.hostname === 'api.stripe.com' && target.pathname === '/v1/customers') {
    return Response.json({ id: 'cus_new123', email: 'test@example.test' });
  }
  throw new Error(`Unexpected fetch: ${url}`);
};

async function tokenFor(sub) {
  return new SignJWT({ email: `${sub}@example.test` })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer('https://example.test/auth/v1')
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

async function runTests() {
  // Dynamic import after mocks
  const { default: app } = await import('../index.ts');
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    // Test 1: Repeat trial rejected before Stripe call
    console.log('Test 1: Repeat trial rejected via can_start_trial...');
    canStartTrialResult = false;
    let res = await fetch(`${origin}/api/billing/create-checkout-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ufwt_at=${await tokenFor('captain')}` },
      body: JSON.stringify({ organization_id: 1, tier: 'premium', interval: 'month', is_trial: true }),
    });
    assert.equal(res.status, 400);
    let body = await res.json();
    assert.equal(body.error, 'Trial already used for this organization');
    assert.equal(dbQueries.filter(q => q.rpc === 'can_start_trial').length, 1);
    console.log('✓ repeat trial checkout rejected');

    // Test 2: New trial creates checkout session with trial_period_days
    console.log('Test 2: New trial creates checkout session...');
    canStartTrialResult = true;
    dbQueries.length = 0;
    res = await fetch(`${origin}/api/billing/create-checkout-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ufwt_at=${await tokenFor('captain')}` },
      body: JSON.stringify({ organization_id: 1, tier: 'premium', interval: 'month', is_trial: true }),
    });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    body = await res.json();
    assert.ok(body.url, 'url returned');
    assert.ok(body.url.includes('checkout.stripe.com'), 'stripe checkout url');
    // Verify can_start_trial was called
    assert.equal(dbQueries.filter(q => q.rpc === 'can_start_trial').length, 1);
    // Verify Stripe was called with trial_period_days=30
    assert.equal(stripeRequests.length, 1);
    assert.equal(stripeRequests[0].body['subscription_data[trial_period_days]'], '30');
    assert.equal(stripeRequests[0].body['mode'], 'subscription');
    assert.equal(stripeRequests[0].body['customer'], 'cus_test123');
    console.log('✓ new trial checkout session created with 30-day trial param');

    // Test 3: Non-trial (upgrade) checkout works without can_start_trial
    console.log('Test 3: Upgrade checkout works without trial guard...');
    dbQueries.length = 0;
    stripeRequests.length = 0;
    res = await fetch(`${origin}/api/billing/create-checkout-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ufwt_at=${await tokenFor('captain')}` },
      body: JSON.stringify({ organization_id: 1, tier: 'plus', interval: 'month', is_trial: false }),
    });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    body = await res.json();
    assert.ok(body.url, 'url returned');
    // can_start_trial should NOT be called for non-trial
    assert.equal(dbQueries.filter(q => q.rpc === 'can_start_trial').length, 0);
    // Verify Stripe was called WITHOUT trial_period_days
    assert.equal(stripeRequests.length, 1);
    assert.ok(!('subscription_data[trial_period_days]' in stripeRequests[0].body));
    assert.equal(stripeRequests[0].body['mode'], 'subscription');
    console.log('✓ upgrade checkout session created without trial param');

    // Test 4: Member (non-captain) forbidden
    console.log('Test 4: Member forbidden...');
    res = await fetch(`${origin}/api/billing/create-checkout-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ufwt_at=${await tokenFor('member')}` },
      body: JSON.stringify({ organization_id: 1, tier: 'premium', interval: 'month', is_trial: true }),
    });
    assert.equal(res.status, 403);
    body = await res.json();
    assert.equal(body.error, 'Only team captains or admins can change subscription');
    console.log('✓ member forbidden');

    // Test 5: Unauthenticated returns 401
    console.log('Test 5: Unauthenticated returns 401...');
    res = await fetch(`${origin}/api/billing/create-checkout-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organization_id: 1, tier: 'premium', interval: 'month', is_trial: true }),
    });
    assert.equal(res.status, 401);
    console.log('✓ unauthenticated rejected');

    // Test 6: Portal session requires captain
    console.log('Test 6: Portal session requires captain...');
    res = await fetch(`${origin}/api/billing/create-portal-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ufwt_at=${await tokenFor('member')}` },
      body: JSON.stringify({ organization_id: 1 }),
    });
    assert.equal(res.status, 403);
    body = await res.json();
    assert.equal(body.error, 'Only team captains or admins can manage billing');
    console.log('✓ portal session forbidden for member');

    // Test 7: Unauthenticated portal returns 401
    console.log('Test 7: Unauthenticated portal returns 401...');
    res = await fetch(`${origin}/api/billing/create-portal-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organization_id: 1 }),
    });
    assert.equal(res.status, 401);
    console.log('✓ unauthenticated portal rejected');

    console.log('\nAll tests passed!');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});