import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Lazy Stripe client: avoids crash on import when STRIPE_SECRET_KEY is unset
// (e.g. in tests or non-billing deployments). First call constructs; subsequent
// calls reuse. Matches Stripe best practice of instance-per-use, not module key.
let stripeClient: Stripe | null = null;
function getStripe(): Stripe {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
    stripeClient = new Stripe(key, {
      apiVersion: '2026-08-26.dahlia' as Stripe.LatestApiVersion,
      httpClient: Stripe.createFetchHttpClient(),
    });
  }
  return stripeClient;
}

// Re-export for code that may import it directly (not used internally).
export const stripe = {
  get checkout() { return getStripe().checkout; },
  get customers() { return getStripe().customers; },
};

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SECRET_KEY || ''
);

// Lookup existing Stripe customer for an org; create and persist one if
// missing. Keeps one customer per organization so Stripe-side state
// (subscriptions, payment methods, trial history) follows the org.
export async function getOrCreateStripeCustomer(orgId: number): Promise<string> {
  const { data, error: lookupError } = await supabase
    .from('organizations')
    .select('id, name, stripe_customer_id')
    .eq('id', orgId)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (!data) throw new Error('Organization not found');
  if (data.stripe_customer_id) return data.stripe_customer_id;

  const customer = await getStripe().customers.create({
    name: data?.name || `Organization ${orgId}`,
    metadata: { organization_id: String(orgId) },
  });

  const { error } = await supabase
    .from('organizations')
    .update({ stripe_customer_id: customer.id })
    .eq('id', orgId);
  if (error) throw error;

  return customer.id;
}

export async function createCheckoutSession(
  orgId: number,
  priceId: string,
  trial: boolean
): Promise<{ url: string }> {
  const customerId = await getOrCreateStripeCustomer(orgId);
  // No payment_method_types: dynamic payment methods come from Dashboard
  // settings. trial_period_days makes Checkout collect the card upfront
  // without charging; conversion at trial end is handled by Stripe.
  const session = await getStripe().checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    ...(trial ? { subscription_data: { trial_period_days: 30 } } : {}),
    success_url: `${process.env.APP_URL}/settings?billing=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.APP_URL}/settings?billing=cancelled`,
  });
  return { url: session.url! };
}

// One-time trial guard: DB RPC checks organizations.trial_started_at is
// null. Called BEFORE any Stripe call so a repeat trial never reaches
// Checkout.
export async function canStartTrial(orgId: number): Promise<boolean> {
  const { data, error } = await supabase.rpc('can_start_trial', { p_org_id: orgId });
  if (error) throw error;
  return data === true;
}

export function verifyWebhook(body: Buffer, signature: string | undefined): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !signature || !Buffer.isBuffer(body)) throw new Error('Missing webhook secret, signature, or raw body');
  return getStripe().webhooks.constructEvent(body, signature, secret);
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  return typeof value === 'string' ? value : value?.id ?? null;
}

function tierForPrice(priceId: string | null): 'plus' | 'premium' | null {
  if (priceId && [process.env.STRIPE_PRICE_PREMIUM_MONTHLY, process.env.STRIPE_PRICE_PREMIUM_YEARLY].includes(priceId)) return 'premium';
  if (priceId && [process.env.STRIPE_PRICE_PLUS_MONTHLY, process.env.STRIPE_PRICE_PLUS_YEARLY].includes(priceId)) return 'plus';
  return null;
}

export async function processWebhook(event: Stripe.Event): Promise<'ok' | 'duplicate' | 'unknown_customer'> {
  if (!['checkout.session.completed', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed'].includes(event.type)) return 'ok';

  const object = event.data.object;
  let subscription: Stripe.Subscription | null = null;
  let subscriptionId: string | null = null;
  let customerId: string | null = null;

  if (event.type === 'checkout.session.completed') {
    const session = object as Stripe.Checkout.Session;
    if (session.mode !== 'subscription' || !idOf(session.subscription) || !idOf(session.customer)) throw new Error('Invalid subscription checkout session');
    subscriptionId = idOf(session.subscription);
    customerId = idOf(session.customer);
  } else if (event.type.startsWith('customer.subscription.')) {
    subscription = object as Stripe.Subscription;
    subscriptionId = subscription.id;
    customerId = idOf(subscription.customer);
  } else {
    const invoice = object as Stripe.Invoice;
    customerId = idOf(invoice.customer);
    subscriptionId = idOf(invoice.parent?.subscription_details?.subscription);
    if (!subscriptionId) return 'ok';
  }

  if (!customerId || !subscriptionId) throw new Error('Missing Stripe customer or subscription');
  if (event.type !== 'customer.subscription.deleted') {
    subscription = await getStripe().subscriptions.retrieve(subscriptionId);
    if (idOf(subscription.customer) !== customerId) throw new Error('Subscription customer mismatch');
  }

  const priceId = subscription?.items.data[0]?.price.id ?? null;
  const tier = tierForPrice(priceId);
  const status = subscription?.status ?? (event.type === 'customer.subscription.deleted' ? 'canceled' : null);
  const isTrial = event.type === 'checkout.session.completed' && subscription?.status === 'trialing' && !!subscription.trial_end;
  const currentPeriodEnd = subscription?.items.data[0]?.current_period_end ?? null;
  const entitled = status === 'active' || status === 'trialing';
  const { data, error } = await supabase.rpc('process_stripe_webhook_event', {
    p_event_id: event.id,
    p_event_type: event.type,
    p_customer_id: customerId,
    p_subscription_id: subscriptionId,
    p_status: status,
    p_current_period_end: currentPeriodEnd ? new Date(currentPeriodEnd * 1000).toISOString() : null,
    p_tier: entitled ? tier : null,
    p_is_trial: isTrial,
  });
  if (error) throw error;
  if (data === 'unknown_customer') throw new Error('Organization not found for Stripe customer');
  return data;
}