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
    v_limit := 500;
  elsif v_tier = 'plus' then
    v_limit := 100;
  else
    v_limit := 5;
  end if;

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

revoke all on function public.consume_ai_message(bigint) from public, anon, authenticated;
grant execute on function public.consume_ai_message(bigint) to service_role;
