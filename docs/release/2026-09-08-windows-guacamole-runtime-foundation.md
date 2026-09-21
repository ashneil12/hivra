# Windows Guacamole runtime foundation

Scope: local, disposable Apache Guacamole 1.6.0 runtime evidence for the planned
Windows browser daily-driver lane. This does not enable Windows remote desktop,
prepare a guest, deploy a gateway, or prove an RDP session.

The fixture runs the official `guacamole/guacd:1.6.0` and
`guacamole/guacamole:1.6.0` linux/amd64 images by immutable platform-manifest
digest on a Docker `--internal` network. It publishes no host ports and removes
both containers and the network on exit.

- guacd linux/amd64 manifest: `sha256:f39258e35244b6bf79bc6ac4e60eee176aea6f6a5adb13e8c3090e48df8ae515`
- web linux/amd64 manifest: `sha256:50484043eadd8d9562053940c0ed523dbddaf9086c370127b2f4acabb8bddddc`
- bundled linux/amd64 JSON-auth JAR: `sha256:541dd411e2ba28564c31728728201b90805318880b2e63bcb4b4f23bf808318d`

The source-owned token builder follows Guacamole's HMAC-SHA-256 plus AES-128-CBC
JSON-auth contract and posts the encrypted value to `/api/tokens`; it does not
place credentials in a URL. Tokens expire within sixty seconds, contain exactly
one private-IPv4 RDP target on port 3389, require NLA and an explicit SHA-256
certificate fingerprint, and expose no target or fixture credential in the token
response. HQ requests 24-bit color and Windows visual effects; Performance uses
16-bit color and leaves those optional effects disabled. Both request RDP 8.1
display updates so the desktop follows the browser size.

Verification:

```sh
cd dashboard
npm run test:guacamole-json-token
npm run smoke:guacamole-rdp-runtime
```

Observed locally on 2026-09-08: three token contract tests passed, the real
Guacamole web application accepted the encrypted fixture handoff, guacd reported
1.6.0, and cleanup left no owned container or network.

The next source-only gate is a read-only Windows guest inspector in
`dashboard/src/lib/remote-computers/windows-rdp-capability.ts`. Its host wrapper
binds execution to the exact running Proxmox VMID, infrastructure tag and private
address before using that VM's QEMU Guest Agent channel. The guest program emits
no credential and requires a licensed Windows workstation, its current boot and
machine identities, enabled RDP with NLA, the TermService-owned port 3389
listener, the currently bound and valid RDP certificate's SHA-256 fingerprint,
and one inbound `Hivra RDP private access` firewall rule restricted to canonical
private IPv4 CIDRs, bound to `TermService`, blocked from edge traversal, and not
shadowed by any second enabled inbound TCP/3389 allow rule. Its descriptor
deliberately records the route as configured but unproven and does not produce a
session-capability receipt.

The companion source-only preparation contract in
`dashboard/src/lib/remote-computers/windows-rdp-preparation-host.ts` can disable
only Windows' three known built-in Remote Desktop allow rules, refuse any
unknown rule that could also match `TermService` on TCP/3389, create or verify
the exact Hivra-owned private rule, require NLA and port 3389, and start the RDP
service. It is idempotent for the same private gateway CIDRs and refuses to
rewrite a conflicting Hivra-owned rule. It creates no account, receives no
credential and returns `accessReady: false`.

Both generated PowerShell programs parsed successfully in the disposable
official PowerShell 7.4 Debian image at linux/amd64 manifest
`sha256:206a748b34deec1b64553fcfa92294fc871c2df5855e9f340df172756bef201f`.
Their success paths also executed there with the Windows-only cmdlets replaced
by deterministic, non-mutating fixtures. That run caught a strict-mode scalar
pipeline bug before commit; after correction, preparation emitted the exact
`accessReady: false` receipt and inspection emitted the exact private descriptor.
Thirty-seven strict builder, authority, preparation-result and descriptor tests
passed. Windows-only cmdlet behavior and the descriptor remain unverified on a
real guest; neither preparation contract is wired to an owner route, and no VM
was inspected or changed.

The source-only credential lease in
`dashboard/src/lib/remote-computers/windows-rdp-credential.ts` now creates a
fresh high-entropy Windows-compatible password and a deterministic
session-derived local username. It seals the credential with the server's
rotatable AES-256-GCM secret custody and binds the authenticated payload to the
exact owner, computer, session, activation, capability generation, guest boot
identity, streaming mode and at-most-five-minute expiry. Opening the envelope
requires every binding to match and rejects expired, future-issued, overlong,
malformed or corrupted leases. Owner identity follows the control plane's
bounded text identifier (including Clerk-style IDs); computer, session,
activation and generation identities remain strict UUIDs. Twelve focused tests,
focused ESLint and the full dashboard TypeScript check passed.

The envelope is intentionally not described as one-use: it has no durable claim
or guest-account side effect. Its plaintext result is for a future immediate
QEMU Guest Agent delivery path only and must never be returned to the browser;
only the later short-lived encrypted Guacamole token may consume it after guest
activation is proved.

The Proxmox execution service now also has a bounded
`runProxmoxHostScriptWithStdin` primitive for that future delivery. Fixed
host-side source is base64-carried in the SSH command while the sensitive value
travels only on the SSH channel's stdin; it is not interpolated into the command
or script. Source is capped at 96 KiB, stdin at 1 MiB, output remains bounded by
the existing runner, and timeout/host-key/target authority behavior is shared
with the established host-script path. The new local integration test and the
existing runner regression suite passed 23 checks; focused ESLint and full
TypeScript also passed. This primitive alone performs no guest mutation.

The source-only account activation bundle is shaped for that primitive: its
script and credential stdin are returned separately so a future coordinator can
carry the secret through SSH and the VMID-scoped QEMU Guest Agent stdin channel. Its
fixed PowerShell program rechecks the exact private address and the inspected
guest boot identity, accepts only the deterministic per-session username and a
maximum five-minute expiry, and creates or idempotently refreshes an expiring
local account bearing the exact activation marker. It refuses an existing
account with any other marker, proves the account is enabled, refuses
Administrators membership, and grants only the built-in Remote Desktop Users
group resolved by SID. The receipt binds computer, session, activation,
capability generation, VMID, boot, mode, username and expiry and contains no
password. Nine builder and strict receipt tests, a pinned PowerShell parser run,
focused ESLint and full TypeScript passed. Microsoft documents the relevant
local-account expiry/password controls and SID/group input on `Set-LocalUser`
and `Get-LocalGroupMember`.

The matching source-only revocation bundle now rechecks the same VMID,
infrastructure tag, private address, boot identity, session-derived username
and activation marker. A missing account is an idempotent success; a conflicting
account or Administrators member is refused. For the exact owned account it
disables login, removes Remote Desktop Users membership, deletes the account and
proves absence before returning a credential-free receipt. Seven focused tests,
focused ESLint, full TypeScript and a pinned PowerShell parser run passed.

Both mutations remain dormant source: no coordinator opens an encrypted lease,
calls activation or guarantees revocation, and no account was created or removed
on a Windows guest. The revocation bundle is an explicit primitive, not evidence
that an interrupted controller has durably completed teardown.

The owner-scoped desktop refresh now reaches the strict Windows inspector instead
of rejecting the profile before inspection. The shared coordinator selects the
Windows-only VMID-bound PowerShell probe, requires a canonical private guest
address before infrastructure access, and returns the exact prepared descriptor
without recording a launch capability. The dashboard route labels that result
`accessReady: false`; it does not admit Guacamole, create an account, or mutate
the guest. Sixty coordinator/profile/route tests and the existing 26-case Windows
inspector suite passed, together with focused ESLint and the dashboard TypeScript
check. Live Windows cmdlet execution remains unverified.

The owner Setup action now coordinates that existing Windows preparation through
the same durable desktop-operation lifecycle used by the other computer profiles.
It allows RDP only from the VM's enforced private `/24` bridge gateway (`.1/32`),
then runs the strict inspector before completing the operation. An uncertain
guest response remains attached to the same operation for observation instead
of being replayed. Windows SHA-256 boot identities are now accepted only for
Windows preparation receipts; Linux retains its UUID requirement. The focused
Windows preparation, inspection, migration and route suites passed 66 tests,
along with focused ESLint and the dashboard TypeScript check.

Remaining before admission: a licensed Windows image lifecycle and live inspector
proof; a durable one-use activation claim and teardown claim; VMID-bound
temporary-account creation, rotation and deletion acceptance;
owner/computer/revision-bound gateway authority; a private gateway-to-guest route; browser handoff and
revocation; and real video, input, audio, clipboard, resize, reconnect, restart,
latency, isolation and teardown acceptance. The existing noVNC console remains
recovery-only.
