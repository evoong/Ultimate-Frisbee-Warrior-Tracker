create or replace function public.consume_ai_message(p_org_id bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tier public.org_tier;
  v_limit integer;
  v_month text := to_char(now(), 'YYYY-MM');
  v_count integer;
begin
  v_tier := public.effective_tier(p_org_id);
  if v_tier = 'premium' then
    return true;
  end if;

  v_limit := case v_tier when 'free' then 5 else 100 end;
  insert into public.ai_usage_logs (organization_id, month_key, message_count)
  values (p_org_id, v_month, 0)
  on conflict (organization_id, month_key) do nothing;

  select message_count into v_count
  from public.ai_usage_logs
  where organization_id = p_org_id and month_key = v_month
  for update;

  if v_count >= v_limit then
    return false;
  end if;

  update public.ai_usage_logs
  set message_count = message_count + 1
  where organization_id = p_org_id and month_key = v_month;
  return true;
end;
$$;

create or replace function public.refund_ai_message(p_org_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month text := to_char(now(), 'YYYY-MM');
begin
  update public.ai_usage_logs
  set message_count = greatest(0, message_count - 1)
  where organization_id = p_org_id and month_key = v_month;
end;
$$;

create or replace function public.enforce_tier_member_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tier public.org_tier;
  v_limit integer;
begin
  perform pg_advisory_xact_lock(1, (new.team_id % 2147483647)::int);
  v_tier := public.effective_tier(new.team_id);
  if v_tier = 'premium' then
    return new;
  end if;

  v_limit := case v_tier when 'free' then 15 else 35 end;
  perform 1
  from public.team_members
  where team_id = new.team_id
  group by team_id
  having count(*) >= v_limit;
  if found then
    raise exception 'organization % has reached its % member limit', new.team_id, v_limit;
  end if;
  return new;
end;
$$;

create or replace function public.enforce_tier_strategy_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(2, (new.organization_id % 2147483647)::int);
  if public.effective_tier(new.organization_id) = 'free'
     and (select count(*) from public.strategy_plays where organization_id = new.organization_id) >= 3 then
    raise exception 'organization % has reached its 3 saved strategy limit', new.organization_id;
  end if;
  return new;
end;
$$;

create or replace function public.set_employee_grant(p_org_id bigint, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.organizations
  set is_employee_granted = p_active,
      plan_source = case when p_active then 'employee_grant'::public.plan_source_type else 'stripe'::public.plan_source_type end
  where id = p_org_id;
  if not found then
    raise exception 'organization % does not exist', p_org_id;
  end if;
end;
$$;

create trigger team_members_tier_limit
before insert on public.team_members
for each row execute function public.enforce_tier_member_limit();

create trigger strategy_plays_tier_limit
before insert on public.strategy_plays
for each row execute function public.enforce_tier_strategy_limit();

revoke all on function public.consume_ai_message(bigint) from public, anon, authenticated;
revoke all on function public.refund_ai_message(bigint) from public, anon, authenticated;
revoke all on function public.set_employee_grant(bigint, boolean) from public, anon, authenticated;
grant execute on function public.consume_ai_message(bigint) to service_role;
grant execute on function public.refund_ai_message(bigint) to service_role;
grant execute on function public.set_employee_grant(bigint, boolean) to service_role;
