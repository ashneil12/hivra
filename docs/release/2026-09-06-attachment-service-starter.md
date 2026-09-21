# One-time guest service starter — 2026-09-06

Source-only continuation from `a2297d7ad`, on PR #600. This implements a
previously missing component, not a reproduced production incident. No app or
host caller is enabled; no migration, service privilege or deployment changes.

The starter pins the read-only preflight, independently renders its fixed unit,
refuses existing activation/service state and durably records intent before
requesting one systemd start. It never enables the service, retries activation,
publishes a binding, calls a model or releases the operation lease. Success is
`service_started`, not native-protocol readiness or useful work. An uncertain
start requests stop only when the created unit and loaded policy remain owned;
that request is not process/session release evidence.

Independent review found two defects in the prototype: journal replacement
could overwrite changed state, and the loaded-unit check omitted commands,
reload state and immediate pre-start inactivity. The corrected implementation
retains original root/lock identity and journal metadata/bytes, checks them
before publications and start, and refuses adoption of replacement state.
Loaded checks cover defined security settings, exact ExecStart/ExecStartPre
objects, absence of additional lifecycle commands, NeedDaemonReload=no and
inactive/dead/MainPID=0 before dispatch. These are cooperating-operation
checks, not containment against a hostile guest root administrator.

## Focused checks

Twelve tests passed in 13.794s on a disposable Linux amd64 root container, using
the actual pinned Codex staging/preflight and a **simulated systemd boundary**.
Coverage includes single start/replay refusal, existing unit preservation,
unknown service state, uncertain start, replaced units, failed publication,
unreviewed preflight, changed loaded policy/extra commands, intervening
activation, and replaced root/lock/journal preservation. No real systemd or
browser attachment acceptance is claimed from these tests.

Fixture owner `00000000-0000-4000-8000-000000001080`, pinned image
`sha256:5478d6a069d57a5b96cfd74e18476ffe16fe5c53dad22dab674467c1de472763`,
network disabled, no mounts or privileged mode, 240-second maximum lifetime.
Container `19cad5c6ac692b00568ae2b97ca4b6b4a2e7437389f4107e03bc39fbc27729ae`
was explicitly stopped. Owner-filter and volume-name checks were subsequently
empty for its anonymous volume
`d00db6a26b05e03f788f0ff307231d43f18603573317059b17608e483701b10b`.
No retained computer or live VM changed; no additional spend.

Review then reproduced a systemctl-format incompatibility: multiple ExecStartPre
commands emit repeated property lines, and empty Exec arrays emit no line
([systemd v249 source](https://raw.githubusercontent.com/systemd/systemd/v249/src/systemctl/systemctl-show.c)).
The parser now accumulates only known Exec properties in order, normalizes their
omitted arrays and still rejects duplicate scalars. The fixture uses that exact
format. Final **13 tests passed in 13.359s**, including duplicate-scalar rejection.
Starter SHA-256 `d06d92137ea69ff0339043176b9cf9631b105eea1c0d19083db9321d742fa314`;
test SHA-256 `77e361ec4aae6802fc0e6ab140af879273dc0c6b63e1f13ff702381fb8d9d88c`.
Final fixture owner `00000000-0000-4000-8000-000000001081`, same pinned image and
240-second/network-none policy, container
`10ce9853796e6cb9efde8cfdf6ca5b6448bcb8a3653156eb9d0d2aa0083399ad`, anonymous volume
`55618a5bb142548701a8f2abac955d8785b89ad3a61927ba390194dbb0017307`.
Both final owner-filter and exact volume checks were empty after explicit stop.
Independent bounded re-review is GREEN on the final source hash; actual parser,
Python AST and diff checks passed. This does not provide live acceptance.

## Live baseline and limits

Vercel CLI confirms Canary alias resolves to ready deployment
`dpl_HAxsTsp6Ks13iigMkhfEYtRvytHU`, URL
`https://hermesos-canary-j4zpndczx-ashneil12s-projects.vercel.app`.
The native app is signed into Hivra Canary. After review GREEN, the normal Launch
button was pressed at approximately 20:43 UTC for owned Ubuntu fixture
`_STARTER_ACCEPT_0906_2030` (2 CPU, 4 GB, existing plan capacity). Cleanup deadline
is 21:25 UTC; resolve fresh DB/VM binding before guest writes. Baseline inventory:
`337f1c3b2eee15e644950801a1e886f9fd37be360b74de05b16f8e0cc2beb868`.

## Actual Ubuntu starter acceptance

Normal UI launch reached Running and visibly connected the desktop at about
20:50 UTC. Fresh fixture computer `00000000-0000-4000-8000-000000001082`, VM1130,
IP `10.240.20.80`, binding tag `hivra-bind-3032dc36b74486c017a7b83a88f8c4aa`.
Its initial provisioning operation `00000000-0000-4000-8000-000000001083` was
cleared before guest writes. The one-off operator harness checked this exact
DB identity and current host/VM name, tag, IP and running state. It did not
exercise the future application DB grant/shared host-lock path.

The committed starter `0721db439`, exact hash above, ran once in real Ubuntu
systemd after the actual pinned fetch/stage path. It returned `service_started`
with MainPID26204, private UID/GID997 and unit inode `[2049,6348]`. Both native
WebSocket-over-Unix initialize connections succeeded with the private Codex home.
A second invocation refused activation without changing the journal. No model
request or second service start was sent. The operator harness stopped the unit
and verified all private-account processes and its runtime directory were gone.

Operator operation `00000000-0000-4000-8000-000000001084`, dispatch
`00000000-0000-4000-8000-000000001085`, installation
`00000000-0000-4000-8000-000000001086`, activation
`00000000-0000-4000-8000-000000001087`, boot
`00000000-0000-4000-8000-000000001088`.
Generated unit SHA `763efabc8debc4b76736dae865f45be050abaa08c728d0d8adc73a8298938f45`.
Desktop container Config/HostConfig/Mounts digest remained
`6713850e4cf3f570e21ca5a5bec8450c634ca1f933c7502c85f402be615d8fdd` and the owned
marker remained `0bfeab0ba7994dc85e442ee75ed2aadbd84e5f9749e7a61d4bd406767d332ab0`.
The ignored exact-fixture harness `.hivra-data/starter-acceptance-0906.cjs` is not
an application worker and refuses rerun against an already-created marker.
Harness SHA `4a1c6d67f9857906dfd13570517a65cd98fa59f1747a7ec94b111cb18d916ce2`.

The normal native-app Box Terminal then printed `STARTER_TERMINAL_OK`, `bux`
and `/home/bux/Hivra` through the public connection path. The owned shell was
exited before Manage → Destroy, acknowledgement and exact-name confirmation.
The permanent-destroy action was sent only for `_STARTER_ACCEPT_0906_2030`.
Before deletion, its only observed disks were `vm-1130-cloudinit` (4 MiB) and
`vm-1130-disk-0` (40 GiB); QEMU PID168546.

Cleanup completed by 20:53 UTC, before the 21:25 deadline: DB desired/status
deleted, operation and VMID null, API token and tunnel cleared. Desktop session
`00000000-0000-4000-8000-000000001089` is revoked with input/control released.
Both authoritative nameservers return NXDOMAIN for
`agents-canary-box-redacted.hermesos.cloud`. VM config and prior QEMU process
are absent, storage lists no VM1130 disks, and the host inventory digest returned
exactly to baseline. Native-app inventory shows the four original computers,
all Running. Only disposable test data was removed; it was not backed up and is
not recoverable through this test. This is not a physical secure-erasure claim.

Status: PASS for the scoped one-time guest starter and preservation campaign.
Independent bounded receipt/source review confirmed the committed starter and
harness hashes, regenerated unit digest, marker bytes, one start/refused replay,
two initialize calls and cleanup checks; no P1/P2 found. The reviewer did not
repeat live execution or independently query final VM deletion.
No extra Hetzner capacity or model work was purchased. No temporary fixture
remains active. Canary web/provisioner deployment and unapplied migrations were
unchanged; source is committed/pushed on PR #600, not merged or promoted to
the application attachment flow.

The DB/host activation caller, observing existing activation outcomes,
native readiness, binding publication, detach/recovery and normal UI attachment
remain unimplemented. The full core-experience goal stays open. Rollback is to
leave this uncalled component unused; there is no live rollback in this slice.
