# Org-Tiered Subscriptions, Limits, and Employee Grants Design

## Overview
Ties plans, limits, and monetization strictly to the **Organization** (tenant). Every member of an organization inherits the organization's plan level.

## Tier Structure & Limits
1. **Free**:
   - Members: max 15
   - Raw Game Event History & Stats: 30 days rolling limit
   - Playbook Strategies: max 3 saved strategies
   - AI Chat Messages: 5 per month
   - Ads: Displayed

2. **Plus**:
   - Members: max 35
   - Raw Game Event History & Stats: Unlimited
   - Playbook Strategies: Unlimited
   - AI Chat Messages: 100 per month
   - Ads: Ad-free

3. **Premium**:
   - Members: Unlimited
   - Raw Game Event History & Stats: Unlimited
   - Playbook Strategies: Unlimited
   - AI Chat Messages: Unlimited
   - Ads: Ad-free

4. **Employee Grant**:
   - Superuser grants an organization `plan_source = 'employee_grant'` via admin RPC, elevating it to **Premium** status indefinitely at zero cost.

5. **Free Trial**:
   - New organizations start with a 30-day Premium trial (no credit card required).

## Architecture & Implementation
- **Database**: 
  - `organizations` table gains `tier` ('free', 'plus', 'premium'), `trial_ends_at`, `plan_source` ('stripe', 'employee_grant', 'trial'), `stripe_customer_id`, `stripe_subscription_id`.
  - `organization_subscriptions` table for Stripe webhook audit logs.
  - `ai_usage_logs` table tracking monthly AI token/message counts per organization.
- **Enforcement**:
  - `effective_tier(org_id)` SQL function and helper in server check employee grant, trial status, and paid tier.
  - API middleware checks membership counts, AI message limits, and strategy counts before mutation/creation.
- **Ads**: Global banner component checking `org.tier === 'free'`.
- **Billing**: Stripe Checkout integration on Express server with webhooks.
