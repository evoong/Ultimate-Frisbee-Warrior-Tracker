# Frozen migration history (001-027)

These files are the historical record of schema changes applied by hand
through the Supabase SQL editor. **Do not add files here.**

They are not replayable: `game_attendance` and `chat_logs` were created
ad hoc in the live database and have no `create table` in this directory,
so replaying these files produces a database that differs from production.

New migrations live in `supabase/migrations/` and are applied with the
Supabase CLI. The baseline there (`00000000000000_baseline.sql`) is a
schema dump of production taken 2026-09-03, which is the only accurate
starting point.

See `docs/superpowers/specs/2026-09-03-team-permissions-design.md`.
