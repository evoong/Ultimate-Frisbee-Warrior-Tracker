create table if not exists public.player_private (
  player_id        integer primary key references public.players(id) on delete cascade,
  team_id          bigint  not null references public.organizations(id) on delete cascade,
  phone            text,
  first_name_edit  text,
  last_name_edit   text
);

create index if not exists player_private_team_id_idx on public.player_private (team_id);

alter table public.player_private enable row level security;

-- Move the data before dropping the columns, in one transaction, so no
-- phone number is ever lost between the two statements.
insert into public.player_private (player_id, team_id, phone, first_name_edit, last_name_edit)
select id, organization_id, phone, first_name_edit, last_name_edit
  from public.players
 where phone is not null or first_name_edit is not null or last_name_edit is not null
on conflict (player_id) do nothing;

alter table public.players drop column if exists phone;
alter table public.players drop column if exists first_name_edit;
alter table public.players drop column if exists last_name_edit;
