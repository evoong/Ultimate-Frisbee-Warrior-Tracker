import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import Stripe from 'stripe';

process.env.VERCEL = '1';
process.env.SUPABASE_URL = 'https://example.test';
process.env.SUPABASE_SECRET_KEY = 'service-role-key';
process.env.SUPABASE_PUBLISHABLE_KEY = 'publishable-key';
process.env.SUPABASE_JWKS_URL = 'https://example.test/auth/v1/.well-known/jwks.json';
process.env.POSTHOG_PROJECT_TOKEN = 'posthog-token';
process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_mock';
process.env.APP_URL = 'http://localhost:5199';

const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = await exportJWK(publicKey);
jwk.kid = 'test-key';

const dbUpdates = [];
const processedEvents = new Set();
let trialActivations = 0;

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(String(url));
  if (target.hostname === '127.0.0.1' || target.hostname === 'localhost') {
    return realFetch(url, init);
  }
  if (target.pathname.endsWith('.well-known/jwks.json')) {
    return Response.json({ keys: [jwk] });
  }
  if (target.hostname === 'api.stripe.com' && target.pathname === '/v1/subscriptions/sub_test123') {
    return Response.json({ id: 'sub_test123', customer: 'cus_test123', status: 'trialing', trial_start: 1727000000, trial_end: 1729592000, items: { data: [{ price: { id: 'price_premium_monthly' }, current_period_end: 1729592000 }] } });
  }
  if (target.pathname === '/rest/v1/rpc/process_stripe_webhook_event') {
    const params = JSON.parse(String(init.body));
    if (processedEvents.has(params.p_event_id)) return Response.json('duplicate');
    processedEvents.add(params.p_event_id);
    if (params.p_is_trial) trialActivations++;
    return Response.json('ok');
  }
  if (target.pathname === '/rest/v1/organizations') {
    if ((init.method ?? 'GET') === 'GET') {
      // Find org by stripe_customer_id or id
      return Response.json([{ id: 1, name: 'Test Org', trial_started_at: null, tier: 'free' }]);
    }
    if (init.method === 'PATCH' || init.method === 'POST') {
      const update = JSON.parse(String(init.body || '{}'));
      dbUpdates.push(update);
      if (update.trial_started_at) trialActivations++;
      return Response.json({ id: 1, ...update });
    }
  }
  if (target.pathname === '/rest/v1/organization_subscriptions') {
    return Response.json({ id: 1 });
  }
  throw new Error(`Unexpected fetch: ${url}`);
};

async function runTests() {
  const { default: app } = await import('../index.ts');
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    const stripe = new Stripe('sk_test_mock', { apiVersion: '2026-08-26.dahlia' });
    const payload = JSON.stringify({
      id: 'evt_test_123',
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_123',
          mode: 'subscription',
          customer: 'cus_test123',
          subscription: 'sub_test123',
          metadata: { organization_id: '1' },
        }
      }
    });

    const timestamp = Math.floor(Date.now() / 1000);
    const goodSig = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_test_mock',
    });

    // Test 1: Bad signature returns 400
    console.log('Test 1: Bad signature returns 400...');
    const bad = await realFetch(`${origin}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'stripe-signature': 't=123,v1=bad' },
      body: payload,
    });
    assert.equal(bad.status, 400);
    console.log('✓ bad signature rejected with 400');

    // Test 2: Idempotent webhook delivery for checkout.session.completed
    console.log('Test 2: Idempotent webhook delivery...');
    const replay1 = await realFetch(`${origin}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'stripe-signature': goodSig, 'content-type': 'application/json' },
      body: payload,
    });
    console.log('replay1 status:', replay1.status, 'body:', await replay1.text());
    const replay2 = await realFetch(`${origin}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'stripe-signature': goodSig, 'content-type': 'application/json' },
      body: payload,
    });
    console.log('replay2 status:', replay2.status, 'body:', await replay2.text());

    assert.equal(replay1.status, 200);
    assert.equal(replay2.status, 200);
    // trial_started_at should only be stamped once due to idempotency or conditional check
    console.log(`Trial activations recorded: ${trialActivations}`);
    assert.equal(trialActivations, 1);
    console.log('✓ webhook verifies signature and is idempotent');

    console.log('\nAll Task 3 tests passed!');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
