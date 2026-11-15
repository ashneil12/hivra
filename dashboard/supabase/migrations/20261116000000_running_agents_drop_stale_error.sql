-- A row that converged to running through a path that did not clear `error`
-- (a restart, an operation release, an older completion writer) kept showing
-- the old failure text — observed live: provisioning-day ssh timeouts still
-- displayed three days into a healthy run. Error text on a running row is
-- always stale; the writer side is guarded in sanitizeHivraAgentRow, and this
-- backfills the rows already carrying it.
update public.hivra_agents
set error = null
where status = 'running' and error is not null;
