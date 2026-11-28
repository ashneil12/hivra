# Managed cross-host KVM wake: Canary QA draft

This is an unverified, opt-in Canary pilot, not a launch or a general-purpose
restore path. It targets the ordinary managed Linux launch shape: one data
disk, generated NoCloud `ide2`, a serial console, and host CPU. The pilot will
not fence or transfer an unqualified source.

## Enable only for an independently qualified fixture

The server gate requires the canonical Git Canary deployment, an exact standing
QA owner and computer, and a separately confirmed paid managed fixture that is
not assigned to the existing single-target QA writer fence. Do not retarget or
disable that fence. Leave the private enrollment's `runtime_profile` and
`runtime_expires_at` null until the fixture is qualified. The operator enables
the pilot for that exact enrollment and a bounded window by setting both. The
app reads the enrollment at request time with a read-only service role RPC;
it does not use build-time selectors or browser-supplied placements. Clear both
fields to stop new pilot work, then reconcile any already claimed operation
without legacy fallback. Both private placements must preserve the same guest IP and MAC and have
compatible routing and isolation. Independently exclude the reserved address
and both VMIDs from other allocators. The live source configuration already
claims its VMID and IP. Reserve a vacant placement before enrollment with
`npm run --silent ops:proxmox:portable-slot -- reserve <host> <vmid> <ip> <binding-tag>`
from the dashboard directory, using its generated script only on the exact
pinned host as root. A vacancy check on its own does not reserve anything.
The reservation is a stopped, locked Proxmox configuration with the private
IP, no NIC, and no disks. Both usual allocators see the VMID and IP in their
existing inventory. Never start the reservation. The operation-specific
prepare permit authorizes converting that exact diskless configuration in place.
The script's `release` action accepts only the unchanged diskless reservation;
it cannot remove the restored guest. Outside the QA pool, the database must
also have an operator-enrolled pair for that exact owner, agent, placements,
and existing binding. VMID 9302 is excluded.

A maintenance host remains unavailable to ordinary launches. For a single
reviewed Canary window an operator can create one
`hivra_kvm_portable_private.maintenance_pilot` row for the exact standing QA
owner, computer, placement and binding tag. Do not change the host registry
status. Before granting or refreshing this permission, independently check
the destination's current customer VM and public gateway health, memory
admission, and storage headroom. The grant expires within four hours and its
customer health evidence must be less than ten minutes old before any new
staging, restore, placement commit or connector activation. Monitor customer
health during the window. If a customer probe or host guard fails, invalidate
the health timestamp immediately and reconcile the in-progress handoff without
legacy fallback. Retain the exact grant for retirement/cleanup, then remove it.

The fixture must have Linux on explicit x86-64 SeaBIOS/i440fx with the common
CPU features on both independently qualified hosts, one LVM-thin `scsi0`
(1–40 whole GiB), a generated seed, one NIC, QGA, and the existing guest-mode
named connector. The operator snapshots the ordinary launch's instance ID and
network settings before hibernation, and the owner must explicitly
opt into sleep. Checkpointing is only attempted once hibernation has discarded
saved RAM. The runtime profile pins the observed source machine ID,
explicit emulated machine, MAC, normalized attachment flags, measured managed
CPU requirements, and qualified cloud-init instance ID, gateway and DNS. It
also pins each host's
bridge and storage profile (`storageId`, `volumeGroup`, `thinPool`). Root
preparation independently checks the driver's exact lease and disk manifest,
qualifies the destination, and issues the per-operation prepare permit and
separate boot permit. The app cannot create or substitute those permits. Do
not replay a captured Proxmox configuration, copy cloud-init credentials, or
use source vendor snippets. The destination regenerates its seed with one
operation-owned metadata line preserving the source instance ID.

## Signed-in wake and acceptance

The existing sleep cron stages the encrypted checkpoint during cooled
hibernation, preserving the sleeping state. No destination operation can begin
until the normal signed-in owner request records authority and the checkpoint
is verified. A request during checkpointing waits; it does not do the copy
itself. The app can advance requested restore work without waiting for the
next cron tick. Destination restore is a bounded detached job. A
quarantined boot is verified before the placement CAS. Only after the CAS can
the destination activate its network. The boot-specific connector must match
the sole active edge connection before the destination lock and owner wake
lease can be released. The legacy reconciler leaves the portable lease alone.

Check Files and Terminal through the normal signed-in page, then get a real
agent reply and verify a stable disk witness. Keep the old source intact and
fenced until that acceptance. The service-only retirement RPC records exact
source VM and connector absence and unchanged healthy destination after
manual retirement; it does not delete a VM or release an unfinished operation.
Requalify and reserve the now-vacant exact slot before repeating; stop on
an allocation conflict or a stale reference rather than taking over a VMID.
Repeat only after verified retirement. Record failed runs, and separate source
checkpoint time from cold read, restore, boot, and first useful signed-in
result. Do **not** report user wake latency from an operator SSH witness.

If a pre-cutover operation cannot proceed, disable dispatch for this pilot
and drain the exact host jobs first. Reconcile the exact destination VM,
restore storage, and quarantine state, and independently verify their
absence. On the source, verify the original disk and stopped guest, and
restore the ordinary cold marker without starting the guest or leaving the
portable Proxmox lock. Only then use the service-only abort RPC to clear the
exact old lease and return the source row to ordinary hibernation. There is
no automatic fallback, and this abort is not available after placement
commit: repair that destination in place while the source stays fenced.
