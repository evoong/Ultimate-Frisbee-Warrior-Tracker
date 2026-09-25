# Complete Billing, Subscription Lifecycle, and Abuse Control Design

## 1. Overview & Business Model

This design governs organization-tied subscriptions, 30-day card-required trials, plan upgrades, downgrades, cancellations, and abuse prevention.

- **Free**: $0/mo ($0/yr). 15 members, 30-day stats history, 3 strategies, 5 AI messages/mo, ad-supported.
- **Plus**: $12/mo ($120/yr). 35 members, unlimited stats/history, unlimited strategies, 100 AI messages/mo, ad-free.
- **Premium**: $20/mo ($200/yr). Unlimited members, unlimited stats/history, unlimited strategies, 500 AI messages/mo, ad-free.
- **Trial**: 30-day Premium trial requires credit card via Stripe Checkout (`subscription_data.trial_period_days = 30`). Automatically converts to paid Premium unless cancelled.
- **Employee Grant**: Superuser/Admin override to Premium indefinitely at zero cost.

---

## 2. Subscription Lifecycle & State Machine

```
                  ┌───────────────────────────────┐
                  │          Organization         │
                  └───────────────┬───────────────┘
                                  │
                  ┌───────────────┴───────────────┐
                  ▼                               ▼
       [ Create without Card ]        [ Create with Card Trial ]
                  │                               │
                  ▼                               ▼
         Tier: Free ($0/mo)            Tier: Premium (Trial)
                  │                               │ (30 days)
                  │                               ▼
                  │                    [ Stripe Webhook Event ]
                  │                   /                        \
                  │        (Payment Succeeded)            (Cancelled / Failed)
                  │                 │                              │
                  │                 ▼                              ▼
                  │        Tier: Premium (Paid)           Tier: Free ($0/mo)
                  │                 │                              │
                  └─────────────────┴──────────────┬───────────────┘
                                                   │
                                     [ Self-Service Customer Portal ]
                                     /               │              \
                             (Upgrade)          (Downgrade)     (Cancel)
                                 │                   │              │
                                 ▼                   ▼              ▼
                          Prorated Immediate   End of Period    End of Period
                             Tier Change        Tier Change      Tier: Free
```

### State Transitions
1. **Trial Start**:
   - Route `POST /api/billing/create-checkout-session` with `{ organization_id, price_id, is_trial: true }`.
   - Generates Stripe Checkout Session with `mode: 'subscription'` and `subscription_data: { trial_period_days: 30 }`.
   - Stripe collects card upfront without charging.
   - `trial_started_at` is stamped in DB on webhook receipt (`checkout.session.completed`).

2. **Trial Conversion / Renewal**:
   - Event `invoice.paid`: updates `organizations.tier = 'premium'`, `organizations.plan_source = 'stripe'`.
   - Event `invoice.payment_failed`: updates `organizations.tier = 'free'`, notifies captain, revokes ad-free and excess limits.

3. **Upgrades**:
   - Handled via Stripe Customer Portal or inline Checkout.
   - Upgrades apply immediately with proration.

4. **Downgrades & Cancellations**:
   - Applied at **end of current billing period** (`cancel_at_period_end = true` or `subscription.updated`).
   - Access remains at paid tier until `current_period_end`, then falls back to `free`.

---

## 3. Database Schema & Migration

### Migration File: `supabase/migrations/20260923150000_billing_lifecycle_and_abuse_control.sql`

```sql
-- 1. Add trial_started_at to track one-time trial usage
alter table public.organizations
  add column if not exists trial_started_at timestamptz,
  alter column trial_ends_at drop default;

-- 2. Ensure Stripe tracking columns exist
alter table public.organizations
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text;

-- 3. Function to enforce one-time trial activation
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

-- 4. Update effective_tier function to handle card trials and strict expirations
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
```

---

## 4. Abuse Prevention & Security Controls

1. **One Trial Per Organization**:
   - Checked via DB column `trial_started_at IS NULL` both at Checkout creation and Webhook processing.
   - If `trial_started_at` is already set, the trial endpoint/Checkout rejects creation with HTTP 400 (`"Trial already used for this organization"`).

2. **One Active Trial Per Stripe Customer / Payment Method**:
   - Stripe Customer ID is bound to `organizations.stripe_customer_id`.
   - Webhook checks if `stripe_customer_id` already has a historical `trial_started_at` record across all organizations.

3. **Downgrade Limit Enforcement**:
   - When an organization downgrades to `Free` (15 member cap, 3 strategy cap):
     - **Members**: Existing members stay, but no NEW members can be added until count falls below 15.
     - **Strategies**: Existing strategies stay read-only, but no NEW strategies can be created until count falls below 3.
     - **AI Usage**: Hard capped at 5 messages/month immediately.

4. **Service Role Security & Webhook Validation**:
   - Webhooks endpoint `POST /api/billing/webhook` strictly verifies `stripe-signature` using `STRIPE_WEBHOOK_SECRET`.
   - Raw body parsing enabled specifically for `/api/billing/webhook`.

---

## 5. Stripe API Integration Architecture

### Express Routes (`server/routes/billing.ts`)

1. `POST /api/billing/create-checkout-session`
   - Validates caller is `captain` or `admin`.
   - If `is_trial = true`, validates `can_start_trial(org_id) == true`.
   - Creates/retrieves Stripe Customer.
   - Returns `{ url: session.url }`.

2. `POST /api/billing/create-portal-session`
   - Creates Stripe Customer Portal session for managing/cancelling subscriptions.
   - Returns `{ url: portalSession.url }`.

3. `POST /api/billing/webhook`
   - Event `checkout.session.completed`:
     - Binds `stripe_customer_id` and `stripe_subscription_id`.
     - Sets `trial_started_at = now()` and `trial_ends_at` if trial session.
   - Event `customer.subscription.updated`:
     - Updates DB `tier` and `current_period_end`.
   - Event `customer.subscription.deleted`:
     - Reverts `tier` to `'free'`, resets `plan_source` to `'stripe'`.

---

## 6. Frontend UI Components & State

1. **`PricingCards.tsx`**:
   - Displays `$0`, `$12/mo` ($120/yr), `$20/mo` ($200/yr).
   - "Start 30-Day Free Trial (Card Required)" button visible ONLY if `currentTier === 'free'` AND `trial_started_at` is null.
   - If trial already used, button text changes to "Upgrade to Premium".

2. **`OrganizationSettingsDialog.tsx`**:
   - Shows current tier, renewal date, or "Trial ends in X days".
   - Provides "Manage Billing" button linking to Stripe Customer Portal.

---

## 7. Verification & Testing Strategy

1. **Unit & API Tests (`server/test/billingLifecycle.test.mjs`)**:
   - Test 1: Reject trial if `trial_started_at` is already set.
   - Test 2: Verify Checkout session generation with 30-day trial parameter.
   - Test 3: Webhook handler processes `customer.subscription.updated` and downgrades correctly at period end.
   - Test 4: AI message consumption caps at 5 (Free), 100 (Plus), 500 (Premium).

2. **Database RLS & Advisor Checks**:
   - Run `get_advisors` to ensure no security definer leaks.
