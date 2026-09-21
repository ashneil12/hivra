# Owned native-service systemd campaign — 2026-09-06

Final status: **PASS for the scoped real-Ubuntu systemd/native-protocol campaign**;
the full attachment workflow remains open. Source baseline
`515530ea2`; live Canary alias freshly inspected as
`dpl_HAxsTsp6Ks13iigMkhfEYtRvytHU` / `.06.4`, not the newer unshipped attachment
source. No pending attachment migration is being applied by this campaign.

Normal Hivra Canary native-app launch created `_NATIVE_SERVICE_0906_1715`,
computer `00000000-0000-4000-8000-000000001063`, around 17:17 UTC. Review showed
2 CPU / 4 GB on the included Command allowance, no server purchase or model
credential. The app moved to its own setup screen and showed status responses.
Cleanup deadline: **17:55 UTC**. Only this newly owned fixture may be modified
for the native service test; retained computers and the shared/default host
provisioner remain out of scope. Cleanup is normal Manage → Destroy, followed by
exact VM/volume/session/route absence checks. No additional Hetzner or inference
spend is authorized or intended by this campaign.

Before launch, node-b identity and the full VM inventory were read; VM 1130 was
absent. Do not assume the new allocation is 1130: resolve the new computer's
current operation, VMID, binding tag and guest identity before any guest write.
Current native inventory had four retained computers, all Running.

## Observed service check

DB subsequently reported running, operation ID/kind null, VM 1130 and
10.240.20.80. `qm config` matched name `hivra-cc-1130`, that IP and exact binding
tag `hivra-bind-c3e949343feb32694fd8b2b80e55991c`. Native Desktop rendered the
Ubuntu desktop over its public authenticated session before guest mutation.
Read-only DB probes initially requested nonexistent `error_message` and
`updated_at` columns; the corrected explicit-field query succeeded. No DB
mutation or attachment grant was issued.

The one-off local operator fixture `.hivra-data/native-systemd-0906.cjs` sent
bounded QGA stdin programs only to the rechecked VMID/tag/IP. It loaded the
committed TypeScript bundle and service builders, rather than recreating a unit
by hand. This fixture is NOT the production host-lock/lease transport and does
not test its authorization or concurrency. Fresh operator fixture identity:

- Operation `00000000-0000-4000-8000-000000001064`
- Dispatch `00000000-0000-4000-8000-000000001065`
- Installation `00000000-0000-4000-8000-000000001066`
- Binding `00000000-0000-4000-8000-000000001067`
- Guest boot `00000000-0000-4000-8000-000000001068`

These UUIDs label this operator test; they are not live canonical DB rows.
Pinned Codex 0.149.1 fetched over HTTPS, then staged once as account
`hva_837dd555ebe44cea9a356339`, UID/GID 997. Binary SHA-256 was
`73dc5888888f411c1f0fa7b81d866e721dcc86b527ce8e3b2cf4708661e823ba`.
Generated unit SHA-256:
`ce05499cf56bb9006d3c93c93d4cafbee42cf42824db64fff7e7df3c7aabc268`.

Before installation, the fixture checked actual passwd UID/GID/home, home mode
0700, executable root/group ownership, mode 0550 and pinned binary hash. Real
`systemd-analyze verify` succeeded. Two systemctl start/stop cycles succeeded;
each initialized two independent WebSocket-over-Unix connections and checked
the returned codexHome. Captured effective properties:

```text
Cycle 1 MainPID=26487; cycle 2 MainPID=26542
User=hva_837dd555ebe44cea9a356339
Group=hva_837dd555ebe44cea9a356339
ProtectHome=yes
ProtectSystem=strict
NoNewPrivileges=yes
RuntimeDirectoryMode=0700
KillMode=control-group
ActiveState=active
SubState=running
Both cycles: resultKeys=[codexHome,platformFamily,platformOs,userAgent]
Both cycles: socket UID 997, mode 0600; parent UID 997, mode 0700
Both stops: runtime directory absent; no remaining UID-997 processes
```

Desktop container `14b974bb337a` Config/HostConfig/Mounts digest stayed
`26f148436dbe4f629ec97975e75dff13993d2ff0f25d5e1ac2bce1ac0bae4bdd`.
Owned marker `/root/hivra-native-preserve-0906` digest stayed
`eb49eda4ec273e115a2f73c60395472371bf2901e7c7c0871bfaa7fe91e843c1`.
This is scoped configuration/marker preservation, not full filesystem or
security-escape proof. Unit remained stopped, not enabled. No credentials,
model request, public listener or new route was configured. Service check
completed approximately 17:29 UTC. Final UI/cleanup/review follow below.

## Public UI and cleanup

The signed-in native app's public Box Terminal executed
`printf 'NATIVE_SERVICE_TERMINAL_OK\n'; id -un; pwd` and visibly returned the
marker, `bux`, and `/home/bux/Hivra`. That owned shell was exited. Switching
back to Desktop rendered KDE again through the existing authenticated session.
No desktop input-latency claim is made.

Normal Manage → Destroy, with exact-name confirmation, removed only this test
computer around 17:31 UTC. Fresh DB read: status deleted, VMID and operation
null, API token and tunnel references cleared. `qm list` had no 1130 row and
`pvesm list local-lvm --vmid 1130` had no disks. Session
`00000000-0000-4000-8000-000000001069` is revoked, input state released and
control_released_at populated. Both authoritative servers, carrera and neil,
returned NXDOMAIN for `agents-canary-box-redacted.hermesos.cloud`.
The app returned to the original four retained computers, all Running. Owned
service, installation, marker and guest diagnostic data were removed with the
disposable VM disk; no recovery copy was retained by this campaign. This is
not secure-erasure or backup-inventory evidence. No new capacity or model
charge was incurred.
The exact VM configuration and original QEMU PID 48799 were absent; a bounded
top-level `/root`, `/tmp`, `/run` name scan returned no `*1130*` entries. The full
host VM inventory digest returned to
`337f1c3b2eee15e644950801a1e886f9fd37be360b74de05b16f8e0cc2beb868`.

Independent reviewer Pauli found no P1/P2 contradiction, independently
regenerated the exact recorded unit hash, checked marker bytes and harness
syntax, and confirmed the runtime source had not drifted from `515530ea2`.
This review checked evidence consistency; it did not repeat the live campaign.

Limits remain explicit: no DB attachment/activation grant, shared host-lock
concurrency, browser agent access, model work, detach, guest reboot, injected
timeout/disconnect recovery or sandbox-escape acceptance. Only selected
effective systemd properties were captured. Windows, Omarchy and other agent
runtimes are not covered by this Linux Codex fixture. The ignored one-off
harness is retained locally for audit, not installed or registered as a worker.
