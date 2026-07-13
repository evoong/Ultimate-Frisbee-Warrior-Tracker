-- Bumps a strategy_plays row's updated_at whenever any of its child rows
-- (steps, positions, opponent markers, arrows, text boxes) are inserted,
-- updated, or deleted, so the play list can be sorted "most recently
-- edited first" and actually reflect editing the board (dragging players,
-- adding steps, drawing arrows), not just renaming the play or relinking
-- its game (which already touch strategy_plays directly via
-- set_audit_fields, see 011_audit_columns.sql).
--
-- Run this entire file in the Supabase SQL Editor AFTER 017.

create or replace function public.touch_strategy_play()
returns trigger
language plpgsql
as $$
declare
  v_play_id bigint;
begin
  if tg_table_name = 'strategy_steps' then
    v_play_id := coalesce(new.play_id, old.play_id);
  else
    select play_id into v_play_id
    from public.strategy_steps
    where id = coalesce(new.step_id, old.step_id);
  end if;

  update public.strategy_plays set updated_at = now() where id = v_play_id;
  return coalesce(new, old);
end
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'strategy_steps', 'strategy_positions', 'strategy_opponent_markers',
    'strategy_arrows', 'strategy_text_boxes'
  ] loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch_play', t);
    execute format(
      'create trigger %I after insert or update or delete on public.%I
         for each row execute function public.touch_strategy_play()',
      t || '_touch_play', t
    );
  end loop;
end
$$;
