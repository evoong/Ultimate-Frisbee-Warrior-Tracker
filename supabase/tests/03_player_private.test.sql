begin;
select plan(5);

select has_table('public', 'player_private', 'player_private exists');
select hasnt_column('public', 'players', 'phone', 'phone no longer lives on players');
select hasnt_column('public', 'players', 'first_name_edit', 'first_name_edit moved off players');
select hasnt_column('public', 'players', 'last_name_edit', 'last_name_edit moved off players');

select is(
  (select phone from public.player_private where player_id = 101),
  '555-0101',
  'seeded phone for player 101 lives in player_private and is readable there'
);

select * from finish();
rollback;
