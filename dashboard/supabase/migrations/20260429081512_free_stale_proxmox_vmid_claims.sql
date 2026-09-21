-- Free stale proxmox_vmid claims so the unique index
-- (hermes_instances_active_proxmox_vmid_idx, defined in
-- 20260425110000_instance_lifecycle_foundation.sql) doesn't block fresh
-- provisions when an old row with the same VMID is still marked active.
--
-- Symptom that motivated this: VM 200 had been destroyed on the Proxmox
-- host (qm destroy) but a row in hermes_instances still had
-- proxmox_vmid=200 / lifecycle_state != 'deleted'. The provision script
-- on the host picks the next free VMID by scanning `qm list`, sees 200
-- is free, allocates it — and then the post-provision DB update hits a
-- 23505 unique-constraint violation on proxmox_vmid because the stale
-- row still claims it. The new instance row gets created at insert time
-- but its post-provision metadata never lands; the Proxmox VM is
-- physically up but the dashboard shows it as forever-spinning
-- "Provisioning server" since gateway_url stays null.
--
-- Heuristic for "stale": Proxmox-backed row with a non-null proxmox_vmid
-- whose status is one of error / failed / stopped (definitely dead),
-- OR provisioning with a null gateway_url and >5min old (the kickoff
-- never finished writing post-provision metadata — see the orphan
-- cleanup migrations for fixturecase14 / fixturecase15 / fixturecase16). For these
-- rows we null out proxmox_vmid and flip lifecycle_state to 'deleted'
-- so the unique index releases the slot.
--
-- We intentionally avoid touching rows that are 'running' / 'active' /
-- 'paused' — those are real, in-use instances and their VMID claim is
-- still live.
update public.hermes_instances
set proxmox_vmid = null,
    lifecycle_state = 'deleted',
    deleted_at = coalesce(deleted_at, now())
where infrastructure_provider = 'proxmox'
  and proxmox_vmid is not null
  and (
    status in ('error', 'failed', 'stopped')
    or (
      status = 'provisioning'
      and gateway_url is null
      and created_at < now() - interval '5 minutes'
    )
  );

-- Belt-and-suspenders: the cleanup-orphan migrations earlier today
-- DELETEd fixturecase14 / fixturecase15 / fixturecase16. Those rows had proxmox_vmid
-- already null per the API responses captured at the time, so the
-- unique index wasn't holding their slots. But if any future cleanup
-- targets a row that DID have proxmox_vmid set, the row would be gone
-- and the slot freed. So no further action needed for them.
