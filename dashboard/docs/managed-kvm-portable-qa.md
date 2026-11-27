# Managed cross-host KVM wake: Canary QA draft

This is an unverified, opt-in Canary pilot, not a launch or a general-purpose
restore path. It targets the ordinary managed Linux launch shape: one data
disk, generated NoCloud `ide2`, a serial console, and host CPU. The pilot will
not fence or transfer an unqualified source.

## Enable only for an independently qualified fixture

The server gate requires the canonical Git Canary deployment, an exact standing
QA owner and computer, and a separately confirmed paid managed fixture that is
not assigned to the existing single-target QA writer fence. Do not retarget or
disable that fence. Keep `HIVRA_KVM_PORTABLE_QA_ENABLED` unset until there is a
qualified fixture. Configure `HIVRA_KVM_PORTABLE_QA_OWNER_ID`,
`HIVRA_KVM_PORTABLE_QA_AGENT_ID`, and `HIVRA_KVM_PORTABLE_QA_PLACEMENTS` (an
array of two exact `{hostId, vmid, ip}` records). No browser-supplied placement is
used. Both private placements must preserve the same guest IP and MAC and have
compatible routing and isolation. Independently exclude the reserved address
and both VMIDs from other allocators. Outside the QA pool, the database must
also have an operator-enrolled pair for that exact owner, agent, placements,
and existing binding. VMID 9302 is excluded.

The fixture must have Linux on explicit x86-64 SeaBIOS/i440fx with the common
CPU features on both independently qualified hosts, one LVM-thin `scsi0`
(1–40 whole GiB), a generated seed, one NIC, QGA, and the existing guest-mode
named connector. The operator snapshots the ordinary launch's instance ID and
network settings before hibernation, and the owner must explicitly
opt into sleep. Checkpointing is only attempted once hibernation has discarded
saved RAM. `HIVRA_KVM_PORTABLE_QA_PROFILE` pins the observed source machine ID,
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
