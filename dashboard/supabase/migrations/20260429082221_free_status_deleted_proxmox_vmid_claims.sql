-- Follow-up to 20260429081512: that migration filtered on
-- `status in ('error','failed','stopped')` to be conservative, but the
-- next provision attempt STILL hit 23505 on proxmox_vmid=200. The likely
-- culprit: a row whose status='deleted' (set by an old DELETE handler
-- that didn't also flip lifecycle_state). Per the partial unique index
-- definition (`where proxmox_vmid is not null and lifecycle_state <>
-- 'deleted'`), a status='deleted' row with lifecycle_state still
-- 'provisioning' or 'active' continues to claim its VMID slot
-- indefinitely. The DELETE handler is now patched in 0dd77811 to also
-- write lifecycle_state='deleted' + proxmox_vmid=null, but this won't
-- help rows that were deleted before that fix.
--
-- Sweep ANY Proxmox-backed row whose status indicates it's no longer
-- live (deleted / error / failed / stopped) OR whose provisioning is
-- demonstrably stuck (>5min, null gateway_url). Null proxmox_vmid +
-- flip lifecycle_state to 'deleted' so the slot reopens.
update public.hermes_instances
set proxmox_vmid = null,
    lifecycle_state = 'deleted',
    deleted_at = coalesce(deleted_at, now())
where infrastructure_provider = 'proxmox'
  and proxmox_vmid is not null
  and (
    status in ('deleted', 'error', 'failed', 'stopped')
    or (
      status = 'provisioning'
      and gateway_url is null
      and created_at < now() - interval '5 minutes'
    )
  );
