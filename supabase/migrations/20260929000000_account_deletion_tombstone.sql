create table if not exists public.deleted_accounts (
  email text primary key,
  user_id uuid not null references auth.users(id) on delete restrict,
  deleted_at timestamptz not null default now(),
  trial_used boolean not null default false,
  stripe_customer_id text null
);

alter table public.deleted_accounts enable row level security;
revoke all on public.deleted_accounts from anon, authenticated;

create or replace function public.is_email_deleted(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.deleted_accounts
    where email = lower(trim(p_email))
  );
$$;

revoke all on function public.is_email_deleted(text) from public;
grant execute on function public.is_email_deleted(text) to anon, authenticated;
