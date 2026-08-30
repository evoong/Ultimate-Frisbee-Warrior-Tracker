---
name: supabase-migration
description: Create and apply a new Supabase migration for this project, keeping supabase-migrations/ and supabase-schema.sql in sync
disable-model-invocation: false
---

# Supabase Migration

This project tracks schema changes as numbered SQL files in
`supabase-migrations/` and keeps a full snapshot in `supabase-schema.sql`.
Use this workflow instead of editing the database ad hoc.

## 1. Understand the current schema

- List existing migrations in `supabase-migrations/` to find the next
  sequence number (files are prefixed `NNN_description.sql`, e.g.
  `016_organizations.sql`).
- If Supabase MCP tools are connected, use `list_tables` to confirm the live
  schema matches what the migration files imply before writing a new one.

## 2. Write the migration

- Create `supabase-migrations/<NNN>_<short_description>.sql` with the new
  migration. Keep it additive and reversible where possible (avoid
  destructive `DROP` without an explicit user request).
- Follow the style of existing migration files (naming, comments explaining
  *why*, RLS policy conventions already used in this repo).

## 3. Apply

- If using Supabase MCP: use `apply_migration` against the correct project
  (confirm project ref with the user first if there is any ambiguity between
  environments).
- Otherwise, direct the user to apply it via the Supabase CLI or dashboard —
  do not attempt to execute raw SQL against production without an explicit
  MCP tool call or the user's direct instruction.

## 4. Keep the snapshot in sync

- After the migration is applied, regenerate or manually update
  `supabase-schema.sql` so it reflects the new schema (dump the full schema
  rather than hand-editing whenever possible).

## 5. Verify

- Confirm the new table/column/policy exists via `list_tables` /
  `execute_sql` (read-only) before reporting the migration as complete.
