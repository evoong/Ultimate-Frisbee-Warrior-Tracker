-- Gives Strategy board text boxes (strategy_text_boxes, 014_strategy_text_boxes.sql)
-- a custom text color, an optional filled background using that same
-- color, and a user-adjustable width, so a callout can be color-coded and
-- sized instead of always rendering as plain foreground-colored text in a
-- fixed-width box.
--
-- color is nullable: null means "use the default foreground color", the
-- exact look every existing text box already has, so this migration is a
-- no-op visually until someone actually picks a color.

alter table public.strategy_text_boxes add column if not exists color text;
alter table public.strategy_text_boxes add column if not exists filled boolean not null default false;
-- Fraction of the field container's rendered width, same convention as
-- x/y being fractions of the field for position. 0.12 matches the
-- longstanding fixed min-w-[70px] box this replaces on a typical field size.
alter table public.strategy_text_boxes add column if not exists width numeric not null default 0.12;
