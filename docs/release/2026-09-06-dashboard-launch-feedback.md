# Dashboard-agent launch confirmation feedback

## Source and release

Observed in the preceding OpenClaw launch: the initial request spent roughly a
minute behind a disabled Launching button before navigation to setup. Source
`c4bd31037ae9f3db50974b939c7d6154bfd51a8b` adds a nearby, polite live status for
the shared Aeon/OpenClaw/Agent Zero launch form. It says the request is pending
and distinguishes confirmation from installation progress. It changes neither
the request payload nor provisioning, model billing, retries or lifecycle.

Normal-risk checks: WelcomeFlow suite 75 passed / six pre-existing skips;
after the final status placement adjustment, all four new focused cases passed.
Scoped ESLint had zero errors and the two pre-existing warnings (unused Link,
selectedPersonaId callback dependency). Full TypeScript and diff checks passed.
Regressions cover all three runtimes, live-region/description semantics,
disabled single submission, accepted navigation and rejection cleanup.

Clean archive `/tmp/hivra-launch-feedback.0nncZ5` built Ready as
`dpl_5wUwAu9KTkLzeBLpdzD1QMauVmah`, then was explicitly promoted in the
**hermesos-canary** project. Inspection of `https://canary.hermesos.cloud`
resolved that exact deployment. URL:
`hermesos-canary-1a0q4qi27-ashneil12s-projects.vercel.app`.
Rollback is prior Ready `dpl_DH7TrdgwaQg9kmstSCZgLYF99GXn`; not exercised.
Actual production, schema, guest bundles and existing VMs were not updated.

## Live confirmation acceptance

Refreshed the logged-in root-path Hivra Mac Alpha. Home retained the original
four computers and two agents, all Running. Normal Agents → Deploy Agent →
Agent Zero submitted `CANARY_A0_FEEDBACK_0906` once, with default 1 CPU / 2 GB
from the managed pool and managed Venice unchecked.

The deployed message visibly appeared above the disabled Launching button.
The accessibility tree exposed its Launch confirmation status and full text.
No percentage, allocation claim or install-stage claim was displayed. After
server acceptance it automatically opened Setting up on the exact agent page,
and the temporary message disappeared. No refresh or duplicate request was
used. This accepts the feedback change, not the runtime's eventual readiness.

## Owned runtime fixture

Agent `00000000-0000-4000-8000-000000001095`, created
`2026-09-06 02:13:00.159638+00`, type `agent-zero`, managed channel `canary`.
Operation `00000000-0000-4000-8000-000000001096` allocated VM 1130, 40 GB disk
`local-lvm:vm-1130-disk-0`, 1 CPU / 2048 MB. Binding tag
`hivra-bind-c5598f2bfe908e7a10e9898a0318104e` and operation tag
`hivra-op-d9f5a12a9265479f959fbcf411cd37b0` were verified before observation.
Canary host provisioner `.10`; installer PID 3689086 observed running.

Deadline 02:35 UTC including cleanup. No model request, login, key import,
provider capacity purchase or additional Hetzner reservation. Pre-test full
`qm list` SHA:
`6bcd71708f0374d062cd039a8957e635efa8539fe653739a40fe5631939d66cf`.

### Native launch: delayed rendering, then recovery

Setup advanced without another submission. Agent Zero v2.2 first appeared around
02:20:26 UTC, roughly seven and a half minutes after creation. Its initial native
Files interaction displayed a WebSocket polling-fallback warning; the screenshot
had missing icon fonts and overlapping layout. This is not a clean first-load
acceptance. By approximately 02:25 UTC, the native layout and file browser had
recovered without a refresh or source patch.

The native resource panel then showed 100% CPU (one core), 1.87/1.92 GB RAM and
load 7.10/2.87/1.17. This suggests pressure at the default allocation but does
not establish the cause of the initial rendering or WebSocket failure. Internal
authenticated gateway checks returned CSS successfully; those checks are not
public-browser asset or WebSocket acceptance. Guest-agent access was briefly
unavailable, then a fresh ping and one read-only retry succeeded.

### Resize and persistence: accepted on this fixture

Through the public Box Terminal as `bux` (UID/GID 1001), created the owned
19-byte marker `HIVRA_A0_RESIZE_OK\n` at
`/opt/a0/usr/canary-a0-feedback-0906/proof.txt`. SHA-256, independently checked
locally:
`83eea0b616068d30505baa72fffbed91470f24de51e9d1304aba6b8e13cfed35`.

Normal Manage → 2 CPU / 4 GB → Apply was clicked once around 02:27 UTC. By
02:31 UTC, the UI reported Running and 2 CPU / 4 GB. Fresh host configuration
confirmed cores 2, memory 4096 and the same disk and binding/operation tags.
Guest boot ID changed from `00000000-0000-4000-8000-000000001097` to
`00000000-0000-4000-8000-000000001098`; the marker hash remained identical.
This verifies the resize reboot, not a separate Restart-button action.

Returning to Dashboard loaded the native Agent Zero interface. Its resource
panel reported 43% CPU (two cores), 1.69/3.82 GB RAM and load 0.03/0.17/0.08.
Native Files → directory `/a0/usr/canary-a0-feedback-0906` displayed `proof.txt`
as 19 bytes in a correctly rendered file browser. Public UI navigation and
listing plus the internal hash check establish retained-file visibility; no
native editor or model reply was tested. Warm caches and elapsed startup time
confound any comparison with the earlier one-core load.

### Cleanup and limits

Normal Manage → Destroy, irreversible checkbox, exact fixture name and
Permanently Destroy submitted one deletion. By **02:33:21 UTC**, before the
deadline, the row was deleted with VM/operation cleared and token/tunnel
references null. VM 1130 configuration, storage volumes, installer PID file
and original installer PID were absent. Full `qm list` hash matched the
pre-test baseline above. Both authoritative Cloudflare nameservers returned
NXDOMAIN for `agents-canary-box-redacted.hermesos.cloud`; the external tunnel
object itself was not independently enumerated.

Home again showed the original four computers and two agents, all Running.
Only the owned VM and its test marker were irreversibly removed. No existing
machine was resized, updated or deleted; no additional provider spend.

The launch-confirmation feedback and this fixture's resize/persistence checks
passed. Agent Zero's initial cold rendering and polling fallback remain open
observations, not repaired defects. Native model authentication/replies, clean
cold-start performance, other catalog runtimes and the full core-experience
goal are not accepted by this receipt.
