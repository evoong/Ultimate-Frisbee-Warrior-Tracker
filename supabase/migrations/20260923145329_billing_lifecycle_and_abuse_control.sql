alter table public.organizations
  add column if not exists trial_started_at timestamptz,
  alter column trial_ends_at drop default,
  alter column trial_ends_at drop not null,
  alter column plan_source set default 'stripe'::public.plan_source_type;

-- Existing orgs whose row predates the explicit-trial model have an
-- auto-granted trial window; backfill trial_started_at from it so they
-- count as having consumed their one trial.
update public.organizations
  set trial_started_at = trial_ends_at - interval '30 days'
  where trial_ends_at is not null and trial_started_at is null;

create or replace function public.can_start_trial(p_org_id bigint)
returns boolean
language sql
security invoker
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.organizations
    where id = p_org_id and trial_started_at is null and trial_ends_at is null
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
