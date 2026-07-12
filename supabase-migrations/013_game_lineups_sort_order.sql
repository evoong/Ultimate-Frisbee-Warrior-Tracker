-- Adds an explicit ordering column to game_lineups so players within a
-- lineup group (e.g. "Lineup 1") can be manually reordered (drag handle in
-- the Schedule page's Lineups tab), rather than relying on insertion/id
-- order which isn't guaranteed by Postgres and isn't user-controllable.
--
-- Named sort_order, not position: game_lineups rows are already joined with
-- players(position) (the on-field position text, e.g. "Handler") and
-- flattened onto the same object client-side, so a column literally named
-- position would collide with and silently overwrite that text field.

alter table public.game_lineups add column if not exists sort_order integer;

-- Backfill existing rows: order by id (insertion order) within each
-- (game_id, lineup_name) group, starting at 0.
with ranked as (
  select id, row_number() over (partition by game_id, lineup_name order by id) - 1 as rn
  from public.game_lineups
)
update public.game_lineups gl
set sort_order = ranked.rn
from ranked
where gl.id = ranked.id
  and gl.sort_order is null;

alter table public.game_lineups alter column sort_order set default 0;
alter table public.game_lineups alter column sort_order set not null;
