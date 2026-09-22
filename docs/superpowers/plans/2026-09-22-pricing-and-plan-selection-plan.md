# Pricing & Plan Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement pricing cards on the Home page and self-service plan selection in Organization Settings using an internal tier-switch API placeholder.

**Architecture:** Add `POST /api/org/plan` route in Express server enforcing captain/admin role. Build reusable `PricingCards` component. Embed pricing section on Home page and render interactive plan selector / upgrade modal in `OrganizationSettingsDialog`.

**Tech Stack:** Express, Supabase, React, Tailwind CSS, shadcn UI.

**Spec:** `docs/superpowers/specs/2026-09-22-pricing-and-plan-selection-design.md`

## Global Constraints
- Free tier: 15 members, 30-day stats, 3 strategies, 5 AI msgs/mo, ads enabled.
- Plus tier: 35 members, unlimited stats/strategies, 100 AI msgs/mo, ad-free.
- Premium tier: Unlimited members, unlimited stats/strategies, unlimited AI, ad-free.
- Only organization captains or admins can change plans.

## Review Focus
- Role validation (`captain` or `admin` check via membership lookup) on `/api/org/plan`.
- Responsive grid layout on Home pricing section.
- Correct state handling in Organization Settings modal when changing plans.

---

### Task 1: Backend Plan-Switch API Route

**Files:**
- Create: `server/test/planSwitch.test.mjs`
- Modify: `server/index.ts`

**Interfaces:**
- Consumes: Request cookies, organization id, requested tier.
- Produces: `POST /api/org/plan` updating `organizations.tier` and clearing trial if upgrading.

- [ ] **Step 1: Implement `/api/org/plan` endpoint in `server/index.ts`**

```typescript
// Add to server/index.ts
app.post('/api/org/plan', async (expressReq, res) => {
  try {
    const orgId = parseInt(expressReq.body.organization_id || expressReq.body.org_id, 10);
    const newTier = expressReq.body.tier;
    if (!orgId || !['free', 'plus', 'premium'].includes(newTier)) {
      return res.status(400).json({ error: 'Invalid organization_id or tier' });
    }

    const caller = await classifyChatCaller(expressReq as unknown as Request, orgId);
    if (!caller.ok) {
      return res.status(caller.status).json({ error: caller.error });
    }
    if (caller.role !== 'captain' && caller.role !== 'admin') {
      return res.status(403).json({ error: 'Only team captains or admins can change subscription plans' });
    }

    // Update tier and clear trial status if moving to paid or explicitly selecting free
    const { data, error } = await supabase
      .from('organizations')
      .update({
        tier: newTier,
        plan_source: 'stripe',
        trial_ends_at: newTier === 'free' ? new Date().toISOString() : undefined
      })
      .eq('id', orgId)
      .select()
      .single();

    if (error) throw error;
    return res.json({ success: true, organization: data });
  } catch (err: any) {
    Sentry.captureException(err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});
```

- [ ] **Step 2: Commit backend route**

```bash
git add server/index.ts
git commit -m "feat: add POST /api/org/plan endpoint for self-service plan changes"
```

---

### Task 2: Pricing Cards Component & Home Page Integration

**Files:**
- Create: `frontend/components/PricingCards.tsx`, `frontend/components/PricingCards.test.tsx`
- Modify: `frontend/pages/Home.tsx`

**Interfaces:**
- Produces: Responsive pricing table component.

- [ ] **Step 1: Write `PricingCards.tsx`**

```tsx
import React from 'react';
import { Button } from '../lib/shadcn/button';
import { Card, CardHeader, CardTitle, CardContent } from '../lib/shadcn/card';
import { Check, X } from 'lucide-react';

const PLANS = [
  {
    name: 'Free',
    price: '$0',
    description: 'Essential tracking for casual teams and recreational play.',
    limits: ['15 members max', '30-day raw stats history', '3 playbook strategies', '5 AI chat messages / mo', 'Ad-supported'],
    tier: 'free',
  },
  {
    name: 'Plus',
    price: '$29',
    period: '/ month',
    description: 'Full stats, unlimited strategies, and higher message caps for growing teams.',
    limits: ['35 members max', 'Unlimited stats & history', 'Unlimited playbook strategies', '100 AI chat messages / mo', 'Ad-free'],
    tier: 'plus',
    popular: true,
  },
  {
    name: 'Premium',
    price: '$79',
    period: '/ month',
    description: 'Unlimited capacity and full AI power for competitive clubs and leagues.',
    limits: ['Unlimited members', 'Unlimited stats & history', 'Unlimited playbook strategies', 'Unlimited AI chat', 'Ad-free'],
    tier: 'premium',
  },
];

export function PricingCards({ currentTier, onSelectTier, loadingTier }: { currentTier?: string; onSelectTier?: (tier: string) => void; loadingTier?: string }) {
  return (
    <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
      {PLANS.map((plan) => {
        const isCurrent = currentTier === plan.tier;
        return (
          <Card key={plan.name} className={`relative flex flex-col justify-between border ${plan.popular ? 'border-primary shadow-md' : 'border-border'}`}>
            {plan.popular && (
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground text-xs px-3 py-1 rounded-full font-medium">
                Most Popular
              </span>
            )}
            <CardHeader>
              <CardTitle className="text-xl font-bold">{plan.name}</CardTitle>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="text-3xl font-bold font-mono">{plan.price}</span>
                {plan.period && <span className="text-sm text-muted-foreground">{plan.period}</span>}
              </div>
              <p className="text-sm text-muted-foreground mt-2">{plan.description}</p>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col justify-between">
              <ul className="space-y-3 text-sm mb-6">
                {plan.limits.map((limit, idx) => (
                  <li key={idx} className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-primary shrink-0" />
                    <span>{limit}</span>
                  </li>
                ))}
              </ul>
              {onSelectTier && (
                <Button
                  variant={isCurrent ? 'outline' : plan.popular ? 'default' : 'secondary'}
                  className="w-full"
                  disabled={isCurrent || loadingTier === plan.tier}
                  onClick={() => onSelectTier(plan.tier)}
                >
                  {isCurrent ? 'Current Plan' : loadingTier === plan.tier ? 'Updating…' : `Select ${plan.name}`}
                </Button>
              )}
            </CardContent>
          </CardCard>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Add pricing section to `frontend/pages/Home.tsx`**

```tsx
// Import PricingCards and embed before footer
```

- [ ] **Step 3: Commit pricing component and Home update**

```bash
git add frontend/components/PricingCards.tsx frontend/pages/Home.tsx
git commit -m "feat: add PricingCards component and pricing section on Home page"
```

---

### Task 3: Organization Settings Plan Change UI Integration

**Files:**
- Modify: `frontend/components/OrganizationSettingsDialog.tsx`

**Interfaces:**
- Consumes: Org entitlement, plan selection callback.
- Produces: Modal / inline change plan selector in settings.

- [ ] **Step 1: Add plan change actions to `OrganizationSettingsDialog.tsx`**

```tsx
// Add interactive plan selector using PricingCards inside a dialog or accordion section
```

- [ ] **Step 2: Commit settings update**

```bash
git add frontend/components/OrganizationSettingsDialog.tsx
git commit -m "feat: add self-service plan switching to Organization Settings"
```

---

### Task 4: Verification and Tests

**Files:**
- Create: `frontend/components/PricingCards.test.tsx`

**Interfaces:**
- Produces: Component tests for pricing cards.

- [ ] **Step 1: Write `PricingCards.test.tsx` and run frontend test suite**

```tsx
import { render, screen } from '@testing-library/react';
import { PricingCards } from './PricingCards';
import { describe, it, expect } from 'vitest';

describe('PricingCards', () => {
  it('renders Free, Plus, and Premium plans', () => {
    render(<PricingCards />);
    expect(screen.getByText('Free')).toBeDefined();
    expect(screen.getByText('Plus')).toBeDefined();
    expect(screen.getByText('Premium')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests and typecheck**

Run: `npm run test:frontend && npm run typecheck:frontend`
Expected: PASS

- [ ] **Step 3: Commit tests**

```bash
git add frontend/components/PricingCards.test.tsx
git commit -m "test: add PricingCards component tests"
```
