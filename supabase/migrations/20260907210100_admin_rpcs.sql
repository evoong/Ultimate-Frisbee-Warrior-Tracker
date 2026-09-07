-- The only two admin-console operations that genuinely need SQL. Everything
-- else the console does is a single-statement service-role write issued over
-- REST -- see docs/superpowers/specs/2026-09-07-admin-console-design.md.
--
-- Both are service-role-only: EXECUTE is revoked from every client role, and
-- the console reaches them through /api/admin/* handlers that already checked
-- platform_admins.

-- Blast radius of deleting an organization, so the console can show it before
-- committing. organizations cascades to roughly 26 tables, so the honest
-- answer is a per-table count.
--
-- The dependent list is derived from pg_constraint rather than by matching
-- column names. Name matching would wrongly include games.team_id,
-- seasons.team_id, and league_games.team_id, which reference teams(id), not
-- organizations(id) -- counting those would overstate the blast radius and
-- misreport which rows actually cascade. Name matching would also wrongly
-- exclude player_links.team_id and player_private.team_id, which really do
-- reference organizations(id) despite the misleading column name. Deriving
-- from real foreign keys also means a table added later is counted without
-- editing this function.
create or replace function public.admin_preview_delete_org(p_org_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row   record;
  v_count bigint;
  v_deps  jsonb := '{}'::jsonb;
begin
  if not exists (select 1 from public.organizations where id = p_org_id) then
    raise exception 'organization % does not exist', p_org_id;
  end if;

  for v_row in
    select c.relname::text as tbl, a.attname::text as col
      from pg_constraint k
      join pg_class c     on c.oid = k.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
     where k.contype = 'f'
       and k.confrelid = 'public.organizations'::regclass
       and array_length(k.conkey, 1) = 1
       and n.nspname = 'public'
       and c.relkind = 'r'
     order by c.relname, a.attname
  loop
    execute format('select count(*) from public.%I where %I = $1', v_row.tbl, v_row.col)
       into v_count using p_org_id;
    if v_count > 0 then
      v_deps := v_deps || jsonb_build_object(v_row.tbl || '.' || v_row.col, v_count);
    end if;
  end loop;

  return jsonb_build_object(
    'organization_id', p_org_id,
    'name',            (select name from public.organizations where id = p_org_id),
    'dependents',      v_deps
  );
end;
$$;

-- Fold one duplicate player into another. Must be one transaction, which
-- PostgREST cannot express as a sequence of separate calls -- that is the only
-- reason this is SQL rather than handler code.
--
-- Ten columns reference players(id). Six of their tables carry a unique
-- constraint (or primary key) that a naive repoint would violate:
--   game_attendance   (game_id, player_id)
--   game_lineups      (game_id, player_id, lineup_name)
--   season_players    (season_id, player_id)
--   strategy_positions(step_id, player_id)
--   player_links      (unique player_id)
--   player_private    (player_id primary key)
--
-- Conflict rule, applied uniformly: THE KEEPER'S ROW WINS. Where repointing
-- the merged player would collide with an existing keeper row, the merged
-- player's row is deleted instead. This is deliberately wholesale rather than
-- field-level coalescing -- a merge that silently blended two players'
-- attributes would be impossible to review after the fact, and the audit log
-- records the per-table counts either way.
create or replace function public.admin_merge_players(
  p_keep_id  integer,
  p_merge_id integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_keep_org  bigint;
  v_merge_org bigint;
  v_repointed jsonb := '{}'::jsonb;
  v_dropped   jsonb := '{}'::jsonb;
  v_n         bigint;
begin
  if p_keep_id = p_merge_id then
    raise exception 'cannot merge player % into itself', p_keep_id;
  end if;

  select organization_id into v_keep_org  from public.players where id = p_keep_id;
  select organization_id into v_merge_org from public.players where id = p_merge_id;

  if v_keep_org is null then
    raise exception 'player % does not exist', p_keep_id;
  end if;
  if v_merge_org is null then
    raise exception 'player % does not exist', p_merge_id;
  end if;
  if v_keep_org <> v_merge_org then
    raise exception 'players % and % are in different organizations', p_keep_id, p_merge_id;
  end if;

  -- Conflict-bearing tables: drop the merged player's colliding rows first,
  -- then repoint whatever is left.

  delete from public.game_attendance m
   where m.player_id = p_merge_id
     and exists (select 1 from public.game_attendance k
                  where k.player_id = p_keep_id and k.game_id = m.game_id);
  get diagnostics v_n = row_count;
  v_dropped := v_dropped || jsonb_build_object('game_attendance', v_n);

  delete from public.game_lineups m
   where m.player_id = p_merge_id
     and exists (select 1 from public.game_lineups k
                  where k.player_id = p_keep_id
                    and k.game_id = m.game_id
                    and k.lineup_name = m.lineup_name);
  get diagnostics v_n = row_count;
  v_dropped := v_dropped || jsonb_build_object('game_lineups', v_n);

  delete from public.season_players m
   where m.player_id = p_merge_id
     and exists (select 1 from public.season_players k
                  where k.player_id = p_keep_id and k.season_id = m.season_id);
  get diagnostics v_n = row_count;
  v_dropped := v_dropped || jsonb_build_object('season_players', v_n);

  delete from public.strategy_positions m
   where m.player_id = p_merge_id
     and exists (select 1 from public.strategy_positions k
                  where k.player_id = p_keep_id and k.step_id = m.step_id);
  get diagnostics v_n = row_count;
  v_dropped := v_dropped || jsonb_build_object('strategy_positions', v_n);

  -- At most one row per player: the keeper's wins outright.
  delete from public.player_links m
   where m.player_id = p_merge_id
     and exists (select 1 from public.player_links k where k.player_id = p_keep_id);
  get diagnostics v_n = row_count;
  v_dropped := v_dropped || jsonb_build_object('player_links', v_n);

  delete from public.player_private m
   where m.player_id = p_merge_id
     and exists (select 1 from public.player_private k where k.player_id = p_keep_id);
  get diagnostics v_n = row_count;
  v_dropped := v_dropped || jsonb_build_object('player_private', v_n);

  -- Repoint every surviving reference.

  update public.game_attendance set player_id = p_keep_id where player_id = p_merge_id;
  get diagnostics v_n = row_count;
  v_repointed := v_repointed || jsonb_build_object('game_attendance.player_id', v_n);

  update public.game_events set player_id = p_keep_id where player_id = p_merge_id;
  get diagnostics v_n = row_count;
  v_repointed := v_repointed || jsonb_build_object('game_events.player_id', v_n);

  update public.game_events set related_player_id = p_keep_id where related_player_id = p_merge_id;
  get diagnostics v_n = row_count;
  v_repointed := v_repointed || jsonb_build_object('game_events.related_player_id', v_n);

  update public.game_lineups set player_id = p_keep_id where player_id = p_merge_id;
  get diagnostics v_n = row_count;
  v_repointed := v_repointed || jsonb_build_object('game_lineups.player_id', v_n);

  update public.lineup_template_players set player_id = p_keep_id where player_id = p_merge_id;
  get diagnostics v_n = row_count;
  v_repointed := v_repointed || jsonb_build_object('lineup_template_players.player_id', v_n);

  update public.season_players set player_id = p_keep_id where player_id = p_merge_id;
  get diagnostics v_n = row_count;
  v_repointed := v_repointed || jsonb_build_object('season_players.player_id', v_n);

  update public.strategy_arrows set start_player_id = p_keep_id where start_player_id = p_merge_id;
  get diagnostics v_n = row_count;
  v_repointed := v_repointed || jsonb_build_object('strategy_arrows.start_player_id', v_n);

  update public.strategy_positions set player_id = p_keep_id where player_id = p_merge_id;
  get diagnostics v_n = row_count;
  v_repointed := v_repointed || jsonb_build_object('strategy_positions.player_id', v_n);

  update public.player_links set player_id = p_keep_id where player_id = p_merge_id;
  get diagnostics v_n = row_count;
  v_repointed := v_repointed || jsonb_build_object('player_links.player_id', v_n);

  update public.player_private set player_id = p_keep_id where player_id = p_merge_id;
  get diagnostics v_n = row_count;
  v_repointed := v_repointed || jsonb_build_object('player_private.player_id', v_n);

  delete from public.players where id = p_merge_id;

  return jsonb_build_object(
    'keep_id',   p_keep_id,
    'merge_id',  p_merge_id,
    'repointed', v_repointed,
    'dropped',   v_dropped
  );
end;
$$;

revoke all on function public.admin_preview_delete_org(bigint) from public, anon, authenticated;
revoke all on function public.admin_merge_players(integer, integer) from public, anon, authenticated;
