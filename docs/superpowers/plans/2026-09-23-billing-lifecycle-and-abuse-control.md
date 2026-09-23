# Complete Billing, Subscription Lifecycle, and Abuse Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace placeholder tier switching with Stripe-backed trials, subscriptions, and customer portal.

**Architecture:** New `server/lib/billing.ts` wraps Stripe SDK; new `server/routes/billing.ts` exposes checkout/portal/webhook routes. Webhooks are source of truth for tier. DB migration adds `trial_started_at` and price IDs.

**Tech Stack:** Express 4, Stripe Node SDK 22.6.0 (latest), Supabase Postgres, Vitest + node assert tests, React frontend.

**Spec:** `docs/superpowers/specs/2026-09-23-billing-and-abuse-control-design.md`

## Global Constraints

- Prices: Free $0, Plus $12/mo ($120/yr), Premium $20/mo ($200/yr).
- AI caps/mo: Free 5, Plus 100, Premium 500.
- Effective tier via `public.effective_tier(bigint)`; SECURITY INVOKER; search_path=''.
- Trial: 30 days, card required via Stripe Checkout, auto-charge after trial.
- Downgrades/cancel apply at period end; upgrades immediate with proration.
- Webhook signature verified with raw body; never trust success URL alone.

## Review Focus

- Repeat trial blocked when `trial_started_at` set; expect 400 `"Trial already used"`.
- Downgrade preserves existing over-limit rows read-only while blocking new inserts.
- Failed payment falls back to `free` without losing existing data.
- Webhook replay/idempotency does not double-activate trial or duplicate subscription rows.
- Non-captain cannot start Checkout or open portal for another org.

---

### Task 1: Billing lifecycle DB migration

**Files:**
- Create: `supabase/migrations/20260923145329_billing_lifecycle_and_abuse_control.sql`
- Modify: `supabase/tests/21_org_tiers.test.sql`
- Test: `supabase/tests/22_billing_lifecycle.test.sql`

**Interfaces:**
- Consumes: existing `public.organizations(tier,trial_ends_at,plan_source,is_employee_granted)`, `public.effective_tier(bigint)`.
- Produces: `public.organizations.trial_started_at timestamptz null`, `public.can_start_trial(bigint) returns boolean`, updated `public.effective_tier(bigint)` semantics (`trial` only premium while `trial_ends_at > now()`).

- [ ] **Step 1: Write failing DB test**

```sql
begin;
select plan(2);
insert into public.organizations (id, name, trial_started_at)
values (997, 'trial-once', now());
select ok(
  not public.can_start_trial(997),
  'org that already started trial cannot start another'
);
insert into public.organizations (id, name) values (996, 'trial-fresh');
select ok(
  public.can_start_trial(996),
  'org that never started trial can start one'
);
select * from finish();
rollback;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run db:test -- --filter 22_billing_lifecycle` (or project pgTAP runner; fallback `npx supabase test db --filter 22_billing_lifecycle`)
Expected: FAIL with `function public.can_start_trial(bigint) does not exist`

- [ ] **Step 3: Write minimal migration**

```sql
alter table public.organizations
  add column if not exists trial_started_at timestamptz,
  alter column trial_ends_at drop default;

create or replace function public.can_start_trial(p_org_id bigint)
returns boolean
language sql
security invoker
set search_path = ''
stable
as $$
  select not exists (
    select 1 from public.organizations
    where id = p_org_id and trial_started_at is not null
  );
$$;

create or replace function public.effective_tier(p_org_id bigint)
returns public.org_tier
language sql
security invoker
set search_path = ''
stable
as $$
  select case
    when o.is_employee_granted then 'premium'::public.org_tier
    when o.plan_source = 'employee_grant' then 'premium'::public.org_tier
    when o.plan_source = 'trial' and o.trial_ends_at > now() then 'premium'::public.org_tier
    else o.tier
  end
  from public.organizations o
  where o.id = p_org_id;
$$;

revoke execute on function public.can_start_trial(bigint) from public;
grant execute on function public.can_start_trial(bigint) to authenticated;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run db:test -- --filter 21_org_tiers,22_billing_lifecycle`
Expected: PASS, no RLS/advisor regressions.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260923145329_billing_lifecycle_and_abuse_control.sql supabase/tests/22_billing_lifecycle.test.sql
git commit -m "feat(billing): one-time trial guard and lifecycle schema"
```

---

### Task 2: Stripe customer + Checkout session backend

**Files:**
- Create: `server/lib/billing.ts`
- Modify: `server/index.ts`
- Test: `server/test/billingCheckout.test.mjs`

**Interfaces:**
- Consumes: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PLUS_MONTHLY`, `STRIPE_PRICE_PLUS_YEARLY`, `STRIPE_PRICE_PREMIUM_MONTHLY`, `STRIPE_PRICE_PREMIUM_YEARLY`, Supabase service-role client.
- Produces: `getOrCreateStripeCustomer(orgId): Promise<string>`, `createCheckoutSession(orgId, priceId, trial: boolean): Promise<{url:string}>`.

- [ ] **Step 1: Write failing test**

```js
import assert from 'node:assert/strict';
// trial already used must be rejected before Stripe is touched
const res = await fetch(`${origin}/api/billing/create-checkout-session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: `ufwt_at=${await tokenFor('captain')}` },
  body: JSON.stringify({ organization_id: 2, price_id: 'price_test', is_trial: true }),
});
assert.equal(res.status, 400);
assert.equal((await res.json()).error, 'Trial already used for this organization');
console.log('✓ repeat trial checkout rejected');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/tsx/dist/cli.mjs server/test/billingCheckout.test.mjs`
Expected: FAIL with `404` (route missing) or wrong body.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/lib/billing.ts
import Stripe from 'stripe';
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2026-08-26.dahlia' as any });
export async function getOrCreateStripeCustomer(orgId: number, email?: string) { /* lookup organizations.stripe_customer_id; create if missing; persist */ }
export async function createCheckoutSession(orgId: number, priceId: string, trial: boolean) {
  const customer = await getOrCreateStripeCustomer(orgId);
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    customer,
    line_items: [{ price: priceId, quantity: 1 }],
    ...(trial ? { subscription_data: { trial_period_days: 30 } } : {}),
    success_url: `${process.env.APP_URL}/settings?billing=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.APP_URL}/settings?billing=cancelled`,
  });
}
```

Route validates captain role via existing `classifyChatCaller`, calls `can_start_trial` RPC when `is_trial`, returns `{url}`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/tsx/dist/cli.mjs server/test/billingCheckout.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/billing.ts server/index.ts server/test/billingCheckout.test.mjs
git commit -m "feat(billing): stripe checkout with one-time trial guard"
```

---

### Task 3: Webhook handler as source of truth

**Files:**
- Modify: `server/index.ts`
- Modify: `server/lib/billing.ts`
- Test: `server/test/billingWebhook.test.mjs`

**Interfaces:**
- Consumes: `STRIPE_WEBHOOK_SECRET`, Stripe event payload.
- Produces: DB updates for `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.

- [ ] **Step 1: Write failing test**

```js
const bad = await fetch(`${origin}/api/billing/webhook`, { method: 'POST', headers: { 'stripe-signature': 'bad' }, body: '{}' });
assert.equal(bad.status, 400);
const replay1 = await postEvent('checkout.session.completed', goodSig);
const replay2 = await postEvent('checkout.session.completed', goodSig);
assert.equal(replay1.status, 200);
assert.equal(replay2.status, 200);
assert.equal(trialActivationsForOrg(1), 1);
console.log('✓ webhook verifies signature and is idempotent');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/tsx/dist/cli.mjs server/test/billingWebhook.test.mjs`
Expected: FAIL with `404`.

- [ ] **Step 3: Write minimal implementation**

Mount raw-body webhook before `express.json()`:

```ts
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'] as string;
  const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
  // switch on event.type; update organizations + organization_subscriptions; set trial_started_at once
  res.json({ received: true });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/tsx/dist/cli.mjs server/test/billingWebhook.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/index.ts server/lib/billing.ts server/test/billingWebhook.test.mjs
git commit -m "feat(billing): verified idempotent stripe webhook"
```

---

### Task 4: Portal + frontend trial/portal wiring

**Files:**
- Modify: `server/index.ts`
- Modify: `frontend/components/PricingCards.tsx`
- Modify: `frontend/components/OrganizationSettingsDialog.tsx`
- Test: `frontend/components/PricingCards.test.tsx`

**Interfaces:**
- Consumes: `/api/billing/create-checkout-session`, `/api/billing/create-portal-session`, `useEffectiveTier`.
- Produces: trial CTA visible only when eligible; portal button for captains.

- [ ] **Step 1: Write failing test**

```tsx
render(<PricingCards currentTier="free" trialEligible onSelectTier={vi.fn()} onStartTrial={onStart} />);
expect(screen.getByRole('button', { name: /Start 30-Day Free Trial/i })).toBeInTheDocument();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:frontend -- PricingCards.test.tsx`
Expected: FAIL (button missing or prop missing).

- [ ] **Step 3: Write minimal implementation**

Add `trialEligible?: boolean` prop; render trial button only when `currentTier==='free' && trialEligible`. Settings dialog fetches eligibility from `can_start_trial` via `/db` RPC and redirects to Checkout URL. Add `Manage billing` button calling portal endpoint.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:frontend -- PricingCards.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/components/PricingCards.tsx frontend/components/OrganizationSettingsDialog.tsx frontend/components/PricingCards.test.tsx server/index.ts
git commit -m "feat(billing): trial CTA eligibility and customer portal"
```
