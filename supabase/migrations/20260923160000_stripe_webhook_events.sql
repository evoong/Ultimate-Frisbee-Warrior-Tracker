-- Task 3: idempotency log for Stripe webhook deliveries. Event IDs are
-- unique per Stripe event; the PK rejects a redelivered event before any
-- org/subscription write runs, so replays are no-ops.
create table if not exists public.processed_stripe_events (
  id text primary key,
  processed_at timestamptz not null default now()
);

alter table public.processed_stripe_events enable row level security;

-- Service-role only (webhook handler holds the service key). Zero policies,
-- same posture as platform_admins / admin_audit_log: add this table to the
-- allowlist in supabase/tests/00_meta.test.sql.
revoke all on public.processed_stripe_events from anon, authenticated;

-- Upsert target for the webhook's subscription writes.
alter table public.organization_subscriptions
  add constraint organization_subscriptions_stripe_subscription_id_key
  unique (stripe_subscription_id);
