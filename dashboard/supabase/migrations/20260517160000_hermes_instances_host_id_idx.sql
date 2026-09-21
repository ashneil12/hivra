-- Performance: add a partial index on hermes_instances.host_id.
--
-- host_id is filtered with .eq() in at least 8 production paths (instance
-- list, host delete, several cron sweeps) but had no covering index. The
-- table is small enough today that a sequential scan still finishes fast,
-- but once the fleet passes ~10k rows every host-scoped query starts
-- pulling the entire table — including the wide `config` jsonb column —
-- per call. Marketing-site polling at /api/stats/agents-deployed already
-- counts the table, so the seq-scan cost would compound quickly.
--
-- Partial on `host_id is not null` because the vast majority of legacy
-- single-tenant rows pre-date the column (they're NULL) and don't need
-- to be indexed for the host-scoped queries.

-- Plain (non-concurrent) CREATE INDEX matches every other migration in
-- this repo. Supabase wraps each migration in a transaction, and
-- CREATE INDEX CONCURRENTLY cannot run inside one. The brief AccessShareLock
-- this takes on the row-count we currently carry (<10k) is acceptable.
create index if not exists hermes_instances_host_id_idx
  on public.hermes_instances(host_id)
  where host_id is not null;
