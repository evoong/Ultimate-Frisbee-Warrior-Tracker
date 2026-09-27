# Task 2 Report: Stripe Billing Backend

Implemented Stripe Checkout flow with one-time trial guard.

## Status
- **Backend:** `server/lib/billing.ts` (new Stripe client, customer lookup, session creation) and updated `server/index.ts` (added `/api/billing/create-checkout-session` and updated `/api/org/trial`) implemented.
- **Verification:** `server/test/billingCheckout.test.mjs` passed (5 test cases: trial repeat guard, trial checkout parameters, upgrade checkout parameters, role auth, unauth).

## Commits
- `feat(billing): create billing.ts, add /api/billing/create-checkout-session, update /api/org/trial`

## Concerns
- Existing `/api/org/trial` now redirects to Stripe Checkout (or rather, returns a redirect URL to frontend). Frontend currently expects `{success, organization}` and will break until Task 4 (frontend portal wiring) updates callers to handle redirects. This was expected as part of the billing transition.
