# Off-site backup design

## Goal and scope

Protect this application's recoverable state without paid services. Back up committed and uncommitted repository files, Supabase Postgres data (including auth users and Storage metadata), Supabase Storage object bytes, and local deployment/configuration secrets. Do not back up reproducible dependencies, build output, caches, logs, or unrelated files on this machine. A successful backup must be independently restorable after loss of either this machine or the Supabase project.

## Destination and security

Use the existing `gdrive-ericvoong0309` rclone remote (~15.98 GB free at design time) as off-site destination. Encrypt all payloads and filenames before upload using a dedicated rclone crypt remote. Keep its recovery password and salt in an owner-controlled password manager/off-machine location; a copy on this machine alone does not satisfy recovery. Never upload raw `.env` files, database dumps, user data, or Storage objects to Drive or GitHub. Backup processes must not print connection strings, keys, or private data. Use restrictive local permissions and temporary directories outside the repo; remove plaintext staging after verified upload. Do not put backup data in Git or a publicly accessible bucket.

## Capture

1. Repository: preserve Git history, all working-tree changes including untracked files, and the small set of ignored, irreplaceable local configuration files (not `node_modules`, build/cache output, QA dumps, logs, or local database volumes). Record current commit and working-tree status. Do not push uncommitted or secret material to GitHub.
2. Database: take a read-only logical export using Supabase-supported CLI dump commands for roles, schema, and data, including auth and Storage metadata where supported; validate actual dump contents before declaring coverage. Do not run `db push`, `db reset`, migrations, or a production restore. Use a suitable supported DB connection (not an assumed working hostname). Dumps may span an interval while writes continue, so record capture times and treat database/Storage as a recoverable near-time snapshot, not an atomic point-in-time copy.
3. Storage: enumerate every application Storage bucket and download all object bytes with Supabase Storage CLI or a read-only S3-compatible client; keep bucket, object path, size, and checksum manifest. An existing Supabase database backup contains Storage metadata but not object bytes. Never use `sync` with deletion against either source or backup destination. If a bucket/object cannot be read, mark the run failed rather than reporting a complete backup.
4. Secrets/settings: include only explicitly enumerated local secret/config files needed for recovery; avoid sweeping all ignored files or credential stores. Document external settings that cannot be exported as files (Supabase Auth/provider settings, deploy-platform secrets, DNS, third-party credentials) as a manual recovery checklist, without exposing values.

## Schedule and lifecycle

After a successful manual baseline, run daily from this Ubuntu machine using an available persistent scheduler. Verify that it runs when no interactive shell is open; otherwise explicitly state the machine-login/uptime dependency. Store each run under a unique UTC timestamp with manifest and independent contents. Retain seven daily and four weekly successful snapshots, subject to free-space checks; never remove the last known-good snapshot or prune after a failed run. If quota is insufficient, fail and alert rather than deleting source data or silently dropping coverage. Deliver failure/success status locally via scheduler logs and a clear last-success marker; add off-machine notification only when an already-available channel is confirmed.

## Restore and verification

A backup run succeeds only when exports complete, Storage inventory matches downloaded object count/bytes, encrypted uploads complete, and remote manifests and representative files can be read back and checksum-verified. Test a non-production restore of Git/working-tree files and a sample Storage object. Validate database dump structure and rehearse a full database restore only in an explicitly approved isolated environment; local QA Docker is disabled by default on this machine and must not be started automatically. Restore runbook: recover crypt key from off-machine location, retrieve one snapshot, inspect its manifest, restore code and secrets privately, provision a separate Supabase project or approved isolated target, restore database, upload Storage object bytes via Storage API, then verify auth/data/object references. Never restore onto production without separate authorization.

## Implementation boundaries

Use installed `rclone` and Supabase CLI where possible; add no app runtime dependencies or database migrations. Keep backup scripts and scheduler definitions small and outside normal app execution. First inspect actual Storage inventory, free Drive quota, CLI commands, credential availability, and scheduler persistence without exposing secret values. Stop before enabling scheduled uploads if recovery key has not been stored off-machine. Test failure paths and a manual baseline before scheduling. Existing GitHub origin protects pushed commits only, not unsaved/ignored local state. Supabase plan-dependent database backups are useful secondary protection, not substitute for independently held exports and object bytes.

## References

- Supabase database backups exclude Storage object bytes: https://supabase.com/docs/guides/platform/backups
- Supabase Storage supports CLI and S3-compatible download: https://supabase.com/docs/guides/storage/management/download-objects
- Supabase database export/restore guidance: https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore
