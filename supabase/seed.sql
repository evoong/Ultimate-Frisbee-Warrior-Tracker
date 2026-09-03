-- Synthetic only. Never seeded from production: real player rows carry
-- phone numbers that must not exist in a dev container.

insert into public.organizations (id, name, is_public) overriding system value
values (1, 'Team A (private)', false),
       (2, 'Team B (public)',  true)
on conflict (id) do nothing;

insert into public.teams (id, name, organization_id) overriding system value
values (1, 'Disc-iples', 1), (2, 'Rival Squad', 2)
on conflict (id) do nothing;

insert into public.seasons (id, team_id, name, year, organization_id) overriding system value
values (1, 1, 'Fall', '2026', 1), (2, 2, 'Fall', '2026', 2)
on conflict (id) do nothing;

insert into public.players (id, first_name, last_name, display_name, organization_id)
overriding system value
values (101, 'Cap',  'Tain',  'Cap',  1),
       (102, 'Ed',   'Itor',  'Ed',   1),
       (103, 'Mem',  'Ber',   'Mem',  1),
       (104, 'Out',  'Sider', 'Out',  2)
on conflict (id) do nothing;

insert into public.player_private (player_id, team_id, phone)
values (101, 1, '555-0101'),
       (102, 1, '555-0102'),
       (103, 1, '555-0103'),
       (104, 2, '555-0104')
on conflict (player_id) do nothing;

insert into public.games (id, season_id, opponent, game_date, our_score, their_score, organization_id)
overriding system value
values (1, 1, 'Rivals', '2026-09-01', 15, 12, 1),
       (2, 2, 'Others', '2026-09-01', 10, 15, 2)
on conflict (id) do nothing;

insert into public.game_events (game_id, player_id, related_player_id, event_type, organization_id)
values (1, 101, 102, 'Goal', 1),
       (1, 103, 101, 'Goal', 1),
       (1, 102, null,  'Goal', 1),
       (2, 104, null,  'Goal', 2);

insert into public.strategy_plays (name, organization_id)
values ('Vertical stack', 1), ('Horizontal stack', 2);

select setval(pg_get_serial_sequence('public.organizations', 'id'), 200, true);
select setval(pg_get_serial_sequence('public.teams',         'id'), 200, true);
select setval(pg_get_serial_sequence('public.seasons',       'id'), 200, true);
select setval(pg_get_serial_sequence('public.players',       'id'), 200, true);
select setval(pg_get_serial_sequence('public.games',         'id'), 200, true);
