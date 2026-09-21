-- Coerce the stale hermes_instances.backend = 'webui' value on RUNNING boxes.
--
-- Background: the Phase-2 webui-retirement collapsed 'gateway' and 'webui' onto
-- a single "webfree" stack. New provisioning always writes 'gateway'
-- (resolveDefaultInstanceBackend + workspace-cloud-provisioner), and NOTHING in
-- the app inserts 'webui' any longer. But ~55 running rows still carried the
-- stale 'webui' label, and a handful of RAW-value readers diverge on it:
--
--   * resolveWebfreeGatewayService('webui') -> restarts a `webui` compose
--     service that these boxes do not have (they run a `gateway` service),
--   * agentPortsForBackend('webui') -> ports 8787 instead of the 8642 the
--     webfree stack actually binds.
--
-- A 2026-07-09 fleet audit (qm guest exec `docker ps` across the RUNNING
-- backend='webui' cohort — all 55 rows, incl. every backend='webui' AND
-- webfree=false row) found ZERO boxes running a bare `agent-<uuid>` / `webui`
-- compose service: every one runs the webfree `-gateway` + `-official-dashboard`
-- topology. So coercing these rows to 'gateway' does not just remove dead
-- branches, it FIXES the restart target and port selection for those boxes.
--
-- SCOPED TO status='running' ON PURPOSE. Cold-restore replays the box's ARCHIVED
-- per-instance docker-compose (restore-vm-cold.sh `docker compose up` on
-- /opt/hermes/instances/<id>), NOT a fresh webfree provision. A non-running VM
-- has nothing to `docker ps`, so the stopped/archived cohort is structurally
-- unauditable, and a box archived while it genuinely ran the legacy `webui`
-- service would restore as `webui`. Coercing such a row to 'gateway' would then
-- point restart_gateway at a nonexistent `gateway` service. Running boxes are
-- exactly the cohort we verified live, so we touch only those; the
-- stopped/archived rows keep their value (their getter result still routes
-- through isWebfreeBackend(), so no live behaviour depends on it).
--
-- The CHECK constraint is intentionally left permissive (still allows 'webui')
-- for rollback safety. Idempotent: re-running is a no-op once the rows flip.

UPDATE public.hermes_instances
SET backend = 'gateway'
WHERE backend = 'webui'
  AND status = 'running';
