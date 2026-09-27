# Pricing & Plan Selection Design

## Overview
Add plan visibility and self-service tier change to Home page (for visitors) and Organization Settings (for members). Uses internal tier-switch placeholder until Stripe is wired.

## Design Tokens (reuse existing)
- **Accent cyan**: `--nav-accent` / `--sch-accent` (hsl 199 89% 48%) — primary CTAs, active tier highlight
- **Type**: Geist (UI), Geist Mono (numbers/limits)
- **Global tokens**: `bg-background`, `text-foreground`, `border-border`, `bg-card`, `bg-muted`, `text-muted-foreground`
- **Success**: `--sch-win` (green), **Warning**: `--sch-tie` (amber), **Danger**: `--sch-loss` (red)

## 1. Home Page — Pricing Section
**Placement**: After features grid, before footer.
**Layout**: Three-column card grid (mobile: stacked). Each card:
- Tier name badge (Free / Plus / Premium)
- Monthly price (Free: $0, Plus: $29/mo, Premium: $79/mo — placeholder)
- Member limit (15 / 35 / Unlimited)
- History limit (30 days / Unlimited / Unlimited)
- Strategies (3 / Unlimited / Unlimited)
- AI messages/mo (5 / 100 / Unlimited)
- Ads (Yes / No / No)
- Primary CTA: "Get started free" (Free) or "Upgrade to Plus" / "Upgrade to Premium"
- Hover: accent cyan border on card, CTA uses `--nav-accent` background
- Current user's tier (if logged in) highlighted with cyan accent rail

**Copy**: Plain, not salesy. "Free for small teams", "Growing teams", "Leagues & clubs"

## 2. Organization Settings — Plan Change
**Location**: Replace static tier badge in `OrganizationSettingsDialog`.
**UI**: Inline tier selector (ghost pills: Free / Plus / Premium) + "Change plan" button.
**Behavior**:
- Click "Change plan" → modal with three tier cards (same design as Home, compact)
- Current tier marked "Current"
- On selection: if internal placeholder, call `/api/org/plan` (POST `{ tier }`), show toast success, refetch entitlement
- If trial active, show "Trial ends YYYY-MM-DD" and disable downgrade until trial ends
- Employee grant: badge only, no downgrade UI (admin action only)

## 3. Internal API (placeholder)
`POST /api/org/plan` body: `{ tier: 'free' | 'plus' | 'premium' }`
- Validates caller is org captain/admin
- Updates `organizations.tier`, clears `trial_ends_at` if upgrading from trial
- Returns updated org row
- No payment processing

## 4. Accessibility & States
- Keyboard navigable tier cards (tab to card, Enter/Space to select)
- Loading spinner on CTA during API call
- Toast for success/error
- Reduced motion: no hover scale, instant border

## 5. Responsive
- Home: 3-col ≥1024px, 2-col ≥640px, 1-col <640px
- Settings modal: full-width <480px, centered 480px otherwise
