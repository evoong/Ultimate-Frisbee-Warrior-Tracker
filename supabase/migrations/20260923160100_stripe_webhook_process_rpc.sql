-- Task 3: transactional RPC to process one Stripe event. Called after
-- signature verification with fields extracted from the event payload.
-- Returns text: 'ok' | 'duplicate' | 'unknown_customer'.
create or replace function public.process_stripe_webhook_event(
  p_event_id text,
  p_event_type text,
  p_customer_id text,
  p_subscription_id text,
  p_status text,
  p_current_period_end timestamptz,
  p_tier public.org_tier,
  p_is_trial boolean
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id bigint;
  v_trial_started_at timestamptz;
begin
  -- Idempotency: insert event ID; on conflict means we already handled it.
  insert into public.processed_stripe_events (id)
  values (p_event_id)
  on conflict (id) do nothing;

  if not found then
    return 'duplicate';
  end if;

  -- Resolve organization by Stripe customer (bound at Checkout creation).
  select o.id, o.trial_started_at into v_org_id, v_trial_started_at
  from public.organizations o
  where o.stripe_customer_id = p_customer_id;

  if v_org_id is null then
    return 'unknown_customer';
  end if;

  case p_event_type
    when 'checkout.session.completed' then
      if p_subscription_id is not null then
        insert into public.organization_subscriptions (
          organization_id, stripe_subscription_id, status, current_period_end
        ) values (
          v_org_id, p_subscription_id, p_status, p_current_period_end
        )
        on conflict (stripe_subscription_id) do update
          set status = excluded.status, current_period_end = excluded.current_period_end;
      end if;

      if p_is_trial then
        if v_trial_started_at is null then
          update public.organizations
          set
            trial_started_at = now(),
            trial_ends_at = now() + interval '30 days',
            plan_source = 'trial'::public.plan_source_type,
            tier = 'premium'::public.org_tier,
            stripe_subscription_id = p_subscription_id
          where id = v_org_id;
        end if;
      else
        update public.organizations
        set
          tier = p_tier,
          plan_source = 'stripe'::public.plan_source_type,
          stripe_subscription_id = p_subscription_id
        where id = v_org_id;
      end if;

    when 'customer.subscription.updated' then
      update public.organizations
      set
        tier = p_tier,
        plan_source = 'stripe'::public.plan_source_type,
        stripe_subscription_id = p_subscription_id
      where id = v_org_id;

      if p_subscription_id is not null then
        insert into public.organization_subscriptions (
          organization_id, stripe_subscription_id, status, current_period_end
        ) values (
          v_org_id, p_subscription_id, p_status, p_current_period_end
        )
        on conflict (stripe_subscription_id) do update
          set status = excluded.status, current_period_end = excluded.current_period_end;
      end if;

    when 'customer.subscription.deleted' then
      update public.organizations
      set
        tier = 'free'::public.org_tier,
        plan_source = 'stripe'::public.plan_source_type,
        stripe_subscription_id = null
      where id = v_org_id;

      if p_subscription_id is not null then
        insert into public.organization_subscriptions (
          organization_id, stripe_subscription_id, status, current_period_end
        ) values (
          v_org_id, p_subscription_id, 'canceled', p_current_period_end
        )
        on conflict (stripe_subscription_id) do update
          set status = 'canceled', current_period_end = excluded.current_period_end;
      end if;

    when 'invoice.paid' then
      -- Authoritative tier from invoice's price (resolved by caller).
      if p_tier is not null then
        update public.organizations
        set
          tier = p_tier,
          plan_source = 'stripe'::public.plan_source_type,
          stripe_subscription_id = coalesce(p_subscription_id, stripe_subscription_id)
        where id = v_org_id;
      end if;
      if p_subscription_id is not null then
        insert into public.organization_subscriptions (
          organization_id, stripe_subscription_id, status, current_period_end
        ) values (
          v_org_id, p_subscription_id, 'active', p_current_period_end
        )
        on conflict (stripe_subscription_id) do update
          set status = 'active', current_period_end = excluded.current_period_end;
      end if;

    when 'invoice.payment_failed' then
      -- Spec: revert to free immediately on failed payment.
      update public.organizations
      set
        tier = 'free'::public.org_tier,
        plan_source = 'stripe'::public.plan_source_type
      where id = v_org_id;

      if p_subscription_id is not null then
        insert into public.organization_subscriptions (
          organization_id, stripe_subscription_id, status, current_period_end
        ) values (
          v_org_id, p_subscription_id, 'past_due', p_current_period_end
        )
        on conflict (stripe_subscription_id) do update
          set status = 'past_due', current_period_end = excluded.current_period_end;
      end if;

    else
      -- Unknown event type; still marked processed to stop retries.
      null;
  end case;

  return 'ok';
end;
$$;

revoke all on function public.process_stripe_webhook_event(text, text, text, text, text, timestamptz, public.org_tier, boolean) from public, anon, authenticated;
grant execute on function public.process_stripe_webhook_event(text, text, text, text, text, timestamptz, public.org_tier, boolean) to service_role;