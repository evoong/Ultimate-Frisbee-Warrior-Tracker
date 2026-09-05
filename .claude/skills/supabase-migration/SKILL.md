---
name: supabase-migration
description: Create and apply a new Supabase migration for this project using the Supabase CLI against the local database in supabase/migrations/
disable-model-invocation: false
---

# Supabase Migration

This project tracks schema changes as CLI-generated migration files in
`supabase/migrations/`, starting from a baseline schema dump of production
(`00000000000000_baseline.sql`). Use this workflow instead of editing the
database ad hoc.

`supabase-migrations/` (no slash) is frozen history from the old hand-applied
workflow; do not add files there. See `supabase-migrations/README.md`.
`supabase-schema.sql` is likewise superseded by the baseline in
`supabase/migrations/`.

## 1. Understand the current schema

- List existing migrations in `supabase/migrations/` to see what has already
  landed.
- If Supabase MCP tools are connected, use `list_tables` to confirm the live
  schema matches what the migration files imply before writing a new one.

## 2. Write the migration

- Create the migration:      `supabase migration new <name>`
- Edit the generated file under `supabase/migrations/` with the new schema
  change. Keep it additive and reversible where possible (avoid destructive
  `DROP` without an explicit user request).
- Follow the style of existing migration files (naming, comments explaining
  *why*, RLS policy conventions already used in this repo).

## 3. Apply

- Apply locally and test:    `npm run db:reset && npm run db:test`
- Apply to production:       `supabase db push --db-url "$DATABASE_URL"`
- Do not run `supabase db push` without an explicit MCP tool call or the
  user's direct instruction. Confirm project/environment first if there is
  any ambiguity between environments.

## 4. Keep the snapshot in sync

- This step no longer applies. `supabase-schema.sql` is superseded by the
  baseline in `supabase/migrations/00000000000000_baseline.sql`; there is no
  separate snapshot file to update after a migration.

## 5. Verify

- Confirm the new table/column/policy exists via `list_tables` /
  `execute_sql` (read-only), or via the local pgTAP suite in
  `supabase/tests/`, before reporting the migration as complete.
