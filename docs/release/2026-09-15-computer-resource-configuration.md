# Computer resource configuration — Canary acceptance

## Scope and accepted release

This receipt covers the consumer configuration milestone across Resources,
connected-host policy, private networking, and the choice between a hardware VM
Computer and a lightweight Linux Sandbox Computer. It does not claim completion
of every small-server feature or a production release.

- Branch: `codex/desktop-runtime-repair-20260914`.
- Original resource-editor implementation: `ec14a71ba`, based on resource
  envelopes in `5ed3785d7`.
- Configuration implementation: `a276683c5`, with cumulative Canary recovery
  and desktop work preserved through merge `418c6469c`.
- Accepted application revision:
  `7072890dae58df6d89706c31997b5193c3af14f1`.
- Canary deployment: `dpl_72yV4QH7HPghLFnYpU72oaos3geT`, READY.
- Public alias: `https://canary.hermesos.cloud`.
- Canary provisioner bundle on node-b: `2026.09.15.2`.
- Separate production provisioner: `2026.09.08.3`, unchanged.

Canary remained non-indexable through `X-Robots-Tag: noindex, nofollow` and its
disallow-all robots file. No production dashboard deployment is claimed.

## Current consumer paths

Launch opens Resources by default. Hardware VM profiles expose reserved CPU,
maximum CPU, reserved memory, and maximum memory. Existing Proxmox Computers
expose the same values in Manage. Infrastructure provides separate Agent and
Computer launch links plus direct **Manage resources** links.

Infrastructure host configuration exposes admission mode, host memory reserve,
CPU density, and memory density. Add, Edit, direct Inspect, Save and Inspect,
Check Readiness, Prepare or Repair gVisor, and their Done paths were exercised
in the deployed UI. On final revision `7072890da`, Edit → Save and Inspect →
Check Readiness → Done returned automatically to one ready inspected target
without a manual refresh. The separate direct Inspect → Check Readiness → Done
path passed on `7719ef7c0`.

The final existing-Computer path also passed: Infrastructure → Manage resources
for `UBUNTU_CANARY_CURRENT` opened `?tab=manage#resources`, loaded the Command
allowance of 3 CPU / 86 GB free, enabled all four controls, and showed the saved
2 CPU / 4 GB reservation and maximum.

Computer launch presents two materially different isolation choices when the
connected capacity supports them:

- **Hardware VM** uses Proxmox management with KVM isolation and supports desktop
  operating systems.
- **Linux Sandbox** uses gVisor runsc for a non-root Linux terminal and Python
  workspace on an owner-connected host.

A hardware VM does not mean dedicated physical hardware or dedicated CPU cores.
CPU scheduling remains shared. Reserved RAM is the Proxmox balloon floor and
maximum RAM is its ceiling. Additional capacity is opportunistic, and Hivra
rejects maximums below reservations.

A Linux Sandbox reserves CPU and memory at the enforced maximum because this
driver has no protected balloon-floor contract. It is an application-kernel
boundary, not a hardware VM. It has no graphical desktop, Windows runtime,
public ports, host mounts, devices, privileged mode, or host namespaces.

Windows remains a hardware-VM path. gVisor never runs Windows. Bring-your-own
Windows media remains subject to the user's installation rights, explicit
attestation, supported ISO evidence, and the existing license gates; this
milestone does not grant or redistribute Windows licenses.

## Dated resource-editor evidence

The original Canary Manage page exposed only CPU and RAM and did not send
maximums. Launch hid resource envelopes under Advanced, and Infrastructure had
no direct resource-management link. The `ec14a71ba` milestone corrected those
consumer paths before the broader host-configuration work.

Disposable fixture `CANARY_CONFIG_20260915`, Computer
`00000000-0000-4000-8000-000000001167`, ran as node-b VM 1113. Its initial
launch occurred on the earlier `5ed3785d7` dashboard after the Canary bundle
repair and reached a real Ubuntu desktop and browser terminal. It reserved
2 CPU / 4 GB with 4 CPU / 8 GB maximums.

On deployed `ec14a71ba`, Chrome followed Infrastructure → Manage resources and
landed on the four saved values. The Command account showed a 24 CPU / 128 GB
managed pool. Reserved choices beyond remaining capacity were disabled while
maximum choices remained independently editable.

A maximum-only change to 2 CPU / 4 GB completed and reconnected. A file written
before resize survived. The terminal reported 2 CPUs and 3911 MiB guest memory;
Proxmox confirmed cores/cpulimit 2, memory/balloon 4096, and the unchanged disk
and binding tag.

Reserved memory was then raised to 8 GB with 4 CPU / 8 GB maximums and later
returned to a 4 GB floor while retaining those maximums. Manage returned to
Running after each change. The file remained readable, the terminal again
reported four CPUs, and Proxmox confirmed balloon 4096, memory 8192,
cores/cpulimit 4, and the original disk and binding.

The deployed Launch flow was also exercised through Computer → Ubuntu →
Configure → Review. Resources was expanded without opening Advanced, and the
selected 2 CPU / 4 GB maximum envelope reached Review with the correct Command
allowance. No second VM was created by that form-only check.

This older evidence remains a dated resource-editor milestone. The final
configuration acceptance below used later revisions and separate disposable
records.

## Host capacity policy receipt

Host policy changes are revision-bound. Saving a new policy invalidates target
readiness and requires an identity-preserving preflight before new admission.
Provision, start, and resize use the same bounded admission helper under the
existing allocation lock. The policy does not authorize a customer to change
shared managed-host limits.

The Canary UI saved and read back `enforce`, a 2048 MiB reserve, CPU density 2,
and memory density 1.5. A later reserve change from 2048 to 2304 MiB invalidated
readiness. Because the pinned gVisor runtime was already installed,
**Check gVisor readiness** ran the read-only preflight rather than reinstalling.
It rebound the live sandbox from connection revision 6 to revision 7 with the
same host, adapter, and runtime identities. Its workspace marker remained
readable after rebind. Prepare or Repair remained a separate explicit mutation.

The admission helper was also exercised read-only on node-b under the allocation
lock. Observe mode returned measured active floor, memory ceiling, CPU ceiling,
and host headroom. Enforce-mode probes at 1x/1x, 2x/2x, and 4x/2x rejected the
current host overcommit on the applicable memory or CPU ceilings. They changed
no VM and evicted nothing.

Those probes verify the source helper's decision on current inventory. They do
not claim that managed node-b has host enforcement activated. Owner-connected
capacity remains bring-your-own capacity and is excluded from the managed
subscription pool.

## Private networking receipt

Supported Ubuntu desktop Computers expose owner-gated private access in Manage.
The path supports the default Tailscale coordination service or an explicit
owner-provided Headscale URL. It uses one-use enrollment credentials and stores
only sanitized observations.

The fixture first proved that Hivra refused to take over an unmanaged connection
to a different coordination URL. After deliberate logout and a fresh one-use
key, Connect returned the private address and a second private peer reached the
fixture-only HTTP proof. Refresh updated observed state. Disconnect moved the
guest to NeedsLogin and made the proof unreachable. Reconnect restored the
owner path and peer proof.

Guest policy kept Tailscale SSH off, route advertisement empty, exit-node
selection empty, and public workload exposure off. The existing desktop
container ID and start time did not change.

This accepts the owner-controlled private networking path on the disposable
fixture. It does not claim a Hivra-operated shared private network or a public
workload port.

## Linux Sandbox receipt

Discovery supports gVisor preparation on Ubuntu 22.04 or 24.04 amd64 root hosts
with cgroup v2 and apt. A fresh supported host can explicitly Prepare. An
installed compatible host can run read-only Check Readiness, with Repair kept as
a separate explicit action.

Preparation verifies the pinned official `release-20260907.0` bundle SHA,
installs runsc and all four sidecars, installs the exact Hivra adapter, reloads
Docker without restarting it, waits for Docker to report the exact runsc path,
pulls the pinned Python image, and runs an isolated non-root smoke test. It
fails closed on a conflicting installed identity and exposes only sanitized
failure stages.

The owned Ubuntu 22.04 fixture completed preparation with adapter SHA-256
`2bb8ce761b72a5fc5054b8dbf9f7c79684da478b74c5f1127a212c489539695d`,
the pinned runsc release, four sidecars, pinned image, and smoke test. Docker 29
capability names are normalized only for the standard `CAP_` prefix; exact
capability sets still reject extra authority.

Fresh browser launch `CONFIG_SANDBOX_ACCEPT_20260915` created Computer
`00000000-0000-4000-8000-000000001168`, sandbox
`00000000-0000-4000-8000-000000001169`, at connection revision 6. Its canonical
201 receipt opened Manage automatically. The record had no VMID and reached
Running with no active operation, 1 CPU, and 1 GB enforced memory.

Browser command execution proved UID `65534`, Python 3.13.15, a writable
private workspace owned by `65534:65534`, and a protected read-only root
filesystem. Python wrote and read the exact preservation marker.

Manage resized the sandbox from 1 to 2 CPU while retaining 1 GB memory, stopped
it to Stopped, and started it back to Running. Python then read the exact marker
with exit code 0. Strict Docker inspection showed runsc, `NoCopy=true`,
non-root user, read-only root, `CapDrop=ALL`, no public ports, only the owned
workspace volume, 2 CPU, and 1 GB memory.

The host policy change then rebound the unchanged child from revision 6 to 7
through Check Readiness without reinstalling. The marker passed again. The
sandbox did not debit the managed subscription pool.

Canonical DELETE returned HTTP 200. The database record became deleted with
live connection and target foreign keys cleared, no operation, and the immutable
revision-7 binding retained in its cleanup audit. The exact container, workspace
volume, and network were absent.

An earlier child, `00000000-0000-4000-8000-000000001170`, independently proved
canonical deletion while a policy rebind was pending. Its revision-5 binding
remained in audit and its exact container, volume, and network were absent.

The lifecycle uses canonical Computer records and canonical launch, start, stop,
resize, delete, and owner receipt routes. Lost launch responses recover through
the immutable request ID without redispatch. The Manage terminal executes a
bounded `/bin/sh -lc` command for at most 60 seconds with bounded output. It is
a command terminal, not interactive SSH.

## Database and authority receipt

The implementation uses hosted Supabase/PostgreSQL. No SQLite database was
introduced. Canary applied:

- `20260915153000_hivra_private_access.sql`
- `20260915170000_hivra_gvisor_computers.sql`
- `20260915183000_host_discovery_inspection_time.sql`
- `20260915184000_infrastructure_capacity_policy_rebind.sql`
- `20260915190000_gvisor_preflight_external_id_text.sql`
- `20260915190100_gvisor_preflight_connection_columns.sql`

The 1900 forward migration corrected the live JSONB/text external-ID comparison
while retaining owner, revision, adapter, runtime, host identity, and rebind
checks. The 1901 migration clears only the preflight lease columns that exist in
the live schema.

Real preflight committed an application-kernel target bound to the exact
connection revision, host identity, adapter SHA, runsc SHA, and terminal-only
capability receipt. Deleted sandboxes detach live foreign keys so the owner can
remove the host connection, while cleanup receipts preserve immutable binding
IDs and runtime hashes.

Admission rejection releases an operation lease only after strict live status
proves the sandbox identity and resources unchanged. Unknown or changed outcomes
retain the lease for reconciliation.

## Configuration fixture cleanup

After the accepted sandbox lifecycle:

- Computer `00000000-0000-4000-8000-000000001168` was deleted and its exact
  Docker resources were absent.
- Owner connection `00000000-0000-4000-8000-000000001171` returned HTTP 200 on
  canonical deletion; its database count and live child foreign-key count were
  zero.
- Parent Computer `00000000-0000-4000-8000-000000001172` returned HTTP 200 on
  canonical deletion; its DB record was deleted with VMID cleared.
- node-b VM 1113 was absent and its storage list was empty.
- The exact private Caddy route was removed and the remaining 50 routes matched
  the baseline.
- The test SSH key, relay directory, temporary service, nftables comment, and
  exact private DNS record were absent.
- The parent box had zero matching Cloudflare DNS records and zero matching
  active tunnels.
- The managed pool returned to 3 CPU / 86 GB free with nine Computers.
- Original VM 1108 remained running with its original CPU, memory, disk, binding,
  and provisioner separation.

## Source verification

Verification included executable Python adapter tests; focused contract,
service, API, migration, discovery, launch, listing, and UI Jest suites; shell
syntax checks; TypeScript typechecks; scoped lint where applicable; and
`git diff --check`.

The real Docker 29 helper inspect receipt is an executable fixture:
`CAP_CHOWN` passes while adding `CAP_NET_ADMIN` fails. Focused corrections
also cover launch receipt recovery, definite admission rejection, uncertain
lease retention, pending-policy cleanup, exact absence checks, runtime identity
pins, preparation fencing, Docker reload readiness, and installed-host
readiness without reinstall.

The earlier resource-editor milestone recorded 319 hot-path tests across 18
suites, 73 final editor/navigation tests, and 61 Infrastructure tests. Its known
broader Omarchy error-copy mismatch was outside this milestone and was not
misreported as a configuration failure.

## Final managed-VM receipt

Fresh managed Computer `CONFIG_VM_FINAL_20260915`, ID
`00000000-0000-4000-8000-000000001173`, launched through the final
`7072890da` UI on the Command plan and Canary bundle `2026.09.15.2`. It reached
Running with 2 CPU / 4 GB reserved and 4 CPU / 8 GB maximums as node-b VM 1113.
Its 40 GB disk was `local-lvm:vm-1113-disk-0`, binding
`256c23a80e93a2435898552c0af2d0d8`, and provision operation tag
`cba6b5ab80fd4ec78aa3dbd23118a853`.

The Canary public desktop path showed the real KDE desktop, wallpaper, and
taskbar. Desktop reported connected over WebSocket with WebCodecs and completed
secure setup in 4.1 seconds. Browser Box Terminal wrote and read
`~/hivra-final-preservation.txt` with marker
`hivra-final-preserved-b272`.

Manage then submitted a maximum-only resize from 4 CPU / 8 GB to 2 CPU / 4 GB,
leaving the 2 CPU / 4 GB reservation unchanged. It returned to Running with no
database operation or error. Proxmox reported cores 2, CPU limit 2, CPU units
200, memory 4096 MiB, and balloon 4096 MiB. The original disk, binding, and
provision-operation tags remained unchanged. The managed pool did not change
during the maximum-only resize.

Browser terminal reconnected after resize, read the exact marker, reported two
processors and 3911 MiB guest memory, and exited successfully. The public
desktop also reconnected and again showed the real KDE desktop through the same
WebSocket, WebCodecs, and secure-setup path.

Canonical DELETE returned HTTP 200. The database record became deleted with
desired state deleted, VMID cleared, no operation or error, and Cloudflare
fields cleared. `qm config 1113` confirmed the VM absent, and the
`local-lvm` storage listing for VMID 1113 was empty. Exact DNS name
`agents-canary-box-redacted` had zero records, and exact tunnel
`00000000-0000-4000-8000-000000001174` was absent from the full 56-tunnel
inventory.

Browser Infrastructure confirmed the managed pool restored to 3 CPU / 86 GB
free out of 24 CPU / 128 GB across nine Computers, with only the original
Hetzner connection remaining. Original VM 1108 remained Running with cores 2,
CPU limit 2, CPU units 100, memory and balloon 4096 MiB, 40 GB disk
`vm-1108-disk-0`, binding `4c366e989eed15aafad5e6f58def4c90`, and provision
operation tag `9a489bcceb49483aab4e278d3e61d668` unchanged.
