# Production chain rehearsal

Status: **harness and down plan built; the real rehearsal has NOT been run.** The only
result so far is on a SYNTHETIC schema (section 5). It does not satisfy the Promote
rehearsal gate.

This is the tool behind [PROMOTE-PACKET-2026-10-08.md](PROMOTE-PACKET-2026-10-08.md)
section 4.5. It applies the production migration chain, file by file, to a throwaway
local Postgres that holds a copy of production's schema and the rows of the constrained
tables, so a constraint that rejects an existing row, or a file that cannot apply over an
older variant, fails here instead of in the Promote window.

It never connects to a hosted database. The only thing it talks to is the local docker
daemon, and the container is removed when it finishes.

## 1. What it does

`scripts/release/prod-chain-rehearsal.mjs`, in order:

1. Wraps every chain file in the same atomic wrapper the production run uses: one
   transaction with lock and statement timeouts, a ledger guard (refuses a version or name
   already recorded), the file verbatim, the ledger row, commit. A file that cannot be
   wrapped (top-level `BEGIN`/`COMMIT`, `CONCURRENTLY`, `VACUUM`) stops the run before any
   database exists.
2. Starts a container from the Supabase Postgres image, so `anon`, `authenticated`,
   `service_role` and `supabase_read_only_user` are real roles. It stubs what the image
   lacks (`storage.buckets`, `storage.objects`, `storage.foldername`, the ledger table).
   Any other Postgres image works too: the harness creates the roles and schemas itself.
3. Loads the schema-only dump, then the optional row CSVs (with triggers and foreign keys
   off for the load, `CHECK` constraints still enforced).
4. Applies the chain in strict filename order, one transaction per file, and **stops at the
   first failure**. Files marked `record-only` run last and only insert their ledger row.
5. Reports per file (`PASS`, `FAIL`, `NOT RUN`, `RECORDED`), then post-chain checks:
   every chain version in the ledger, `SECURITY DEFINER` functions callable by `anon` or
   `authenticated`, public tables with RLS off (each also measured before the chain), and
   row counts of the loaded tables before and after.
6. Optionally rehearses the `hivra_agents` down plan (section 6).

The report is plain text and JSON. It carries table names, counts and file names, never
row values, paths or hosts.

## 2. Inputs

| Input | Flag | Notes |
|---|---|---|
| Schema dump | `--schema` | `pg_dump --schema-only --no-owner --schema public`, keeping privileges (grants matter for the security checks). `CREATE SCHEMA public` and default privileges for the image's admin role are skipped and counted in the report; anything else that fails to load fails the run unless `--allow-load-errors`. |
| Chain | `--chain` | One version per line, optionally `<version> record-only`. Order is forced to filename order. The pinned list is `scripts/release/fixtures/prod-chain/chain-2026-10-08.txt` (197 files, one record-only). Recompute it on the day (packet section 5a). |
| Rows (optional) | `--rows table=file.csv` | Only `hivra_agents`, `crypto_deposit_receipts`, `yearly_token_quotes`, `yearly_token_subscriptions`, `managed_venice_token_quotes`. CSV with a header of column names. |
| Kind | `--kind real\|synthetic` | `real` means the schema is a dump of the real target. A `synthetic` report says so in its first line and can never be eligible for the gate. |
| Migrations | `--migrations` | Default `dashboard/supabase/migrations`. |

Row CSVs hold customer data. Keep them local, never commit them, and delete them with the
container when the run is done.

## 3. Run it

```sh
# real run, once the owner has produced the dump and CSVs (owner action)
node scripts/release/prod-chain-rehearsal.mjs \
  --schema /path/to/prod-schema.sql \
  --chain scripts/release/fixtures/prod-chain/chain-2026-10-08.txt \
  --kind real \
  --rows hivra_agents=/path/to/hivra_agents.csv \
  --rows crypto_deposit_receipts=/path/to/crypto_deposit_receipts.csv \
  --rows yearly_token_quotes=/path/to/yearly_token_quotes.csv \
  --rows yearly_token_subscriptions=/path/to/yearly_token_subscriptions.csv \
  --rows managed_venice_token_quotes=/path/to/managed_venice_token_quotes.csv \
  --probe scripts/release/fixtures/prod-chain/old-build-hivra-agents-probe.sql \
  --guard-scope scripts/release/fixtures/prod-chain/hivra-agents-guard-files.txt \
  --down-plan docs/release/HIVRA-AGENTS-GUARDS-DOWN-PLAN.sql \
  --rearm docs/release/HIVRA-AGENTS-GUARDS-REARM.sql \
  --report-md rehearsal.md --report-json rehearsal.json
```

Exit code 0 only when every file passes, every chain version is in the ledger, and (when
given) the down plan review, application and re-arm all pass. A run takes about a minute.

Build a synthetic input to try the tool without a dump:

```sh
node scripts/release/prod-chain-synthetic.mjs scripts/release/fixtures/prod-chain/chain-2026-10-08.txt /tmp/synth
# writes /tmp/synth/schema.sql and one CSV per constrained table
```

The synthetic builder applies every migration that is NOT in the chain (the baseline,
179 files), then `synthetic-prod-overlay.sql` (invented prod-only extensions and tables,
a stale `SECURITY DEFINER` helper, an older same-named index), then invented rows
(`synthetic-prod-rows.sql`: 108 agents, 14 receipts, 3 yearly quotes, 1 yearly
subscription, 179 managed-Venice quotes, the counts the packet gives).

Tests: `node --test scripts/release/prod-chain-rehearsal.test.mjs` (pure logic, runs in
CI). With docker, `HIVRA_REHEARSAL_DB_TEST=1 node --test ...` also runs the end to end
case on a throwaway Postgres (set `HIVRA_REHEARSAL_TEST_IMAGE` to choose the image).

## 4. How to read a failure

A `FAIL` line names the file and Postgres' first error lines. The file is atomic: nothing
of it was applied and no ledger row was written, and nothing after it ran. The usual
causes, from the packet:

- a validated constraint rejects an existing row (the error names the constraint and
  relation): repair the data or relax the constraint by a PR into `canary`, never edit a
  merged file;
- an `anchor mismatch` from a release admission file: the chain was run out of order or a
  file it rewrites is missing;
- a file that assumes an object the dump does not have.

Keep the `--keep` container to inspect (`docker exec`), then remove it.

## 5. Result so far: SYNTHETIC

Run on this branch against the synthetic schema (docker, Supabase Postgres 17.6 image):

```
SYNTHETIC RESULT. The schema was built from public migrations plus modelled older variants,
not from a dump of production. This does NOT satisfy the production rehearsal gate.
chain files: 197  result: PASS
summary: PASS=196 RECORDED=1
post: chain versions in ledger 197/197; missing 0; SECURITY DEFINER callable by
      anon/authenticated 0; public tables with RLS off 0
pre-chain (the loaded schema): SECURITY DEFINER callable by anon/authenticated 21; RLS off 1
row counts before -> after: hivra_agents 108 -> 108, crypto_deposit_receipts 14 -> 14,
      yearly_token_quotes 3 -> 3, yearly_token_subscriptions 1 -> 1,
      managed_venice_token_quotes 179 -> 179
```

Negative control (same schema, one `crypto_deposit_receipts` row with
`sweep_status = 'confirmed'` and no sweep hash, fixture
`negative-control-crypto_deposit_receipts.csv`): the run stops at file 155,
`20260922185029_credit_deposit_sweep_state`, with
`check constraint "crypto_deposit_receipts_sweep_confirmed_check" ... is violated by some row`;
files 1 to 154 passed (their versions are in the ledger) and the 42 files after the failure are `NOT RUN`.

What the synthetic run says: the 197 files apply in filename order over a schema that
contains every other migration, over rows shaped like the old build's, and the harness
detects a bad row, a bad down plan and a missing guard. What it cannot say: anything about
the real production schema. The overlay models the kinds of difference the packet lists
with invented objects; the real older constraint and function variants, production grants,
production-only functions, `cron.job` and the 36 production-only tables are not in it.

Not covered even with a real dump: rows of tables other than the five (a constraint that
validates against another table sees empty parents there), and how the live build behaves.

## 6. The `hivra_agents` down plan

Files: [HIVRA-AGENTS-GUARDS-DOWN-PLAN.sql](HIVRA-AGENTS-GUARDS-DOWN-PLAN.sql) and its
companion [HIVRA-AGENTS-GUARDS-REARM.sql](HIVRA-AGENTS-GUARDS-REARM.sql). They live under
`docs/release/`, not under `dashboard/supabase/migrations/`, on purpose: no migration
runner can apply them. They are an emergency script for the owner.

**Scope.** The down plan drops every trigger and `CHECK` constraint that the 16 NOT-AS-IS
files (packet section 4.2) introduce on `hivra_agents`, measured from the rehearsal, not
read off the files: **16 triggers and 18 constraints**, no `NOT NULL` without a default
(the new columns that are `NOT NULL` all have one). `guard-files.txt` lists the 16 files.
The harness compares the plan to that measured set and fails on a missing drop, an
unrelated drop, or any other statement.

**What it loses** is listed in the SQL header: the deployment authority matrix and
self-managed binding checks, the lifecycle operation shape, provider ownership and
installer, native and desktop fences, attachment, desktop-prepare and private-access lease
guards, gVisor and managed-session identity guards, the provisioner channel rule, the
CPU/RAM envelope, Windows ISO and desired-state checks. The new build relies on them, so
the way back is the re-arm script, which re-adds the same definitions and re-validates
every row.

**What it leaves.** Columns, defaults, indexes, RLS, keys, the trigger functions, and the
guards introduced by other files. Those are 15 triggers and 3 constraints:

| File | Left in place |
|---|---|
| 20260826120000 portable_hivra_target_bindings | constraint `hivra_agents_self_managed_binding_complete_check` |
| 20260827090000 hivra_delete_credential_guard | trigger `hivra_agents_delete_credential_guard` |
| 20260828040000 provider_power_operation_fence | trigger `hivra_agents_provider_power_guard` |
| 20260828060000 provider_computer_launch_admission | trigger `hivra_agents_provider_launch_model_guard` |
| 20260828080000 hivra_model_key_operations | triggers `hivra_agents_model_key_guard`, `hivra_agents_model_key_cleanup` |
| 20260828090000 hivra_launch_model_custody | triggers `hivra_agents_launch_model_guard`, `hivra_agents_launch_model_cleanup` |
| 20260831234500 provider_native_cleanup_fence | trigger `hivra_agents_provider_native_lifecycle_guard` |
| 20260901010000 hivra_buzz_runtime | trigger `retire_hivra_buzz_runtime_after_agent_delete` |
| 20260903010000 hivra_computer_profiles | constraint `hivra_agents_computer_profile_check` |
| 20260904100000 hivra_canonical_resource_shadow | trigger `hivra_canonical_hivra_source_event` |
| 20260904130000 hivra_provider_resize_operations | trigger `hivra_agents_provider_resize_guard` |
| 20260905100000 hivra_folder_recovery | trigger `hivra_folder_recovery_lease_guard` |
| 20260906070000 provider_workspace_sessions | trigger `invalidate_hivra_workspace_sessions` |
| 20260915130000 windows_byo_iso_launch | constraint `hivra_windows_byo_iso_shape_check` |
| 20260923190000 hivra_activity_retention | trigger `delete_hivra_activity_after_agent_delete` |
| 20260924090000 drop_user_bankr_key_on_agent_delete | trigger `drop_user_bankr_key_after_hivra_agent_delete` |

The packet's static scan called these files ADDITIVE or REVIEW because they validate no
existing rows. They are still guards on the table. If the old build is blocked by one of
them, extend the down plan with a `drop trigger` / `drop constraint` for that name and
re-run the rehearsal; the scope file and review check stay the same.

**Rehearsal result (SYNTHETIC).** After the chain: the plan reviewed clean against the
measured guards; it applied in one transaction; none of the 34 in-scope guards remained;
re-arm restored a guard set identical (names and definitions) to the post-chain one.
Write probe (`old-build-hivra-agents-probe.sql`, nine old-shaped writes as `service_role`:
create, mark running, stop and start, record error, soft and hard delete, and the same
moves on existing rows): all nine pass before the chain, after the chain, after the down
plan and after the re-arm. Two **control** writes (not old-build writes: an invalid
deployment mode, a substrate flip) are rejected while the guards stand, accepted after the
down plan, and rejected again after the re-arm, which shows the probe can see the guards.

**Read this carefully.** In the synthetic rehearsal the old-shaped writes were **not**
rejected by the guards even before the down plan; only the controls were. That is
consistent with the migrations' own design (new columns default to the managed values, a
compatibility trigger normalises old lifecycle writes), but it is not proof for the real
build or real rows. What the live build actually writes to `hivra_agents` is unverified.
The down plan is insurance for the case where it does trip a guard.
