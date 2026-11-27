# Register a Proxmox operator workload

Use this only for an operator-owned QEMU VM that deliberately has no Hivra
instance or agent row. Verify the owner and exact running VM first. Registration
is not a Hivra ownership record and does not change scheduling, capacity,
backup, or lifecycle policy.

Append one VM config tag without replacing the existing tags:
`hivra-operator-<fleet-host-id>+<vmid>+<vm-name>`. For example, an
`operator-service` VM with ID `401` on fleet host `test-node` gets
`hivra-operator-test-node+401+operator-service`. Use the host ID as it appears
in the sweep, not an SSH alias. The detector compares the whole tag exactly.
A move, rename, or clone to a different ID invalidates the old registration.
Remove the tag if ownership lapses or before reusing the slot. Don't carry
operator tags into a replacement config.

The authenticated `/api/cron/detect-proxmox-orphans` result lists registered
IDs under `hosts[].operatorVmids`. They remain in the running inventory count
but do not contribute to `orphanCount`. A tag cannot hide a restore-clone name
or a VM with Hivra binding or managed-operation tags. Config-less disk
detection is unaffected.

Confirm a completed sweep on the target release lists the exact VMID under its
host's `operatorVmids` before archiving its stale warning. Don't archive a
warning that also covers unresolved orphans. The cron has opt-in cleanup
actions; don't invoke an extra live sweep just to check registration without
first confirming it is safe and authorized.
