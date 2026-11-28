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
separate boot permit. Use the original allocation operation ID from the same
owner-bound agent row, not the portable handoff ID or guest metadata. Source
qualification and destination verification require its allocation tag and the
binding tag; destination preparation writes both, so ordinary signed Delete
can still check the committed guest's ownership. The app cannot create or
substitute those permits. Do
not replay a captured Proxmox configuration, copy cloud-init credentials, or
use source vendor snippets. The destination regenerates its seed with one
operation-owned metadata line preserving the source instance ID.

For the ordinary paid launch this pilot requires a fixed memory envelope. The
stored allocation supplies the matching memory floor and ceiling, and its
pool priority supplies the CPU weight. Both values are verified against the
source and carried through restore. The only permitted raw-only section is a
single Proxmox cloud-init cache entry for this VM's original allocation-scoped
QGA vendor reference, after that reference has been removed from the current
configuration. The checkpoint binds both raw and current hashes, but stores
only the effective configuration. It never replays that cache or the source
vendor data; the destination generates its own NoCloud seed.

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

### Guarded operator cleanup

Do not arm a trial on the strength of offline cleanup tests. The tools below
cover two distinct states:

- **Retire:** after a finished wake and successful signed-in acceptance,
  retire only the exact stopped source recorded in the journal. Keep the
  checkpoint. Verify the destination is still using the pinned reservation
  and the accepted boot with its sole current edge connector. The source
  script verifies the original allocation, binding, raw and effective
  hashes, and pinned thin-volume identities under native and Hivra locks.
- **Abort:** before placement commit, remove only a stopped destination with
  its original slot and preparation lineage proved. Quiesced restore failures
  can be reconciled if the prepared artifacts still match. Verify physical
  destination absence before releasing the source's exact fence. Restore only
  the original cold state; never start the source as part of cleanup.

The abort tooling does **not** cover a slot with no operation-bound preparation
attempt, an interrupted native conversion without proven lineage, or a
destination with a boot attempt, quarantine bridge rules, a running guest,
or another active writer. Leave the hold and last recoverable copy in place.
Do not substitute a general lock bypass or deletion command. After retirement,
the authoritative destination still uses the ordinary signed Delete route.
Per-operation replay receipts are not reusable host permits. Reconcile
operation bookkeeping and the encrypted checkpoint separately; these tools
do not purge the shared repository.

Work only on the authorized Canary owner and fixture. Retain the signed
acceptance evidence (retirement), immutable preparation or boot profile,
checkpoint proof, and independently measured source volume identities. Turn
off the exact runtime selector and let its workers drain. Keep the exact
maintenance admission for retirement while it is still required. Use the
operator-only `hivra_kvm_portable_private.claim_cleanup` function with the
original action, owner, operation, generation, allocation ID, binding hash,
journal phase and both placements; never expose the full binding hash on any
output channel. A missing or changed receipt is a refusal, not permission to
generate replacement input from the current host.

The runner is `dashboard/scripts/ops/kvm-portable-guarded-cleanup.ts`. Run it
with the dashboard's `ts-node/register/transpile-only` and
`tsconfig-paths/register` hooks and the repository's
`scripts/register-server-only-noop.cjs` hook; set
`TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}'`.
It requires `--apply-canary`, an absolute private manifest path (mode 0600,
`{authority,run}`), and an absolute trusted operator driver path. The driver
is environment-specific and must be verified offline before live use.

The runner sends JSON on stdin and reads a JSON response from one bounded
driver invocation per action:

- `read` calls the private `read_cleanup` with the held receipt and the
  original tuple, returning the exact DB receipt or null.
- `host` verifies the selected host is one of the two authorized registered
  targets and uses strict host authentication. It runs the supplied script
  with no request data or credentials on stdout; return only
  `{ok,stdout}`, where stdout is restricted to the script's native receipt.
- `connectors` uses the exact owned tunnel and returns the active connector
  IDs; an unavailable lookup must not produce an empty list.
- `finish` passes the generated evidence to private `finish_cleanup` with
  the original receipt and tuple. Return true only after the returned journal
  matches the terminal operation. A lost response can be reconciled by
  replaying those exact finish arguments; never redispatch against a completed
  hold.

The runner independently asks the host to verify absence after a successful
cleanup command and re-reads authority before mutation and finalization. A
nonzero exit is not evidence of absence. Use the original manifest for a
retry only after reconciling the exact journal and host state.
