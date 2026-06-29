-- Ultimate Frisbee Warrior Tracker — Supabase Schema + Seed Data
-- Paste this entire file into Supabase SQL Editor and run it

-- ============================================================
-- SCHEMA
-- ============================================================

create table if not exists teams (
  id serial primary key,
  name text not null
);

create table if not exists seasons (
  id serial primary key,
  team_id integer references teams(id),
  name text,
  year text,
  start_date date,
  end_date date,
  location text,
  league_name text,
  organizer text,
  default_game_time time
);

create table if not exists players (
  id serial primary key,
  first_name text,
  last_name text,
  display_name text,
  gender_match text,
  phone text,
  is_sub boolean default false,
  position text,
  photo_url text,
  number text,
  first_name_edit text,
  last_name_edit text
);

create table if not exists games (
  id serial primary key,
  season_id integer references seasons(id),
  opponent text,
  game_date date,
  game_time time,
  game_type text,
  our_score integer default 0,
  their_score integer default 0,
  result text,
  notes text,
  outcome_override text
);

create table if not exists event_types (
  id serial primary key,
  name text not null,
  category text
);

create table if not exists game_events (
  id serial primary key,
  game_id integer references games(id) on delete cascade,
  player_id integer references players(id),
  related_player_id integer references players(id),
  event_type text,
  point_number integer,
  event_timestamp timestamptz default now(),
  notes text
);

create table if not exists season_players (
  id serial primary key,
  season_id integer references seasons(id),
  player_id integer references players(id),
  jersey_number text,
  active boolean default true,
  role text,
  unique(season_id, player_id)
);

create table if not exists game_lineups (
  id serial primary key,
  game_id integer references games(id) on delete cascade,
  player_id integer references players(id),
  lineup_name text,
  unique(game_id, player_id, lineup_name)
);

create table if not exists standings (
  id serial primary key,
  season_id integer references seasons(id),
  team_name text,
  games_played integer default 0,
  wins integer default 0,
  losses integer default 0,
  ties integer default 0,
  default_losses integer default 0,
  points integer default 0,
  points_for integer default 0,
  points_against integer default 0,
  point_differential integer default 0
);

-- ============================================================
-- SEED DATA
-- ============================================================

-- Teams
insert into teams (id, name) overriding system value values
  (1, 'Disc-iples'),
  (2, 'The Jogging Dead'),
  (3, 'RHUC Warriors');
select setval('teams_id_seq', 3);

-- Seasons
insert into seasons (id, team_id, name, year, start_date, end_date, location, league_name, organizer, default_game_time) overriding system value values
  (1, 1, 'Spring', '2026', '2026-05-03', '2026-06-21', 'De La Salle College', 'Mixed Ultimate - Outdoor Turf 5s', 'Jam', '17:30:00'),
  (2, 2, 'Summer', '2026', '2026-07-05', null, 'De La Salle College', 'Mixed Ultimate - Outdoor Turf 5s (De La Salle College)', 'Jam', null),
  (3, 3, 'Spring', '2026', '2026-05-14', '2026-08-13', 'Fletcher Field', '2026 Summer Thursday 7-on-7 @ Fletcher''s Fields', 'RHUC', '19:00:00');
select setval('seasons_id_seq', 3);

-- Players
insert into players (id, first_name, last_name, display_name, gender_match, phone, is_sub, position) overriding system value values
  (1,  'Jackson',   'Truong',  'Jackson Truong',  'Man',   '4168922198', false, 'Handler'),
  (2,  'Bibi',      'Siew',    'Bibi Siew',        'Woman', null,         false, null),
  (3,  'Brandon',   'Ca',      'Brandon Ca',       'Man',   '4372242205', false, null),
  (4,  'Danny',     'Nguyen',  'Danny Nguyen',     'Man',   '6478397390', false, null),
  (5,  'Eric',      'Voong',   'Eric Voong',       'Man',   '6476872386', false, null),
  (6,  'Etienne',   'Dupuy',   'Etienne Dupuy',    'Man',   null,         false, null),
  (7,  'Haniah',    'Saleem',  'Haniah Saleem',    'Woman', null,         false, null),
  (8,  'Kathy',     'Nguyen',  'Kathy Nguyen',     'Woman', '6479069758', false, null),
  (9,  'Luca',      'Rubino',  'Luca Rubino',      'Man',   '4165093484', false, null),
  (10, 'Martina',   'Rubino',  'Martina Rubino',   'Woman', null,         false, null),
  (11, 'Phat',      'Tran',    'Phat Tran',        'Man',   null,         false, null),
  (12, 'Stephanie', 'Luu',     'Stephanie Luu',    'Woman', '6477406988', false, null),
  (13, 'Grace',     'Main',    'Grace Main',       'Woman', '4169987822', false, null),
  (14, 'Joe',       'W',       'Joe W',            'Man',   '4169049964', false, null),
  (15, 'Jonathan',  'Chik',    'Jonathan Chik',    'Man',   '9293872318', false, null),
  (16, 'Kar',       'Tri',     'Kar Tri',          'Woman', '4169049964', false, null),
  (18, 'Phat Friend', null,    'Phat Friend',      null,    null,         true,  null);
select setval('players_id_seq', 18);

-- Games
insert into games (id, season_id, opponent, game_date, game_time, game_type, our_score, their_score, result, notes, outcome_override) overriding system value values
  (1,  1, 'Huck, Huck, Goose',   '2026-05-03', '18:30:00', 'Regular', 1,  8,  'Loss',           'Final score.jamsports', null),
  (2,  1, 'UFO',                 '2026-05-10', '16:30:00', 'Regular', 3,  10, 'Loss',           'Final score.jamsports', null),
  (3,  1, 'The Tamsters',        '2026-05-24', '17:30:00', 'Regular', 3,  16, 'Loss',           'Final score.jamsports', null),
  (4,  1, 'Magic Skule Bus',     '2026-05-31', '16:30:00', 'Regular', 0,  20, 'Loss',           'Final score.jamsports', null),
  (5,  1, 'PlsGoEasyWeNew',      '2026-06-07', '17:30:00', 'Regular', 6,  12, 'Loss',           'Final score.jamsports', null),
  (6,  1, 'Huck, Huck, Goose',   '2026-06-14', '18:30:00', 'Playoff', 0,  0,  'Win (by default)', 'Playoff Week 1.jamsports', null),
  (7,  1, 'UFO',                 '2026-06-21', '17:30:00', 'Playoff', 0,  0,  'Loss (by default)', 'Playoff Week 2.jamsports', null),
  (10, 3, 'Huck 2ya',            '2026-05-14', '19:00:00', 'Regular', 0,  0,  null,             null, null),
  (11, 3, 'Kachow Force Lions',  '2026-05-21', '19:00:00', 'Regular', 0,  0,  null,             null, null),
  (12, 3, 'Handle My Hammer',    '2026-05-28', '19:00:00', 'Regular', 0,  0,  null,             null, null),
  (13, 3, 'milfs & dilfs',       '2026-06-04', '19:00:00', 'Regular', 0,  0,  null,             null, null),
  (14, 3, 'Frisbee Enjoyers',    '2026-06-11', '19:00:00', 'Regular', 0,  0,  null,             null, null),
  (15, 3, 'Pammers',             '2026-06-25', '19:00:00', 'Regular', 0,  0,  null,             null, null);
select setval('games_id_seq', 15);

-- Event Types
insert into event_types (id, name, category) overriding system value values
  (1, 'Goal',          'Offense'),
  (3, 'Block',         'Defense'),
  (4, 'Throwaway',     'Offense'),
  (5, 'Drop',          'Offense'),
  (6, 'Pull',          'Special'),
  (7, 'Opponent Goal', 'Defense'),
  (8, 'Caught OB',     'Offense');
select setval('event_types_id_seq', 8);

-- Season Players
insert into season_players (id, season_id, player_id, jersey_number, active, role) overriding system value values
  (1,  1, 1,  null, true, null),
  (2,  1, 2,  null, true, null),
  (3,  1, 3,  null, true, null),
  (4,  1, 4,  null, true, null),
  (5,  1, 5,  null, true, null),
  (6,  1, 6,  null, true, null),
  (7,  1, 7,  null, true, null),
  (8,  1, 8,  null, true, null),
  (9,  1, 9,  null, true, null),
  (10, 1, 10, null, true, null),
  (11, 1, 11, null, true, null),
  (12, 1, 12, null, true, null),
  (13, 2, 1,  null, true, 'Captain'),
  (14, 2, 3,  null, true, 'Player'),
  (15, 2, 4,  null, true, 'Player'),
  (16, 2, 5,  null, true, 'Player'),
  (17, 2, 13, null, true, 'Player'),
  (18, 2, 14, null, true, 'Player'),
  (19, 2, 15, null, true, 'Player'),
  (20, 2, 16, null, true, 'Player'),
  (21, 2, 8,  null, true, 'Player'),
  (22, 2, 9,  null, true, 'Player'),
  (23, 2, 12, null, true, 'Player'),
  (25, 1, 18, null, true, null),
  (26, 3, 1,  null, true, null),
  (27, 3, 5,  null, true, null),
  (28, 3, 12, null, true, null);
select setval('season_players_id_seq', 28);

-- Standings
insert into standings (id, season_id, team_name, games_played, wins, losses, ties, default_losses, points, points_for, points_against, point_differential) overriding system value values
  (1, 1, 'The Tamsters',     7, 7, 0, 0, 0, 14, 80, 35,  45),
  (2, 1, 'UFO',              7, 5, 2, 0, 0, 10, 61, 45,  16),
  (3, 1, 'Magic Skule Bus',  7, 4, 2, 0, 1,  7, 70, 41,  29),
  (4, 1, 'PlsGoEasyWeNew',   7, 3, 4, 0, 0,  6, 53, 78, -25),
  (5, 1, 'Huck, Huck, Goose',7, 1, 5, 0, 1,  1, 41, 53, -12),
  (6, 1, 'Disc-iples',       7, 1, 5, 0, 1,  1, 13, 66, -53);
select setval('standings_id_seq', 6);

-- Game Events
insert into game_events (id, game_id, player_id, related_player_id, event_type, point_number, event_timestamp, notes) overriding system value values
  (14,  1,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (15,  1,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (16,  1,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (17,  1,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (18,  1,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (19,  1,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (20,  1,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (21,  1,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (22,  2,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (23,  2,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (24,  2,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (25,  2,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (26,  2,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (27,  2,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (28,  2,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (29,  2,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (30,  2,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (31,  2,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (32,  3,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (33,  3,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (34,  3,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (35,  3,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (36,  3,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (37,  3,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (38,  3,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (39,  3,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (40,  3,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (41,  3,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (42,  3,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (43,  3,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (44,  3,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (45,  3,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (46,  3,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (47,  3,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (48,  4,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (49,  4,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (50,  4,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (51,  4,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (52,  4,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (53,  4,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (54,  4,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (55,  4,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (56,  4,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (57,  4,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (58,  4,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (59,  4,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (60,  4,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (61,  4,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (62,  4,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (63,  4,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (64,  4,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (65,  4,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (66,  4,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (67,  4,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (68,  5,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (69,  5,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (70,  5,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (71,  5,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (72,  5,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (73,  5,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (74,  5,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (75,  5,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (76,  5,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (77,  5,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (78,  5,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (79,  5,  null, null, 'Opponent Goal', null, '2026-06-27T07:44:03.680Z', null),
  (85,  5,  9,    11,   'Goal',          null, '2026-06-27T16:00:21.225Z', null),
  (86,  5,  8,    1,    'Goal',          null, '2026-06-27T16:00:54.072Z', null),
  (87,  5,  5,    1,    'Goal',          null, '2026-06-27T16:01:07.801Z', null),
  (88,  5,  5,    1,    'Goal',          null, '2026-06-27T16:01:12.688Z', null),
  (89,  5,  5,    1,    'Goal',          null, '2026-06-27T16:01:15.544Z', null),
  (91,  5,  1,    5,    'Goal',          null, '2026-06-27T16:01:20.753Z', null),
  (92,  1,  5,    6,    'Goal',          null, '2026-06-27T16:07:20.056Z', null),
  (93,  3,  9,    1,    'Goal',          null, '2026-06-27T16:15:51.409Z', null),
  (94,  3,  9,    1,    'Goal',          null, '2026-06-27T16:15:59.903Z', null),
  (95,  3,  18,   11,   'Goal',          null, '2026-06-27T16:16:20.314Z', null),
  (96,  2,  5,    6,    'Goal',          null, '2026-06-27T16:27:35.738Z', null),
  (97,  2,  9,    6,    'Goal',          null, '2026-06-27T16:27:40.800Z', null),
  (98,  2,  12,   1,    'Goal',          null, '2026-06-27T16:27:52.123Z', null),
  (99,  10, null, null, 'Goal',          null, '2026-06-28T15:17:37.253Z', null),
  (100, 10, null, null, 'Goal',          null, '2026-06-28T15:17:37.912Z', null),
  (101, 10, null, null, 'Goal',          null, '2026-06-28T15:17:38.448Z', null),
  (102, 10, null, null, 'Goal',          null, '2026-06-28T15:17:38.817Z', null),
  (103, 10, null, null, 'Goal',          null, '2026-06-28T15:17:39.024Z', null),
  (104, 10, null, null, 'Goal',          null, '2026-06-28T15:17:39.229Z', null),
  (105, 10, null, null, 'Goal',          null, '2026-06-28T15:17:39.433Z', null),
  (106, 10, null, null, 'Goal',          null, '2026-06-28T15:17:39.624Z', null),
  (107, 10, null, null, 'Goal',          null, '2026-06-28T15:17:39.804Z', null),
  (108, 10, null, null, 'Goal',          null, '2026-06-28T15:17:40.023Z', null),
  (109, 10, null, null, 'Goal',          null, '2026-06-28T15:17:40.734Z', null),
  (110, 10, null, null, 'Goal',          null, '2026-06-28T15:17:41.347Z', null),
  (111, 10, null, null, 'Goal',          null, '2026-06-28T15:17:42.535Z', null),
  (112, 10, null, null, 'Goal',          null, '2026-06-28T15:17:43.265Z', null),
  (113, 10, null, null, 'Opponent Goal', null, '2026-06-28T15:17:54.547Z', null),
  (114, 10, null, null, 'Opponent Goal', null, '2026-06-28T15:17:54.702Z', null),
  (115, 10, null, null, 'Opponent Goal', null, '2026-06-28T15:17:54.889Z', null),
  (116, 10, null, null, 'Opponent Goal', null, '2026-06-28T15:17:55.077Z', null),
  (117, 10, null, null, 'Opponent Goal', null, '2026-06-28T15:17:55.263Z', null),
  (118, 10, null, null, 'Opponent Goal', null, '2026-06-28T15:17:55.430Z', null),
  (119, 10, null, null, 'Opponent Goal', null, '2026-06-28T15:17:55.621Z', null),
  (120, 10, null, null, 'Opponent Goal', null, '2026-06-28T15:17:55.773Z', null),
  (121, 10, null, null, 'Opponent Goal', null, '2026-06-28T15:17:55.941Z', null),
  (123, 11, 5,    null, 'Goal',          null, '2026-06-28T15:19:40.766Z', null),
  (124, 11, 5,    null, 'Goal',          null, '2026-06-28T15:19:41.539Z', null),
  (125, 11, 5,    null, 'Goal',          null, '2026-06-28T15:21:15.109Z', null),
  (126, 11, null, null, 'Opponent Goal', null, '2026-06-28T15:30:44.446Z', null),
  (127, 11, null, null, 'Opponent Goal', null, '2026-06-28T15:30:44.667Z', null),
  (128, 11, null, null, 'Opponent Goal', null, '2026-06-28T15:30:44.955Z', null),
  (129, 11, null, null, 'Opponent Goal', null, '2026-06-28T15:30:45.123Z', null),
  (130, 11, null, null, 'Opponent Goal', null, '2026-06-28T15:30:45.274Z', null),
  (131, 11, null, null, 'Opponent Goal', null, '2026-06-28T15:30:45.451Z', null),
  (132, 11, null, null, 'Opponent Goal', null, '2026-06-28T15:30:45.602Z', null),
  (133, 11, null, null, 'Opponent Goal', null, '2026-06-28T15:30:45.730Z', null),
  (134, 11, null, null, 'Opponent Goal', null, '2026-06-28T15:30:45.882Z', null),
  (136, 15, 12,   null, 'Goal',          null, '2026-06-28T15:33:04.224Z', null),
  (137, 15, null, null, 'Opponent Goal', null, '2026-06-28T15:33:12.149Z', null),
  (138, 15, null, null, 'Opponent Goal', null, '2026-06-28T15:33:12.306Z', null),
  (139, 15, null, null, 'Opponent Goal', null, '2026-06-28T15:33:12.483Z', null),
  (140, 15, null, null, 'Opponent Goal', null, '2026-06-28T15:33:12.652Z', null),
  (141, 15, null, null, 'Opponent Goal', null, '2026-06-28T15:33:12.850Z', null),
  (142, 15, null, null, 'Opponent Goal', null, '2026-06-28T15:33:13.002Z', null),
  (143, 15, null, null, 'Opponent Goal', null, '2026-06-28T15:33:13.171Z', null),
  (144, 15, null, null, 'Opponent Goal', null, '2026-06-28T15:33:13.317Z', null),
  (145, 15, null, null, 'Opponent Goal', null, '2026-06-28T15:33:13.485Z', null),
  (146, 15, null, null, 'Opponent Goal', null, '2026-06-28T15:33:13.668Z', null),
  (147, 15, null, null, 'Opponent Goal', null, '2026-06-28T15:33:13.836Z', null),
  (148, 15, null, null, 'Opponent Goal', null, '2026-06-28T15:33:14.078Z', null),
  (149, 15, null, null, 'Opponent Goal', null, '2026-06-28T15:33:14.755Z', null),
  (150, 15, null, null, 'Opponent Goal', null, '2026-06-28T15:33:15.286Z', null),
  (151, 15, null, null, 'Opponent Goal', null, '2026-06-28T15:33:15.846Z', null),
  (154, 15, null, null, 'Goal',          null, '2026-06-28T15:42:48.903Z', null);
select setval('game_events_id_seq', 154);
