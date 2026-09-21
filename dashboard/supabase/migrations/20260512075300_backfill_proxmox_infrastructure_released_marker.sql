-- Backfill the `config.infrastructureReleased` marker for rows that already
-- went through a deliberate handle-strip BEFORE that marker existed.
--
-- Context: 20260512 we shipped two related fixes:
--
--   1. b254d680 — when GET observes `qm status` reporting vmid missing on
--      the routed host, we now null `proxmox_vmid` AND strip
--      `config.infrastructure` so a later delete can't teardown a vmid that
--      has been recycled to another user's row (kairo/ari + ghost-row).
--
--   2. (this PR) — the strip also stamps `config.infrastructureReleased =
--      { at, reason }` so DELETE / force-delete / account-delete can tell
--      "we verified the VM is gone" from "we never had a complete handle."
--      The first is a safe DB-only delete; the second still refuses.
--
-- Rows that hit (1) but not (2) — i.e. they were stripped between b254d680
-- shipping and this PR landing — are stuck: their Delete button returns
-- 502 ("Proxmox delete failed: no infrastructure handle") because
-- `infrastructure_provider` is still 'proxmox' (makes them look
-- Proxmox-backed) but `proxmox_vmid` is null + `config.infrastructure` is
-- gone (no resolvable lifecycle target), and there's no release marker to
-- unblock the guard.
--
-- This backfill stamps the marker on every row that matches that exact
-- stuck shape, so the user can finally remove the error-state row from
-- their dashboard. Uses a distinct reason ('legacy_backfill') so these
-- rows are distinguishable from organically-released ones in audit /
-- telemetry queries.
--
-- Idempotent: the `(config -> 'infrastructureReleased') is null` predicate
-- means re-running this is a no-op.

update public.hermes_instances
set
  config = coalesce(config, '{}'::jsonb) || jsonb_build_object(
    'infrastructureReleased',
    jsonb_build_object(
      'at', to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'reason', 'legacy_backfill'
    )
  ),
  updated_at = now()
where infrastructure_provider = 'proxmox'
  and proxmox_vmid is null
  and lifecycle_state is distinct from 'deleted'
  and (config -> 'infrastructure') is null
  and (config -> 'infrastructureReleased') is null;
