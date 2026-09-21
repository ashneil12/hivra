# Provider Ubuntu interrupted-install cleanup

Status: PASS for pre-ownership live cancellation and original-resource cleanup;
independent review GREEN. This is not full platform or desktop launch acceptance.

## Scope and budget

- Canary deployment `dpl_2G7xzCL2Xc8PqhWTfSmFTaFmo7nm`, source `ed1c41bd7`,
  immutable provisioner `2026.09.06.1`. Alias inspected live before the campaign.
- Existing connection `00000000-0000-4000-8000-000000001136`, displayed as
  Canary Hetzner E2E 2026-09-04. Fresh Sync servers reports zero servers; SQL
  reports zero non-deleted provider computers. The six existing managed
  computers/agents remain running and are excluded from every mutation.
- Reserve **£1 additional**, taking conservative cumulative campaign
  reservations to **£6.90 of £10**. This is a budget allowance, not an invoice or
  currency conversion. No purchase had been submitted when this entry was made.
- One cpx32, 4 CPU / 8 GB / 160 GB, Helsinki hel1, Ubuntu 22.04. Fresh UI quote
  reviewed on September 6: USD 0.08196/hour gross including IPv4, monthly cap
  USD 51.108, 20 TiB included traffic, USD 1.44/additional TB. VAT 20%; no backups
  or extra volumes. Generated name `hivra-9e049e1a119d4a4197e3`.
- Cleanup no later than **06:25 UTC September 6**, and earlier once the test
  finishes or a terminal failure is established. Record original IDs after
  creation; never reuse a previous fixture's provider identity or host pin.

## Test boundary

Use normal guided setup, then launch `CANARY_PROVIDER_CANCEL_0906`. Observe the
exact original worker active, with no completed desktop ownership, before the
normal Manage / Destroy action. Follow the same retained provision and durable
cancellation through verified worker termination and original provider cleanup.
Missing desktop ownership must remain pending, not fabricated stopped proof.
After server removal, require fresh absence handoff, all five original resource
absences, cleared access, and terminal SQL state. Do not manually clear leases,
restart the installer, or submit a replacement launch after an uncertain result.

Live migration history confirms `20260906040000`, `20260906050000`, and
`20260906110000`. Independent read-only source preflight found no known blocker
in the deployed cancellation/teardown path; 77 focused delete tests passed.
That review is not live acceptance. The ambiguous historical August 28 order,
unrelated provider resources, and all pre-existing managed data are excluded.

## Live operation

Normal UI purchase submitted once at approximately **04:21 UTC**. Original order
`00000000-0000-4000-8000-000000001137` returned provider server **164742229**, name
`hivra-9e049e1a119d4a4197e3`, and create action **653556590216964**. The first
response observed initializing, not prepared. This is the sole newly owned paid
fixture. Follow this original request; cleanup deadline remains **06:25 UTC**.
Original generated SSH key: **118412035**; IPv4 resource **148270377**
(`10.252.45.62`), IPv6 resource **148270378**. The provider reused an earlier
fixture's IP, not its identity; no earlier SSH pin or resource scope is reused.

An early same-request check retained the initial response inside the existing
mutation-reconciliation lease. Fresh inventory sync subsequently reported off;
the saved request reconciled to `created_off` at **04:24:31 UTC**. Normal
Continue computer setup / Continue setup then selected this exact server. No
second create request or manual database status change occurred.

Guided setup verified original firewall **11580959** at
`04:25:23.169 UTC`, then requested power-on. Enrollment attempt
`00000000-0000-4000-8000-000000001138`, connection revision 1, produced target
`00000000-0000-4000-8000-000000001139`. The normal UI reached Environment
prepared, and Choose what to launch preserved this exact target.

The unified Computer / Ubuntu / My infrastructure review showed the original
server and no new purchase. Launch created **CANARY_PROVIDER_CANCEL_0906**,
computer **00000000-0000-4000-8000-000000001140**, at
`04:27:48.894337 UTC`. Original allocation/provision operation is
**00000000-0000-4000-8000-000000001141**. Dispatch was recorded at
`04:27:51.399209 UTC`, with immutable bundle `2026.09.06.1`.

## Actual cancellation and cleanup

Before Destroy, a read-only SSH observation loaded the original installation
binding and current enrollment receipt, pinned SSH to that receipt's Ed25519
host identity, and checked only this original server. It reported installer
`MainPID=2087`, `ActiveState=active`, `SubState=running`, start
`04:27:54 UTC`, and `RuntimeMaxUSec=20min`. The original journal directory had
dispatch, started, and desktop-preparation intent, but **no desktop-ownership
or desktop-ready record**. This is observed incomplete installation, not a
synthetic failure or an already-completed desktop.

The actual Mac Alpha Canary page exposed Manage while provisioning. Destroy
named this computer and disclosed removal of its original provider server, IPs,
firewall and key. The irreversible checkbox and exact-name confirmation were
completed; the normal Permanently destroy action was submitted once. The UI
continued cleanup automatically and returned to Computers with the four
original Ubuntu computers still running.

The durable records establish the sequence:

| Observation | UTC on September 6 |
| --- | --- |
| Original desktop cancellation grant issued | 04:29:58.376277 |
| Installer stopped, immutable outcome `cancelled` | 04:30:01.829859 |
| Original provider cleanup began | 04:30:02.211394 |
| Exact server absence freshly observed | 04:30:09.209 |
| Separate server-absence handoff recorded | 04:30:09.313628 |
| All original resource cleanup completed | 04:30:29.188156 |

The desktop-cleanup journal retains **receipt NULL / observed_at NULL**; no
successful desktop shutdown receipt was invented for missing ownership. The
separate absence journal retains original server `164742229` and operation
`00000000-0000-4000-8000-000000001141`. The deleted computer retains its original
installer outcome, with desired state deleted and operation ID/kind NULL. Its
database management token and tunnel reference are NULL.

Original order is deleted, cleanup error NULL, all five absence flags true, and
encrypted bootstrap material erased. A separate read-only provider check at
**04:32:33.922 UTC** loaded the same current owner-bound project connection and
made only five allowlisted GETs. Each returned structured not-found: server
164742229, IPv4 148270377, IPv6 148270378, SSH key 118412035, firewall 11580959.
The checker permits neither provider writes nor requests for other resources.

Independent review reran the inspected absence checker at **04:35:26.957 UTC**:
all five exact resources returned structured not-found, exit 0. Independent
terminal SQL readback at **04:37:52.357 UTC** confirmed the documented lifecycle,
NULL operation/allocation references, original cancelled outcome, NULL guest
cleanup receipt, and grant → stop → teardown → absence → completion sequence.
Both authoritative nameservers, `carrera.ns.cloudflare.com` and
`neil.ns.cloudflare.com`, returned NXDOMAIN for
`agents-canary-box-redacted.hermesos.cloud`. The external Cloudflare tunnel
object was not separately enumerated; clearing its database reference is not
proof of external tunnel-object removal.

Private, credential-free diagnostic source is retained at
`/tmp/hivra-cancel-check.BjA7Ue/{observe,absence}.cjs`; connection secrets
were loaded only in process memory and never printed or written to those files.
The SSH observation ended before cancellation, and the absence checker exited 0.
No temporary worker or billable fixture remains from this campaign. The test
VM's partial installation/disk is irreversibly deleted; no user files were
created on it or removed from another computer.

Post-cleanup SQL confirms all six pre-existing managed IDs, names, VM IDs,
CPU/RAM and running states unchanged. This is identity/allocation/status
preservation, not a byte-for-byte disk audit. No managed VM, deployment, shared
host, model credentials, account sign-in or production environment was changed.
Conservative reservations remain **£6.90/£10**, not a final provider invoice.

## Remaining limits and observed UI issue

This proves normal user-driven cancellation of an actively installing provider
Ubuntu computer **before desktop ownership exists**, followed by scoped provider
cleanup and truthful original-server-absence handoff. It does not establish
post-ownership cancellation, failure rollback, another provider/OS, native model
inference, full data recovery, or full core completion.

Manage displayed an inaccurate resize message while provisioning: “The original
resize is saved but its result is not verified.” No resize was requested; the
actual operation was provision. This is a separate UI defect to correct, not a
reason to reinterpret successful cancellation or launch another paid fixture.
