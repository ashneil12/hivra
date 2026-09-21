# Supabase Migration Runbook

Use this runbook from `/Users/example/Projects/Hermesdeploy/dashboard`.

## Rules

- Treat `supabase/migrations` as append-only.
- Never edit, rename, or delete a migration that has been pushed anywhere shared.
- If the remote database was changed outside local migrations, reconcile it with `supabase db pull` and then commit the generated migration.
- If migration history is wrong but the schema is already correct, repair history with `supabase migration repair`.

## Normal Release Flow

1. Check local vs remote migration history:

```bash
supabase migration list -p '<DB_PASSWORD>'
```

2. Preview pending migrations before applying:

```bash
supabase db push --dry-run -p '<DB_PASSWORD>'
```

3. Apply them only after the dry run looks correct:

```bash
supabase db push -p '<DB_PASSWORD>'
```

## Drift Recovery

If someone changed the hosted database directly in the Supabase dashboard or another tool:

1. Inspect history first:

```bash
supabase migration list -p '<DB_PASSWORD>'
```

2. Pull the remote schema into a new migration file:

```bash
supabase db pull reconcile_remote_schema -p '<DB_PASSWORD>'
```

3. Review the generated SQL carefully, then commit it.

## History Repair

If the schema already matches reality but the migration history table is wrong:

Mark a version as applied:

```bash
supabase migration repair --status applied 20260403000000 -p '<DB_PASSWORD>'
```

Mark a version as reverted:

```bash
supabase migration repair --status reverted 20260403000000 -p '<DB_PASSWORD>'
```

Run `supabase migration list -p '<DB_PASSWORD>'` again after any repair.

## Local CI Guard

This repo now has a migration hygiene check:

```bash
node scripts/check-supabase-migration-hygiene.cjs --base origin/main --head HEAD
```

What it allows:

- adding a brand-new migration file with a timestamped name

What it blocks:

- editing an existing migration
- renaming an existing migration
- deleting an existing migration
- duplicate timestamp prefixes

## After an Emergency Fix

If you had to patch or reconcile production quickly:

1. make the smallest safe schema change
2. pull or add the matching migration locally
3. commit the migration file
4. rerun:

```bash
supabase migration list -p '<DB_PASSWORD>'
supabase db push --dry-run -p '<DB_PASSWORD>'
```
