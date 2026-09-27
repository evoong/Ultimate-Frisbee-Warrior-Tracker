create or replace function public.increment_ai_usage(p_org_id bigint)
returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.ai_usage_logs (organization_id, month_key, message_count)
  values (p_org_id, to_char(now(), 'YYYY-MM'), 1)
  on conflict (organization_id, month_key)
  do update set message_count = public.ai_usage_logs.message_count + 1;
$$;

revoke all on function public.increment_ai_usage(bigint) from public, anon, authenticated;
grant execute on function public.increment_ai_usage(bigint) to service_role;
