-- Add Pass to event_types
insert into event_types (name, category)
values ('Pass', 'Offense')
on conflict do nothing;
