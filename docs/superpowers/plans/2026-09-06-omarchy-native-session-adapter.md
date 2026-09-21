# Omarchy native session adapter

Status: source-complete Omarchy native launch, bounded rolling renewal, exact
stop/release, HQ-first mode binding and reload recovery; Canary deployment and
live stream acceptance remain pending. Active native sessions can switch between
HQ and Performance only after the previous controller is exactly stopped and
released; uncertain teardown keeps the existing mode held.

Scope: Canary Omarchy and the local Mac Alpha. This follows the approved
[remote-computer design](../specs/2026-08-31-hivra-remote-computers.md), not a new
transport or permission to change the user's network. Baseline: `7b3aec9b6`.

## Current gap

The current branch implements the isolated Mac Moonlight profile, one-time
session exchange, Omarchy guardian activation, certificate-pinned server bind,
fixed HQ or Performance launch, same-process renewal, exact local/server stop,
automatic release after Moonlight exits, fail-closed one-click mode switching,
and reload recovery after re-proving the exact app-owned process. HQ is the
default at 1080p60 and 25 Mbps;
Performance is 720p60 and 12 Mbps. The recovery console remains available and
does not claim native-stream acceptance.

The remaining Omarchy gates are operational: apply the database migration and
application/guest/Mac revisions to Canary, establish the approved private or
authenticated-relay UDP path, then prove live video, input, audio, reconnect,
same-PID renewal, revocation and interaction latency on the exact guest. The
existing Mac route observation below is a historical checkpoint, not current
installed-app state: Moonlight 6.1.0 is now installed locally and its fixed
profile/launch contract passes focused tests, but it has not completed live
media acceptance through the still-blocked path.

Windows native daily-driver streaming is still unimplemented. Its browser
recovery console is a separate working path and must not be relabeled as native
Sunshine acceptance. The Windows work requires its own owned guest lifecycle
and the same media/input/audio/reconnect/stop evidence; it cannot inherit
Omarchy's systemd guardian evidence.

## Exact upstream constraints

- Moonlight Qt `v6.1.0` supports portable preferences when `portable.dat` exists
  in its working directory. Use an owned per-session directory, never the
  user's normal Moonlight profile. Actual credential/log/keychain isolation
  still needs a local client check. [Source](https://github.com/moonlight-stream/moonlight-qt/blob/v6.1.0/app/main.cpp#L274-L291).
- Sunshine `14ffa6fdaa53f7b51512be2b3d24f3939695403c` registers
  `/api/clients/unpair`, despite an older example comment naming `/api/unpair`.
  Writes invoke CSRF validation, but the pinned implementation permits
  authenticated non-browser requests without a CSRF token when both Origin
  and Referer are absent. Unpair removes a client but
  does not itself guarantee termination of its active stream when other
  clients remain. Disabling a client calls the global session termination
  function. Therefore neither operation is a safe generic per-session
  disconnect for a shared Sunshine instance. [Handlers and routes](https://github.com/LizardByte/Sunshine/blob/14ffa6fdaa53f7b51512be2b3d24f3939695403c/src/confighttp.cpp#L794-L899),
  [pairing state implementation](https://github.com/LizardByte/Sunshine/blob/14ffa6fdaa53f7b51512be2b3d24f3939695403c/src/nvhttp.cpp#L1130-L1155).

## Next implementation slice

1. Durable exclusive ownership preparation first, then the guest-owned lease
   supervisor. Today's inspector proves an unpaired snapshot, **not exclusive
   service ownership**. Create a Hivra-specific service and separate private
   configuration, certificate and pairing-state namespace; never retrospectively
   claim the running standard owner unit. Bind preparation to the computer,
   VM, owner UID, operation and exact installed source identity. Refuse conflicts
   without stopping or reconfiguring the standard unit. Subsequent lease work
   must also bind capability generation, exact revision and controller lease.
2. Pair only the lease's isolated Moonlight certificate. Keep Sunshine admin
   authentication and CSRF exchange guest-local, TLS-pinned to the inspected
   certificate. No PIN, bearer or password in URLs, process arguments or logs.
   Reject an unexpected additional pairing instead of deleting it.
3. Enforce expiry and revocation in the guest even when the Mac disappears.
   Demonstrate both stopped media/input and rejected reconnect before releasing
   the controller lease. A removed pairing or exited local process alone is
   insufficient. Recover owned incomplete pairing state after broker restart.
4. Add the Mac process/profile lifecycle using the accepted one-time handoff,
   with no arbitrary executable/host/argument bridge from web content. Do not
   implement a standalone "Open Moonlight" button that bypasses this lease.
5. Verify the exact private/UDP path from this Mac to one owned guest before
   buying or preparing another fixture. A new system VPN, route, relay or
   public port exposure needs its own scoped network decision; do not infer it
   from the general weekend implementation request.
6. On one disposable guest, use the actual native client: pair, render the
   existing Hyprland desktop, type and save a file, hear audio, reconnect,
   revoke while streaming, reject the old client, then remove all owned state.
   Preserve unrelated user data. Record setup duration separately from any
   physical latency claim; do not start a large optical campaign just to
   establish whether the first functional session works.

Guest adapter and native handoff changes require focused regressions and fresh
independent review before Canary integration. Keep the public selector closed
until the revision-bound native acceptance passes. The absence of a private
route blocks this live experiment, not other provider, recovery or app work.

### Independent boundary review, 2026-09-06

Read-only review against `f195461c2` confirmed that the current preparation
script's rollback state is process-local. Neither it nor the prepared
descriptor records original exclusive service creation. An additional journal
describing the same shared service would not fix this: it cannot prevent a
foreign pairing, and a global stop would still disrupt that client.

The next source entrypoint is a private
`dashboard/scripts/omarchy-sunshine-ownership.py`, with separate prepare and
fresh-observe operations. It must journal exclusive intent before creating
resources and bind the exact unit bytes, configuration paths, certificate
fingerprint, computer/VM, owner UID, operation and installed source identity.
Preparation ends **before activation, pairing or session issuance**. Its
receipt means owned preparation verified, never desktop ready. Interrupted
preparation must not adopt replaced files or services. Preserve existing owner
resources byte-for-byte and state-for-state when rejecting a conflict.

Keep this observer separate from `omarchy-native-capability.ts` and retain its
false reachability/input-takeover flags. Do not widen the Selkies broker: its
container-specific no-agent-input evidence is not evidence about Hyprland.

The subsequent supervisor must fence pairing/reconnect, stop only its owned
process boundary, verify listeners and held input have ended, and invalidate
only the expired client identity before allowing another activation. If any
termination or identity cleanup is uncertain, controller release stays pending.
A timer inside the broker alone does not cover broker crashes or reboot
resurrection. No service claim or native supervisor is implemented by this
review checkpoint, and no live system was mutated.

No additional Hetzner reservation or spend was made for this investigation.
The last provider fixture is already deleted; the existing cumulative
conservative reservation remains GBP 5.90 of GBP 10, not an invoice total.

### Inactive ownership foundation, 2026-09-06

`dashboard/scripts/omarchy-sunshine-ownership.py` now implements exclusive
preparation and fresh observation, separately from the existing launch path.
It is not invoked by the provisioner or public selector and is not included
in a released provisioner bundle. No existing service is adopted or stopped.

Preparation writes durable intent before creating credentials or the separate
unit. The private key is readable only by the exact service UID, not its
potentially shared primary group. Observation pins file hashes, filesystem
identities, directory identities, original binding and installed Sunshine
identity. It refuses replaced resources, pairing state, an activation marker,
service overrides or a non-inactive effective service definition. The created
unit has no install target; no code creates its required activation marker.

Systemd observation checks the exact loaded fragment, all reported drop-ins,
pending-reload flag, command, owner, environment and lifecycle settings. The
helper does **not** run daemon-reload. If systemd retains its initial
not-found cache or requires a reload, preparation may leave its durable files
and return refusal. Re-running prepare does not adopt them. Explicit,
separately reviewed reconciliation is still required; there is no automatic
cleanup or recovery implementation yet. Do not install this foundation as a
working launch feature.

Focused check: `PYTHONDONTWRITEBYTECODE=1 python3
dashboard/runtime-adapters/omarchy-native/ownership.test.py` — 18 tests passed
in temporary directories. Coverage includes interruption, no replay/adoption,
replacement files/directories, unsafe permissions, shared-group key access,
restrictive umask, binding/runtime drift and systemd property rejection. The
production probe is substituted in filesystem tests. Property-format tests
are local fixtures, not an actual Linux systemd execution. Empty Exec arrays
and repeated command output handling follow the
[systemd v257 property printer](https://github.com/systemd/systemd/blob/v257/src/systemctl/systemctl-show.c#L1285-L1337).

Independent review found and resolved two P2 issues: group-readable private
keys and trusting on-disk unit bytes without checking the effective unit.
This checkpoint is source-only. Linux preparation, real command-output
serialization, private-route access, pairing, video/input/audio, expiry and
revocation remain unverified. No guest, cloud capacity, firewall, standard
owner service or Canary deployment was changed. All test-created directories
were removed by the temporary-directory test cleanup.

### Service-identity traversal correction, 2026-09-06

The inactive foundation previously let root report prepared ownership even
when an existing root-only ancestor prevented the Sunshine UID from reaching
its configuration and key. Two new Linux regressions reproduced the false
admission on prepare and fresh observe before the correction.

Preparation now checks ancestor traversal before creating its namespace, and
observation rechecks it. The bounded probe runs under the service UID, explicit
primary GID and account supplementary groups, with Python `-I -S` and a fixed
environment. The kernel evaluates access; no chmod of an existing ancestor is
performed. This is still an inactive preparation receipt, not activation or a
desktop capability. The guest probe remains substituted in filesystem tests.

Independent review rejected the first mode-bit calculation: a supplementary
group denial can override other-execute, and ACLs cannot be inferred from mode
bits. It also required disabling Python startup customization in the identity
probe. Regressions cover actual Linux supplementary-group denial, actual
service-UID reads of the key/configuration, shared-group key denial, resolver
membership and subprocess isolation settings.

Local Linux checks use already-present image
`sha256:d3870c1312a28311a89f2fa8e4419985be477df4d09e9c4d8a02841c212600b8`,
no network, no pull, a read-only image and disposable test storage, not a guest.
The ACL-denial test has an explicit environment hold: tmpfs rejected POSIX ACL
xattrs with EOPNOTSUPP; a separate anonymous-volume check stored the ACL but an
independent `chdir` under UID/GID 1000 still succeeded. Neither is evidence of
enforced named-user ACL denial. The regression runs only when that filesystem
actually enforces the control denial; no ACL acceptance is claimed here.

Read-only `systemctl show` on node-b/systemd 257 confirmed not-found exit 0 and
the never-started ExecStart serialization used by the parser. No unit was
installed, reloaded or started. That observation is not Omarchy guest or full
effective-unit acceptance. No network, live VM, provider reservation or Canary
deployment changed. Lease supervision, pairing, input/media, revocation,
private-route acceptance and the remaining native lifecycle remain open.

Final checks: Linux 24 tests, 23 passed and the ACL case explicitly skipped;
macOS 24 tests, 20 passed and four Linux-only cases skipped. `git diff --check`
passed. Independent reviewer `core_gap_map` found no remaining P1/P2 in the
corrected source boundary and did not rerun the Linux suite. Docker test
containers used `--rm`; test-created directories were removed by their cleanup.
The bounded source correction is accepted, while enforcing-filesystem ACL and
actual guest service readiness remain unverified. No activation was enabled.

### Checkpointed inactive resume, 2026-09-06

The implementation adds an explicit same-operation resume for new inactive
preparations. This is not permission to adopt old incomplete preparation. New
preparations record immutable cumulative checkpoints between resource-creation
steps. Resume must hold an exclusive operation lock and verify original binding,
installed source, every recorded file and directory identity, an empty state
namespace, and the absence of activation or overrides before continuing.

Only fully recorded steps can be reused. Any uncheckpointed side effect,
replaced resource, foreign file, competing writer, or legacy incomplete operation
must refuse without modification. No delete, key regeneration, service start,
daemon reload, pairing, network change, or capability publication belongs to this
slice. A stale effective systemd definition remains a hold, not automatic repair.

Acceptance is source-only: interrupt at every durable boundary, resume the exact
operation, preserve recorded bytes and unrelated resources, and reject in-step
interruptions and identity drift. Run focused macOS and disposable Linux checks
plus independent review. Actual Omarchy service activation and native desktop
acceptance remain separate work.

Source acceptance passed: 37 focused tests, 33 passed / four platform skips on
macOS, and 36 passed / one filesystem ACL skip in the pinned disposable Linux
container. Independent review reproduced and resolved two publication races:
rebasing a changed prior key into a later checkpoint, and emitting the final
receipt after the observation probe introduced state. The corrected helper
carries original evidence forward and rechecks after the final observation.

The command is `resume`, using the same stdin binding as `prepare` and `observe`.
Only new ownership-v2 journaled preparations are eligible. Completed legacy-v1
preparations retain observation support; they are not migrated or resumed.
Neither the public launch selector nor any provisioner bundle includes this
helper. See [the source-only receipt](../../release/2026-09-06-omarchy-preparation-resume.md)
for exact hashes, checks, limitations, and cleanup. No live resource or network
was changed and no additional provider spend was incurred.

### Integrated guardian implementation boundary, September 6

Read-only investigation at source `2f9a5ebae` and independent review changed
the next action: do not add another standalone admission helper or turn the
v2 marker into an activation API. Implement a fresh v3 guest recipe with a
root guardian supervising the unprivileged Sunshine child in the same systemd
cgroup. Keep v1/v2 preparation and observation behavior inactive and unchanged.

The current empty-state recipe does not bootstrap administration. The pinned
[Sunshine password handler](https://github.com/LizardByte/Sunshine/blob/14ffa6fdaa53f7b51512be2b3d24f3939695403c/src/confighttp.cpp#L1148-L1186)
skips authentication while the username is empty, and its CSRF validator allows
requests without Origin or Referer. Therefore `origin_web_ui_allowed=pc` is not
sufficient evidence for safe initial bootstrap. Do not start this configuration
and configure credentials afterward. Before first exposure, the fresh recipe
must establish private administrator credentials using verified pinned
semantics, or verify an existing network boundary prevents access to port47990.
No firewall rule or network route change is authorized by this investigation.

Implementation requirements:

1. Pin guardian, unit, configuration, original preparation and installed
   Sunshine identities. Consume a durable one-use grant before spawning. Bind
   it to computer, VM, owner, preparation operation, capability generation and
   revision, controller session/lease, exact client certificate, guest boot ID
   and absolute CLOCK_BOOTTIME deadline. A lost acknowledgement, broker crash
   or reboot allows stop/observe recovery only, never replay of that grant.
2. Use `Restart=no`, no install target, bounded startup/shutdown and cgroup-wide
   killing. Set the systemd backstop from the admitted remaining lease budget;
   fixed RuntimeMaxSec240 does not enforce shorter leases or a hung guardian.
   Revocation and expiry must never extend the deadline. See pinned
   [systemd v257 service semantics](https://github.com/systemd/systemd/blob/v257/man/systemd.service.xml#L639-L698).
3. Keep release observation separate from the guardian. Confirm the original
   unit/invocation stopped, cgroup empty and owned listeners closed before
   releasing controller ownership. A successful stop response or a guardian
   finally block cannot prove child teardown; uncertainty remains release-pending.
   See [systemd v257 cgroup termination](https://github.com/systemd/systemd/blob/v257/man/systemd.kill.xml#L44-L90).
4. Enforce the lease's paired certificate, not merely a recorded fingerprint.
   Never load A's pairing into B's session. Unexpected pairing requires stopping
   the owned service and holding; do not delete an unexplained client record.
5. Wire the new recipe through native-specific broker revision admission and
   the Mac's isolated Moonlight profile/process. Current
   `requireCurrentSelkiesRevision` and `requireCurrentSessionProtocol` bypass
   non-Selkies transports; that is not guardian-version admission. Preserve
   exact lease exchange/revocation/release and certificate binding. Do not
   reinterpret Sunshine shutdown as proof of agent-input suspension in Hyprland.

Focused acceptance must exercise actual guardian/child termination, guardian
hang/death, expiry, reboot/replay, revoked A followed by B without A reconnect,
and held-input termination. Missing recipe/admin isolation, stale grants,
changed identities, conflicting standard services/listeners or unverified
network restrictions are no-spawn conditions. Native capability flags remain
false until the integrated path has its required evidence.

A fresh `route -n get 10.240.20.1` on the Mac still selects its default route via
192.168.1.254 on en0. This is not a private guest path or a connectivity test.
No VM, native client, service, pairing, firewall or route was changed during
this investigation. The integrated guardian is **not implemented by this
checkpoint**. The newly verified bootstrap prerequisite must be handled within
that implementation, not by weakening the inactive v2 recipe.

### Fresh v3 administration bootstrap implementation

The new `dashboard/scripts/omarchy-native-supervisor.py` begins the fresh v3
recipe with private administrator credentials prepared offline before any
service exists. It is separate from v1/v2, does not install a unit, and cannot
activate or pair. A root-only plaintext secret and service-UID-only compatible
hash file are separate from initially empty pairing state. Returned preparation
evidence never includes the password and still forbids activation.

Focused source and disposable Linux identity checks cover format, permissions,
interruption, replay/refusal and original-namespace preservation. See
`docs/release/2026-09-06-omarchy-v3-admin-bootstrap.md` for exact results and
limits. This implements the bootstrap part only; the integrated guardian,
native broker/Mac wiring and actual Sunshine authentication remain unfinished.
Do not advertise this source checkpoint as native-session support.

### Actual administrator authentication compatibility

The official pinned Sunshine Debian binary has now loaded the unchanged v3
preparation in a network-isolated disposable container. Across two fresh process
launches it accepted the prepared credentials and rejected anonymous access,
incorrect credentials and unauthenticated password bootstrap. No clients were
paired and prepared files stayed unchanged. See
`docs/release/2026-09-06-omarchy-administration-runtime.md` for exact artifacts,
checks and limits. This clears binary authentication compatibility only, not
actual Omarchy/Hyprland streaming or the integrated guardian implementation.

### Certificate admission prerequisite discovered in the actual runtime

The proposed exact-client binding cannot rely on a paired record's fingerprint
alone. The pinned Sunshine runtime accepts certificates chaining to a paired
certificate; an isolated actual-binary experiment confirmed that pairing a
CA-capable certificate also authorized its unlisted signed child. Fresh state
with only B rejected A and A's child, but that does not make CA-capable A an
exact-certificate admission boundary.

Before wiring the guardian's one-use grant, validate its supplied public client
certificate: single canonical PEM, expected DER SHA256, self-signature, and no
CA or certificate-signing capability. Keep this validation in the v3 guardian
module, not a separate activation/admission API. Verify ordinary non-CA client
acceptance and rejection of a delegated certificate against the pinned binary.
Require explicit basicConstraints `CA:FALSE`: both legacy v1 and Netscape
certificate-type inference can grant CA capability when that constraint is
missing. The native client recipe must therefore generate an explicit non-CA
certificate; an unmodified stock Moonlight identity without that constraint is
not admitted by this policy. This refines
the planned exact-client prerequisite without authorizing a network change or
enabling native launch. Broker/Mac must send a fresh isolated client certificate;
their integration remains required.

### Internal guardian lifecycle implementation

`supervise_lease()` now implements the internal one-use/owned-child lifecycle
within the v3 module. It pins grant/runtime identities, creates separate
root-owned pairing authority, enforces expiry/revocation, observes the live
client list and retains a release-pending claim on stop. The default context
checks the root guardian's systemd invocation/cgroup/backstop; the real-binary
component tests explicitly substitute that context, not systemd behavior.

CLI remains `prepare|observe`. No unit installer, native broker admission,
dispatch/release observer, Mac recipe or capability flag is enabled. The next
work must connect those existing planned boundaries and verify actual systemd
and guest behavior; do not add an independent activation shortcut. See
`docs/release/2026-09-06-omarchy-guardian-lifecycle-core.md` for evidence and limits.

### Separate process-stop observation

The internal `observe_lease_stop()` now checks the exact consumed lease and
retained claim against the original stopped systemd invocation, recursive cgroup
emptiness and actual IPv4/IPv6 stream/admin socket absence. It rechecks evidence
after observation and preserves all state. The planned release observer's process
boundary is implemented, not its controller/input-release authorization.

CLI remains `prepare|observe`; no unit installer or activation shortcut was added.
Missing or changed evidence remains a hold, including reboot or collected unit
state. `releasePending` remains true until native input-release integration has
its separate evidence. See
`docs/release/2026-09-06-omarchy-guardian-stop-observer.md` for actual versus
substituted checks and the remaining unit/broker/Mac integration.

### Mac isolated identity preparation

The Mac core now creates exclusive per-session portable Moonlight profiles with
explicit non-CA client certificates. The actual signed Moonlight 6.1.0 binary
consumed the macOS domain-based settings path without replacing the supplied
identity; the same public certificate passed Linux guardian admission. Parent
ACLs and replacement-directory cleanup are covered by actual macOS regressions.
See `docs/release/2026-09-06-moonlight-private-profile.md` for bounded evidence.

This is profile preparation only: no user-facing Moonlight launch, web-command
bridge, native session exchange, pairing or guest activation was added. Remaining
work is the integrated unit/broker/native-process lifecycle, private path and
actual media/input/revocation acceptance. The public Omarchy selector stays closed.

### Per-lease guardian activation and revision admission

The v3 guardian now has an exact systemd service recipe and root-only `activate`,
`run`, and `observe-stop` entry points. Activation validates the preparation and
pinned source identities, writes the one-use grant before installing the unit,
uses `Restart=no` with cgroup-wide SIGKILL, and binds systemd's runtime maximum to
the admitted guest boottime lease. A failed or lost start acknowledgement leaves
durable state that cannot be replayed as a second process.

Sunshine/Moonlight session issue, exchange, authorization and renewal now require
the current native session revision. That revision includes the inspector,
guardian and ownership source hashes, and a regression test catches source drift.
The current prepared Omarchy receipt deliberately does not claim that revision,
so these changes cannot open native access before integrated guest inspection,
Mac handoff, private UDP reachability and input-takeover evidence exist.

Focused macOS source tests cover deterministic unit construction, bounded runtime,
one start, durable start failure, capability revision rotation, and stale native
session refusal. Actual systemd, Moonlight media/input, revocation, private-route,
and user-facing acceptance remain pending.
